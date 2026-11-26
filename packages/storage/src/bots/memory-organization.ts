import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/database.ts";
import { nonNegativeCost } from "./memory-dream.ts";

/**
 * One memory owner's organization run. Unlike extraction a run is not bound to a topic, so
 * the row itself carries the bookkeeping: which owner it looked at, when it finished, and what it
 * cost. Proposals it produced are ordinary pending memory proposals; the row never holds note text.
 */
export type MemoryOrganizationStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface MemoryOrganization {
  id: string;
  botId: string;
  scope: "user" | "bot";
  ownerId: string;
  status: MemoryOrganizationStatus;
  reason: "count" | "stale";
  ownerInitiated: boolean;
  modelProvider: string | null;
  modelId: string | null;
  tokens: number;
  costUsd: number;
  proposals: number;
  memoryCount: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What the scheduler needs to decide whether an owner is due again. */
export interface OrganizationTarget {
  scope: "user" | "bot";
  ownerId: string;
  activeCount: number;
  lastDoneAt: string | null;
  lastAttemptAt: string | null;
  lastChangedAt: string | null;
}

const columns = `id, bot_id AS botId, scope, owner_id AS ownerId, status, reason, owner_initiated AS ownerInitiated,
  model_provider AS modelProvider, model_id AS modelId, tokens, MAX(COALESCE(cost_usd,0),0) AS costUsd, proposals,
  memory_count AS memoryCount, error, created_at AS createdAt, started_at AS startedAt,
  finished_at AS finishedAt`;

function row(value: Record<string, unknown>): MemoryOrganization {
  return {
    id: String(value.id),
    botId: String(value.botId),
    scope: value.scope as "user" | "bot",
    ownerId: String(value.ownerId),
    status: value.status as MemoryOrganizationStatus,
    reason: value.reason as "count" | "stale",
    ownerInitiated: value.ownerInitiated === 1,
    modelProvider: value.modelProvider == null ? null : String(value.modelProvider),
    modelId: value.modelId == null ? null : String(value.modelId),
    tokens: Number(value.tokens ?? 0),
    costUsd: Number(value.costUsd ?? 0),
    proposals: Number(value.proposals ?? 0),
    memoryCount: Number(value.memoryCount ?? 0),
    error: value.error == null ? null : String(value.error),
    createdAt: String(value.createdAt),
    startedAt: value.startedAt == null ? null : String(value.startedAt),
    finishedAt: value.finishedAt == null ? null : String(value.finishedAt),
  };
}

export class MemoryOrganizationsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** A crash left rows running; they go back to the queue so the next start picks them up. */
  recover(): void {
    this.db
      .prepare(`UPDATE memory_organizations SET status='failed', error='interrupted',
      finished_at=? WHERE owner_initiated=1 AND status IN ('queued','running')`)
      .run(new Date().toISOString());
    this.db
      .prepare(
        "UPDATE memory_organizations SET status='queued', started_at=NULL WHERE status='running' AND owner_initiated=0",
      )
      .run();
  }

  /** Only the explicit management RPC may create these; no queued/restart path can run them. */
  beginOwner(botId: string, id: string = randomUUID()): string {
    return transaction(this.db, () => {
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE memory_organizations SET status='skipped', finished_at=?
        WHERE scope='user' AND owner_id='user' AND status='queued' AND owner_initiated=0`)
        .run(now);
      this.db
        .prepare(`INSERT INTO memory_organizations
        (id,bot_id,scope,owner_id,status,reason,owner_initiated,created_at,started_at)
        VALUES (?,?,'user','user','running','stale',1,?,?)`)
        .run(id, botId, now, now);
      return id;
    });
  }

  ownerRunning(id: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM memory_organizations
      WHERE id=? AND owner_initiated=1 AND scope='user' AND owner_id='user' AND status='running'`)
      .get(id);
  }

  /** One open run per owner: a second enqueue while it waits or runs is a no-op. */
  enqueue(input: {
    botId: string;
    scope: "user" | "bot";
    ownerId: string;
    reason: "count" | "stale";
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO memory_organizations
        (id, bot_id, scope, owner_id, status, reason, created_at)
        SELECT ?,?,?,?, 'queued', ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_organizations
          WHERE scope=? AND owner_id=? AND status IN ('queued','running')
        )`,
      )
      .run(
        randomUUID(),
        input.botId,
        input.scope,
        input.ownerId,
        input.reason,
        new Date().toISOString(),
        input.scope,
        input.ownerId,
      );
    return result.changes > 0;
  }

  /**
   * The queued run belonging to the fewest busy Bots. User-scope rows may belong to another Bot
   * than the one claiming them: the notes are shared, so any Bot with a usable model can run it.
   */
  claim(excludedBotIds: readonly string[], now = new Date().toISOString()) {
    return transaction(this.db, () => {
      const excluded = excludedBotIds.length
        ? `AND bot_id NOT IN (${excludedBotIds.map(() => "?").join(",")})`
        : "";
      const found = this.db
        .prepare(
          `SELECT ${columns} FROM memory_organizations
          WHERE status='queued' AND owner_initiated=0 ${excluded}
          ORDER BY created_at, id LIMIT 1`,
        )
        .get(...excludedBotIds);
      if (!found) return undefined;
      const value = row(found);
      const changed = this.db
        .prepare(
          "UPDATE memory_organizations SET status='running', started_at=? WHERE id=? AND status='queued'",
        )
        .run(now, value.id);
      return changed.changes ? { ...value, status: "running" as const, startedAt: now } : undefined;
    });
  }

  finish(
    id: string,
    patch: {
      status: "done" | "failed" | "skipped";
      modelProvider?: string | null;
      modelId?: string | null;
      tokens?: number;
      costUsd?: number;
      proposals?: number;
      memoryCount?: number;
      error?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE memory_organizations SET status=?, model_provider=COALESCE(?,model_provider), model_id=COALESCE(?,model_id), tokens=COALESCE(?,tokens),
        cost_usd=COALESCE(?,cost_usd), proposals=?, memory_count=?, error=?, finished_at=?
        WHERE id=? AND status='running'`,
      )
      .run(
        patch.status,
        patch.modelProvider ?? null,
        patch.modelId ?? null,
        patch.tokens ?? null,
        patch.costUsd === undefined ? null : nonNegativeCost(patch.costUsd),
        patch.proposals ?? 0,
        patch.memoryCount ?? 0,
        patch.error ?? null,
        new Date().toISOString(),
        id,
      );
  }

  /** Persist the reservation/settlement even when the auxiliary call later fails. */
  recordUsage(
    id: string,
    usage: { tokens: number; costUsd?: number; modelProvider: string; modelId: string },
  ) {
    this.db
      .prepare(
        `UPDATE memory_organizations SET tokens=?, cost_usd=?, model_provider=?, model_id=?
         WHERE id=? AND status='running'`,
      )
      .run(usage.tokens, nonNegativeCost(usage.costUsd), usage.modelProvider, usage.modelId, id);
  }

  /**
   * Every owner this Bot can organize: its own notes and the shared user notes. Group and project
   * notes are written under the group's own rules, so organizing them stays out of this queue.
   */
  targets(botId: string): OrganizationTarget[] {
    return this.db
      .prepare(
        `WITH o(scope, owner_id) AS (SELECT 'user', 'user' UNION ALL SELECT 'bot', ?)
        SELECT o.scope AS scope, o.owner_id AS ownerId,
          (SELECT COUNT(*) FROM scoped_memories m
            WHERE m.scope=o.scope AND m.owner_id=o.owner_id AND m.archived_at IS NULL) AS activeCount,
          (SELECT MAX(r.finished_at) FROM memory_organizations r
            WHERE r.scope=o.scope AND r.owner_id=o.owner_id AND r.status='done') AS lastDoneAt,
          (SELECT MAX(r.created_at) FROM memory_organizations r
            WHERE r.scope=o.scope AND r.owner_id=o.owner_id) AS lastAttemptAt,
          (SELECT MAX(m.updated_at) FROM scoped_memories m
            WHERE m.scope=o.scope AND m.owner_id=o.owner_id AND m.archived_at IS NULL) AS lastChangedAt
        FROM o`,
      )
      .all(botId)
      .map((value) => ({
        scope: value.scope as "user" | "bot",
        ownerId: String(value.ownerId),
        activeCount: Number(value.activeCount ?? 0),
        lastDoneAt: value.lastDoneAt == null ? null : String(value.lastDoneAt),
        lastAttemptAt: value.lastAttemptAt == null ? null : String(value.lastAttemptAt),
        lastChangedAt: value.lastChangedAt == null ? null : String(value.lastChangedAt),
      }));
  }

  /** Organization cost shares the extraction budget, so both tables are summed by the caller. */
  usageSince(since: string) {
    const value = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, IFNULL(SUM(tokens),0) AS tokens,
        IFNULL(SUM(MAX(cost_usd,0)),0) AS costUsd, IFNULL(SUM(proposals),0) AS proposals
        FROM memory_organizations WHERE created_at>=? AND status='done'`,
      )
      .get(since);
    return {
      runs: Number(value?.runs ?? 0),
      tokens: Number(value?.tokens ?? 0),
      costUsd: Number(value?.costUsd ?? 0),
      proposals: Number(value?.proposals ?? 0),
    };
  }

  /** Attempts started today, including failures: the cap protects both cost and time. */
  todayByBot(since: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT bot_id AS botId, COUNT(*) AS n FROM memory_organizations
        WHERE created_at>=? AND status<>'queued' GROUP BY bot_id`,
      )
      .all(since);
    return new Map(rows.map((value) => [String(value.botId), Number(value.n)]));
  }

  /** Queued work survives a restart; the queue is drained oldest-first on the next start. */
  pending(): number {
    const value = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_organizations WHERE status IN ('queued','running')",
      )
      .get();
    return Number(value?.n ?? 0);
  }
}
