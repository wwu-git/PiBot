// Map Claude's visible human and assistant messages while keeping non-text blocks out of history.
import { z } from "zod";
import { ImportFailure } from "../adapter.ts";
import { type ConversationItem, readableText } from "./text.ts";

const stamp = z.iso.datetime({ offset: true });
const conversation = z.object({
  name: z.string().nullish(),
  created_at: stamp,
  updated_at: stamp.nullish(),
  chat_messages: z.array(z.unknown()),
  version: z.undefined().optional(),
  // Exports that link a chat to its project use either field; neither is required.
  project_uuid: z.string().max(120).nullish(),
  project: z.object({ uuid: z.string().max(120), name: z.string().nullish() }).nullish(),
});

export function claudeProjectKey(uuid: string) {
  return `claude:${uuid}`;
}
const message = z.object({
  sender: z.string(),
  text: z.string().nullish(),
  created_at: stamp.nullish(),
  content: z.array(z.unknown()).nullish(),
  attachments: z.array(z.unknown()).nullish(),
  files: z.array(z.unknown()).nullish(),
});
const block = z.object({ type: z.string(), text: z.string().optional() });

const mediaKinds = new Set(["image", "document", "audio", "video", "file", "attachment"]);

function* messageItems(raw: unknown, date: string): Generator<ConversationItem> {
  const parsed = message.safeParse(raw);
  if (!parsed.success) throw new ImportFailure("format");
  const item = parsed.data;
  if (item.sender !== "human" && item.sender !== "assistant") return;
  const parts: string[] = [];
  let media = 0;
  for (const rawBlock of item.content ?? []) {
    const content = block.safeParse(rawBlock);
    if (!content.success) continue;
    if (content.data.type === "text" && content.data.text) parts.push(content.data.text);
    if (mediaKinds.has(content.data.type)) media++;
  }
  const attachments = Math.max(media, (item.attachments?.length ?? 0) + (item.files?.length ?? 0));
  if (attachments) yield { kind: "attachments", count: attachments };
  const text = readableText(parts) || readableText([item.text ?? ""]);
  if (text)
    yield {
      kind: "message",
      role: item.sender === "human" ? "user" : "assistant",
      text,
      createdAt: item.created_at ?? date,
    };
}

export function* claudeConversation(
  raw: unknown,
  signal: AbortSignal,
): Generator<ConversationItem> {
  const parsed = conversation.safeParse(raw);
  if (!parsed.success) throw new ImportFailure("format");
  const { name, created_at, updated_at, chat_messages, project_uuid, project } = parsed.data;
  const uuid = project?.uuid || project_uuid;
  yield {
    kind: "topic",
    title: (name ?? "").slice(0, 200),
    createdAt: created_at,
    updatedAt: updated_at ?? created_at,
    ...(uuid
      ? { project: { key: claudeProjectKey(uuid), name: (project?.name ?? "").slice(0, 200) } }
      : {}),
  };
  for (const chat of chat_messages) {
    signal.throwIfAborted();
    yield* messageItems(chat, created_at);
  }
}
