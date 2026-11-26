import { type Message, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { ChatTarget } from "../../transport/link-port.ts";
import type { Caller } from "./controls/scope.ts";

/** One page of the thread (fits a phone frame) and the small tail read that usually suffices. */
export const HISTORY_PAGE = 50;
export const HISTORY_TAIL = 10;

export interface HistoryDelta {
  /** The phone's copy with what changed applied, oldest first. */
  messages: Message[];
  /** False only when the computer has nothing older than what came back. */
  hasMore: boolean;
  /** Only the tail was read; `hasMore` then keeps what the caller knew. */
  tail: boolean;
}
/**
 * Proposal 4: what changed in a topic since the phone's copy, with the cursors every desktop
 * already has. The newest few messages are read first; when the oldest of them is in the copy,
 * everything older is unchanged (new and streaming messages are the newest), so the copy up to
 * that message plus the tail is the current thread. Otherwise the gap is larger than the tail
 * and the latest page replaces the copy, as a full read did before.
 */
export async function readHistoryDelta(
  c: Caller,
  target: ChatTarget,
  local: readonly Message[],
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<HistoryDelta> {
  const read = async (limit: number) => {
    try {
      return await c.call("chat.history", { ...target, limit }, signal, timeoutMs);
    } catch (error) {
      signal.throwIfAborted();
      // An authoritative missing DM topic must replace the phone's cached history.
      if (
        target.botId &&
        target.topicId &&
        error instanceof RpcError &&
        error.code === RpcErrorCodes.invalidParams &&
        error.message === "Unknown topic"
      )
        return [];
      throw error;
    }
  };
  if (local.length) {
    const tail = await read(HISTORY_TAIL);
    signal.throwIfAborted();
    // The whole topic fit in the tail: it is the thread.
    if (tail.length < HISTORY_TAIL) return { messages: tail, hasMore: false, tail: false };
    const first = tail[0] as Message;
    const at = local.findIndex((message) => message.id === first.id);
    if (at >= 0) return { messages: [...local.slice(0, at), ...tail], hasMore: true, tail: true };
  }
  const page = await read(HISTORY_PAGE);
  signal.throwIfAborted();
  return { messages: page, hasMore: page.length === HISTORY_PAGE, tail: false };
}
