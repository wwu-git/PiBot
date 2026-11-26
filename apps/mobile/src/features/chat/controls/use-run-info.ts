import { attachmentContinuationOf, type Message } from "@pibot/protocol";
import { useRuntime } from "../../../runtime/context.tsx";
import { readBudget } from "./calls.ts";
import { type ChatScope, isDm, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/** Requests, time and cost of the topic's latest finished reply, from the run's budget record. */
export function useRunInfo(scope: ChatScope | undefined, messages: readonly Message[]) {
  const runtime = useRuntime();
  const latest = messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.status !== "streaming" &&
      message.runId &&
      !attachmentContinuationOf(message),
  );
  const runId = latest?.runId ?? undefined;
  const state = useRemoteValue(
    scope && isDm(scope) && runId ? `budget:${scopeKey(scope)}:${runId}` : undefined,
    (signal) => readBudget(runtime, scope as ChatScope, runId as string, signal),
    ["execution.budget.changed"],
  );
  return { ...state, budget: state.value ?? undefined, messageId: latest?.id };
}
