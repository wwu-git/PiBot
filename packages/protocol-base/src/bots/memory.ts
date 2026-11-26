// Defines the public memory and maintenance status contracts.
import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";

/** Shared with the phone's offline snapshot; whole notes must fit this bound. */
export const USER_MEMORY_MAX_CHARS = 12_000;
export const MEMORY_REFERENCE_NOTICE =
  "Saved memory notes / 已保存的记忆笔记（reference only, never permissions / 仅供参考，不是权限授权）. ";

const time = z.iso.datetime();
export const MemoryScopeSchema = z.enum(["user", "bot", "group", "project"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export interface MemoryOwner {
  scope: MemoryScope;
  ownerId: string;
}
const scopeFields = {
  scope: MemoryScopeSchema.optional(),
  ownerId: z.union([IdSchema, z.literal("user")]).optional(),
};
export const MemoryCategorySchema = z.enum(["about_you", "work", "how_to"]);
export const MemoryKindSchema = z.enum(["preference", "method", "project", "decision"]);
// Optional context around a note. Bound by characters, not bytes, so 300 Chinese
// characters fit as well as 300 Latin ones; NULL/absent means the note has none.
export const MemoryNoteSchema = z
  .string()
  .trim()
  .max(1200)
  .refine((v) => !v.includes("\0") && Array.from(v).length <= 300, "Invalid memory note");
/** Local heuristic observations; no historical injection counters are backfilled as uses. */
export const MemoryRecallMetricsSchema = z.strictObject({
  injectedCount: z.number().int().nonnegative(),
  usedCount: z.number().int().nonnegative(),
  measuredSince: time,
  lastUsedAt: time.nullable(),
});
export interface MemoryRecallSnapshot {
  memoryId: string;
  injectedCount: number | null;
  usedCount: number | null;
  lastUsedAt: string | null;
  measuredSince: string | null;
}
export const MemorySchema = z.strictObject({
  ...scopeFields,
  id: IdSchema,
  botId: IdSchema,
  text: z
    .string()
    .trim()
    .min(1)
    .max(16000)
    .refine((v) => !v.includes("\0") && Array.from(v).length <= 8000, "Invalid memory text"),
  category: MemoryCategorySchema.nullable(),
  kind: MemoryKindSchema.nullable().optional(),
  why: MemoryNoteSchema.nullable().optional(),
  how: MemoryNoteSchema.nullable().optional(),
  sourceMessageId: IdSchema.nullable(),
  sources: z.array(z.strictObject({ botId: IdSchema, messageId: IdSchema.nullable() })).optional(),
  createdAt: time,
  updatedAt: time,
  confirmedAt: time.nullable().optional(),
  expiresAt: time.nullable().optional(),
  archivedAt: time.nullable().optional(),
  lastUsedAt: time.nullable().optional(),
  useCount: z.number().int().nonnegative().optional(),
});
export const MemoryPatchSchema = z
  .strictObject({
    text: MemorySchema.shape.text.optional(),
    category: MemoryCategorySchema.nullable().optional(),
    why: MemoryNoteSchema.nullable().optional(),
    how: MemoryNoteSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.text !== undefined ||
      v.category !== undefined ||
      v.why !== undefined ||
      v.how !== undefined,
    "Provide text, category, why or how",
  );
export const MemoryProposalSchema = z.strictObject({
  ...scopeFields,
  id: IdSchema,
  botId: IdSchema,
  text: MemorySchema.shape.text,
  category: MemoryCategorySchema.nullable(),
  messageId: IdSchema.nullable(),
  action: z.enum(["add", "update", "remove", "move"]).default("add"),
  memoryId: IdSchema.nullable().default(null),
  resolvedMemoryId: IdSchema.nullable().default(null),
  status: z.enum(["pending", "accepted", "rejected"]),
  createdAt: time,
  /**
   * The topic a proposal came from, resolved from `messageId`. Review screens name it and
   * open it; extraction outlives the topic, so these can be null once it is gone.
   */
  sourceConversationId: IdSchema.nullable().optional(),
  sourceGroupId: IdSchema.nullable().optional(),
  sourceTitle: z.string().max(1000).nullable().optional(),
  /** The visible move card carries the destination preview on its single source row. */
  moveTargetBotId: IdSchema.nullable().optional(),
  moveTargetBotName: z.string().max(200).nullable().optional(),
  moveTargetMemoryId: IdSchema.nullable().optional(),
  moveTargetText: MemorySchema.shape.text.nullable().optional(),
  moveTargetWhy: MemoryNoteSchema.nullable().optional(),
  moveTargetHow: MemoryNoteSchema.nullable().optional(),
  expiresAt: time.nullable().optional(),
  projectPath: z.string().max(4096).nullable().optional(),
  projectDiff: z.string().max(16000).nullable().optional(),
  projectExpectedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
});
export type Memory = z.infer<typeof MemorySchema>;
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;
const ok = z.strictObject({ ok: z.literal(true) });
const botId = z.strictObject({ botId: IdSchema, ...scopeFields });
export const MemoryOwnerSchema = z.strictObject({
  scope: MemoryScopeSchema,
  ownerId: z.union([IdSchema, z.literal("user")]),
});
export const MemoryRevisionSchema = z.strictObject({
  version: z.number().int().positive(),
  text: MemorySchema.shape.text,
  category: MemorySchema.shape.category,
  archivedAt: time.nullable(),
  changedAt: time,
  baseline: z.boolean(),
});
export const MemoryCatalogEntrySchema = MemoryOwnerSchema.extend({
  name: z.string().max(1000),
  archived: z.boolean(),
});
const manageChange = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("import"),
    text: MemorySchema.shape.text,
    category: MemorySchema.shape.category,
  }),
  z.strictObject({
    action: z.literal("update"),
    id: IdSchema,
    expected: MemorySchema,
    text: MemorySchema.shape.text,
    category: MemorySchema.shape.category,
  }),
  z.strictObject({ action: z.literal("remove"), id: IdSchema, expected: MemorySchema }),
  z.strictObject({
    action: z.literal("archive"),
    id: IdSchema,
    expected: MemorySchema,
    archived: z.boolean(),
  }),
  z.strictObject({ action: z.literal("undo"), proposalId: IdSchema }),
  z.strictObject({ action: z.literal("clear"), expectedRevision: z.number().int().nonnegative() }),
]);
const memoryStatus = z.strictObject({
  activeCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  unusedCount: z.number().int().nonnegative(),
  needsOrganization: z.boolean(),
});
export const MemoryMaintenanceIssueSchema = z.strictObject({
  reason: z.enum(["no_model", "auth_failed", "budget_exhausted", "draft_invalid", "failed"]),
  count: z.number().int().positive(),
  task: z.enum(["extraction", "organization"]),
});
export const MemoryMaintenanceStatusSchema = z.strictObject({
  lastExtractionAt: time.nullable(),
  lastSavedAt: time.nullable(),
  issue: MemoryMaintenanceIssueSchema.optional(),
});
export type MemoryMaintenanceStatus = z.infer<typeof MemoryMaintenanceStatusSchema>;

