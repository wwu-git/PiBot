import type { DatabaseSync } from "node:sqlite";
import {
  MemoryCatalogEntrySchema,
  type MemoryOwner,
  MemoryRecallMetricsSchema,
  MemoryRevisionSchema,
} from "@pibot/protocol-base";

/** Management metadata stays in storage; callers validate the owner before every scoped query. */
export class MemoryManagementRepo {
  constructor(private readonly db: DatabaseSync) {}

  catalog(after = "") {
    return this.db
      .prepare(`SELECT * FROM (
      SELECT 'user' AS scope,'user' AS ownerId,'user' AS name,0 AS archived
      UNION ALL SELECT 'bot',id,name,archived_at IS NOT NULL FROM bots
      UNION ALL SELECT 'group',id,name,0 FROM groups
    ) WHERE scope||':'||ownerId>? ORDER BY scope,ownerId LIMIT 50`)
      .all(after)
      .map((r) => MemoryCatalogEntrySchema.parse({ ...r, archived: !!r.archived }));
  }

  actor(owner: MemoryOwner): string {
    if (
      owner.scope === "user"
        ? owner.ownerId !== "user"
        : !this.db
            .prepare(
              owner.scope === "bot"
                ? "SELECT 1 FROM bots WHERE id=?"
                : owner.scope === "project"
                  ? "SELECT 1 FROM memory_projects WHERE id=?"
                  : "SELECT 1 FROM groups WHERE id=?",
            )
            .get(owner.ownerId)
    )
      throw new TypeError("memory_owner_unavailable");
    const member =
      owner.scope === "group"
        ? this.db
            .prepare(
              "SELECT b.id FROM groups g JOIN group_members gm ON gm.group_id=g.id JOIN bots b ON b.id=gm.bot_id WHERE g.id=? AND gm.left_at IS NULL AND b.archived_at IS NULL ORDER BY b.id=g.coordinator_bot_id DESC,gm.position LIMIT 1",
            )
            .get(owner.ownerId)
        : this.db.prepare("SELECT id FROM bots WHERE is_main=1 AND archived_at IS NULL").get();
    const actor =
      member ??
      this.db.prepare("SELECT id FROM bots WHERE is_main=1 AND archived_at IS NULL").get();
    if (!actor) throw new TypeError("memory_owner_unavailable");
    return String(actor.id);
  }

  details(id: string, before?: number) {
    const sources = this.db
      .prepare(`SELECT json_extract(s.value,'$.botId')||':'||COALESCE(json_extract(s.value,'$.messageId'),'manual') AS sourceKey,COALESCE(b.name,'') AS botName,
      CASE WHEN c.id IS NULL THEN NULL ELSE COALESCE(NULLIF(c.title,''),g.name,b.name,'') END AS conversationTitle,m.created_at AS createdAt
      FROM scoped_memories sm,json_each(sm.sources_json) s
      LEFT JOIN bots b ON b.id=json_extract(s.value,'$.botId')
      LEFT JOIN messages m ON m.id=json_extract(s.value,'$.messageId')
      LEFT JOIN conversations c ON c.id=m.conversation_id
      LEFT JOIN groups g ON g.id=c.group_id
      WHERE sm.id=? ORDER BY s.key LIMIT 100`)
      .all(id)
      .map((row) => ({
        key: String(row.sourceKey),
        botName: String(row.botName),
        conversationTitle: row.conversationTitle === null ? null : String(row.conversationTitle),
        createdAt: row.createdAt === null ? null : String(row.createdAt),
      }));
    const history = this.db
      .prepare(`SELECT version,text,category,archived_at AS archivedAt,
      changed_at AS changedAt,baseline FROM memory_revisions
      WHERE memory_id=? AND version<? ORDER BY version DESC LIMIT 20`)
      .all(id, before ?? Number.MAX_SAFE_INTEGER)
      .map((row) => MemoryRevisionSchema.parse({ ...row, baseline: !!row.baseline }));
    return { sources, history };
  }

  presentation(ids: string[]) {
    // Archive / restore also writes a revision but keeps text and category; only those count.
    return this.db
      .prepare(`SELECT m.id,
      CASE WHEN EXISTS(SELECT 1 FROM json_each(m.sources_json) WHERE json_extract(value,'$.messageId') IS NOT NULL) THEN b.name ELSE NULL END AS botName,
      (SELECT COUNT(*) FROM (SELECT r.text,r.category,
        LAG(r.text) OVER w AS priorText,LAG(r.category) OVER w AS priorCategory,
        ROW_NUMBER() OVER w AS n FROM memory_revisions r WHERE r.memory_id=m.id
        WINDOW w AS (ORDER BY r.version))
      WHERE n>1 AND (text IS NOT priorText OR category IS NOT priorCategory)) AS edits,
      (SELECT json_object('injectedCount',r.injected_count,'usedCount',r.used_count,
        'measuredSince',r.measured_since,'lastUsedAt',r.last_used_at)
       FROM memory_recall_metrics r WHERE r.memory_id=m.id) AS recallMetrics
      FROM scoped_memories m LEFT JOIN bots b ON b.id=m.bot_id
      WHERE m.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids))
      .map((row) => ({
        id: String(row.id),
        botName: row.botName == null ? null : String(row.botName),
        edits: Number(row.edits),
        ...(row.recallMetrics
          ? {
              recallMetrics: MemoryRecallMetricsSchema.parse(JSON.parse(String(row.recallMetrics))),
            }
          : {}),
      }));
  }

  revision(owner: MemoryOwner) {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(r.version),0) AS version FROM memory_revisions r
      JOIN scoped_memories m ON m.id=r.memory_id WHERE m.scope=? AND m.owner_id=?`)
      .get(owner.scope, owner.ownerId);
    return Number(row?.version ?? 0);
  }

  undoCandidates(owner: MemoryOwner, before?: string) {
    // Snapshots survive deletion of the memory itself; select by proposal ownership.
    return this.db
      .prepare(`SELECT p.id,p.bot_id AS botId FROM scoped_memory_proposals p
      JOIN settings s ON s.key='memory-undo:'||p.bot_id||':'||p.id
      JOIN bots b ON b.id=p.bot_id AND (p.scope='user' OR b.archived_at IS NULL)
      WHERE p.scope=? AND p.owner_id=? AND p.status='accepted' AND p.id<?
      ORDER BY p.id DESC LIMIT 50`)
      .all(owner.scope, owner.ownerId, before ?? "~")
      .map((row) => ({ id: String(row.id), botId: String(row.botId) }));
  }

  clearPending(owner: MemoryOwner) {
    this.db
      .prepare(
        "DELETE FROM scoped_memory_proposals WHERE scope=? AND owner_id=? AND status='pending'",
      )
      .run(owner.scope, owner.ownerId);
  }
}
