import type { DatabaseSync } from "node:sqlite";
import {
  type GroupWorkflowRunStatus,
  GroupWorkflowRunStatusSchema,
  type GroupWorkflowStepStatus,
  GroupWorkflowStepStatusSchema,
  PlanRelaxationHistorySchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

export interface GroupWorkflowRunRecord {
  id: string;
  groupId: string;
  skillId: string;
  contractVersion: number | null;
  status: GroupWorkflowRunStatus;
  initiatorBotId: string;
  coordinatorBotId: string;
  cycleId: string;
  sourceMessageId: string;
  budgetRootRunId: string | null;
  workflow: unknown;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface GroupWorkflowStepRecord {
  workflowRunId: string;
  stepId: string;
  status: GroupWorkflowStepStatus;
  attempt: number;
  taskId: string | null;
  executionRunId: string | null;
  deliverables: unknown[];
  ownerBotId: string;
  decisionMessageId: string | null;
  updatedAt: string;
}

const runColumns = `id,group_id AS groupId,skill_id AS skillId,contract_version AS contractVersion,
status,initiator_bot_id AS initiatorBotId,coordinator_bot_id AS coordinatorBotId,cycle_id AS cycleId,
source_message_id AS sourceMessageId,budget_root_run_id AS budgetRootRunId,workflow_json AS workflow,created_at AS createdAt,
updated_at AS updatedAt,finished_at AS finishedAt`;
const stepColumns = `workflow_run_id AS workflowRunId,step_id AS stepId,status,attempt,task_id AS taskId,
execution_run_id AS executionRunId,deliverables_json AS deliverables,owner_bot_id AS ownerBotId,
decision_message_id AS decisionMessageId,updated_at AS updatedAt`;

const run = (row: Record<string, unknown>): GroupWorkflowRunRecord => ({
  id: String(row.id),
  groupId: String(row.groupId),
  skillId: String(row.skillId),
  contractVersion: row.contractVersion === null ? null : Number(row.contractVersion),
  status: GroupWorkflowRunStatusSchema.parse(row.status),
  initiatorBotId: String(row.initiatorBotId),
  coordinatorBotId: String(row.coordinatorBotId),
  cycleId: String(row.cycleId),
  sourceMessageId: String(row.sourceMessageId),
  budgetRootRunId: row.budgetRootRunId === null ? null : String(row.budgetRootRunId),
  workflow: JSON.parse(String(row.workflow)),
  createdAt: String(row.createdAt),
  updatedAt: String(row.updatedAt),
  finishedAt: row.finishedAt === null ? null : String(row.finishedAt),
});
const step = (row: Record<string, unknown>): GroupWorkflowStepRecord => ({
  workflowRunId: String(row.workflowRunId),
  stepId: String(row.stepId),
  status: GroupWorkflowStepStatusSchema.parse(row.status),
  attempt: Number(row.attempt),
  taskId: row.taskId === null ? null : String(row.taskId),
  executionRunId: row.executionRunId === null ? null : String(row.executionRunId),
  deliverables: JSON.parse(String(row.deliverables)),
  ownerBotId: String(row.ownerBotId),
  decisionMessageId: row.decisionMessageId === null ? null : String(row.decisionMessageId),
  updatedAt: String(row.updatedAt),
});

/** Durable DAG repository. Callers group multi-row transitions in `transaction()`. */
export class GroupWorkflowsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Record each applied engine migration once, when startup has a real main Bot for audit. A fresh
   * install has no group to migrate, so `needed` settles the marker silently instead of telling the
   * person that something was migrated.
   */
  auditMigration(version: number, needed: () => boolean, append: () => void) {
    transaction(this.db, () => {
      const key = `group-workflow-migration-audit:${version}`;
      if (!this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)) return;
      if (this.db.prepare("SELECT 1 FROM settings WHERE key=?").get(key)) return;
      if (needed()) append();
      this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(key, "true");
    });
  }

  /** Group data the workflow migrations could have touched; none on a new install. */
  hasGroups() {
    return this.db.prepare("SELECT 1 FROM groups LIMIT 1").get() !== undefined;
  }

  create(input: Omit<GroupWorkflowRunRecord, "createdAt" | "updatedAt" | "finishedAt">) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO group_workflow_runs(
          id,group_id,skill_id,contract_version,status,initiator_bot_id,coordinator_bot_id,
          cycle_id,source_message_id,budget_root_run_id,workflow_json,created_at,updated_at,finished_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.groupId,
        input.skillId,
        input.contractVersion,
        GroupWorkflowRunStatusSchema.parse(input.status),
        input.initiatorBotId,
        input.coordinatorBotId,
        input.cycleId,
        input.sourceMessageId,
        input.budgetRootRunId,
        JSON.stringify(input.workflow),
        now,
        now,
        null,
      );
    return this.get(input.id) as GroupWorkflowRunRecord;
  }

  createStep(input: Omit<GroupWorkflowStepRecord, "updatedAt">) {
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO group_workflow_steps(
        workflow_run_id,step_id,status,attempt,task_id,execution_run_id,deliverables_json,
        owner_bot_id,decision_message_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.workflowRunId,
        input.stepId,
        GroupWorkflowStepStatusSchema.parse(input.status),
        input.attempt,
        input.taskId,
        input.executionRunId,
        JSON.stringify(input.deliverables),
        input.ownerBotId,
        input.decisionMessageId,
        now,
      );
  }

  get(id: string) {
    const row = this.db.prepare(`SELECT ${runColumns} FROM group_workflow_runs WHERE id=?`).get(id);
    return row ? run(row) : undefined;
  }

  /** Tombstones survive retry/replan/restart; a later association never restores old authority. */
  revokeWorkplaces(groupId: string, folderId?: string) {
    this.db
      .prepare(`UPDATE group_workflow_runs
      SET workflow_json=json_set(workflow_json,'$.workplaceRevoked',json('true')),updated_at=?
      WHERE group_id=? AND (? IS NULL OR json_type(workflow_json,'$.workplace') IS NULL
        OR EXISTS (SELECT 1 FROM json_each(workflow_json,'$.workplace.folders') f
          WHERE json_extract(f.value,'$.id')=?))`)
      .run(new Date().toISOString(), groupId, folderId ?? null, folderId ?? null);
  }

  workplaceRevoked(id: string) {
    return (
      this.db
        .prepare(`SELECT 1 FROM group_workflow_runs WHERE id=?
      AND json_extract(workflow_json,'$.workplaceRevoked')=1`)
        .get(id) !== undefined
    );
  }

  updateWorkflow(id: string, workflow: unknown) {
    this.db
      .prepare(`UPDATE group_workflow_runs SET workflow_json=
        CASE WHEN json_extract(workflow_json,'$.workplaceRevoked')=1
          THEN json_set(?,'$.workplaceRevoked',json('true')) ELSE ? END,updated_at=? WHERE id=?`)
      .run(JSON.stringify(workflow), JSON.stringify(workflow), new Date().toISOString(), id);
  }

  byPlan(planId: string) {
    const row = this.db
      .prepare(`SELECT ${runColumns} FROM group_workflow_runs
      WHERE id=? AND json_extract(workflow_json,'$.source.kind')='dynamic'`)
      .get(planId);
    return row ? run(row) : undefined;
  }

  replanning(runId: string) {
    const row = this.db
      .prepare(`SELECT ${runColumns} FROM group_workflow_runs
      WHERE status='waiting' AND json_extract(workflow_json,'$.progress.replanRunId')=? LIMIT 1`)
      .get(runId);
    return row ? run(row) : undefined;
  }

  /** The newest plan sharing a budget root, i.e. the last replacement of a plan chain. */
  latestPlan(groupId: string, cycleId: string, budgetRootRunId: string) {
    const row = this.db
      .prepare(`SELECT ${runColumns} FROM group_workflow_runs
      WHERE group_id=? AND cycle_id=? AND budget_root_run_id=?
      AND json_extract(workflow_json,'$.source.kind')='dynamic' ORDER BY rowid DESC LIMIT 1`)
      .get(groupId, cycleId, budgetRootRunId);
    return row ? run(row) : undefined;
  }

  /** Whether any plan of a chain (one budget root) still runs: its step workspaces are in use. */
  chainActive(budgetRootRunId: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM group_workflow_runs WHERE budget_root_run_id=?
        AND status IN ('running','waiting') LIMIT 1`)
      .get(budgetRootRunId);
  }

  /** The running dynamic plan that owns a group's current cycle. */
  activePlan(groupId: string, cycleId: string) {
    const row = this.db
      .prepare(`SELECT ${runColumns} FROM group_workflow_runs
      WHERE group_id=? AND status IN ('running','waiting') AND cycle_id=?
      AND json_extract(workflow_json,'$.source.kind')='dynamic' ORDER BY rowid DESC LIMIT 1`)
      .get(groupId, cycleId);
    return row ? run(row) : undefined;
  }

  /** A group's running or waiting plans (any cycle), for the chat's pause and continue words. */
  activeForGroup(groupId: string, limit = 20) {
    return this.db
      .prepare(`SELECT ${runColumns} FROM group_workflow_runs
        WHERE group_id=? AND status IN ('running','waiting') ORDER BY rowid LIMIT ?`)
      .all(groupId, Math.min(Math.max(limit, 1), 100))
      .map(run);
  }

  active(afterId?: string, limit = 100) {
    return this.db
      .prepare(`SELECT ${runColumns} FROM group_workflow_runs
        WHERE status IN ('running','waiting') AND id>? ORDER BY id LIMIT ?`)
      .all(afterId ?? "", Math.min(Math.max(limit, 1), 100))
      .map(run);
  }

  setBudgetRoot(id: string, runId: string) {
    this.db
      .prepare(`UPDATE group_workflow_runs SET budget_root_run_id=COALESCE(budget_root_run_id,?),
        updated_at=? WHERE id=?`)
      .run(runId, new Date().toISOString(), id);
    return this.get(id)?.budgetRootRunId;
  }

  steps(id: string) {
    return this.db
      .prepare(`SELECT ${stepColumns} FROM group_workflow_steps
        WHERE workflow_run_id=? ORDER BY rowid`)
      .all(id)
      .map(step);
  }

  /**
   * Open tasks of every attempt of one step. Each attempt's first run carries the step's trigger
   * (`group-workflow:<run>:<step>:<attempt>[:<previous run>]`); later runs of a task share its id.
   */
  openStepTasks(workflowRunId: string, stepId: string): string[] {
    return this.db
      .prepare(`SELECT DISTINCT t.id FROM runs r JOIN group_tasks t ON t.id=r.task_id
        WHERE r.trigger_key GLOB ? AND t.status='open' ORDER BY t.created_at,t.id LIMIT 50`)
      .all(`group-workflow:${workflowRunId}:${stepId}:*`)
      .map((row) => String(row.id));
  }

  /**
   * Scalar facts only: retries and inherited passed steps count once per logical step. A plan the
   * user stopped before a later plan of the same request is not part of what this reply did.
   */
  executionSummary(groupId: string, conversationId: string, cycleId: string) {
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT w.id) AS plans,
        MAX(w.status IN ('running','waiting')) AS active,
        MAX(json_extract(w.workflow_json,'$.acceptanceRelaxed')=1) AS acceptanceRelaxed,
        COUNT(DISTINCT CASE WHEN (r.started_at IS NOT NULL OR EXISTS (
          SELECT 1 FROM group_task_handoffs h JOIN runs a ON a.task_id=h.task_id
          WHERE json_extract(h.spec,'$.workflowStep.workflowRunId')=w.id
            AND json_extract(h.spec,'$.workflowStep.stepId')=s.step_id
            AND a.started_at IS NOT NULL
        )) AND NOT (json_extract(w.workflow_json,'$.progress.stoppedReason')='user_stopped'
          AND EXISTS (SELECT 1 FROM group_workflow_runs later WHERE later.group_id=w.group_id
            AND later.cycle_id=w.cycle_id AND later.created_at>w.created_at))
        THEN s.step_id END) AS steps,
        EXISTS(SELECT 1 FROM runs d WHERE d.group_id=? AND d.cycle_id=?
          AND ((d.kind='group_task' AND d.task_id IS NOT NULL)
            OR (d.kind='wake' AND d.trigger_key GLOB '*:ask_bot'))) AS delegated
        FROM group_workflow_runs w
        JOIN messages m ON m.id=w.source_message_id
        LEFT JOIN group_workflow_steps s ON s.workflow_run_id=w.id
        LEFT JOIN runs r ON r.id=s.execution_run_id
        WHERE w.group_id=? AND m.conversation_id=? AND w.cycle_id=?`)
      .get(groupId, cycleId, groupId, conversationId, cycleId);
    return {
      plans: Number(row?.plans ?? 0),
      active: !!row?.active,
      acceptanceRelaxed: !!row?.acceptanceRelaxed,
      steps: Number(row?.steps ?? 0),
      delegated: !!row?.delegated,
    };
  }

  /** The latest cumulative list already includes both user-confirmed replan rounds. */
  executionRelaxations(groupId: string, conversationId: string, cycleId: string) {
    const row = this.db
      .prepare(`SELECT json_extract(w.workflow_json,'$.relaxationDetails') AS details
      FROM group_workflow_runs w JOIN messages m ON m.id=w.source_message_id
      WHERE w.group_id=? AND m.conversation_id=? AND w.cycle_id=?
        AND json_type(w.workflow_json,'$.relaxationDetails')='array'
      ORDER BY w.rowid DESC LIMIT 1`)
      .get(groupId, conversationId, cycleId);
    return row ? PlanRelaxationHistorySchema.parse(JSON.parse(String(row.details))) : [];
  }

  running(after: readonly [string, string], limit = 50) {
    return this.db
      .prepare(`SELECT ${stepColumns} FROM group_workflow_steps
      WHERE status='running' AND (workflow_run_id>? OR (workflow_run_id=? AND step_id>?))
      ORDER BY workflow_run_id,step_id LIMIT ?`)
      .all(after[0], after[0], after[1], Math.min(Math.max(limit, 1), 50))
      .map(step);
  }

  rebindCycle(id: string, cycleId: string) {
    this.db
      .prepare("UPDATE group_workflow_runs SET cycle_id=?,updated_at=? WHERE id=?")
      .run(cycleId, new Date().toISOString(), id);
  }

  byTask(taskId: string) {
    const row = this.db
      .prepare(`SELECT ${stepColumns} FROM group_workflow_steps WHERE task_id=?`)
      .get(taskId);
    return row ? step(row) : undefined;
  }

  updateStep(
    workflowRunId: string,
    stepId: string,
    patch: Partial<
      Pick<
        GroupWorkflowStepRecord,
        | "status"
        | "attempt"
        | "taskId"
        | "executionRunId"
        | "deliverables"
        | "ownerBotId"
        | "decisionMessageId"
      >
    >,
  ) {
    const current = this.steps(workflowRunId).find((item) => item.stepId === stepId);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(`UPDATE group_workflow_steps SET status=?,attempt=?,task_id=?,execution_run_id=?,
        deliverables_json=?,owner_bot_id=?,decision_message_id=?,updated_at=?
        WHERE workflow_run_id=? AND step_id=?`)
      .run(
        GroupWorkflowStepStatusSchema.parse(next.status),
        next.attempt,
        next.taskId,
        next.executionRunId,
        JSON.stringify(next.deliverables),
        next.ownerBotId,
        next.decisionMessageId,
        next.updatedAt,
        workflowRunId,
        stepId,
      );
    return next;
  }

  updateRun(id: string, status: GroupWorkflowRunStatus) {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE group_workflow_runs SET status=?,updated_at=?,finished_at=
        CASE WHEN ? IN ('passed','failed','cancelled') THEN COALESCE(finished_at,?) ELSE NULL END
        WHERE id=?`)
      .run(GroupWorkflowRunStatusSchema.parse(status), now, status, now, id);
    return this.get(id);
  }
}
