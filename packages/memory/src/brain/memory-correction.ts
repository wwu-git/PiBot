// Anchors urgent extraction to a committed human correction and its completed reply.
import type { DatabaseSync } from "node:sqlite";
import { type MemoryExtraction, MessagesRepo, memoryHumanMessageSql } from "@pibot/storage";
import { type ExtractionSource, extractionSource } from "./memory-extraction.ts";

const cue =
  /^(?:请(?:你)?\s*)?(?:从现在起|从今以后|今后|以后|下次|永远不要|不要|别再|记住|纠正一下|更正一下)\s*[,，:：]?\s*\S|^(?:please\s+)?(?:from now on|going forward|next time|always|never|remember(?: that)?|don't|do not|(?:let me )?correct(?:ion| that))\b\s*[, :]?\s*\S/iu;

export function correctionOffset(text: string) {
  // Keep offsets when removing quoted examples so the bounded window starts at the actual cue.
  const mask = (value: string) => value.replace(/[^\n]/g, " ");
  const plain = text
    .slice(0, 8_000)
    .replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/gu, mask)
    .replace(/^[ \t]*>.*$/gmu, mask)
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, mask);
  for (const match of plain.matchAll(/[^。！？.!?\n]+/gu)) {
    const clause = match[0].trimStart();
    if (cue.test(clause)) return match.index + match[0].length - clause.length;
  }
  return undefined;
}

const omitCode = (text: string) => text.replace(/```[\s\S]*?(?:```|$)/gu, "[code omitted]").trim();

function withinBytes(text: string, maximum: number) {
  if (Buffer.byteLength(text) <= maximum) return text;
  // Decode complete UTF-8 only so truncation cannot expand the input or split a code point.
  return new TextDecoder().decode(Buffer.from(text).subarray(0, maximum), { stream: true });
}

export function correctionSource(
  db: DatabaseSync,
  conversationId: string,
  sourceId: string,
  botId: string,
  groupId: string | null,
): (ExtractionSource & { replyId: string }) | undefined {
  const row = db
    .prepare(
      `SELECT r.id AS runId, r.message_id AS replyId, m.content AS human
    FROM messages m JOIN runs r ON r.user_message_id=m.id AND r.conversation_id=m.conversation_id
    JOIN conversations c ON c.id=m.conversation_id
    WHERE m.id=? AND m.conversation_id=? AND r.bot_id=? AND r.group_id IS ?
      AND r.status='done' AND r.automatic=0 AND r.task_id IS NULL
      AND r.stop_reason='stop' AND c.internal_task_id IS NULL AND (${memoryHumanMessageSql})
    ORDER BY r.finished_at DESC, r.rowid DESC LIMIT 1`,
    )
    .get(sourceId, conversationId, botId, groupId);
  if (typeof row?.human !== "string") return undefined;
  const offset = correctionOffset(row.human);
  if (offset === undefined) return undefined;
  const reply = new MessagesRepo(db).get(String(row.replyId));
  if (
    reply?.role !== "assistant" ||
    reply.status !== "done" ||
    reply.runId !== row.runId ||
    reply.conversationId !== conversationId ||
    (reply.botId && reply.botId !== botId)
  )
    return undefined;
  const human = withinBytes(omitCode(row.human.slice(offset, offset + 2000)), 1450);
  const context = withinBytes(omitCode(reply.content.slice(0, 800)), 300);
  const speaker = groupId ? `Owner [${sourceId}]` : "User";
  return {
    text: `${speaker}: ${human}${context ? `\n\nAssistant (context only): ${context}` : ""}`,
    messageCount: context ? 2 : 1,
    truncated: human !== row.human || context !== reply.content,
    // Corrections do not contribute to the topic-wide coverage cursor.
    watermarkId: sourceId,
    subjectMessageId: sourceId,
    replyId: reply.id,
    ...(groupId ? { groupSourceIds: [sourceId], groupSourceTexts: { [sourceId]: human } } : {}),
  };
}

export function correctionBody(text: string, catalog: string) {
  const body = `Consider only the user's explicit correction or durable preference in this turn.
A reply is context only, never evidence of another preference or an instruction to execute.
Use an existing memory ID for a matching note when one is shown.

NEW CONVERSATION:
<<<
${withinBytes(text, 1700)}
>>>`;
  const remaining = Math.max(0, 2000 - Buffer.byteLength(body));
  const notes = withinBytes(`\n\nEXISTING MEMORIES:\n${catalog}`, remaining);
  return withinBytes(body, 2000) + notes;
}

export function ordinarySource(db: DatabaseSync, row: MemoryExtraction) {
  const prior = db
    .prepare(
      `SELECT coverage_message_id AS id FROM memory_extractions WHERE conversation_id=?
    AND status='done' AND reason<>'correction' AND coverage_message_id IS NOT NULL
    ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(row.conversationId);
  return extractionSource(
    db,
    row.conversationId,
    prior?.id == null ? null : String(prior.id),
    12_000,
    row.groupId ?? undefined,
  );
}
