// Selects eligible conversation boundaries using stored ownership and message provenance.
import type { DatabaseSync } from "node:sqlite";
import { memoryHumanMessageSql } from "./memory-extraction-origin.ts";

const topicOwner = `
  FROM conversations c
  LEFT JOIN groups g ON g.id=c.group_id AND g.archived_at IS NULL
  JOIN bots b ON b.id=COALESCE(c.bot_id,g.coordinator_bot_id)
  WHERE c.import_id IS NULL AND c.kind IN ('dm','group') AND c.internal_task_id IS NULL
    AND b.archived_at IS NULL AND b.memory_extraction=1 AND b.kind IS NOT 'agent'
    AND (c.kind='dm' OR EXISTS (
      SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.bot_id=b.id AND gm.left_at IS NULL
    ))`;

function topic(row: Record<string, unknown>) {
  return {
    conversationId: String(row.conversationId),
    botId: String(row.botId),
    groupId: row.groupId == null ? null : String(row.groupId),
    sourceMessageId: String(row.sourceMessageId),
  };
}

export function correctionTopic(db: DatabaseSync, conversationId: string, sourceId: string) {
  const row = db
    .prepare(
      `SELECT c.id AS conversationId, b.id AS botId, c.group_id AS groupId, ? AS sourceMessageId
    ${topicOwner} AND c.id=? AND EXISTS (
      SELECT 1 FROM messages m WHERE m.id=? AND m.conversation_id=c.id AND (${memoryHumanMessageSql})
    ) AND NOT EXISTS (
      SELECT 1 FROM memory_extractions e WHERE e.conversation_id=c.id
        AND e.reason='correction' AND e.source_message_id=? AND e.status IN ('done','skipped')
    )`,
    )
    .get(sourceId, conversationId, sourceId, sourceId);
  return row ? topic(row) : undefined;
}

export const memoryExtractionCadence = (botColumn: string) => `(
  SELECT COUNT(*) FROM (
    SELECT error, finished_at FROM memory_extractions observed
    WHERE observed.bot_id=${botColumn} AND status='done'
    ORDER BY finished_at DESC, id DESC LIMIT 3
  ) WHERE error='no_candidates'
  HAVING MAX(finished_at)>?
) IS NOT 3`;

export function boundaryTopics(
  db: DatabaseSync,
  options: { at: string; before: string; conversationId?: string; after?: string; exit?: boolean },
) {
  const now = Date.parse(options.at);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const explicit = options.conversationId !== undefined;
  const quiet = !explicit && !options.exit;
  const quietFloor = new Date(now - 6 * 60 * 60_000).toISOString();
  const rows = db
    .prepare(
      `WITH topics AS (
      SELECT c.id AS conversationId, b.id AS botId, c.group_id AS groupId,
        (SELECT id FROM messages WHERE conversation_id=c.id ORDER BY rowid DESC LIMIT 1)
          AS sourceMessageId
      ${topicOwner}
      AND c.id ${explicit ? "=" : ">"} ?
      ${quiet ? `AND c.id IN (SELECT conversation_id FROM messages WHERE created_at>? AND created_at<=?)` : ""}
      AND EXISTS (
        SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND (${memoryHumanMessageSql})
      )
    )
    SELECT t.* FROM topics t JOIN messages last ON last.id=t.sourceMessageId
    WHERE last.created_at<=? AND NOT EXISTS (
      SELECT 1 FROM memory_extractions e WHERE e.conversation_id=t.conversationId AND (
        (e.status='queued' AND e.priority>=1)
        OR (e.status='running' AND e.source_message_id=t.sourceMessageId)
        OR (e.status='done' AND e.reason<>'correction' AND e.coverage_message_id=t.sourceMessageId)
        OR (e.reason='boundary' AND e.created_at>?)
        OR (e.status IN ('failed','skipped') AND e.error IS NOT 'already_covered' AND e.finished_at>?)
      )
    )
    AND (SELECT COUNT(*) FROM memory_extractions e WHERE e.conversation_id=t.conversationId
      AND e.status='failed' AND e.started_at>?)<3
    ${quiet ? "AND last.created_at>?" : ""}
    ${options.exit ? "" : `AND ${memoryExtractionCadence("t.botId")}`}
    ORDER BY t.conversationId LIMIT 100`,
    )
    .all(
      options.conversationId ?? options.after ?? "",
      ...(quiet ? [quietFloor, options.before] : []),
      options.before,
      new Date(now - 10 * 60_000).toISOString(),
      new Date(now - 60 * 60_000).toISOString(),
      day.toISOString(),
      ...(quiet ? [quietFloor] : []),
      ...(options.exit ? [] : [new Date(now - 2 * 60 * 60_000).toISOString()]),
    );
  return rows.map(topic);
}

