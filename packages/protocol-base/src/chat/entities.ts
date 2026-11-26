// Defines persisted chat messages and their compatible usage fields.
import { z } from "zod";
import { AbsolutePathSchema, CanonicalTimeSchema } from "../core/boundaries.ts";
import { AgentErrorCodeSchema } from "../core/errors.ts";
import { IdSchema } from "../core/ids.ts";
import {
  CalendarTriggerMessageSchema,
  ConnectionTriggerMessageSchema,
  GithubTriggerMessageSchema,
} from "../core/routine-triggers.ts";
import { ToolCallRecordSchema } from "../execution/tool-calls.ts";
import { AttachmentSchema, MAX_REPLY_ATTACHMENTS } from "./attachments.ts";

export const MemoryNotedSchema = z
  .array(z.strictObject({ id: IdSchema, text: z.string().min(1).max(500) }))
  .max(5);

export function memoryNoted(usage: Message["usage"]) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  return MemoryNotedSchema.safeParse(usage.memoryNoted).data;
}

/** A file-delivery page keeps the original reply as the run's semantic/receipt owner. */
export function attachmentContinuationOf(message: Message): string | undefined {
  if (
    message.role !== "assistant" ||
    message.status !== "done" ||
    message.content !== "" ||
    !message.runId ||
    !message.usage ||
    typeof message.usage !== "object" ||
    Array.isArray(message.usage)
  )
    return undefined;
  const parsed = IdSchema.safeParse(message.usage.attachmentContinuationOf);
  return parsed.success && parsed.data !== message.id ? parsed.data : undefined;
}

export const MessageSchema = z.strictObject({
  botId: IdSchema.nullable().optional(),
  routineTrigger: z
    .strictObject({
      routineRunId: IdSchema,
      reason: z.enum([
        "cron",
        "folder",
        "once",
        "github",
        "connection",
        "calendar",
        "manual",
        "trial",
        "catchup",
      ]),
      github: GithubTriggerMessageSchema.optional(),
      connection: ConnectionTriggerMessageSchema.optional(),
      calendar: CalendarTriggerMessageSchema.optional(),
      scheduledFor: CanonicalTimeSchema,
      paths: z.array(AbsolutePathSchema).max(50),
      extraCount: z.number().int().nonnegative().safe(),
    })
    .optional(),
  taskResult: z.strictObject({ taskId: IdSchema, threadId: IdSchema }).optional(),
  mentions: z.array(IdSchema).max(6).optional(),
  id: IdSchema,
  conversationId: IdSchema,
  role: z.enum(["user", "assistant", "error"]),
  content: z.string(),
  status: z.enum(["streaming", "done", "error", "aborted"]),
  runId: IdSchema.nullable(),
  errorCode: AgentErrorCodeSchema.nullable(),
  usage: z.json().nullable(),
  attachments: z.array(AttachmentSchema).max(MAX_REPLY_ATTACHMENTS).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  tools: z.array(ToolCallRecordSchema).optional(),
});
export const ConversationSchema = z.strictObject({
  readOnly: z.literal(true).optional(),
  importSource: z.string().min(1).max(32).optional(),
  workplaceFolderId: z
    .union([z.literal("home"), IdSchema])
    .nullable()
    .optional(),
  workplaceRevision: z.number().int().nonnegative().safe().optional(),
  id: IdSchema,
  kind: z.enum(["dm", "group", "thread"]),
  botId: IdSchema.nullable(),
  groupId: IdSchema.nullable().optional(),
  threadOf: IdSchema.nullable().optional(),
  routineId: IdSchema.nullable().optional(),
  title: z.string().max(200).optional(),
  archivedAt: z.iso.datetime().nullable().optional(),
  piSessionFile: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
export type Message = z.infer<typeof MessageSchema>;
