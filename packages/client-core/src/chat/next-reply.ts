import type { TranslationKey } from "@pibot/i18n";
import {
  AGENT_SETUP_ERROR_CODES,
  attachmentContinuationOf,
  type ChatNotice,
  type Message,
} from "@pibot/protocol";
import type { ExecutionTopic } from "../tasks/types.ts";

/** Local state only: suggestions never request a model, grant permission, or execute a tool. */
export function nextReply(
  conversationId: string | undefined,
  messages: readonly Message[],
  topics: readonly ExecutionTopic[],
  notices: readonly ChatNotice[],
) {
  if (!conversationId) return;
  const latest = messages.findLast(
    (message) => message.conversationId === conversationId && !attachmentContinuationOf(message),
  );
  if (!latest || latest.role === "user" || latest.status === "streaming") return;
  if (
    !messages.some(
      (message) => message.conversationId === conversationId && message.role === "user",
    )
  )
    return;
  if (
    notices.some(
      (notice) =>
        notice.conversationId === conversationId &&
        "runId" in notice &&
        "status" in notice &&
        notice.runId === latest.runId &&
        ["pending", "running"].includes(notice.status),
    )
  )
    return;
  // An external agent that never started (sign-in, folder, confirmation): the error says what to do.
  if (latest.errorCode && AGENT_SETUP_ERROR_CODES.has(latest.errorCode)) return;
  const usage = latest.usage;
  const pause =
    usage && typeof usage === "object" && !Array.isArray(usage) ? usage.executionPause : null;
  const reason =
    pause && typeof pause === "object" && !Array.isArray(pause) ? pause.reason : undefined;
  const check = notices.findLast(
    (notice) =>
      notice.conversationId === conversationId &&
      notice.kind === "auto_check" &&
      notice.runId === latest.runId,
  );
  const topic = topics.find((item) => item.botId === latest.botId);
  const lastTool = latest.tools?.findLast(
    (tool) => !["todo_list", "todo_update", "todo_pause"].includes(tool.tool),
  );
  // A deliberate refusal is a completed user decision, not a recoverable tool failure.
  if (
    messages.some(
      (message) =>
        !!latest.runId &&
        message.conversationId === conversationId &&
        message.runId === latest.runId &&
        message.tools?.some(
          (tool) =>
            tool.approval?.status === "denied" &&
            tool.approval.explanation?.some(
              (step) => step.code === "approval_user_denied" && step.effect === "deny",
            ),
        ),
    )
  )
    return;
  let key: TranslationKey;
  if (
    latest.role === "error" ||
    latest.status === "error" ||
    ["blocked", "check_blocked", "no_progress", "round_limit"].includes(String(reason)) ||
    (check?.kind === "auto_check" && ["failed", "timeout", "blocked"].includes(check.status)) ||
    lastTool?.status === "error" ||
    // A done step may exit 1 (grep with no matches); suggesting "investigate" would send
    // the model back to the same search. The step's own status already carries a real failure.
    lastTool?.status === "blocked"
  ) {
    key = "nextReply.investigate";
  } else if (reason === "needs_user" || reason === "awaiting_reply") {
    key = "nextReply.clarify";
  } else if (reason === "review" || reason === "review_summary") {
    key = "nextReply.review";
  } else if (reason === "waiting_tasks") {
    key = "nextReply.children";
  } else if (latest.status === "aborted") {
    key = "nextReply.stopped";
  } else if (reason === "checkpoint") {
    key = "nextReply.nextSteps";
  } else if (/[?？]\s*$/.test(latest.content)) {
    key = "nextReply.clarify";
  } else if (
    topic?.plan?.items.some((item) => item.status !== "done" && item.status !== "cancelled")
  ) {
    key = topic.settings?.mode === "plan" ? "nextReply.plan" : "nextReply.continue";
  } else if (latest.attachments?.some((item) => item.kind === "image")) {
    key = "nextReply.image";
  } else {
    key = "nextReply.nextSteps";
  }
  return { id: `${conversationId}:${latest.id}`, key };
}
