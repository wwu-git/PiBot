// Persists the extraction queue, including interrupted attempts and their usage.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/database.ts";
import { nonNegativeCost } from "./memory-dream.ts";
import { legacyDueTopics, memoryExtractionCadence } from "./memory-extraction-boundaries.ts";
import { extractionAutomatedReason } from "./memory-extraction-origin.ts";

export {
  boundaryTopics,
  correctionTopic,
  type ExtractionTopic,
} from "./memory-extraction-boundaries.ts";

export { memoryHumanMessageSql } from "./memory-extraction-origin.ts";

export type MemoryExtractionStatus = "queued" | "running" | "done" | "failed" | "skipped";
export type MemoryExtractionReason = "idle" | "archive" | "boundary" | "correction";

export interface MemoryExtraction {
  id: string;
  botId: string;
  conversationId: string;
  groupId: string | null;
  status: MemoryExtractionStatus;
  reason: MemoryExtractionReason;
  sourceMessageId: string | null;
  coverageMessageId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  tokens: number;
  costUsd: number;
  candidates: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const columns = `id, bot_id AS botId, conversation_id AS conversationId, group_id AS groupId,
  status, reason, source_message_id AS sourceMessageId, coverage_message_id AS coverageMessageId, model_provider AS modelProvider,
  model_id AS modelId, tokens, MAX(COALESCE(cost_usd,0),0) AS costUsd, candidates, error, created_at AS createdAt,
  started_at AS startedAt, finished_at AS finishedAt`;

function row(value: Record<string, unknown>): MemoryExtraction {
  return {
    id: String(value.id),
    botId: String(value.botId),
    conversationId: String(value.conversationId),
    groupId: value.groupId == null ? null : String(value.groupId),
    status: value.status as MemoryExtractionStatus,
    reason: value.reason as MemoryExtractionReason,
    sourceMessageId: value.sourceMessageId == null ? null : String(value.sourceMessageId),
    coverageMessageId: value.coverageMessageId == null ? null : String(value.coverageMessageId),
    modelProvider: value.modelProvider == null ? null : String(value.modelProvider),
    modelId: value.modelId == null ? null : String(value.modelId),
    tokens: Number(value.tokens ?? 0),
    costUsd: Number(value.costUsd ?? 0),
    candidates: Number(value.candidates ?? 0),
    error: value.error == null ? null : String(value.error),
    createdAt: String(value.createdAt),
    startedAt: value.startedAt == null ? null : String(value.startedAt),
    finishedAt: value.finishedAt == null ? null : String(value.finishedAt),
  };
}

export class MemoryExtractionsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** A crash left rows running; they go back to the queue so the next start picks them up. */
  recover(): void {
    const interrupted = this.db
      .prepare(`SELECT ${columns} FROM memory_extractions WHERE status='running'`)
      .all();
    for (const value of interrupted) this.defer(row(value), "restart_interrupted");
  }

  enqueue(
    input: Pick<MemoryExtraction, "botId" | "conversationId" | "reason"> &
      Partial<Pick<MemoryExtraction, "groupId" | "sourceMessageId">>,
    at = new Date().toISOString(),
  ): boolean {
    const priority = input.reason === "correction" ? 2 : input.reason === "boundary" ? 1 : 0;
    const source = input.sourceMessageId ?? null;
    const result = this.db
      .prepare(
        `INSERT INTO memory_extractions
        (id, bot_id, conversation_id, group_id, status, reason, priority, source_message_id, created_at)
      SELECT ?,?,?,?, 'queued', ?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE id=? AND import_id IS NOT NULL)
        AND NOT EXISTS (
        SELECT 1 FROM memory_extractions
        WHERE conversation_id=? AND status='running'
          AND (?=0 OR (reason=? AND source_message_id IS ?))
      )
      ON CONFLICT(conversation_id) WHERE status='queued' DO UPDATE SET
        bot_id=excluded.bot_id, group_id=excluded.group_id,
        reason=excluded.reason, priority=excluded.priority,
        source_message_id=excluded.source_message_id, created_at=excluded.created_at,
        error=NULL
      WHERE excluded.priority>memory_extractions.priority OR (
        excluded.priority=2 AND (
          SELECT rowid FROM messages WHERE id=excluded.source_message_id
        )>(SELECT rowid FROM messages WHERE id=memory_extractions.source_message_id)
      )`,
      )
      .run(
        randomUUID(),
        input.botId,
        input.conversationId,
        input.groupId ?? null,
        input.reason,
        priority,
        source,
        at,
        input.conversationId,
        input.conversationId,
        priority,
        input.reason,
        source,
      );
    return result.changes > 0;
  }

