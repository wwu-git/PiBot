// Run bounded page extraction on the configured auxiliary model.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { AgentError, mapAgentError } from "../../core/errors.ts";
import type { AgentRuntime } from "../../core/types.ts";
import { textTokens } from "../context-estimate.ts";
import {
  boundedExtract,
  EXTRACT_MAX_TOKENS,
  EXTRACT_MIN_CHARS,
  EXTRACT_TIMEOUT_MS,
  PAGE_EXTRACT_INSTRUCTION,
  pageExtractInput,
} from "../page-extract.ts";
import { createPageExtractLimit } from "../page-extract-limit.ts";
import { RequestAccounting } from "../request-observer.ts";
import type { RuntimeContext } from "../runtime.ts";

/**
 * A small helper window takes a shorter slice instead of failing: CJK pages are ~1 token per
 * character, so 60k characters do not fit a 32k model. Shrinks by the measured ratio, a few rounds.
 */
function fitted(request: Parameters<typeof pageExtractInput>[0], room: number) {
  let input = pageExtractInput(request);
  for (let round = 0; round < 4; round++) {
    const tokens = textTokens(input.content);
    if (tokens < room) return input;
    const chars = Math.floor(input.readChars * (room / tokens) * 0.9);
    if (chars < EXTRACT_MIN_CHARS) break;
    input = pageExtractInput(request, chars);
  }
  const last = pageExtractInput(request, EXTRACT_MIN_CHARS);
  if (textTokens(last.content) >= room) throw new AgentError("context_too_large");
  return last;
}

export function createPageExtractOperation({
  auxiliaryModel,
  buildRuntime,
  deps,
}: RuntimeContext): Pick<AgentRuntime, "extractPage"> {
  const acquire = createPageExtractLimit();
  return {
    async extractPage(request) {
      // One deadline for selection and generation: a slow helper must not hold the tool call.
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(EXTRACT_TIMEOUT_MS)]);
      const room = (model: { contextWindow: number; maxTokens: number }) =>
        model.contextWindow -
        Math.min(EXTRACT_MAX_TOKENS, model.maxTokens) -
        512 -
        textTokens(PAGE_EXTRACT_INSTRUCTION);
      let release: (() => void) | undefined;
      try {
        const queued = request.onQueue?.();
        try {
          release = await acquire(signal);
        } finally {
          queued?.();
        }
        const { runtime } = await buildRuntime();
        signal.throwIfAborted();
        const model = await auxiliaryModel.only(
          runtime,
          "web_page",
          signal,
          (candidate) =>
            textTokens(pageExtractInput(request, EXTRACT_MIN_CHARS).content) < room(candidate),
        );
        const input = fitted(request, room(model));
        // Extraction needs no deliberation; a model that cannot turn reasoning off gets its lowest.
        const supported = getSupportedThinkingLevels(model);
        const reasoning = supported.includes("off")
          ? undefined
          : supported.find((level) => level !== "off");
        const accounting = new RequestAccounting(request.observer, deps.network?.observeRequest);
        // Throws when the run's budget is spent; nothing has been sent yet.
        const receipt = accounting.begin(model, "auxiliary");
        const pending = receipt.send(() =>
          runtime.completeSimple(
            model,
            {
              systemPrompt: PAGE_EXTRACT_INSTRUCTION,
              messages: [{ role: "user", content: input.content, timestamp: Date.now() }],
            },
            {
              signal,
              maxTokens: Math.min(EXTRACT_MAX_TOKENS, model.maxTokens),
              ...(reasoning ? { reasoning } : {}),
              maxRetries: 0,
              timeoutMs: EXTRACT_TIMEOUT_MS,
              cacheRetention: "none",
            },
          ),
        );
        accounting.observe(receipt, pending);
        const result = await pending;
        await accounting.drain();
        signal.throwIfAborted();
        // A length stop still carries a usable answer; the bound below marks the cut.
        if (result.stopReason !== "stop" && result.stopReason !== "length")
          throw new AgentError(
            result.stopReason === "aborted" ? "aborted" : mapAgentError(result.errorMessage),
          );
        const text = boundedExtract(
          result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        );
        if (!text) throw new AgentError("provider_error");
        return {
          text,
          model: { provider: model.provider, id: model.id },
          readChars: input.readChars,
        };
      } catch (error) {
        throw new AgentError(signal.aborted ? "aborted" : mapAgentError(error));
      } finally {
        release?.();
      }
    },
  };
}
