// Run a checkpoint model request under the compaction deadline and accounting.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { AgentError, agentHttpStatus, mapAgentError } from "../core/errors.ts";
import { textTokens } from "../runtime/context-estimate.ts";
import type { CompactionState } from "./compaction.ts";

export type SummaryModel = Parameters<ModelRegistry["streamSimple"]>[0];
export const SUMMARY_IDLE_MS = 90_000;

/** Observe every event without racing away from the stream's actual abort/settlement. */
export async function checkpointRequest(input: {
  registry: ModelRegistry;
  model: SummaryModel;
  state: CompactionState;
  systemPrompt: string;
  text: string;
  maxTokens: number;
  signal: AbortSignal;
}) {
  const { registry, model, state, systemPrompt, text, maxTokens } = input;
  const idleMs = state.timing?.idleMs ?? SUMMARY_IDLE_MS;
  const idle = new AbortController();
  const signal = AbortSignal.any([input.signal, idle.signal]);
  const started = Date.now();
  if (state.diagnostic) {
    state.diagnostic.firstTokenMs = undefined;
    state.diagnostic.requestDurationMs = undefined;
    state.diagnostic.outputTokens = 0;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleMs);
    timer.unref?.();
  };
  const supported = getSupportedThinkingLevels(model);
  const reasoning = supported.includes("off")
    ? undefined
    : supported.find((level) => level !== "off");
  const receipt = state.accounting?.begin(model, "compaction", state.toolSet?.());
  try {
    reset();
    const send = () =>
      registry.streamSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
        },
        {
          signal,
          maxTokens,
          ...(reasoning ? { reasoning } : {}),
          // Some adapters interpret this as an absolute request deadline. Our event timer owns idle.
          timeoutMs: state.diagnostic?.totalDeadlineMs ?? 1_200_000,
          cacheRetention: "none",
          maxRetries: 0,
        },
      );
    const stream = receipt ? receipt.send(send) : send();
    const result = stream.result();
    if (receipt) state.accounting?.observe(receipt, result);
    let output = 0;
    for await (const event of stream) {
      reset();
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        output += textTokens(event.delta);
        if (state.diagnostic) {
          state.diagnostic.firstTokenMs ??= Date.now() - started;
          state.diagnostic.outputTokens = output;
        }
      }
    }
    const response = await result;
    input.signal.throwIfAborted();
    if (idle.signal.aborted) throw new AgentError("compaction_timeout");
    if (state.diagnostic) {
      state.diagnostic.stopReason = response.stopReason;
      state.diagnostic.outputTokens = response.usage.output || output;
      state.diagnostic.requestDurationMs = Date.now() - started;
    }
    if (response.stopReason === "error") {
      const code = mapAgentError(response.errorMessage);
      throw new AgentError(
        code === "internal" ? "provider_error" : code,
        agentHttpStatus(response.errorMessage),
      );
    }
    if (response.stopReason === "aborted") throw new AgentError("compaction_failed");
    return response;
  } catch (error) {
    receipt?.settle();
    if (input.signal.aborted) throw error;
    if (idle.signal.aborted) throw new AgentError("compaction_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    if (state.diagnostic) state.diagnostic.requestDurationMs = Date.now() - started;
  }
}