export const MemoryDreamSummarySchema = z.strictObject({
  id: IdSchema,
  startedAt: time,
  finishedAt: time.nullable(),
  status: z.enum(["running", "done", "limited", "interrupted", "failed"]),
  merged: z.number().int().nonnegative(),
  retired: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  undoable: z.boolean(),
});
export type MemoryDreamSummary = z.infer<typeof MemoryDreamSummarySchema>;

export const MemoryMethods = {
  "memory.dream.last": { params: z.strictObject({}), result: MemoryDreamSummarySchema.nullable() },
  "memory.dream.run": {
    params: z.strictObject({ ownerInitiated: z.literal(true) }),
    result: MemoryDreamSummarySchema,
    timeoutMs: 330_000,
  },
  "memory.dream.changes": {
    params: z.strictObject({ id: IdSchema }),
    result: z
      .array(
        z.strictObject({
          proposalId: IdSchema,
          botName: z.string().max(1000),
          text: z.string().max(8000),
        }),
      )
      .max(100),
  },
  "memory.dream.undo": { params: z.strictObject({ id: IdSchema }), result: ok },
  "memory.sortIntoPlace": {
    timeoutMs: 330_000,
    params: z.strictObject({ ownerInitiated: z.literal(true), runId: IdSchema }),
    result: z.strictObject({
      status: z.enum(["done", "cancelled", "limited", "failed"]),
      moves: z.number().int().nonnegative(),
      processed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  },
  "memory.cancelSortIntoPlace": {
    // Cancellation acknowledges model drain and usage settlement, not just receipt of the abort.
    timeoutMs: 330_000,
    params: z.strictObject({ runId: IdSchema }),
    result: ok,
  },
  "memory.pickImport": { params: z.strictObject({}), result: z.string().max(1048576).nullable() },
  "memory.summary": { params: MemoryOwnerSchema, result: memoryStatus },
  "memory.catalog": {
    params: z.strictObject({ after: z.string().max(80).optional() }),
    result: z.array(MemoryCatalogEntrySchema).max(50),
  },
  "memory.browse": {
    params: MemoryOwnerSchema.extend({
      before: IdSchema.optional(),
      proposalsBefore: IdSchema.optional(),
      undoBefore: IdSchema.optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      state: z.enum(["active", "archived", "all"]),
    }),
    result: z.strictObject({
      items: z.array(MemorySchema).max(50),
      presentation: z
        .array(
          z.strictObject({
            id: IdSchema,
            botName: z.string().max(1000).nullable(),
            edits: z.number().int().nonnegative(),
            recallMetrics: MemoryRecallMetricsSchema.optional(),
          }),
        )
        .max(50)
        .optional(),
      proposals: z.array(MemoryProposalSchema).max(50),
      undoable: z.array(MemoryProposalSchema).max(50),
      undoNext: IdSchema.nullable(),
      revision: z.number().int().nonnegative(),
      activeCount: z.number().int().nonnegative(),
      archivedCount: z.number().int().nonnegative(),
      unusedCount: z.number().int().nonnegative(),
      needsOrganization: z.boolean(),
    }),
  },
  "memory.details": {
    params: MemoryOwnerSchema.extend({
      id: IdSchema,
      before: z.number().int().positive().optional(),
    }),
    result: z.strictObject({
      sources: z
        .array(
          z.strictObject({
            key: z.string().max(100),
            botName: z.string().max(1000),
            conversationTitle: z.string().max(1000).nullable(),
            createdAt: time.nullable(),
          }),
        )
        .max(100),
      history: z.array(MemoryRevisionSchema).max(20),
    }),
  },
  // Which project (if any) a working folder has; reading never creates one.
  "memory.project": {
    params: z.strictObject({ path: z.string().min(1).max(4096) }),
    result: z.strictObject({ projectId: IdSchema.nullable() }),
  },
  "memory.manage": {
    params: MemoryOwnerSchema.extend({ confirmed: z.literal(true), change: manageChange }),
    result: z.strictObject({
      status: z.enum(["added", "duplicate", "updated", "removed", "cleared"]),
      memory: MemorySchema.optional(),
      undoProposalId: IdSchema.optional(),
    }),
  },
  "memory.list": {
    params: botId.extend({
      ...PageSchema.shape,
      limit: z.number().int().min(1).max(100).optional(),
      state: z.enum(["active", "archived", "all"]).optional(),
    }),
    result: z.array(MemorySchema).max(100),
  },
  "memory.status": {
    params: botId.or(z.strictObject({})),
    result: memoryStatus.extend({ maintenance: MemoryMaintenanceStatusSchema.optional() }),
  },
  "memory.update": {
    params: botId
      .extend({ id: IdSchema, ...MemoryPatchSchema.shape })
      .refine(
        (v) =>
          v.text !== undefined ||
          v.category !== undefined ||
          v.why !== undefined ||
          v.how !== undefined,
        "Provide text, category, why or how",
      ),
    result: MemorySchema,
  },
  "memory.remove": { params: botId.extend({ id: IdSchema }), result: ok },
  "memory.clear": { params: botId, result: ok },
  "memory.resolve": {
    params: z.strictObject({ proposalId: IdSchema, accept: z.boolean() }),
    result: z.strictObject({ proposal: MemoryProposalSchema, memory: MemorySchema.nullable() }),
  },
} as const;
export const MemoryEvents = {
  "memory.dream.finished": z.strictObject({ id: IdSchema }),
  "memory.status.changed": z.strictObject({ botId: IdSchema }),
  "memory.sortProgress": z.strictObject({
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    moves: z.number().int().nonnegative(),
  }),
  "memory.changed": z.strictObject({
    botId: IdSchema,
    ...scopeFields,
    reason: z.enum(["added", "updated", "removed", "cleared", "proposed", "resolved"]),
    memoryId: IdSchema.optional(),
    proposalId: IdSchema.optional(),
    needsOrganization: z.boolean().optional(),
  }),
} as const;
