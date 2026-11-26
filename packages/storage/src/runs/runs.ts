import type { DatabaseSync } from "node:sqlite";
import {
  type Page,
  RUN_INTERRUPTED,
  type Run,
  RunSchema,
  type RunStopCause,
  RunStopCauseSchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";
import { markEmptyCancelledWake } from "./empty-wake.ts";
import { RunEventsRepo } from "./run-events.ts";
import { KEPT_QUEUED } from "./run-recovery.ts";

const columns = `id,bot_id AS botId,conversation_id AS conversationId,group_id AS groupId,kind,status,message_id AS messageId,user_message_id AS userMessageId,task_id AS taskId,cycle_id AS cycleId,automatic,parent_run_id AS parentRunId,after_run_id AS afterRunId,ancestry,trigger_key AS triggerKey,session_file AS sessionFile,stop_reason AS stopReason,error_code AS errorCode,created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt`;
function parse(row: Record<string, unknown>): Run {
  return RunSchema.parse({
    ...row,
    automatic: row.automatic === 1,
    ancestry: JSON.parse(String(row.ancestry)),
  });
}
/**
 * Message bubbles only carry streaming/done/error/aborted, while run terminal states are wider
 * (routine bookkeeping also ends runs as cancelled / interrupted / timeout / failed). The reply
 * paths have always written `aborted` for an aborted run and `error` for everything else, so the
 * mapping lives here where the SQL write happens and cannot be skipped by a caller.
 */
function messageStatus(status: string): "done" | "error" | "aborted" {
  if (status === "done") return "done";
  return status === "aborted" || status === "cancelled" || status === "interrupted"
    ? "aborted"
    : "error";
}
export class RunsRepo {
  constructor(private readonly db: DatabaseSync) {}
  /**
   * Parked chat approvals outlive their SDK run; multiple cards still represent one task.
   * The IN list repeats the runs_unfinished partial-index predicate verbatim so SQLite uses it
   * (a narrower list scans every historical run on each tray refresh).
   */
  activeCount(): number {
    return Number(
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM (
        SELECT id FROM runs WHERE status IN ('queued','running','waiting') AND status != 'queued'
        UNION
        SELECT run_id FROM approvals WHERE status='pending'
      )`)
        .get()?.n ?? 0,
    );
  }
  get(id: string): Run | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM runs WHERE id=?`).get(id);
    return row ? parse(row) : undefined;
  }
  trigger(key: string): Run | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM runs WHERE trigger_key=?`).get(key);
    return row ? parse(row) : undefined;
  }
  hasRunAfter(id: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM runs next JOIN runs source ON source.id=?
      WHERE next.bot_id=source.bot_id AND next.conversation_id=source.conversation_id
      AND next.rowid>source.rowid LIMIT 1`)
      .get(id);
  }
  hasNewUserRunAfter(id: string): boolean {
    // rowid preserves insertion order even when two turns share a millisecond.
    return !!this.db
      .prepare(`SELECT 1 FROM runs next JOIN runs source ON source.id=?
      WHERE next.bot_id=source.bot_id AND next.conversation_id=source.conversation_id
      AND next.rowid>source.rowid AND next.automatic=0 LIMIT 1`)
      .get(id);
  }
  /** Whether work started by this run (child tasks or an automatic continuation) is still live. */
  hasActiveChild(id: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM runs WHERE parent_run_id=? AND status IN ('queued','running','stopping') LIMIT 1`,
      )
      .get(id);
  }
  /** Whether the program is running members of this group on its own (plan steps, hand-offs). */
  hasActiveAutomatic(groupId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM runs WHERE group_id=? AND automatic=1 AND status IN ('queued','running','waiting','stopping') LIMIT 1`,
      )
      .get(groupId);
  }
  /** A solo decision lasts through queued continuations and live background processes. */
  hasActiveForCycle(groupId: string, cycleId: string): boolean {
    return !!this.db
      .prepare(`WITH RECURSIVE cycle_runs(id) AS (
      SELECT id FROM runs WHERE group_id=? AND cycle_id=?
      UNION SELECT child.id FROM runs child JOIN cycle_runs parent ON child.parent_run_id=parent.id
    ) SELECT 1 FROM runs r JOIN cycle_runs c ON c.id=r.id WHERE
      (r.status IN ('queued','running','waiting','stopping') OR EXISTS (
        SELECT 1 FROM background_commands b WHERE b.run_id=r.id AND b.status='running'
      )) LIMIT 1`)
      .get(groupId, cycleId);
  }
  /** Whether another admitted run of this group task (e.g. its continuation) is still live. */
  hasActiveForTask(taskId: string, exceptId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM runs WHERE task_id=? AND id<>? AND status IN ('queued','running','waiting','stopping') LIMIT 1`,
      )
      .get(taskId, exceptId);
  }
  /** Runs started by this run (execution children, continuations, member replies), bounded. */
  childIds(id: string, limit = 50): string[] {
    return this.db
      .prepare("SELECT id FROM runs WHERE parent_run_id=? ORDER BY rowid LIMIT ?")
      .all(id, Math.min(Math.max(limit, 1), 200))
      .map((row) => String(row.id));
  }
  backgroundChild(id: string): Run | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM runs WHERE (parent_run_id=? OR id IN (
        SELECT c.run_id FROM background_completion_runs c JOIN background_commands b ON b.id=c.job_id WHERE b.run_id=?))
      AND trigger_key LIKE 'background_finished:%' ORDER BY rowid DESC LIMIT 1`)
      .get(id, id);
    return row ? parse(row) : undefined;
  }
  /** Every run admitted for one group task (its turns, wakes and continuations), bounded. */
  taskRunIds(taskId: string, limit = 50): string[] {
    return this.db
      .prepare("SELECT id FROM runs WHERE task_id=? ORDER BY created_at,id LIMIT ?")
      .all(taskId, Math.min(Math.max(limit, 1), 200))
      .map((row) => String(row.id));
  }
  userReply(groupId: string, messageId: string, botId: string) {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM runs WHERE group_id=? AND user_message_id=? AND bot_id=? AND kind='chat' AND automatic=0 ORDER BY created_at,id LIMIT 1`,
      )
      .get(groupId, messageId, botId);
    return row ? parse(row) : undefined;
  }
  create(
    input: Omit<
      Run,
      | "status"
      | "createdAt"
      | "startedAt"
      | "finishedAt"
      | "sessionFile"
      | "stopReason"
      | "errorCode"
    >,
  ): Run {
    const v = RunSchema.parse({
      ...input,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      sessionFile: null,
      stopReason: null,
      errorCode: null,
    });
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO runs(id,bot_id,conversation_id,group_id,kind,status,message_id,user_message_id,task_id,cycle_id,automatic,parent_run_id,after_run_id,ancestry,trigger_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          v.id,
          v.botId,
          v.conversationId,
          v.groupId,
          v.kind,
          v.status,
          v.messageId,
          v.userMessageId,
          v.taskId,
          v.cycleId,
          Number(v.automatic),
          v.parentRunId,
          v.afterRunId,
          JSON.stringify(v.ancestry),
          v.triggerKey,
          v.createdAt,
        );
      new RunEventsRepo(this.db).append({
        runId: v.id,
        conversationId: v.conversationId,
        kind: "run.created",
        at: v.createdAt,
        payload: { status: v.status, runKind: v.kind, automatic: v.automatic },
      });
    });
    return v;
  }
  start(id: string): boolean {
    return transaction(this.db, () => {
      const at = new Date().toISOString();
      const changed =
        this.db
          .prepare(
            "UPDATE runs SET status='running',started_at=COALESCE(started_at,?) WHERE id=? AND status='queued'",
          )
          .run(at, id).changes > 0;
      const run = changed ? this.get(id) : undefined;
      if (run)
        new RunEventsRepo(this.db).append({
          runId: run.id,
          conversationId: run.conversationId,
          kind: "run.started",
          at,
          payload: { status: "running" },
        });
      return changed;
    });
  }
  session(id: string, file: string) {
    this.db.prepare("UPDATE runs SET session_file=? WHERE id=? AND status='running'").run(file, id);
  }
  reply(id: string, messageId: string): boolean {
    return (
      this.db
        .prepare(`UPDATE runs SET message_id=? WHERE id=? AND status='running'
      AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.run_id=runs.id
        AND m.bot_id=runs.bot_id AND m.conversation_id=runs.conversation_id
        AND m.role='assistant' AND m.status='streaming')`)
        .run(messageId, id, messageId).changes > 0
    );
  }
  /** Only the explicit user RPC records intent; shutdown/budget cancellation stays distinct. */
  requestUserStop(id: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE runs SET stop_reason='user_stopped' WHERE id=? AND status IN ('queued','running','waiting') AND COALESCE(stop_reason,'')<>'user_stopped'",
          )
          .run(id).changes,
      ) > 0
    );
  }
  /** The first stop owns the receipt even if a drain or restart later tries to stop it again. */
  recordStop(id: string, cause: RunStopCause) {
    return transaction(this.db, () => {
      if (
        this.db
          .prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='run.stopped' LIMIT 1")
          .get(id)
      )
        return false;
      const run = this.get(id);
      if (!run) return false;
      new RunEventsRepo(this.db).append({
        runId: id,
        conversationId: run.conversationId,
        kind: "run.stopped",
        payload: { cause },
      });
      return true;
    });
  }
  finish(
    id: string,
    status: "done" | "error" | "aborted",
    stopReason: string,
    errorCode: string | null = null,
  ) {
    transaction(this.db, () => {
      if (
        status === "aborted" &&
        stopReason === "aborted" &&
        this.get(id)?.stopReason === "user_stopped"
      )
        stopReason = "user_stopped";
      const at = new Date().toISOString();
      const changed = this.db
        .prepare(
          "UPDATE runs SET status=?,stop_reason=?,error_code=?,finished_at=? WHERE id=? AND status IN ('queued','running','waiting')",
        )
        .run(status, stopReason, errorCode, at, id).changes;
      // The run and its assistant bubble end in the same write. Paths with a reply
      // object have already ended their messages, so this hits only cancellations and bookkeeping
      // failures that end a run without one; `done` never leaves a streaming bubble behind.
      let messageChanged = 0;
      if (status !== "done") {
        const message = messageStatus(status);
        messageChanged = Number(
          this.db
            .prepare(
              `UPDATE messages SET status=?,error_code=?,usage=json_set(COALESCE(usage,'{}'),'$.stopReason',?)
          WHERE id=(SELECT message_id FROM runs WHERE id=?) AND status='streaming'`,
            )
            .run(message, errorCode ?? message, stopReason, id).changes,
        );
      }
      const run = changed ? this.get(id) : undefined;
      if (run)
        new RunEventsRepo(this.db).append({
          runId: run.id,
          conversationId: run.conversationId,
          kind: "run.finished",
          at,
          payload: { status, stopReason, errorCode },
        });
      if (run && status === "aborted") messageChanged += markEmptyCancelledWake(this.db, id);
      if (run && messageChanged) this.appendMessageFinalized(run, at);
    });
  }
  /**
   * Reclaims a row that is still queued but never reached the in-memory queue. The caller owns the
   * transaction, because the same step may also settle the message the run was created with.
   */
  abandonQueued(id: string, reason: string): boolean {
    return transaction(this.db, () => {
      const at = new Date().toISOString();
      const changed =
        this.db
          .prepare(
            "UPDATE runs SET status='aborted',stop_reason=?,error_code='aborted',finished_at=? WHERE id=? AND status='queued'",
          )
          .run(reason, at, id).changes > 0;
      if (!changed) return false;
      const messageChanged = this.db
        .prepare(
          "UPDATE messages SET status='aborted',error_code='aborted',usage=json_set(COALESCE(usage,'{}'),'$.stopReason','aborted') WHERE run_id=? AND status='streaming'",
        )
        .run(id).changes;
      const run = this.get(id);
      if (run) {
        const cause = RunStopCauseSchema.safeParse({ code: reason });
        this.recordStop(run.id, cause.success ? cause.data : { code: "cancelled" });
        new RunEventsRepo(this.db).append({
          runId: run.id,
          conversationId: run.conversationId,
          kind: "run.finished",
          at,
          payload: { status: "aborted", stopReason: reason, errorCode: "aborted" },
        });
      }
      if (run && messageChanged) this.appendMessageFinalized(run, at);
      if (run) new RunEventsRepo(this.db).sealTerminal(run.id);
      return true;
    });
  }
  list(scope: { botId?: string; groupId?: string; conversationId?: string }, page: Page = {}) {
    const filters: [string, string][] = [];
    if (scope.botId) filters.push(["bot_id", scope.botId]);
    if (scope.groupId) filters.push(["group_id", scope.groupId]);
    if (scope.conversationId) filters.push(["conversation_id", scope.conversationId]);
    return readPage(this.db, "runs", columns, "created_at", page, filters).map(parse);
  }
  /**
   * Startup: settles what an earlier process left. A started run is `aborted` with stop reason
   * `interrupted`: it may have had side effects before its last checkpoint, so it is
   * never replayed, only resumed when the user asks (`runs.resume`). A queued run never started;
   * the private-chat workflow runs `KEPT_QUEUED` names stay queued for the brain to publish
   * again, every other one ends as before (`restart`). Returns the interrupted runs.
   */
  recover(): { id: string; botId: string; conversationId: string }[] {
    return transaction(this.db, () => {
      const now = new Date().toISOString();
      const started = "status IN ('running','waiting') AND kind<>'routine'";
      const queued = `status='queued' AND kind<>'routine' AND NOT EXISTS (SELECT 1 FROM run_recovery x
        JOIN runs r ON r.id=x.run_id WHERE x.run_id=runs.id AND ${KEPT_QUEUED})`;
      const interrupted = this.db
        .prepare(
          `SELECT id,bot_id AS botId,conversation_id AS conversationId FROM runs WHERE ${started}`,
        )
        .all()
        .map((row) => ({
          id: String(row.id),
          botId: String(row.botId),
          conversationId: String(row.conversationId),
        }));
      const restarted = this.db
        .prepare(
          `SELECT id,bot_id AS botId,conversation_id AS conversationId FROM runs WHERE ${queued}`,
        )
        .all()
        .map((row) => ({
          id: String(row.id),
          botId: String(row.botId),
          conversationId: String(row.conversationId),
        }));
      // The bubble keeps the plain stopped look; `usage.stopReason` tells the UI it can resume.
      this.db
        .prepare(
          `UPDATE messages SET status='aborted',error_code='aborted',usage=json_set(COALESCE(usage,'{}'),'$.stopReason','${RUN_INTERRUPTED}') WHERE id IN (SELECT message_id FROM runs WHERE ${started})`,
        )
        .run();
      this.db
        .prepare(
          "UPDATE messages SET status='aborted',error_code='aborted',usage=json_set(COALESCE(usage,'{}'),'$.stopReason','aborted') WHERE id IN (SELECT message_id FROM runs WHERE " +
            queued +
            ")",
        )
        .run();
      // Losing one run does not cancel the task; the user can resume or retry its thread.
      this.db
        .prepare(
          `UPDATE runs SET status='aborted',stop_reason='${RUN_INTERRUPTED}',error_code='aborted',finished_at=? WHERE ${started}`,
        )
        .run(now);
      const events = new RunEventsRepo(this.db);
      for (const run of interrupted) {
        this.recordStop(run.id, { code: "restart" });
        events.append({
          runId: run.id,
          conversationId: run.conversationId,
          kind: "run.finished",
          at: now,
          payload: { status: "aborted", stopReason: RUN_INTERRUPTED, errorCode: "aborted" },
        });
      }
      this.db
        .prepare(
          `UPDATE runs SET status='aborted',stop_reason='restart',error_code='aborted',finished_at=? WHERE ${queued}`,
        )
        .run(now);
      for (const run of restarted) {
        this.recordStop(run.id, { code: "restart" });
        events.append({
          runId: run.id,
          conversationId: run.conversationId,
          kind: "run.finished",
          at: now,
          payload: { status: "aborted", stopReason: "restart", errorCode: "aborted" },
        });
        this.appendMessageFinalized(this.get(run.id) as Run, now);
      }
      for (const run of interrupted) this.appendMessageFinalized(this.get(run.id) as Run, now);
      return interrupted;
    });
  }
  /**
   * Shutdown (quit, update, system stop): runs this process was executing end `aborted` through
   * the normal stop path; they were not stopped by the user, so they get the same `interrupted`
   * mark a crash leaves and can be continued with `runs.resume`. Routine runs keep their
   * own resume path. Returns the runs it marked.
   */
  markInterrupted(ids: readonly string[]): { id: string; botId: string; conversationId: string }[] {
    if (!ids.length) return [];
    return transaction(this.db, () => {
      const marked: { id: string; botId: string; conversationId: string }[] = [];
      const select = this.db.prepare(
        "SELECT id,bot_id AS botId,conversation_id AS conversationId,message_id AS messageId FROM runs WHERE id=? AND status='aborted' AND kind<>'routine'",
      );
      const run = this.db.prepare(`UPDATE runs SET stop_reason='${RUN_INTERRUPTED}' WHERE id=?`);
      const message = this.db.prepare(
        `UPDATE messages SET usage=json_set(COALESCE(usage,'{}'),'$.stopReason','${RUN_INTERRUPTED}') WHERE id=? AND status='aborted'`,
      );
      for (const id of ids) {
        const row = select.get(id);
        if (!row) continue;
        run.run(id);
        message.run(String(row.messageId));
        new RunEventsRepo(this.db).append({
          runId: id,
          conversationId: String(row.conversationId),
          kind: "run.interrupted",
          payload: { status: "aborted", stopReason: RUN_INTERRUPTED },
        });
        marked.push({ id, botId: String(row.botId), conversationId: String(row.conversationId) });
      }
      return marked;
    });
  }

  private appendMessageFinalized(run: Run, at: string) {
    // Recovery settles the run's reply, even when attachment pages were inserted after it.
    const message = this.db
      .prepare(`SELECT id,role,content,status,error_code AS errorCode,
        length(CAST(content AS BLOB)) AS contentLength FROM messages
        WHERE run_id=? AND status<>'streaming'
        AND json_extract(usage,'$.attachmentContinuationOf') IS NULL
        ORDER BY id=? DESC, rowid DESC LIMIT 1`)
      .get(run.id, run.messageId);
    if (!message) return;
    new RunEventsRepo(this.db).append({
      runId: run.id,
      conversationId: run.conversationId,
      kind: "message.finalized",
      at,
      payload: {
        messageId: String(message.id),
        role: String(message.role),
        status: String(message.status),
        content: String(message.content),
        contentLength: Number(message.contentLength),
        errorCode: message.errorCode === null ? null : String(message.errorCode),
      },
    });
  }
}