  /** Claims urgent rows first, preserving the archive-first order among legacy items. */
  claim(excludedBotIds: readonly string[], now = new Date().toISOString()) {
    return transaction(this.db, () => {
      const timestamp = Date.parse(now);
      const excluded = excludedBotIds.length
        ? `AND bot_id NOT IN (${excludedBotIds.map(() => "?").join(",")})`
        : "";
      const found = this.db
        .prepare(
          `SELECT ${columns} FROM memory_extractions
          WHERE status='queued' ${excluded}
            AND NOT EXISTS (SELECT 1 FROM memory_extractions active
              WHERE active.conversation_id=memory_extractions.conversation_id AND active.status='running')
            AND (reason<>'boundary'
              OR EXISTS (SELECT 1 FROM conversations c
                WHERE c.id=memory_extractions.conversation_id AND c.archived_at IS NOT NULL)
              OR (SELECT m.created_at FROM messages m WHERE m.conversation_id=memory_extractions.conversation_id
                ORDER BY m.rowid DESC LIMIT 1)<=?
              OR ${memoryExtractionCadence("memory_extractions.bot_id")})
          ORDER BY priority DESC, CASE WHEN EXISTS (SELECT 1 FROM conversations c
            WHERE c.id=memory_extractions.conversation_id AND c.archived_at IS NOT NULL)
            THEN 0 ELSE 1 END,
            (SELECT m.created_at FROM messages m WHERE m.conversation_id=memory_extractions.conversation_id
              ORDER BY m.rowid DESC LIMIT 1) DESC, created_at, id LIMIT 1`,
        )
        .get(
          ...excludedBotIds,
          new Date(timestamp - 6 * 60 * 60_000).toISOString(),
          new Date(timestamp - 2 * 60 * 60_000).toISOString(),
        );
      if (!found) return undefined;
      const value = row(found);
      const changed = this.db
        .prepare(
          `UPDATE memory_extractions SET status='running', started_at=?, finished_at=NULL
          WHERE id=? AND status='queued'`,
        )
        .run(now, value.id);
      return changed.changes ? { ...value, status: "running" as const, startedAt: now } : undefined;
    });
  }

  skipQueued(conversationId: string, reason: string, coverageMessageId: string | null) {
    this.db
      .prepare(`UPDATE memory_extractions SET status='skipped', error=?,
      coverage_message_id=?, finished_at=? WHERE conversation_id=? AND status='queued'`)
      .run(reason, coverageMessageId, new Date().toISOString(), conversationId);
  }

  recordUsage(
    id: string,
    usage: { tokens: number; costUsd?: number; modelProvider: string; modelId: string },
  ) {
    this.db
      .prepare(`UPDATE memory_extractions SET tokens=?, cost_usd=?, model_provider=?, model_id=?
      WHERE id=? AND status='running'`)
      .run(usage.tokens, nonNegativeCost(usage.costUsd), usage.modelProvider, usage.modelId, id);
  }

  diagnostics(
    id: string,
    counts: {
      raw: number;
      valid: number;
      applied: number;
      proposed: number;
      reasons: Record<string, number>;
    },
  ) {
    this.db
      .prepare(`UPDATE memory_extractions SET raw_candidates=?, valid_candidates=?,
      applied_candidates=?, proposed_candidates=?, reason_counts=? WHERE id=?`)
      .run(
        counts.raw,
        counts.valid,
        counts.applied,
        counts.proposed,
        JSON.stringify(counts.reasons),
        id,
      );
  }

  /** Keep the billed attempt, create a fresh durable work item; cancellation never refunds usage. */
  defer(value: MemoryExtraction, reason: string) {
    transaction(this.db, () => {
      const usage = this.db
        .prepare("SELECT tokens FROM memory_extractions WHERE id=?")
        .get(value.id);
      const successor = this.db
        .prepare("SELECT 1 FROM memory_extractions WHERE conversation_id=? AND status='queued'")
        .get(value.conversationId);
      if (!Number(usage?.tokens) && !successor) {
        this.db
          .prepare(`UPDATE memory_extractions SET status='queued', started_at=NULL, finished_at=?,
          error=? WHERE id=? AND status='running'`)
          .run(reason === "budget_exhausted" ? new Date().toISOString() : null, reason, value.id);
        return;
      }
      if (Number(usage?.tokens)) this.finish(value.id, { status: "failed", error: reason });
      else this.db.prepare("DELETE FROM memory_extractions WHERE id=?").run(value.id);
      this.enqueue(value, value.createdAt);
      this.db
        .prepare(
          "UPDATE memory_extractions SET error=?, finished_at=? WHERE conversation_id=? AND status='queued' AND error IS NULL",
        )
        .run(
          reason,
          reason === "budget_exhausted" ? new Date().toISOString() : null,
          value.conversationId,
        );
    });
  }

