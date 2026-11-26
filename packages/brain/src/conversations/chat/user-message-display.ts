import type { MessageDispatch, MessageForward, MessageQuote } from "@pibot/protocol-base";

/**
 * C7: what a trusted routine confirmation tells the display about the message it queues. The text
 * the model receives stays fixed; only the chat presentation is replaced by a system line.
 */
// A type alias (not an interface) keeps the value assignable to the message `usage` JSON record.
export type RoutineNotice = {
  kind: "created" | "updated";
  name?: string;
  /** ISO time of the next scheduled run; absent for folder-driven routines. */
  at?: string;
};

/**
 * FORWARD-DISPLAY: display hints a brain-internal sender attaches to the user message it creates.
 * Never accepted from an RPC: the renderer cannot choose what its own bubble hides.
 */
export interface UserMessageDisplay {
  inputOrigin?: "user" | "acp" | "phone";
  forward?: MessageForward;
  /** The default Pi sent this message on the person's request (display label only). */
  dispatch?: MessageDispatch;
  routineNotice?: RoutineNotice;
}

/** The `usage` fields of a new user message (quote snapshot and display hints), if any. */
export function userMessageUsage(quote: MessageQuote | undefined, display?: UserMessageDisplay) {
  const usage = {
    ...(display?.inputOrigin ? { inputOrigin: display.inputOrigin } : {}),
    ...(quote ? { messageQuote: quote } : {}),
    ...(display?.forward ? { forward: display.forward } : {}),
    ...(display?.dispatch ? { dispatch: display.dispatch } : {}),
    ...(display?.routineNotice ? { systemEvent: true, routineNotice: display.routineNotice } : {}),
  };
  return Object.keys(usage).length ? { usage } : {};
}
