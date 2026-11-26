import { IdSchema } from "@pibot/protocol-base";
import { z } from "zod";

/**
 * One piece of work the default Pi handed to a Bot or a group, as the receipt card in Pi's chat
 * shows it. Built from the app's own records: the receiver's run status, a short redacted excerpt
 * of its last reply and the names of files it produced; never full replies or file contents.
 */
export const PiDispatchStatusSchema = z.enum(["working", "done", "failed", "stopped", "waiting"]);
export const PiDispatchSchema = z.strictObject({
  id: IdSchema,
  /** Pi's tool call, so the card sits under the step that sent the work. */
  toolCallId: z.string().min(1).max(200),
  messageId: IdSchema,
  targetKind: z.enum(["bot", "group"]),
  targetId: IdSchema,
  targetName: z.string().min(1).max(200),
  /** The receiver's new topic ("open topic"); a group's is its group topic. */
  targetConversationId: IdSchema.nullable(),
  title: z.string().min(1).max(80),
  status: PiDispatchStatusSchema,
  summary: z.string().max(600),
  outputs: z.array(z.string().min(1).max(255)).max(10),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type PiDispatch = z.infer<typeof PiDispatchSchema>;
export type PiDispatchStatus = z.infer<typeof PiDispatchStatusSchema>;

export const PiDispatchMethods = {
  "teams.dispatches": {
    params: z.strictObject({ messageId: IdSchema }),
    result: z.array(PiDispatchSchema).max(20),
  },
} as const;

export const PiDispatchEvents = {
  "teams.dispatch.changed": z.strictObject({ messageId: IdSchema }),
} as const;