export interface ExtractionTopic {
  conversationId: string;
  botId: string;
  groupId: string | null;
  lastMessageId: string;
  lastUserId: string;
  lastAt: string;
}

/**
 * Topics that are ready for extraction. A topic is due when it was archived or its last message
 * is older than the idle cutoff; it needs two user messages, an enabled Bot, and no extraction
 * that already covered its newest message. Failed/skipped attempts wait an hour and stop after
 * three failures in a day so a broken model cannot loop.
 */
export function legacyDueTopics(
  db: DatabaseSync,
  idleBefore: string,
  retryAfter: string,
  failedSince: string,
  limit: number,
) {
  const rows = db
    .prepare(
      `WITH t AS (
        SELECT c.id AS conversationId,
          COALESCE(c.bot_id, g.coordinator_bot_id) AS botId,
          c.group_id AS groupId,
          c.archived_at AS archivedAt,
          (SELECT m.id FROM messages m WHERE m.conversation_id=c.id
            ORDER BY m.rowid DESC LIMIT 1) AS lastMessageId,
          (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id
            ORDER BY m.rowid DESC LIMIT 1) AS lastAt,
          (SELECT m.id FROM messages m WHERE m.conversation_id=c.id AND m.role='user'
            AND m.status='done' ORDER BY m.rowid DESC LIMIT 1) AS lastUserId,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.role='user'
            AND m.status='done') AS userCount
        FROM conversations c LEFT JOIN groups g ON g.id=c.group_id
        WHERE c.import_id IS NULL AND c.kind IN ('dm','group')
      )
      SELECT t.conversationId, t.botId, t.groupId, t.lastMessageId, t.lastUserId, t.lastAt
      FROM t JOIN bots b ON b.id=t.botId AND b.memory_extraction=1 AND b.archived_at IS NULL
      WHERE t.userCount>=2 AND t.lastMessageId IS NOT NULL
        AND (t.archivedAt IS NOT NULL OR t.lastAt<=?)
        AND NOT EXISTS (
          SELECT 1 FROM memory_extractions e WHERE e.conversation_id=t.conversationId
            AND ((((e.status='done' AND e.reason<>'correction') OR (e.status='skipped' AND e.error LIKE 'automation_%')) AND e.coverage_message_id=t.lastMessageId)
              OR e.status IN ('queued','running')
              OR (e.status IN ('failed','skipped') AND e.error IS NOT 'already_covered' AND e.finished_at>?))
        )
        AND (SELECT COUNT(*) FROM memory_extractions e2
          WHERE e2.conversation_id=t.conversationId AND e2.status='failed'
            AND e2.started_at>?)<3
      ORDER BY (t.archivedAt IS NOT NULL) DESC, t.lastAt DESC LIMIT ?`,
    )
    .all(idleBefore, retryAfter, failedSince, limit);
  return rows.map((value) => ({
    conversationId: String(value.conversationId),
    botId: String(value.botId),
    groupId: value.groupId == null ? null : String(value.groupId),
    lastMessageId: String(value.lastMessageId),
    lastUserId: String(value.lastUserId),
    lastAt: String(value.lastAt),
  })) satisfies ExtractionTopic[];
}
