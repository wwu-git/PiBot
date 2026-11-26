// Reassemble persisted assistant bubbles belonging to one headless run.
import {
  attachmentContinuationOf,
  type Events,
  type Message,
  type Methods,
  type Peer,
} from "@pibot/protocol";

export type Receipt = { runId: string; conversationId?: string; assistantMessageId: string };
type Client = Peer<typeof Methods, typeof Events>;

export async function committedReply(
  client: Client,
  botId: string,
  receipt: Receipt,
  bounded: <T>(work: Promise<T>, what: string) => Promise<T>,
) {
  const pages: string[] = [];
  let before: string | undefined;
  let terminal: Message | undefined;
  const limit = 200;
  for (;;) {
    const rows = await bounded(
      client.call("chat.history", {
        botId,
        ...(receipt.conversationId ? { topicId: receipt.conversationId } : {}),
        ...(before && { before }),
        limit,
      }),
      "chat.history",
    );
    const anchor = rows.findIndex((message) => message.id === receipt.assistantMessageId);
    const bubbles = rows
      .slice(Math.max(0, anchor))
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.runId === receipt.runId &&
          !attachmentContinuationOf(message),
      );
    if (!terminal && bubbles.length) {
      terminal = bubbles.at(-1);
      const usage = terminal?.usage;
      if (
        terminal?.status === "streaming" ||
        (usage &&
          typeof usage === "object" &&
          "stopReason" in usage &&
          usage.stopReason === "continued")
      )
        return;
    }
    pages.push(...bubbles.reverse().map((message) => message.content));
    if (anchor >= 0 && terminal)
      return { ...terminal, content: pages.reverse().filter(Boolean).join("\n\n") };
    if (rows.length < limit) return;
    before = rows[0]?.id;
  }
}
