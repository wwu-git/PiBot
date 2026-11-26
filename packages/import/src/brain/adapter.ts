// Adapters yield bounded records rather than exposing provider-specific objects to storage.
import {
  ExportDetailsSchema,
  ImportProjectKeySchema,
  type ImportSource,
} from "@pibot/import-contract";
import { z } from "zod";

export { ImportFailure } from "../store/failure.ts";
export { LONG_MESSAGE_CHARS, MESSAGE_CHARS } from "./limits.ts";

import { LONG_MESSAGE_CHARS, MESSAGE_CHARS } from "./limits.ts";
import { geminiAdapter } from "./local/gemini.ts";
import { transcriptAdapter } from "./local/transcript.ts";

const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
/** The source project a topic or note belongs to; `path` is a local tool's working directory. */
export const ProjectRefSchema = z.strictObject({
  key: ImportProjectKeySchema,
  name: z.string().max(200),
  path: z.string().min(1).max(4096).optional(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;
export const ImportTopicSchema = z.strictObject({
  kind: z.literal("topic"),
  title: z.string().max(200),
  createdAt: time,
  updatedAt: time,
  project: ProjectRefSchema.optional(),
});
export const ImportMessageSchema = z.strictObject({
  kind: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(LONG_MESSAGE_CHARS),
  createdAt: time,
});
export const ImportRecordSchema = z.discriminatedUnion("kind", [
  ImportTopicSchema,
  ImportMessageSchema,
]);
export type ImportRecord = z.input<typeof ImportRecordSchema>;

const exportSummary = ExportDetailsSchema.extend({ kind: z.literal("exportSummary") });
export const PreviewRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("topic"),
    createdAt: time,
    updatedAt: time,
    project: ProjectRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("message"),
    createdAt: time,
    /** Over MESSAGE_CHARS: imported as a preview plus a text attachment. */
    long: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal("skipped") }),
  /** A knowledge piece of a source project (its chats may be elsewhere in the export or absent). */
  z.strictObject({
    kind: z.literal("projectKnowledge"),
    project: ProjectRefSchema,
    /** 0 names a project that has no knowledge of its own. */
    pieces: z.union([z.literal(0), z.literal(1)]),
  }),
  exportSummary,
]);
export type PreviewRecord = z.input<typeof PreviewRecordSchema>;

/** The preview record of one message, flagging the ones that need a text attachment. */
export function previewMessage(record: { createdAt: string; text: string }): PreviewRecord {
  return {
    kind: "message",
    createdAt: record.createdAt,
    ...(record.text.length > MESSAGE_CHARS ? { long: true as const } : {}),
  };
}

export interface ImportFile {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface ImportInput {
  (signal: AbortSignal): AsyncIterable<Buffer>;
  modifiedAt?: string;
  projectNote?: true;
  file?(signal: AbortSignal): AsyncIterable<ImportFile>;
}

export interface ImportAdapter {
  detect(signal: AbortSignal): AsyncIterable<boolean>;
  preview(input: ImportInput, signal: AbortSignal): AsyncIterable<PreviewRecord>;
  /** Every topic precedes its messages. Topics and messages from different topics never interleave. */
  read(input: ImportInput, signal: AbortSignal): AsyncIterable<ImportRecord>;
}

export function adapters(
  fixture: ImportAdapter,
  chatgpt: ImportAdapter,
  claude: ImportAdapter,
): Record<ImportSource, ImportAdapter> {
  return {
    fixture,
    chatgpt,
    claude,
    "claude-code": transcriptAdapter("claude-code"),
    codex: transcriptAdapter("codex"),
    cursor: transcriptAdapter("cursor"),
    gemini: geminiAdapter,
  };
}
