// Select the active ChatGPT branch without including tool messages or hidden scaffolding.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { z } from "zod";
import { ImportFailure } from "../adapter.ts";
import { type ConversationItem, readableText } from "./text.ts";

const stamp = z.number().finite().min(0).max(253_402_300_799);
const nullableStamp = stamp.nullish();
const record = z.object({
  title: z.string().nullish(),
  create_time: stamp,
  update_time: nullableStamp,
  current_node: z.string().min(1),
  mapping: z.custom<Record<string, unknown>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  version: z.undefined().optional(),
  // Project chats carry their project's "g-p-" gizmo; custom GPTs ("g-") are not projects.
  gizmo_id: z.string().nullish(),
});
const node = z.object({
  parent: z.string().nullable(),
  message: z.unknown(),
});
const message = z.object({
  author: z.object({ role: z.string() }),
  recipient: z.string().nullish(),
  create_time: nullableStamp,
  content: z
    .object({
      content_type: z.string().optional(),
      parts: z.array(z.unknown()).optional(),
    })
    .nullish(),
  metadata: z
    .object({
      is_visually_hidden_from_conversation: z.boolean().optional(),
      attachments: z.array(z.unknown()).optional(),
      user_context_message_data: z
        .object({
          about_user: z.string().optional(),
          about_model: z.string().optional(),
        })
        .optional(),
    })
    .nullish(),
});
const image = z.object({
  content_type: z.enum([
    "image_asset_pointer",
    "audio_asset_pointer",
    "video_asset_pointer",
    "file_asset_pointer",
  ]),
});

function iso(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}

async function branch(mapping: Record<string, unknown>, current: string, signal: AbortSignal) {
  const seen = new Set<string>();
  const path: unknown[] = [];
  let id: string | null = current;
  while (id !== null) {
    signal.throwIfAborted();
    if (seen.has(id) || !Object.hasOwn(mapping, id)) throw new ImportFailure("format");
    if (seen.size >= 50_000) throw new ImportFailure("limit");
    if (seen.size % 256 === 255) await yieldToLoop(undefined, { signal });
    seen.add(id);
    const item = node.safeParse(mapping[id]);
    if (!item.success) throw new ImportFailure("format");
    if (item.data.message != null) path.push(item.data.message);
    id = item.data.parent;
  }
  return path.reverse();
}

function* messageItems(raw: unknown, createdAt: number): Generator<ConversationItem> {
  const parsed = message.safeParse(raw);
  if (!parsed.success) throw new ImportFailure("format");
  const {
    author: { role },
    content,
    metadata,
    recipient,
    create_time,
  } = parsed.data;
  if (metadata?.is_visually_hidden_from_conversation || role === "system") {
    const context = metadata?.user_context_message_data;
    if (context)
      yield {
        kind: "instructions",
        value: [context.about_user, context.about_model],
      };
    return;
  }
  if (role !== "user" && role !== "assistant") return;
  if (recipient && recipient !== "all") return;
  const parts = content?.parts ?? [];
  const fields = parts.filter((part): part is string => typeof part === "string");
  const media = parts.filter((part) => image.safeParse(part).success).length;
  const attachments = Math.max(media, metadata?.attachments?.length ?? 0);
  if (attachments) yield { kind: "attachments", count: attachments };
  const text = readableText(fields);
  const type = content?.content_type;
  if (!text || (type && type !== "text" && type !== "multimodal_text")) return;
  yield { kind: "message", role, text, createdAt: iso(create_time ?? createdAt) };
}

export async function* chatgptConversation(
  raw: unknown,
  signal: AbortSignal,
): AsyncGenerator<ConversationItem> {
  const parsed = record.safeParse(raw);
  if (!parsed.success) throw new ImportFailure("format");
  const { title, create_time, update_time, mapping, current_node, gizmo_id } = parsed.data;
  const project =
    gizmo_id?.startsWith("g-p-") && gizmo_id.length <= 120
      ? { key: `chatgpt:${gizmo_id}`, name: "" }
      : undefined;
  yield {
    kind: "topic",
    title: (title ?? "").slice(0, 200),
    createdAt: iso(create_time),
    updatedAt: iso(update_time ?? create_time),
    ...(project ? { project } : {}),
  };
  for (const raw of await branch(mapping, current_node, signal)) {
    signal.throwIfAborted();
    yield* messageItems(raw, create_time);
  }
}
