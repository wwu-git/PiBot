// Projects only human-visible text from Claude Code, Codex, and Cursor transcripts.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ImportAdapter,
  ImportFailure,
  type ImportInput,
  type ImportRecord,
  type ProjectRef,
  previewMessage,
} from "../adapter.ts";
import { LONG_MESSAGE_CHARS } from "../limits.ts";
import type { LocalSource } from "./locations.ts";
import { jsonLines, OVERSIZED_LINE } from "./text.ts";

const date = z.iso.datetime({ offset: true });
const role = z.enum(["user", "assistant"]);
const blocks = z.array(z.object({ type: z.string(), text: z.string().optional() })).max(4096);
const envelope = z.object({
  type: z.string().optional(),
  role: z.string().optional(),
  timestamp: z.string().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  message: z.object({ role: z.string().optional(), content: z.unknown() }).optional(),
  payload: z
    .object({
      type: z.string(),
      message: z.string().optional(),
      item: z
        .object({
          type: z.string(),
          content: z.unknown(),
          moderation: z.object({ moderated: z.boolean() }).nullish(),
        })
        .optional(),
    })
    .optional(),
});

type Message = Extract<ImportRecord, { kind: "message" }>;
const LIMIT = LONG_MESSAGE_CHARS;
const names: Record<LocalSource, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

function blockText(raw: unknown, type = "text") {
  if (typeof raw === "string") return raw;
  const content = blocks.safeParse(raw);
  if (!content.success) return "";
  const texts = content.data.filter((block) => block.type === type && block.text);
  return texts.map((block) => block.text).join("\n");
}

type Variant = "plain" | "legacy" | "paginated";

function codexMessage(row: z.output<typeof envelope>) {
  const event = row.payload;
  if (row.type !== "event_msg" || !event) return;
  if (event.type === "user_message" || event.type === "agent_message") {
    return {
      variant: "legacy" as const,
      role: event.type === "user_message" ? "user" : "assistant",
      text: event.message,
    };
  }
  const item = event.item;
  if (event.type !== "item_completed" || !item || item.moderation?.moderated) return;
  if (item.type === "UserMessage" || item.type === "AgentMessage") {
    const user = item.type === "UserMessage";
    return {
      variant: "paginated" as const,
      role: user ? "user" : "assistant",
      text: Array.isArray(item.content)
        ? blockText(item.content, user ? "text" : "Text")
        : undefined,
    };
  }
}

function plainMessage(row: z.output<typeof envelope>, source: LocalSource) {
  const actor = source === "cursor" ? row.role : row.type;
  if (row.message?.role && row.message.role !== actor) return;
  return { variant: "plain" as const, role: actor, text: blockText(row.message?.content) };
}

function message(
  source: LocalSource,
  raw: unknown,
  modifiedAt?: string,
): { variant: Variant; record: Message } | undefined {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return;
  const row = parsed.data;
  if (row.isMeta || row.isSidechain) return;
  const entry = source === "codex" ? codexMessage(row) : plainMessage(row, source);
  if (!entry?.text?.trim()) return;
  const actor = role.safeParse(entry.role);
  if (!actor.success) return;
  const timestamp = date.safeParse(row.timestamp ?? (source === "cursor" ? modifiedAt : undefined));
  if (!timestamp.success) throw new ImportFailure("format");
  if (entry.text.length > LIMIT) throw new ImportFailure("limit");
  return {
    variant: entry.variant,
    record: {
      kind: "message",
      role: actor.data,
      text: entry.text,
      createdAt: new Date(timestamp.data).toISOString(),
    },
  };
}

async function* messages(
  source: LocalSource,
  input: ImportInput,
  signal: AbortSignal,
  onRow?: (raw: unknown) => void,
) {
  for await (const raw of jsonLines(input, signal)) {
    onRow?.(raw);
    const item = message(source, raw, input.modifiedAt);
    if (item) yield item;
  }
}

// Claude Code stamps every row with `cwd`; Codex keeps it in the session_meta / turn_context payload.
const workingDirectory = z.union([
  z.object({ cwd: z.string() }),
  z.object({ payload: z.object({ cwd: z.string() }) }),
]);
const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;

/** The project of a transcript is the folder the tool worked in; the key never carries the path. */
export function localProject(raw: unknown): ProjectRef | undefined {
  const parsed = workingDirectory.safeParse(raw);
  if (!parsed.success) return;
  const path = "cwd" in parsed.data ? parsed.data.cwd : parsed.data.payload.cwd;
  if (!absolute.test(path) || path.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(path)) return;
  const name =
    path
      .split(/[\\/]+/u)
      .filter(Boolean)
      .at(-1) ?? path;
  const key = `local:${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
  return { key, name: name.slice(0, 200), path };
}

type Span = { createdAt: string; updatedAt: string; count: number };

async function* read(
  source: LocalSource,
  input: ImportInput,
  signal: AbortSignal,
  oversized?: () => void,
) {
  const spans = new Map<Variant, Span>();
  let project: ProjectRef | undefined;
  const findProject = (raw: unknown) => {
    // Lines past the line limit (Codex context compaction, huge tool output) are skipped whole.
    if (raw === OVERSIZED_LINE) oversized?.();
    else project ??= localProject(raw);
  };
  for await (const {
    variant,
    record: { createdAt },
  } of messages(source, input, signal, findProject)) {
    const span = spans.get(variant) ?? { createdAt, updatedAt: createdAt, count: 0 };
    if (createdAt < span.createdAt) span.createdAt = createdAt;
    if (createdAt > span.updatedAt) span.updatedAt = createdAt;
    if (++span.count > 500_000) throw new ImportFailure("limit");
    spans.set(variant, span);
  }
  // Paginated Codex files keep structured turn items instead of the legacy UI events.
  const preferred = spans.has("paginated") ? "paginated" : source === "codex" ? "legacy" : "plain";
  const span = spans.get(preferred);
  if (!span) throw new ImportFailure("format");
  yield {
    kind: "topic" as const,
    title: names[source],
    createdAt: span.createdAt,
    updatedAt: span.updatedAt,
    ...(project ? { project } : {}),
  };
  for await (const { variant, record } of messages(source, input, signal)) {
    if (variant === preferred) yield record;
  }
}

export function transcriptAdapter(source: LocalSource): ImportAdapter {
  return {
    async *detect(signal) {
      signal.throwIfAborted();
      yield true;
    },
    async *preview(input, signal) {
      let skipped = 0;
      for await (const record of read(source, input, signal, () => skipped++)) {
        if (record.kind === "topic")
          yield {
            kind: "topic",
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            ...(record.project ? { project: record.project } : {}),
          };
        else yield previewMessage(record);
      }
      for (let index = 0; index < skipped; index++) yield { kind: "skipped" as const };
    },
    read: (input, signal) => read(source, input, signal),
  };
}
