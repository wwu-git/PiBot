import type { DatabaseSync } from "node:sqlite";
import type { MemoryOwner } from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { AuditRepo } from "../permissions/audit.ts";

export function memoryStatus(db: DatabaseSync, owner: MemoryOwner) {
  const row = db
    .prepare(`SELECT COUNT(*) FILTER(WHERE archived_at IS NULL) AS active,
    COUNT(*) FILTER(WHERE archived_at IS NOT NULL) AS archived,
    COUNT(*) FILTER(WHERE r.measured_since IS NOT NULL
      AND COALESCE(r.last_used_at,r.measured_since)<?) AS unused
    FROM scoped_memories m LEFT JOIN memory_recall_metrics r ON r.memory_id=m.id
    WHERE scope=? AND owner_id=?`)
    .get(new Date(Date.now() - 90 * 86400_000).toISOString(), owner.scope, owner.ownerId);
  // Only quota archiving (makeMemoryRoom) asks for organizing; a memory the user archived
  // themselves is already organized. The quota audit is written after `archived_at` is set, so a
  // later user archive of the same memory (newer `archived_at`) no longer matches it.
  const automatic = db
    .prepare(`SELECT 1 FROM scoped_memories m WHERE m.scope=? AND m.owner_id=?
    AND m.archived_at IS NOT NULL AND EXISTS(SELECT 1 FROM audit_log a
      WHERE a.kind='memory.changed' AND a.at>=m.archived_at
      AND json_extract(a.detail,'$.reasonCode')='memory_archived'
      AND json_extract(a.detail,'$.memoryId')=m.id) LIMIT 1`)
    .get(owner.scope, owner.ownerId);
  return {
    activeCount: Number(row?.active ?? 0),
    archivedCount: Number(row?.archived ?? 0),
    unusedCount: Number(row?.unused ?? 0),
    needsOrganization: !!automatic,
  };
}

/** Called under the mutation's write transaction; any later failure rolls archiving back too. */
export function makeMemoryRoom(
  db: DatabaseSync,
  owner: MemoryOwner,
  botId: string,
  id: string,
  text: string,
  redact: (text: string) => string,
) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n,COALESCE(SUM(length(text)),0) AS size FROM scoped_memories WHERE scope=? AND owner_id=? AND archived_at IS NULL AND id<>?",
    )
    .get(owner.scope, owner.ownerId, id);
  let count = Number(row?.n ?? 0) + 1;
  let size = Number(row?.size ?? 0) + Array.from(text).length;
  const now = new Date().toISOString();
  while (count > 100 || size > 8000) {
    const candidates = db
      .prepare(`SELECT id,length(text) AS size FROM scoped_memories
      WHERE scope=? AND owner_id=? AND archived_at IS NULL AND id<>? AND (category='work' OR category IS NULL)
      ORDER BY COALESCE(last_used_at,created_at),created_at,id LIMIT 100`)
      .all(owner.scope, owner.ownerId, id);
    if (!candidates.length) throw new Error("Memory quota exceeded");
    const audit = new AuditRepo(db, { redact });
    for (const candidate of candidates) {
      db.prepare(
        "UPDATE scoped_memories SET archived_at=?,updated_at=? WHERE id=? AND scope=? AND owner_id=?",
      ).run(now, now, String(candidate.id), owner.scope, owner.ownerId);
      audit.append({
        botId,
        kind: "memory.changed",
        summary: "Unused memory archived / 不常用记忆已归档",
        detail: {
          memoryScope: owner.scope,
          memoryOwnerId: owner.ownerId,
          ...(owner.scope === "group" ? { groupId: owner.ownerId } : {}),
          memoryId: String(candidate.id),
          reasonCode: "memory_archived",
        },
      });
      count--;
      size -= Number(candidate.size);
      if (count <= 100 && size <= 8000) break;
    }
  }
}

/**
 * Extraction and organization draw on one daily budget, so the cap is checked
 * across all maintenance workers so every run contributes to the shared limits.
 */
export function memoryMaintenanceUsage(db: DatabaseSync, since: string) {
  const sum = (table: "memory_extractions" | "memory_organizations") =>
    db
      .prepare(
        `SELECT IFNULL(SUM(tokens),0) AS tokens, IFNULL(SUM(MAX(cost_usd,0)),0) AS costUsd
        FROM ${table} WHERE COALESCE(started_at,created_at)>=?`,
      )
      .get(since);
  const extraction = sum("memory_extractions");
  const organization = sum("memory_organizations");
  const imported = db
    .prepare("SELECT COALESCE(SUM(tokens),0) AS tokens FROM import_memory_usage WHERE at>=?")
    .get(since);
  const dream = db
    .prepare(`SELECT IFNULL(SUM(tokens),0) AS tokens, IFNULL(SUM(MAX(cost_usd,0)),0) AS costUsd
    FROM memory_dream_runs WHERE started_at>=?`)
    .get(since);
  return {
    tokens:
      Number(extraction?.tokens ?? 0) +
      Number(organization?.tokens ?? 0) +
      Number(imported?.tokens ?? 0) +
      Number(dream?.tokens ?? 0),
    costUsd:
      Number(extraction?.costUsd ?? 0) +
      Number(organization?.costUsd ?? 0) +
      Number(dream?.costUsd ?? 0),
  };
}

export function recordMemoryUsage(db: DatabaseSync, ids: readonly string[], at: string) {
  writeMemoryUsage(db, new Map(ids.map((id) => [id, at])));
}

export function writeMemoryUsage(db: DatabaseSync, observations: ReadonlyMap<string, string>) {
  transaction(db, () => {
    const update = db.prepare(
      "UPDATE scoped_memories SET last_used_at=CASE WHEN last_used_at IS NULL OR last_used_at<? THEN ? ELSE last_used_at END,use_count=use_count+1 WHERE id=?",
    );
    for (const [id, at] of observations) update.run(at, at, id);
  });
}
