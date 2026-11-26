// Reads recent maintenance facts and usage without changing model settings or queue state.
import type { DatabaseSync } from "node:sqlite";
import type { MemoryMaintenanceStatus } from "@pibot/protocol-base";
import { SettingsRepo } from "../workspace/repositories.ts";
import { memoryMaintenanceUsage } from "./memory-maintenance.ts";

type Issue = NonNullable<MemoryMaintenanceStatus["issue"]>;

function visibleFailure(reason: unknown): Issue["reason"] {
  switch (reason) {
    case "no_model":
    case "auth_failed":
    case "budget_exhausted":
    case "draft_invalid":
      return reason;
    case "candidates_invalid":
      return "draft_invalid";
    default:
      return "failed";
  }
}

function failure(db: DatabaseSync, botId: string | undefined, since: string): Issue | undefined {
  const row = db
    .prepare(
      `SELECT h.task,h.reason_code,h.streak FROM background_task_health h
       JOIN bots b ON b.id=h.subject
      WHERE h.task IN ('memory_extraction','memory_organization')
        AND b.archived_at IS NULL AND b.kind IS NOT 'agent'
        AND (h.task='memory_organization' OR b.memory_extraction=1)
        AND (? IS NULL OR b.id=?)
        AND (h.reason_code<>'budget_exhausted' OR h.last_failed_at>=?)
      ORDER BY h.last_failed_at DESC,h.subject,h.task LIMIT 1`,
    )
    .get(botId ?? null, botId ?? null, since);
  if (!row) return undefined;
  return {
    reason: visibleFailure(row.reason_code),
    count: Number(row.streak),
    task: row.task === "memory_extraction" ? "extraction" : "organization",
  };
}

function budgetIssue(
  db: DatabaseSync,
  botId: string | undefined,
  since: string,
): Issue | undefined {
  const deferred = db
    .prepare(
      `SELECT 1 FROM memory_extractions e JOIN bots b ON b.id=e.bot_id
     WHERE e.status='queued' AND e.error='budget_exhausted' AND e.finished_at>=?
       AND b.archived_at IS NULL AND b.memory_extraction=1 AND b.kind IS NOT 'agent'
       AND (? IS NULL OR b.id=?) LIMIT 1`,
    )
    .get(since, botId ?? null, botId ?? null);
  if (deferred) return { reason: "budget_exhausted", count: 1, task: "extraction" };
  const settings = new SettingsRepo(db).get({ initializeDefaultModel: false });
  const used = memoryMaintenanceUsage(db, since);
  if (
    used.costUsd < (settings.memoryExtractionDailyCostUsd ?? 0.5) &&
    used.tokens < (settings.memoryExtractionDailyTokens ?? 2_000_000)
  )
    return undefined;
  return { reason: "budget_exhausted", count: 1, task: "extraction" };
}

export function readMemoryMaintenance(
  db: DatabaseSync,
  since: string,
  botId?: string,
): MemoryMaintenanceStatus {
  const extraction = db
    .prepare(
      `SELECT MAX(e.finished_at) AS at FROM memory_extractions e JOIN bots b ON b.id=e.bot_id
     WHERE (e.status='done' OR e.tokens>0 OR e.error IN ('no_model','auth_failed','draft_invalid'))
       AND e.status IN ('done','failed','skipped') AND b.archived_at IS NULL AND b.kind IS NOT 'agent'
       AND (? IS NULL OR b.id=?)`,
    )
    .get(botId ?? null, botId ?? null);
  const saved = botId
    ? undefined
    : db
        .prepare(
          "SELECT MAX(updated_at) AS at FROM scoped_memories WHERE scope='user' AND owner_id='user' AND archived_at IS NULL",
        )
        .get();
  const issue = budgetIssue(db, botId, since) ?? failure(db, botId, since);
  return {
    lastExtractionAt: typeof extraction?.at === "string" ? extraction.at : null,
    lastSavedAt: typeof saved?.at === "string" ? saved.at : null,
    ...(issue ? { issue } : {}),
  };
}

export function memoryAttemptReceipt(
  db: DatabaseSync,
  task: "extraction" | "organization",
  id: string,
) {
  const table = task === "extraction" ? "memory_extractions" : "memory_organizations";
  return db.prepare(`SELECT status,error,tokens FROM ${table} WHERE id=?`).get(id);
}