  automatedReason(conversationId: string) {
    return extractionAutomatedReason(this.db, conversationId);
  }

  finish(
    id: string,
    patch: {
      status: "done" | "failed" | "skipped";
      coverageMessageId?: string | null;
      modelProvider?: string | null;
      modelId?: string | null;
      tokens?: number;
      costUsd?: number;
      candidates?: number;
      error?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE memory_extractions SET status=?, coverage_message_id=?, model_provider=COALESCE(?,model_provider),
        model_id=COALESCE(?,model_id), tokens=COALESCE(?,tokens), cost_usd=COALESCE(?,cost_usd), candidates=?, error=?, finished_at=?
        WHERE id=? AND status='running'`,
      )
      .run(
        patch.status,
        patch.coverageMessageId ?? null,
        patch.modelProvider ?? null,
        patch.modelId ?? null,
        patch.tokens ?? null,
        patch.costUsd === undefined ? null : nonNegativeCost(patch.costUsd),
        patch.candidates ?? 0,
        patch.error ?? null,
        new Date().toISOString(),
        id,
      );
  }

  pendingCorrection(options?: {
    botId: string;
    destinationConversationId: string | undefined;
    since: string;
  }) {
    const match = this.db
      .prepare(
        `SELECT status FROM memory_extractions WHERE reason='correction'
        AND status IN ('queued','running') AND error IS NOT 'budget_exhausted'
        ${options ? "AND bot_id=? AND conversation_id IS NOT ? AND created_at>=?" : ""}
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END LIMIT 1`,
      )
      .get(
        ...(options
          ? [options.botId, options.destinationConversationId ?? null, options.since]
          : []),
      );
    const status = match?.status;
    return status === "queued" || status === "running" ? status : undefined;
  }

  covered(conversationId: string, messageId: string) {
    return !!this.db
      .prepare(
        `SELECT 1 FROM memory_extractions WHERE conversation_id=? AND status='done'
        AND reason<>'correction' AND coverage_message_id=?`,
      )
      .get(conversationId, messageId);
  }

  /** The newest message the topic has; used as the coverage watermark after a run. */
  watermark(conversationId: string) {
    const last = this.db
      .prepare(
        "SELECT id, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(conversationId);
    const user = this.db
      .prepare(
        `SELECT id FROM messages WHERE conversation_id=? AND role='user' AND status='done'
        ORDER BY rowid DESC LIMIT 1`,
      )
      .get(conversationId);
    return last
      ? {
          messageId: String(last.id),
          lastAt: String(last.createdAt),
          lastUserId: user ? String(user.id) : null,
        }
      : undefined;
  }

  dueTopics(idleBefore: string, retryAfter: string, failedSince: string, limit = 100) {
    return legacyDueTopics(this.db, idleBefore, retryAfter, failedSince, limit);
  }

  /** Attempts started today, including failures: the cap protects both cost and time. */
  todayByBot(since: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT bot_id AS botId, COUNT(*) AS n FROM memory_extractions
        WHERE started_at>=? AND status IN ('running','done','failed') GROUP BY bot_id`,
      )
      .all(since);
    return new Map(rows.map((value) => [String(value.botId), Number(value.n)]));
  }

  costSince(since: string): number {
    const value = this.db
      .prepare(
        "SELECT IFNULL(SUM(MAX(cost_usd,0)),0) AS cost FROM memory_extractions WHERE started_at>=?",
      )
      .get(since);
    return Number(value?.cost ?? 0);
  }

  /** Usage statistics read this, so extraction cost is visible next to chat runs. */
  usageSince(since: string) {
    const value = this.db
      .prepare(
        `SELECT COUNT(*) AS topics, IFNULL(SUM(tokens),0) AS tokens,
        IFNULL(SUM(MAX(cost_usd,0)),0) AS costUsd, IFNULL(SUM(candidates),0) AS candidates
        FROM memory_extractions WHERE started_at>=? AND status IN ('done','failed')`,
      )
      .get(since);
    return {
      topics: Number(value?.topics ?? 0),
      tokens: Number(value?.tokens ?? 0),
      costUsd: Number(value?.costUsd ?? 0),
      candidates: Number(value?.candidates ?? 0),
    };
  }

  /** Pending work survives a restart. */
  pending(): number {
    const value = this.db
      .prepare("SELECT COUNT(*) AS n FROM memory_extractions WHERE status IN ('queued','running')")
      .get();
    return Number(value?.n ?? 0);
  }
}
