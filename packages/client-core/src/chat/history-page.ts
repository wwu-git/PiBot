// Bound older reads while filling in a reply segment that starts outside the current page.
import { type Message, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { ChatSession } from "./session.ts";

export const HISTORY_PAGE_SIZE = 50;
const MAX_FILL_PAGES = 6;

export function historyPage(
  session: ChatSession,
  route: ReturnType<ChatSession["route"]>,
  signal: AbortSignal,
  before?: string,
) {
  return session.reads.read(
    before ? `history-page:${JSON.stringify([route, before])}` : `history:${JSON.stringify(route)}`,
    (signal) =>
      session.peer.call(
        "chat.history",
        { ...route, ...(before ? { before } : {}), limit: HISTORY_PAGE_SIZE },
        { signal },
      ),
    signal,
  );
}

export async function completeLeadingReplies(
  session: ChatSession,
  route: ReturnType<ChatSession["route"]>,
  page: Message[],
  signal: AbortSignal,
  retainWindow = false,
) {
  const head = page[0];
  const full = page.length === HISTORY_PAGE_SIZE;
  if (!full || head?.role !== "assistant" || !head.runId) return { messages: page, hasMore: full };

  // A refresh that already overlaps the interior of a loaded window can keep its prefix.
  if (retainWindow && session.state.messages.findIndex((message) => message.id === head.id) > 0)
    return { messages: page, hasMore: true };

  const chunks = [page];
  const cursors = new Set<string>();
  let before = head.id;
  for (let index = 0; index < MAX_FILL_PAGES; index++) {
    if (cursors.has(before)) throw new Error("History cursor did not advance");
    cursors.add(before);
    let older: Message[];
    try {
      older = await historyPage(session, route, signal, before);
      signal.throwIfAborted();
    } catch (error) {
      const timeout = signal.aborted
        ? signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        : error instanceof RpcError && error.code === RpcErrorCodes.timeout;
      // The original page is usable even if the optional continuation misses its deadline.
      if (timeout) return { messages: page, hasMore: true };
      throw error;
    }
    if (older.some((message) => message.conversationId !== head.conversationId))
      throw new Error("History target mismatch");
    const boundary = older.findLastIndex(
      (message) => message.role !== "assistant" || message.runId !== head.runId,
    );
    const matching = older.slice(boundary + 1);
    if (matching.length) chunks.push(matching);
    // A different message starts another card, even if the same run resumes later.
    const oldest = older[0];
    if (boundary >= 0 || !oldest || older.length < HISTORY_PAGE_SIZE)
      return { messages: chunks.reverse().flat(), hasMore: boundary >= 0 };
    before = oldest.id;
  }
  // The next explicit page starts at the oldest row we kept.
  return { messages: chunks.reverse().flat(), hasMore: true };
}
