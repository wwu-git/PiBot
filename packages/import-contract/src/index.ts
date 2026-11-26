// Desktop clients and the import worker share a content-free preview and progress contract.
import { IdSchema, MemoryCategorySchema, MemorySchema } from "@pibot/protocol-base";
import { z } from "zod";

export const ImportSourceSchema = z.enum([
  "fixture",
  "chatgpt",
  "claude",
  "claude-code",
  "codex",
  "cursor",
  "gemini",
]);
export type ImportSource = z.infer<typeof ImportSourceSchema>;

const count = z.number().int().nonnegative().safe();
const memoryScope = z.enum(["user", "bot", "persona"]);
const memoryChoice = z.strictObject({
  id: IdSchema,
  text: MemorySchema.shape.text,
  category: MemoryCategorySchema,
  outcome: z.enum(["add", "duplicate", "conflict"]),
  existingText: MemorySchema.shape.text.optional(),
});
const memoryReview = z.strictObject({
  reviewId: IdSchema,
  items: z.array(memoryChoice).max(100),
  omitted: count,
  personaBefore: z.string().max(100_000).optional(),
});
export type ImportMemoryReview = z.infer<typeof memoryReview>;
export const ImportCountsSchema = z.strictObject({ topics: count, messages: count });
export type ImportCounts = z.infer<typeof ImportCountsSchema>;

export const ExportDetailsSchema = z.strictObject({
  memories: count,
  customInstructions: count,
  projects: count,
  skippedAttachments: count,
  skippedFiles: count,
});
export type ExportDetails = z.infer<typeof ExportDetailsSchema>;

export const ImportProjectKeySchema = z.string().min(1).max(160);
/** One source project (ChatGPT/Claude project, a local tool's working directory) in the batch. */
export const ImportProjectSchema = ImportCountsSchema.extend({
  key: ImportProjectKeySchema,
  /** Empty when the export carries no name (ChatGPT projects). */
  name: z.string().max(200),
  /** Knowledge pieces: Claude project docs and prompt, a selected CLAUDE.md / AGENTS.md / rule. */
  knowledge: count,
});
export type ImportProject = z.infer<typeof ImportProjectSchema>;

const preview = ImportCountsSchema.extend({
  importId: IdSchema,
  source: ImportSourceSchema,
  from: z.iso.datetime().nullable(),
  through: z.iso.datetime().nullable(),
  projectNotes: count.optional(),
  skippedRecords: count.optional(),
  exportDetails: ExportDetailsSchema.optional(),
  projects: z.array(ImportProjectSchema).max(200).optional(),
  /** Messages over the per-message limit: imported as a preview with the full text attached. */
  longMessages: count.optional(),
});
export type ImportPreview = z.infer<typeof preview>;

/** "user" is 关于你 (every Bot can use it); a Bot id keeps the memory for that Bot only. */
export const ImportMemoryTargetSchema = z.union([z.literal("user"), IdSchema]);
export type ImportMemoryTarget = z.infer<typeof ImportMemoryTargetSchema>;
const planMemory = z.strictObject({
  id: IdSchema,
  text: MemorySchema.shape.text,
  /** Preferences and personal facts default to 关于你, ways of working to the responsible Bot. */
  kind: z.enum(["preference", "method"]),
  project: ImportProjectKeySchema.optional(),
  /** Destinations that already know this memory; any other destination would add it. */
  known: z
    .array(
      z.strictObject({
        target: ImportMemoryTargetSchema,
        outcome: z.enum(["duplicate", "conflict"]),
        existingText: MemorySchema.shape.text.optional(),
      }),
    )
    .max(201),
});
const display = z.string().min(1).max(4096);
/** Where a project's work folder comes from; the brain resolves paths, the UI never sends one. */
export const ImportFolderTargetSchema = z.discriminatedUnion("kind", [
  /** A work folder a Bot already uses, or one just picked with workplaces.pick. */
  z.strictObject({ kind: z.literal("folder"), folderId: IdSchema }),
  /** ~/Documents/<project name>, created by the import when missing. */
  z.strictObject({ kind: z.literal("new") }),
  /** The local tool's own working directory for that project. */
  z.strictObject({ kind: z.literal("source") }),
  /** No work folder: the topics stay in the Bot's own folder and no AGENTS.md is written. */
  z.strictObject({ kind: z.literal("home") }),
]);
export type ImportFolderTarget = z.infer<typeof ImportFolderTargetSchema>;
const plan = z.strictObject({
  reviewId: IdSchema,
  memories: z.array(planMemory).max(100),
  omitted: count,
  /** A short excerpt of the custom instructions; the role comparison shows the full text. */
  instructions: z.string().max(400).optional(),
  folders: z
    .array(z.strictObject({ id: IdSchema, botId: IdSchema, name: z.string().min(1), display }))
    .max(100),
  projects: z
    .array(
      z.strictObject({
        key: ImportProjectKeySchema,
        /** ~/Documents/<name> as the user reads it (home abbreviated, platform separators). */
        newDisplay: display,
        newExists: z.boolean(),
        /** The local tool's working directory no longer exists. */
        sourceMissing: z.literal(true).optional(),
        source: display.optional(),
        /** An existing work folder whose name matches the project. */
        match: IdSchema.optional(),
      }),
    )
    .max(200),
});
export type ImportPlan = z.infer<typeof plan>;

