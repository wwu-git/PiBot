// Imports Gemini My Activity turns from the one documented Takeout data location.
import { z } from "zod";
import {
  type ImportAdapter,
  ImportFailure,
  type ImportInput,
  type ImportRecord,
  previewMessage,
} from "../adapter.ts";
import { LONG_MESSAGE_CHARS } from "../limits.ts";
import { jsonArray } from "./json-array.ts";
import { zipMember } from "./zip-member.ts";

const ENTRY = "Takeout/My Activity/Gemini Apps/MyActivity.json";
const geminiNames = new Set([
  "gemini",
  "gemini apps",
  "gemini apps activity",
  "gemini 应用",
  "gemini应用",
  "gemini 应用活动",
  "bard",
]);
const text = z.string().trim().min(1);
const reply = z.union([text, z.object({ html: text })]);
const htmlItems = z.array(z.object({ html: z.string().optional() }));
const activity = z.object({
  header: z.string().optional(),
  products: z.array(z.string()).optional(),
  title: z.unknown().optional(),
  prompt: z.unknown().optional(),
  response: z.unknown().optional(),
  time: z.iso.datetime({ offset: true }),
  safeHtmlItem: z.unknown().optional(),
});

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function entity(match: string, token: string) {
  if (!token.startsWith("#"))
    return Object.hasOwn(entities, token) ? (entities[token] ?? match) : match;
  const hex = token[1]?.toLowerCase() === "x";
  const point = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return match;
  return String.fromCodePoint(point);
}

function answerText(html: string) {
  // Retain visible text only. Never interpret HTML or preserve active URLs or attributes.
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?(?:br|p|div|li|h[1-6]|pre|tr)\b[^>]*>/gi, "\n")
    .replace(/<(?:[^<>"']|"[^"]*"|'[^']*')*>/g, "")
    .replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, entity)
    .trim();
}

function isGeminiName(value: string) {
  return geminiNames.has(value.trim().toLowerCase());
}

function replyText(structured: unknown) {
  const parsed = reply.safeParse(structured);
  if (!parsed.success) return "";
  return answerText(typeof parsed.data === "string" ? parsed.data : parsed.data.html);
}

function classify(raw: unknown) {
  const parsed = activity.safeParse(raw);
  if (!parsed.success) return;
  const { header, products, title, time, prompt, response, safeHtmlItem } = parsed.data;
  if (!isGeminiName(header ?? "") && !products?.some(isGeminiName)) return;
  // Activity records may store the prompt exclusively in the localized display title.
  const userText = text.safeParse(prompt).data ?? text.safeParse(title).data;
  const html = htmlItems.safeParse(safeHtmlItem).data;
  const answer =
    replyText(response) ||
    html
      ?.map(({ html }) => answerText(html ?? ""))
      .filter(Boolean)
      .join("\n");
  if (!userText || !answer) return;
  if (userText.length > LONG_MESSAGE_CHARS || answer.length > LONG_MESSAGE_CHARS)
    throw new ImportFailure("limit");
  return { userText, answer, createdAt: new Date(time).toISOString() };
}

async function* activityRecords(
  input: ImportInput,
  signal: AbortSignal,
): AsyncIterable<ImportRecord | { kind: "skipped" }> {
  if (!input.file) throw new ImportFailure("unsupported");
  for await (const file of input.file(signal)) {
    for await (const item of jsonArray(zipMember(file, ENTRY, signal), signal)) {
      const turn = classify(item);
      if (!turn) {
        yield { kind: "skipped" };
        continue;
      }
      const { userText, answer, createdAt } = turn;
      // My Activity does not guarantee thread identity. Only the two sides of this turn are paired.
      yield { kind: "topic", title: "Gemini", createdAt, updatedAt: createdAt };
      yield { kind: "message", role: "user", text: userText, createdAt };
      yield { kind: "message", role: "assistant", text: answer, createdAt };
    }
  }
}

export const geminiAdapter: ImportAdapter = {
  async *detect(signal) {
    signal.throwIfAborted();
    yield true;
  },
  async *preview(input, signal) {
    for await (const record of activityRecords(input, signal)) {
      if (record.kind === "topic")
        yield { kind: "topic", createdAt: record.createdAt, updatedAt: record.updatedAt };
      else if (record.kind === "message") yield previewMessage(record);
      else yield record;
    }
  },
  async *read(input, signal) {
    for await (const record of activityRecords(input, signal))
      if (record.kind !== "skipped") yield record;
  },
};
