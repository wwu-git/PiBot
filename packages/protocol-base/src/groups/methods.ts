import { AcpGroupMethods } from "./acp.ts";

export type { AcpGroupRunReceipt, AcpGroupSnapshot } from "./acp.ts";
export {
  AcpGroupMethods,
  AcpGroupRunReceiptSchema,
  AcpGroupSnapshotSchema,
  GroupPlanConclusionSchema,
} from "./acp.ts";

import { z } from "zod";
import { MessageSchema } from "../chat/entities.ts";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";
import { GroupCycleSchema } from "../execution/runs.ts";
import {
  ExecutionCheckpointSchema,
  TaskPageSchema,
  TaskSummarySchema,
} from "../execution/tasks.ts";
import { GroupPlanCardSchema } from "./dynamic-plan.ts";
import { GroupFolderSelectionSchema } from "./files.ts";
import {
  GroupPatchSchema,
  GroupRunnerFolderSchema,
  GroupSchema,
  GroupTaskSchema,
  GroupWorkplaceSchema,
} from "./group.ts";
import { GroupTaskBriefSchema } from "./task-brief.ts";

const label = z.string().trim().min(1).max(200);
const ok = z.strictObject({ ok: z.literal(true) });
const _botId = z.strictObject({ botId: IdSchema });
const groupId = z.strictObject({ groupId: IdSchema });
const page = PageSchema;
export const GroupMethods = {
  ...AcpGroupMethods,
  "groups.plan.current": {
    params: groupId,
    result: z.strictObject({ messageId: IdSchema, card: GroupPlanCardSchema }).nullable(),
  },
  "groups.create": {
    params: z.strictObject({
      name: label,
      botIds: z
        .array(IdSchema)
        .min(2)
        .max(6)
        .refine((v) => new Set(v).size === v.length),
      coordinatorBotId: IdSchema.optional(),
      announcement: GroupSchema.shape.announcement.optional(),
      autoRoundLimit: GroupSchema.shape.autoRoundLimit.optional(),
      // Leave omissions intact through the phone gateway. Group creation applies the default.
      externalAgentStepContext: z.boolean().optional(),
      workplace: GroupWorkplaceSchema.optional(),
    }),
    result: GroupSchema,
  },
  "groups.update": { params: GroupPatchSchema.extend({ groupId: IdSchema }), result: GroupSchema },
  "groups.addMember": { params: groupId.extend({ botId: IdSchema }), result: GroupSchema },
  "groups.removeMember": { params: groupId.extend({ botId: IdSchema }), result: GroupSchema },
  "groups.list": {
    params: page.extend({
      query: z.string().trim().max(200).optional(),
      archived: z.boolean().optional(),
    }),
    result: z.array(GroupSchema).max(200),
  },
  "groups.get": { params: groupId, result: GroupSchema },
  "groups.folders.reveal": {
    params: groupId.extend({ folderId: GroupFolderSelectionSchema.optional() }),
    result: ok,
  },
  "groups.folders.used": {
    params: groupId,
    result: z.strictObject({
      folders: z.array(z.strictObject({ id: IdSchema, name: z.string().min(1) })).max(32),
    }),
  },
  "groups.folders.setPrimary": {
    params: z.strictObject({ groupId: IdSchema, folderId: IdSchema.nullable() }),
    result: GroupSchema,
  },
  // `create` opens the system dialog that can make a new folder (same as a DM topic).
  "groups.folders.add": {
    params: GroupRunnerFolderSchema.safeExtend({
      groupId: IdSchema,
      create: z.boolean().optional(),
    }).refine(
      (value) => !(value.location && value.create),
      "Runner folder cannot be created by the local picker",
    ),
    result: GroupSchema,
  },
  "groups.folders.remove": { params: groupId.extend({ folderId: IdSchema }), result: GroupSchema },
  "groups.archive": { params: groupId, result: GroupSchema },
  "groups.restore": { params: groupId, result: GroupSchema },
  "groups.delete": { params: groupId.extend({ confirmed: z.literal(true) }), result: ok },
  "groups.state": { params: groupId, result: GroupCycleSchema },
  "groups.tasks": {
    params: groupId.extend(page.shape).extend({
      status: GroupTaskSchema.shape.status.optional(),
      origin: z.enum(["user", "coordinator"]).optional(),
      section: z.enum(["open", "closed"]).optional(),
    }),
    result: z.array(GroupTaskSchema).max(200),
  },
  "groups.execution.tasks": {
    params: groupId.extend({
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    result: z.strictObject({
      items: z
        .array(
          TaskSummarySchema.extend({
            groupTaskId: IdSchema.nullable(),
            groupTaskTitle: z.string().nullable(),
          }),
        )
        .max(50),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "groups.tasks.history": {
    params: groupId.extend({
      taskId: IdSchema,
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    result: z.strictObject({
      messages: z.array(MessageSchema).max(50),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "groups.tasks.execution": {
    params: groupId.extend({
      taskId: IdSchema,
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    result: TaskPageSchema.extend({
      checkpoint: ExecutionCheckpointSchema.nullable(),
      resultMessageId: IdSchema.nullable(),
    }),
  },
  /**
   * The structured brief of a plan step's task, from stored plan, step and hand-off records (no
   * model call). Null for tasks that are not plan steps (ad-hoc assignments, older tasks).
   */
  "groups.tasks.brief": {
    params: groupId.extend({ taskId: IdSchema }),
    result: GroupTaskBriefSchema.nullable(),
  },
  "groups.tasks.summary": {
    params: groupId.extend({
      origin: z.enum(["user", "coordinator"]).optional(),
      messageIds: z.array(IdSchema).max(200).optional(),
    }),
    result: z.strictObject({
      openCount: z.number().int().nonnegative(),
      closedCount: z.number().int().nonnegative(),
      batches: z
        .array(
          z.strictObject({
            messageId: IdSchema,
            count: z.number().int().nonnegative(),
            done: z.number().int().nonnegative(),
          }),
        )
        .max(200),
      collaborations: z
        .array(
          z.strictObject({
            messageId: IdSchema,
            targetBotId: IdSchema,
            runId: IdSchema,
            threadId: IdSchema.nullable(),
            status: z.enum(["queued", "running", "done", "error", "aborted"]),
          }),
        )
        .max(200),
    }),
  },
  "groups.tasks.resolve": {
    params: groupId.extend({
      taskId: IdSchema,
      status: z.enum(["done", "cancelled"]),
      summary: z.string().trim().min(1).max(16000),
      resultMessageId: IdSchema.optional(),
      confirmed: z.literal(true),
    }),
    result: GroupTaskSchema,
  },
  "groups.workflow.resolve": {
    params: groupId.extend({
      workflowRunId: IdSchema,
      stepId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
      action: z.enum(["retry", "skip", "reassign", "accept"]),
      ownerBotId: IdSchema.optional(),
      confirmed: z.literal(true),
    }),
    result: ok,
  },
} as const;
export const GroupEvents = {
  "groups.changed": z.strictObject({
    groupId: IdSchema,
    reason: z.enum(["created", "updated", "members", "deleted"]),
  }),
  "group.task": z.strictObject({ task: GroupTaskSchema }),
  "group.paused": z.strictObject({
    groupId: IdSchema,
    reason: z.enum(["limit", "user"]),
    rounds: z.number().int().nonnegative(),
    limit: GroupSchema.shape.autoRoundLimit,
  }),
} as const;
