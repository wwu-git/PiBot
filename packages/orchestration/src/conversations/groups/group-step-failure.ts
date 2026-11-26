import type { Run } from "@pibot/protocol-base";
import { MessagesRepo, ToolCallsRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/**
 * The run ended its turn because what it read no longer fit its context (three compactions in a
 * row without progress). Returns the redacted files it was reading ("" when none were recorded),
 * or undefined for any other ending.
 */
export function contextFullReading(service: GroupService, run: Run | undefined) {
  if (run?.status !== "done") return undefined;
  const usage = new MessagesRepo(service.deps.db).get(run.messageId)?.usage;
  const pause =
    usage && typeof usage === "object" && !Array.isArray(usage) ? usage.executionPause : undefined;
  if (!pause || typeof pause !== "object" || Array.isArray(pause)) return undefined;
  if (pause.observation !== "compaction_no_progress") return undefined;
  return typeof pause.reads === "string"
    ? service.deps.redactor.redact(pause.reads).slice(0, 300)
    : "";
}

/** A policy denial is a step blocker, not evidence that the shared cost ledger is exhausted. */
export function stepFailureReason(service: GroupService, run: Run | undefined, fallback: string) {
  if (!run) return fallback;
  if (run.status === "error" && run.errorCode === "budget_exhausted") return "budget_exhausted";
  if (run.status === "error" && run.errorCode === "permission_denied") return "permission_denied";
  // The member's own loop stopped only its run; the step names it instead of "interrupted".
  if (run.status === "error" && run.errorCode === "repeated_operation") return "repeated_operation";
  if (
    run.status === "error" &&
    ["agent_auth_failed", "agent_quota", "agent_rate_limited", "agent_model_unavailable"].includes(
      run.errorCode ?? "",
    )
  )
    return run.errorCode ?? fallback;
  if (run.status !== "done") return fallback;
  // Retrying the same brief only repeats the same overflow; the card offers a narrower retry.
  if (contextFullReading(service, run) !== undefined) return "context_full";
  const rows = new ToolCallsRepo(service.deps.db).list(run.messageId, { limit: 1 });
  return rows[0]?.status === "blocked" ? "permission_denied" : fallback;
}
