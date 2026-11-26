// Preserve streamed output and request accounting across bounded retries.
import { setTimeout as wait } from "node:timers/promises";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ProviderResponse,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  AgentError,
  agentHttpStatus,
  mapAgentError,
  providerModelLimit,
  transientRequestError,
} from "../core/errors.ts";
import type { ToolSetSnapshot } from "../core/types.ts";
import type { RequestAccounting } from "./request-observer.ts";
import { CONNECTION_RETRY_DELAYS, RequestRecovery, type RequestRetry } from "./request-recovery.ts";

type ResponseStream = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

function hasOutput(message: AssistantMessage): boolean {
  return message.content.some((part) => {
    if (part.type === "toolCall") return true;
    if (part.type === "text") return !!(part.text.length || part.textSignature?.length);
    // Responses can deliver encrypted reasoning without any visible thinking text.
    return !!(part.thinking.length || part.thinkingSignature?.length);
  });
}

/**
 * How often one response may be re-requested after the stream dropped mid-way. The
 * dropped part is billed, so this stays small; it shares the run's connection allowance too.
 */
const MID_STREAM_RETRIES = 2;

/** Fixed text (prompt cache): the dropped response was never shown and none of it ran. */
export const DROPPED_RESPONSE_HINT =
  "[Pi Bot connection retry] 上一次回复在传输中断线，已丢弃，其中的工具调用都没有执行。请重新生成；写大文件时分成几次较小的写入，断线时损失更少。 / The connection dropped while your previous response was streaming; it was discarded and none of its tool calls ran. Generate it again; write large files in several smaller writes so a drop loses less.";

/**
 * The text the user already saw, as a finished reply the next request can continue. Reasoning
 * and half-streamed tool calls are dropped (none of them ran), and so are provider item ids: a
 * replayed id without its reasoning item would be rejected.
 */
function keptReply(message: AssistantMessage): AssistantMessage | undefined {
  const content = message.content.flatMap((part) =>
    part.type === "text" && part.text.trim() ? [{ type: "text" as const, text: part.text }] : [],
  );
  if (!content.length) return undefined;
  const { errorMessage: _error, diagnostics: _diagnostics, ...rest } = message;
  return { ...rest, content, stopReason: "length" };
}

function classified(error: unknown, status?: number, detail?: string): AgentError {
  const code = mapAgentError(error, status);
  return new AgentError(
    code === "internal" ? "provider_error" : code,
    status ?? agentHttpStatus(error),
    detail,
  );
}

function failed(model: Model<Api>, error: unknown, partial?: AssistantMessage): AssistantMessage {
  const code = mapAgentError(error);
  const status = agentHttpStatus(error);
  // pi's overflow recovery matches text; preserve its fixed sentinel, never the raw diagnostic.
  const diagnostic =
    code === "context_overflow"
      ? "context length exceeded"
      : code === "internal"
        ? "provider_error"
        : code;
  // SDK diagnostic objects can include request bodies and headers even when errorMessage is safe.
  const { diagnostics: _diagnostics, ...fields } = partial ?? {};
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    ...fields,
    stopReason: code === "aborted" ? "aborted" : "error",
    // SDK diagnostics can carry credentials; only fixed codes and the HTTP number survive.
    errorMessage: `${diagnostic}${status ? ` HTTP ${status}` : ""}`,
  };
}

