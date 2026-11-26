import { z } from "zod";
import { AgentErrorCodeSchema } from "../core/errors.ts";
import { IdSchema } from "../core/ids.ts";
import { GroupTaskHandoffSchema } from "./handoff.ts";

export const GroupRunnerFolderSchema = z
  .strictObject({
    location: z
      .string()
      .regex(/^runner:[a-f0-9]{64}$/)
      .optional(),
    path: z.string().min(1).max(32768).optional(),
  })
  .refine((value) => !!value.location === !!value.path, "Runner folder requires location and path");

const label = z.string().trim().min(1).max(200);
const time = z.iso.datetime();
export const GroupQuickStartsSchema = z.array(z.string().trim().min(1).max(300)).min(1).max(6);
export const GroupWorkplaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("coordinator") }),
  z.strictObject({
    kind: z.literal("folder"),
    botId: IdSchema,
    folderId: z.union([z.literal("home"), IdSchema]),
  }),
]);
export const GroupMemberSchema = z.strictObject({
  botId: IdSchema,
  position: z.number().int().min(0).max(5),
  joinedAt: time,
});
export const GroupFolderSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(32768),
  path: z.string().min(1).max(32768),
  location: z
    .string()
    .regex(/^runner:[a-f0-9]{64}$/)
    .optional(),
  displayPath: z.string().min(1).max(32768),
  role: z.enum(["primary", "readonly"]).optional(),
});
export const GroupMemberWorkspaceSchema = z.strictObject({
  taskId: IdSchema,
  sourceConversationId: IdSchema,
  botId: IdSchema,
  path: z.string(),
  branch: z.string(),
  state: z.enum([
    "preparing",
    "working",
    "awaiting_integration",
    "integrating",
    "integrated",
    "conflict",
    "interrupted",
    "removed",
  ]),
  errorCode: z.string().nullable(),
});
export const GroupSchema = z.strictObject({
  id: IdSchema,
  name: label,
  archivedAt: time.nullable().optional(),
  coordinatorBotId: IdSchema,
  announcement: z.string().max(8000),
  autoRoundLimit: z.number().int().min(1).max(10),
  externalAgentStepContext: z.boolean().default(true),
  paused: z.boolean(),
  workplace: GroupWorkplaceSchema,
  folders: z.array(GroupFolderSchema).max(32).optional(),
  primaryFolderId: IdSchema.nullable().optional(),
  workspaceRevision: z.number().int().nonnegative().safe().optional(),
  memberWorkspaces: z.array(GroupMemberWorkspaceSchema).max(50).optional(),
  members: z.array(GroupMemberSchema).min(2).max(6),
  conversationId: IdSchema,
  topicTitle: z.string().optional(),
  topicArchivedAt: time.nullable().optional(),
  createdAt: time,
  updatedAt: time,
});
export const GroupPatchSchema = GroupSchema.pick({
  name: true,
  coordinatorBotId: true,
  announcement: true,
  autoRoundLimit: true,
  externalAgentStepContext: true,
  paused: true,
  workplace: true,
})
  .partial()
  // A patch carries only what the caller set. The group schema's default (true) survived
  // .partial(), so every update — the phone's pause, a rename — also sent
  // externalAgentStepContext: true, turning the setting back on and making a pause look like a
  // full update (2026-11-20).
  .extend({ externalAgentStepContext: z.boolean().optional() });
export const GroupTaskSchema = z.strictObject({
  executionMode: z.enum(["serial", "parallel"]).optional(),
  id: IdSchema,
  groupId: IdSchema,
  threadConversationId: IdSchema,
  assigneeBotId: IdSchema,
  title: label,
  instructions: z.string().min(1).max(16000),
  status: z.enum(["open", "done", "cancelled"]),
  summary: z.string().max(16000).nullable(),
  createdByBotId: IdSchema,
  createdAt: time,
  finishedAt: time.nullable(),
  /** Set when a plain chat reply closed the task; the task panel lists only real work. */
  quietAt: time.nullable().optional(),
  activity: z
    .strictObject({
      state: z.enum(["open", "running", "waiting", "paused", "error"]),
      waitingForBotId: IdSchema.optional(),
      waitingForUser: z.boolean().optional(),
      waitingForChildren: z.boolean().optional(),
      waitingForTasks: z.boolean().optional(),
      failure: z.strictObject({ runId: IdSchema, code: AgentErrorCodeSchema }).optional(),
      /**
       * The latest run stopped because what it read no longer fit its context: `reading` names
       * the redacted files, and a blocked plan step is named so the task can offer its retry.
       */
      stop: z
        .strictObject({
          code: z.literal("context_full"),
          reading: z.string().max(300).optional(),
          workflowRunId: IdSchema.optional(),
          stepId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,40}$/)
            .optional(),
        })
        .optional(),
    })
    .optional(),
  source: z
    .strictObject({
      kind: z.enum(["user", "coordinator", "unknown"]),
      messageId: IdSchema.nullable(),
      conversationId: IdSchema.nullable(),
      batchMessageId: IdSchema.nullable(),
      parentTaskId: IdSchema.nullable().optional(),
      createdAt: time.nullable(),
      available: z.boolean(),
    })
    .optional(),
  /** Expected output, completion condition and the program's check of a hand-off. */
  handoff: GroupTaskHandoffSchema.optional(),
});
export type Group = z.infer<typeof GroupSchema>;
export type GroupTask = z.infer<typeof GroupTaskSchema>;
