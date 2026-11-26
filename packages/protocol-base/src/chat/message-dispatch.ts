import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

/**
 * A user message the default Pi sent into another Bot's or group's new topic on the person's
 * request. Display only: the chat labels the bubble "from Pi". Set by the brain when it creates the
 * message, never accepted from an RPC, and it grants nothing.
 */
export const MessageDispatchSchema = z.strictObject({
  /** The sending Pi's display name at the time (already redacted). */
  from: z.string().min(1).max(200),
  dispatchId: IdSchema,
});
export type MessageDispatch = z.infer<typeof MessageDispatchSchema>;

export function messageDispatch(message: { usage: unknown }): MessageDispatch | undefined {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const result = MessageDispatchSchema.safeParse((usage as Record<string, unknown>).dispatch);
  return result.success ? result.data : undefined;
}