export const ImportStatusSchema = ImportCountsSchema.extend({
  importId: IdSchema,
  source: ImportSourceSchema,
  state: z.enum(["running", "completed", "cancelled", "failed", "undoing", "undone"]),
  cleanup: z.enum(["discarding", "undoing"]).optional(),
  cleanupBlocked: z.literal(true).optional(),
  removed: ImportCountsSchema.optional(),
  memories: count.optional(),
  persona: z.literal(true).optional(),
  /** AGENTS.md files the batch wrote. */
  projectFiles: count.optional(),
  /** Folders the batch created. */
  folders: count.optional(),
  /** Hand-edited AGENTS.md files and no longer empty folders that undo kept. */
  keptProjectFiles: count.optional(),
  keptFolders: count.optional(),
  reason: z
    .enum([
      "source_changed",
      "format",
      "timeout",
      "target",
      "limit",
      "interrupted",
      "internal",
      "memory_conflict",
      "memory_quota",
      "distillation",
      "project",
      "unsupported",
    ])
    .nullable(),
});
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

/** One past batch in the import history; batches from before the history have no date. */
export const ImportHistoryItemSchema = ImportStatusSchema.extend({
  createdAt: z.iso.datetime().nullable(),
});
export type ImportHistoryItem = z.infer<typeof ImportHistoryItemSchema>;

const importId = z.strictObject({ importId: IdSchema });
const source = z.strictObject({ source: ImportSourceSchema });
const distillationQuote = z.strictObject({
  quoteId: IdSchema,
  modelId: z.string().min(1).max(256),
  maxTokens: count,
  costUsd: z.literal(0),
});

export const ImportMethods = {
  "import.detect": { params: source, result: z.strictObject({ available: z.boolean() }) },
  "import.preview": { params: source, result: preview.nullable() },
  /** The role comparison uses scope "persona"; memories are reviewed by import.reviewPlan. */
  "import.reviewMemories": {
    params: importId.extend({ botId: IdSchema, scope: memoryScope }),
    result: memoryReview,
  },
  /** Memories with their known destinations, the instructions excerpt and the folder choices. */
  "import.reviewPlan": { params: importId, result: plan },
  "import.estimateDistillation": {
    params: importId.extend({ botId: IdSchema }),
    result: distillationQuote.nullable(),
  },
  /** The AGENTS.md change one project would make in that folder; nothing is written yet. */
  "import.reviewProject": {
    params: importId.extend({ key: ImportProjectKeySchema, folder: ImportFolderTargetSchema }),
    result: z.strictObject({
      reviewId: IdSchema,
      file: z.literal("AGENTS.md"),
      folder: display,
      /** The file as the user reads it (~/…/AGENTS.md). */
      path: display,
      diff: z.string().max(30_000),
      lines: count,
      /** What the write creates: the file, or the folder and the file. Absent: it appends. */
      create: z.enum(["file", "folder"]).optional(),
    }),
  },
  "import.start": {
    params: importId.extend({
      /** Owner of the chats outside any project, and of the batch record. */
      botId: IdSchema,
      conversations: z.boolean().optional(),
      distillationQuoteId: IdSchema.optional(),
      /** Included source projects; a project left out imports nothing. */
      projects: z
        .array(
          z.strictObject({
            key: ImportProjectKeySchema,
            botId: IdSchema,
            folder: ImportFolderTargetSchema,
            /** Present only after the user confirmed this project's AGENTS.md diff. */
            reviewId: IdSchema.optional(),
          }),
        )
        .max(200)
        .optional(),
      memories: z
        .strictObject({
          reviewId: IdSchema,
          items: z
            .array(z.strictObject({ id: IdSchema, target: ImportMemoryTargetSchema }))
            .max(100),
        })
        .optional(),
      /** The compared role (import.reviewMemories, scope "persona") for that Bot. */
      persona: z.strictObject({ reviewId: IdSchema, botId: IdSchema }).optional(),
    }),
    result: ImportStatusSchema,
  },
  "import.status": { params: importId, result: ImportStatusSchema },
  /** Past batches, newest first; `before` is the `next` cursor of the previous page. */
  "import.history": {
    params: z.strictObject({
      before: count.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    result: z.strictObject({
      items: z.array(ImportHistoryItemSchema).max(50),
      next: count.nullable(),
    }),
  },
  "import.cancel": { params: importId, result: ImportStatusSchema },
  "import.undo": { params: importId, result: ImportStatusSchema },
} as const;

export const ImportEvents = { "import.progress": ImportStatusSchema } as const;
