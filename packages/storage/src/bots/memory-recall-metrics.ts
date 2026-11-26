import type { DatabaseSync } from "node:sqlite";
import type { MemoryOwner, MemoryRecallSnapshot } from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

export interface RecallMemory extends MemoryOwner {
  id: string;
  updatedAt: string;
}

/** A durable run/id pair prevents prompt refreshes and resumed runs inflating the totals. */
export function recordRecallInjection(
  db: DatabaseSync,
  runId: string,
  botId: string,
  notes: readonly RecallMemory[],
  at: string,
): string[] {
  return transaction(db, () => {
    if (
      !db
        .prepare("SELECT 1 FROM runs WHERE id=? AND bot_id=? AND status='running'")
        .get(runId, botId)
    )
      return [];
    const existing = db.prepare(
      "SELECT 1 FROM memory_recall_observations WHERE run_id=? AND memory_id=?",
    );
    const insert = db.prepare(`INSERT INTO memory_recall_observations
      (run_id,memory_id,memory_updated_at,injected_at)
      SELECT ?,id,updated_at,? FROM scoped_memories
      WHERE id=? AND scope=? AND owner_id=? AND updated_at=? AND (expires_at IS NULL OR expires_at>?)
      ON CONFLICT(run_id,memory_id) DO UPDATE SET memory_updated_at=excluded.memory_updated_at`);
    const total =
      db.prepare(`INSERT INTO memory_recall_metrics(memory_id,injected_count,measured_since)
      VALUES(?,1,?) ON CONFLICT(memory_id) DO UPDATE SET injected_count=injected_count+1`);
    const recorded: string[] = [];
    for (const note of notes.slice(0, 200)) {
      const seen = !!existing.get(runId, note.id);
      if (!insert.run(runId, at, note.id, note.scope, note.ownerId, note.updatedAt, at).changes)
        continue;
      if (!seen) total.run(note.id, at);
      recorded.push(note.id);
    }
    return recorded;
  });
}

export function recordRecallUsed(
  db: DatabaseSync,
  runId: string,
  note: RecallMemory,
  at: string,
): boolean {
  return transaction(db, () => {
    const row = db
      .prepare(`UPDATE memory_recall_observations SET used_at=?
      WHERE run_id=? AND memory_id=? AND memory_updated_at=? AND used_at IS NULL
      AND EXISTS(SELECT 1 FROM scoped_memories m WHERE m.id=memory_id
        AND m.scope=? AND m.owner_id=? AND m.updated_at=? AND (m.expires_at IS NULL OR m.expires_at>?))
      RETURNING memory_id`)
      .get(at, runId, note.id, note.updatedAt, note.scope, note.ownerId, note.updatedAt, at);
    if (!row) return false;
    db.prepare(`UPDATE memory_recall_metrics SET used_count=used_count+1,
      last_used_at=CASE WHEN last_used_at IS NULL OR last_used_at<? THEN ? ELSE last_used_at END
      WHERE memory_id=?`).run(at, at, note.id);
    return true;
  });
}

/** Owner clauses and IDs both come from the capability's current visibility check. */
export function memoryRecallSnapshot(
  db: DatabaseSync,
  owners: readonly MemoryOwner[],
  ids: readonly string[],
  signal: AbortSignal,
): MemoryRecallSnapshot[] {
  signal.throwIfAborted();
  const selected = [...new Set(ids.slice(0, 200))].filter((id) => /^[a-f0-9-]{36}$/i.test(id));
  if (!owners.length || !selected.length) return [];
  const rows = db
    .prepare(`SELECT m.id AS memoryId,r.injected_count AS injectedCount,
    r.used_count AS usedCount,r.last_used_at AS lastUsedAt,r.measured_since AS measuredSince
    FROM scoped_memories m LEFT JOIN memory_recall_metrics r ON r.memory_id=m.id
    WHERE m.id IN (${selected.map(() => "?").join(",")})
      AND (${owners.map(() => "(m.scope=? AND m.owner_id=?)").join(" OR ")})
      AND m.archived_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) LIMIT 200`)
    .all(
      ...selected,
      ...owners.flatMap((owner) => [owner.scope, owner.ownerId]),
      new Date().toISOString(),
    );
  signal.throwIfAborted();
  return rows.map((row) => ({
    memoryId: String(row.memoryId),
    injectedCount: row.injectedCount == null ? null : Number(row.injectedCount),
    usedCount: row.usedCount == null ? null : Number(row.usedCount),
    lastUsedAt: row.lastUsedAt == null ? null : String(row.lastUsedAt),
    measuredSince: row.measuredSince == null ? null : String(row.measuredSince),
  }));
}