/** The wrapper owns stream consumption, accounting and backoff; SDK retries must stay off. */
export function retryStream(input: {
  model: Model<Api>;
  signal?: AbortSignal;
  accounting: RequestAccounting;
  toolSet?: ToolSetSnapshot;
  open(recovery: {
    hint?: string;
    response(response: ProviderResponse): void;
  }): ResponseStream | Promise<ResponseStream>;
  describeFailure?(error: unknown): string | undefined;
  onLimit?(limit: { maxTokens: number }): void;
}) {
  const output = createAssistantMessageEventStream();
  const { model, signal, accounting } = input;
  const recovery = new RequestRecovery();
  // Response streams are sequential within a run; successful later turns must clear old failures.
  accounting.responseError = undefined;
  accounting.interrupted = false;
  const pump = async () => {
    let limitRetried = false;
    let retry: RequestRetry | undefined;
    let partial: AssistantMessage | undefined;
    // pi pushes a message on every "start"; a retried attempt must keep updating that one.
    let started = false;
    // Visible reply text already went to the user; a regenerated reply would repeat it.
    let textShown = false;
    let midStreamRetries = 0;
    let regenerating = false;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const receipt = accounting.begin(model, "response", input.toolSet);
        let responseStatus: number | undefined;
        let observed = false;
        let result: AssistantMessage;
        let error: unknown;
        recovery.resetResponse();
        try {
          const stream = await receipt.send(() =>
            input.open({
              hint: recovery.hint,
              response: (response) => {
                responseStatus = response.status;
                recovery.response(response);
              },
            }),
          );
          for await (const event of stream) {
            // A provider may attach its last usage only to the terminal event, even when result rejects.
            if (event.type === "error" || event.type === "done") {
              partial = event.type === "error" ? event.error : event.message;
              continue;
            }
            partial = event.partial;
            // Even an empty tool-call start identifies model output; do not replay it.
            observed ||=
              event.type === "toolcall_start" ||
              event.type === "toolcall_end" ||
              ("delta" in event && event.delta.length > 0) ||
              hasOutput(event.partial);
            if (event.type === "start") {
              if (started) continue;
              started = true;
            }
            // The session's repeat guard reads reasoning deltas; a regenerated response repeats
            // the dropped one's reasoning by design. Its final message still carries all of it.
            if (regenerating && event.type.startsWith("thinking_")) continue;
            if (event.type === "text_delta" && event.delta.length > 0) textShown = true;
            output.push(event);
          }
          result = await stream.result();
          if (result.stopReason === "error") error = result.errorMessage;
        } catch (caught) {
          error = caught;
          result = failed(model, signal?.aborted ? { name: "AbortError" } : caught, partial);
        }
        observed ||= hasOutput(result);
        // On a 200 stream, a number from the error body is not the HTTP response status.
        const attemptError = error === undefined ? undefined : classified(error, responseStatus);
        const unbilled = receipt.settle(
          result,
          attemptError && { error: attemptError, outputObserved: observed },
        );
        const rateLimited =
          attemptError?.code === "rate_limited" && attemptError.httpStatus === 429;
        const recoveryRetry =
          result.stopReason === "error" && !signal?.aborted && !accounting.blocked
            ? recovery.next(result, rateLimited && unbilled, accounting.retryAttempts)
            : undefined;
        const transientRetry =
          !rateLimited &&
          unbilled &&
          !accounting.blocked &&
          accounting.retryAttempts < CONNECTION_RETRY_DELAYS.length;
        const dropped =
          result.stopReason === "error" &&
          observed &&
          !unbilled &&
          !signal?.aborted &&
          !accounting.blocked &&
          !rateLimited &&
          !!transientRequestError(attemptError ?? result.errorMessage) &&
          midStreamRetries < MID_STREAM_RETRIES &&
          accounting.retryAttempts < CONNECTION_RETRY_DELAYS.length;
        const limit =
          !limitRetried && result.stopReason === "error"
            ? providerModelLimit(error ?? result.errorMessage, model.maxTokens)
            : undefined;
        if (limit && !signal?.aborted && !accounting.blocked) {
          limitRetried = true;
          input.onLimit?.(limit);
          partial = undefined;
          continue;
        }
        const kept = dropped && textShown ? keptReply(result) : undefined;
        if (dropped && (kept || !textShown)) {
          // A relay dropping a long stream ended the whole run with `network` (6 runs in
          // the owner's logs, minutes of work lost). Nothing in an unfinished response ran, so
          // asking again replays no side effect.
          midStreamRetries++;
          const delayMs = CONNECTION_RETRY_DELAYS[accounting.retryAttempts] as number;
          accounting.retryAttempts++;
          const attempt = {
            attempt: accounting.retryAttempts,
            maxAttempts: CONNECTION_RETRY_DELAYS.length,
          };
          const status = attemptError?.httpStatus;
          accounting.onReconnect?.({
            type: "reconnect",
            phase: "start",
            ...attempt,
            delayMs,
            reason: kept ? "interrupted" : "regenerate",
            ...(status === undefined ? {} : { status }),
          });
          await wait(delayMs, undefined, { signal });
          if (kept) {
            // The shown text stays and ends this response; the run asks the model to continue it
            // in the same reply (chat-run), like a reply cut at the output limit.
            accounting.interrupted = true;
            accounting.onReconnect?.({
              type: "reconnect",
              phase: "end",
              ...attempt,
              outcome: "done",
            });
            output.push({ type: "done", reason: "length", message: kept });
            return;
          }
          retry = { kind: "connection", delayMs, ...attempt };
          recovery.hint = DROPPED_RESPONSE_HINT;
          regenerating = true;
          partial = undefined;
          continue;
        }
        if (!signal?.aborted && (recoveryRetry || transientRetry)) {
          retry = recoveryRetry ?? {
            kind: "connection",
            delayMs: CONNECTION_RETRY_DELAYS[accounting.retryAttempts] as number,
            attempt: accounting.retryAttempts + 1,
            maxAttempts: CONNECTION_RETRY_DELAYS.length,
          };
          if (retry.kind === "connection") accounting.retryAttempts++;
          // Why it failed, as a code and HTTP status only (never provider text): without it the
          // log shows a run losing a minute to backoff with no cause.
          const status = attemptError?.httpStatus;
          accounting.onReconnect?.({
            type: "reconnect",
            phase: "start",
            attempt: retry.attempt,
            maxAttempts: retry.maxAttempts,
            delayMs: retry.delayMs,
            reason: retry.kind === "connection" ? attemptError?.code : retry.kind,
            ...(status === undefined ? {} : { status }),
          });
          await wait(retry.delayMs, undefined, { signal });
          partial = undefined;
          continue;
        }
        if (retry)
          accounting.onReconnect?.({
            type: "reconnect",
            phase: "end",
            attempt: retry.attempt,
            maxAttempts: retry.maxAttempts,
            outcome:
              signal?.aborted || result.stopReason === "aborted"
                ? "aborted"
                : result.stopReason === "error"
                  ? "error"
                  : "done",
          });
        // The allowance guards against a provider that stays down; once a response arrives,
        // the next drop starts from the short delay again instead of inheriting old attempts.
        if (result.stopReason !== "error" && result.stopReason !== "aborted")
          accounting.retryAttempts = 0;
        if (result.stopReason === "error" || result.stopReason === "aborted") {
          const cause = error ?? result.errorMessage;
          accounting.responseError =
            signal?.aborted || result.stopReason === "aborted"
              ? new AgentError("aborted")
              : classified(cause, responseStatus, input.describeFailure?.(cause));
          const final = failed(model, accounting.responseError, result);
          output.push({
            type: "error",
            reason: final.stopReason === "aborted" ? "aborted" : "error",
            error: final,
          });
        } else if (result.stopReason === "pending") output.end(result);
        else output.push({ type: "done", reason: result.stopReason, message: result });
        return;
      }
    } catch (error) {
      // Admission/settlement failures belong to the program, not the provider. The session's
      // existing programFailure gate must retain them even when SDK diagnostics are sanitized.
      if (!signal?.aborted) accounting.blocked ??= mapAgentError(error);
      if (retry)
        accounting.onReconnect?.({
          type: "reconnect",
          phase: "end",
          attempt: retry.attempt,
          maxAttempts: retry.maxAttempts,
          outcome: signal?.aborted ? "aborted" : "error",
        });
      accounting.responseError = classified(signal?.aborted ? { name: "AbortError" } : error);
      const final = failed(model, accounting.responseError, partial);
      output.push({
        type: "error",
        reason: final.stopReason === "aborted" ? "aborted" : "error",
        error: final,
      });
    } finally {
      output.end();
    }
  };
  accounting.track(pump());
  return output;
}
