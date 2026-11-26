import { attachmentContinuationOf, type Message } from "@pibot/protocol";

export interface ReplyReceiptPosition {
  /** Null suppresses a duplicate footer; a missing owner row can still use its receipt ID. */
  messageId: string | null;
  message?: Message;
}

/** Keep one receipt at the end of delivered files without changing the run's stored owner. */
export function replyReceiptPositions(messages: readonly Message[]) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const continuations = new Map<string, string>();
  for (const message of messages) {
    const parentId = attachmentContinuationOf(message);
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (
      parent &&
      (parent.role !== "assistant" ||
        parent.runId !== message.runId ||
        parent.conversationId !== message.conversationId ||
        parent.botId !== message.botId ||
        attachmentContinuationOf(parent))
    )
      continue;
    continuations.set(message.id, parentId);
  }
  const continued = new Set(continuations.values());
  const result = new Map<string, ReplyReceiptPosition>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.runId) return;
    const next = messages[index + 1];
    const last =
      next?.role !== "assistant" ||
      next.runId !== message.runId ||
      next.conversationId !== message.conversationId;
    const parentId = continuations.get(message.id);
    const messageId = parentId
      ? last
        ? parentId
        : null
      : continued.has(message.id)
        ? null
        : message.id;
    const owner = messageId ? byId.get(messageId) : undefined;
    result.set(message.id, { messageId, ...(owner ? { message: owner } : {}) });
  });
  return result;
}
