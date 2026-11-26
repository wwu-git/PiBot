// Stores workflow progress and owns the transition when a plan stops.
import { createHash } from "node:crypto";
import type { ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  type GroupPlanCard,
  GroupVerificationSchema,
  ReportVerdictSchema,
  type RunStopCause,
} from "@pibot/protocol-base";
import {
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  type GroupWorkflowsRepo,
  MessagesRepo,
  RunReceiptRepo,
  transaction,
} from "@pibot/storage";
import { z } from "zod";
import type { GroupService } from "./group-service.ts";
import { handoffReportVerdict } from "./group-verdict-results.ts";
import { settlePlanWebConsent } from "./group-web-consent.ts";
import {
  DeliveryReviewSchema,
  reviewConclusion,
  supplementConclusion,
} from "./group-workflow-delivery-review.ts";
import { GroupWorkflowReplanner } from "./group-workflow-replan.ts";
import { closeStepTasks } from "./group-workflow-step-tasks.ts";
import { workflowStopText } from "./group-workflow-stop-text.ts";

const Entry = z.strictObject({
  artifacts: z.array(z.string().max(4096)).max(50),
  checks: z.array(z.string().max(80)).max(50),
  fingerprint: z.string().max(64),
  repeated: z.number().int().nonnegative().default(0),
  unmet: z.number().int().nonnegative().default(0),
  stalled: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  pdfFiles: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(20)
    .optional(),
  pdfReadFiles: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(20)
    .optional(),
  pdf: z
    .strictObject({
      read: z.number().int().min(0).max(20),
      total: z.number().int().min(0).max(20),
      truncated: z.boolean(),
    })
    .optional(),
});
const Progress = z.strictObject({
  version: z.literal(1),
  implementation: GroupVerificationSchema.optional(),
  replans: z.number().int().min(0).max(2),
  requested: z.boolean(),
  verdicts: z
    .record(z.string(), ReportVerdictSchema)
    .refine((items) => Object.keys(items).length <= 20)
    .default(() => ({})),
  verdictRepairs: z
    .record(z.string(), z.string())
    .refine((items) => Object.keys(items).length <= 20)
    .default(() => ({})),
  verdictFixes: z
    .record(z.string(), z.string())
    .refine((items) => Object.keys(items).length <= 20)
    .default(() => ({})),
  verdictSkips: z
    .record(z.string(), z.literal(true))
    .refine((items) => Object.keys(items).length <= 20)
    .default(() => ({})),
  verdictResubmissions: z
    .record(z.string(), z.literal(true))
    .refine((items) => Object.keys(items).length <= 20)
    .default(() => ({})),
  /**
   * Reviewed steps whose FAIL verdict the user kept as it is (after skipping its repair, or by
   * continuing past the replan limit). They count as resolved, so their dependents can run.
   */
  verdictAccepts: z
    .record(z.string(), z.literal(true))
    .refine((items) => Object.keys(items).length <= 20)
    .optional(),
  /**
   * The plan waits for the user's choice on its card instead of planning again or rechecking:
   * no replans left, or a repair the user skipped (its reviewed steps keep FAIL meanwhile).
   */
  hold: z
    .strictObject({
      kind: z.enum(["replan_limit", "fix_skipped"]),
      stepIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)).max(20),
    })
    .optional(),
  /** Steps whose last run stopped because what it read did not fit; the next brief says so. */
  contextFull: z
    .record(z.string(), z.literal(true))
    .refine((items) => Object.keys(items).length <= 20)
    .optional(),
  replanRunId: z.string().optional(),
  /**
   * Maintainers 2026-11-20: steps whose run the group's pause stopped. They wait as `ready` at the same
   * attempt (a pause is not a fix round) and run again when the group continues.
   */
  paused: z
    .record(z.string(), z.literal(true))
    .refine((items) => Object.keys(items).length <= 20)
    .optional(),
  /**
   * Maintainers 2026-11-21: steps the group's continue released, with the stopped run and attempt.
   * Their rerun is told files may have changed and goes on in the workspace it had; a user's
   * retry (a new attempt) or any later run starts fresh as before.
   */
  resumed: z
    .record(
      z.string(),
      z.strictObject({
        runId: z.string().max(64),
        attempt: z.number().int().nonnegative(),
        /** When the stopped run ended and when the group continued: the rerun's summary window. */
        pausedAt: z.iso.datetime().optional(),
        continuedAt: z.iso.datetime().optional(),
      }),
    )
    .refine((items) => Object.keys(items).length <= 20)
    .optional(),
  /**
   * Steps the program already ran once more after the member's run stopped in a repeated-action
   * loop. A second loop goes to the user as before.
   */
  loopRetried: z
    .record(z.string(), z.literal(true))
    .refine((items) => Object.keys(items).length <= 50)
    .optional(),
  review: DeliveryReviewSchema.optional(),
  /** Why the program ended the plan (fixed reason code); `user_stopped` is the user's stop. */
  stoppedReason: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
  steps: z.record(z.string(), Entry).refine((steps) => Object.keys(steps).length <= 20),
  /** Maintainers 2026-11-14: why a passed step's workspace could not be merged, and which files. */
  merges: z
    .record(
      z.string(),
      z.strictObject({
        code: z.string().regex(/^[a-z_]{1,40}$/),
        files: z.array(z.string().max(500)).max(20),
      }),
    )
    .refine((merges) => Object.keys(merges).length <= 20)
    .optional(),
});
export type WorkflowProgress = z.infer<typeof Progress>;
export function progressOf(record: GroupWorkflowRunRecord): WorkflowProgress {
  const raw = (record.workflow as { progress?: unknown }).progress;
  return raw === undefined
    ? {
        version: 1,
        replans: 0,
        requested: false,
        steps: {},
        verdicts: {},
        verdictRepairs: {},
        verdictFixes: {},
        verdictSkips: {},
        verdictResubmissions: {},
      }
    : Progress.parse(raw);
}

/** Persist bounded execution facts, including redacted report declarations, under one lifecycle. */
export class GroupWorkflowProgress {
  private readonly drains = new Set<Promise<void>>();
  private readonly failedDrains = new Set<string>();
  private readonly replanner: GroupWorkflowReplanner;
  constructor(
    private readonly service: GroupService,
    private readonly repo: GroupWorkflowsRepo,
  ) {
    this.replanner = new GroupWorkflowReplanner(service, repo, this);
  }

  save(record: GroupWorkflowRunRecord, progress: WorkflowProgress) {
    const latest = this.repo.get(record.id);
    if (latest)
      this.repo.updateWorkflow(record.id, {
        ...(latest.workflow as object),
        progress: Progress.parse(progress),
      });
  }

  reading(
    context: ToolRunContext,
    pdf: NonNullable<import("@pibot/protocol-base").AuditDetail["pdfProgress"]>,
    path: string,
    readable: boolean,
  ) {
    if (!context.taskId || !context.groupId || this.service.signal.aborted) return;
    const state = this.repo.byTask(context.taskId);
    if (
      state?.status !== "running" ||
      state.executionRunId !== context.runId ||
      state.ownerBotId !== context.botId
    )
      return;
    const record = this.repo.get(state.workflowRunId);
    if (
      !record ||
      record.groupId !== context.groupId ||
      !["running", "waiting"].includes(record.status)
    )
      return;
    const progress = progressOf(record);
    const old = progress.steps[state.stepId];
    const read = new Set(old?.pdfReadFiles ?? []);
    if (readable) read.add(createHash("sha256").update(path).digest("hex"));
    progress.steps[state.stepId] = {
      artifacts: [],
      checks: [],
      fingerprint: "",
      repeated: 0,
      unmet: 0,
      stalled: 0,
      failures: 0,
      ...old,
      pdfReadFiles: [...read],
      pdf: {
        read: read.size,
        total: Math.max(pdf.total, old?.pdf?.total ?? 0, old?.pdfFiles?.length ?? 0),
        truncated: pdf.truncated || (old?.pdf?.truncated ?? false),
      },
    };
    this.save(record, progress);
  }

  /** Durable admission prevents a retry or explicit resume from opening the next batch in one step. */
  admit(context: ToolRunContext, path: string) {
    if (!context.taskId || !context.groupId) return true;
    const state = this.repo.byTask(context.taskId);
    if (!state) return true;
    const record = this.repo.get(state.workflowRunId);
    if (
      this.service.signal.aborted ||
      state.status !== "running" ||
      state.executionRunId !== context.runId ||
      state.ownerBotId !== context.botId ||
      record?.groupId !== context.groupId ||
      !["running", "waiting"].includes(record.status)
    )
      return false;
    const progress = progressOf(record);
    const old = progress.steps[state.stepId];
    const files = new Set(old?.pdfFiles ?? []);
    const digest = createHash("sha256").update(path).digest("hex");
    if (files.has(digest)) return true;
    if (files.size >= 20) return false;
    files.add(digest);
    progress.steps[state.stepId] = {
      artifacts: [],
      checks: [],
      fingerprint: "",
      repeated: 0,
      unmet: 0,
      stalled: 0,
      failures: 0,
      ...old,
      pdfFiles: [...files],
    };
    this.save(record, progress);
    return true;
  }

  observe(record: GroupWorkflowRunRecord, state: GroupWorkflowStepRecord, failed: boolean) {
    const progress = progressOf(this.repo.get(record.id) ?? record);
    const result = state.taskId ? this.service.handoffs.repo.get(state.taskId)?.result : undefined;
    const report = handoffReportVerdict(result?.items ?? []);
    if (!failed && report) progress.verdicts[state.stepId] = report;
    const old = progress.steps[state.stepId];
    const artifacts = [...new Set(result?.artifacts ?? [])].sort().slice(0, 50);
    const checks = [
      ...new Set(
        result?.items.filter((item) => item.status === "pass").map((item) => item.id) ?? [],
      ),
    ]
      .sort()
      .slice(0, 50);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          result?.items.map((item) => [item.id, item.status, item.reason, item.missing ?? []]) ??
            [],
        ),
      )
      .digest("hex");
    const unmet =
      result?.items.reduce(
        (sum, item) => sum + (item.status === "fail" ? 1 + (item.missing?.length ?? 0) : 0),
        0,
      ) ?? 0;
    const advanced =
      artifacts.some((path) => !old?.artifacts.includes(path)) ||
      checks.some((id) => !old?.checks.includes(id)) ||
      (old !== undefined && unmet < old.unmet);
    const observedPdf = this.pdfProgress(state.executionRunId).pdf;
    const pdf = old?.pdf
      ? { ...old.pdf, truncated: old.pdf.truncated || (observedPdf?.truncated ?? false) }
      : observedPdf;
    progress.steps[state.stepId] = {
      artifacts: [...new Set([...(old?.artifacts ?? []), ...artifacts])].slice(0, 50),
      checks: [...new Set([...(old?.checks ?? []), ...checks])].slice(0, 50),
      fingerprint,
      repeated: failed && old?.fingerprint === fingerprint ? old.repeated + 1 : 0,
      unmet,
      stalled: failed && !advanced ? (old?.stalled ?? 0) + 1 : 0,
      failures: (old?.failures ?? 0) + (failed ? 1 : 0),
      ...(old?.pdfFiles ? { pdfFiles: old.pdfFiles } : {}),
      ...(old?.pdfReadFiles ? { pdfReadFiles: old.pdfReadFiles } : {}),
      ...(pdf ? { pdf } : {}),
    };
    if (failed && (progress.steps[state.stepId]?.stalled ?? 0) >= 2) progress.requested = true;
    this.save(record, progress);
    return progress;
  }

  private pdfProgress(runId: string | null) {
    if (!runId) return {};
    const audit = new RunReceiptRepo(this.service.deps.db).audit(runId);
    const entries = audit.rows.flatMap((row) =>
      row.kind === "file.read" && row.detail.pdfProgress ? [row.detail.pdfProgress] : [],
    );
    const latest = entries.at(-1);
    return latest
      ? { pdf: { ...latest, truncated: audit.truncated || entries.some((item) => item.truncated) } }
      : {};
  }

  request(record: GroupWorkflowRunRecord) {
    const progress = progressOf(this.repo.get(record.id) ?? record);
    progress.requested = true;
    this.save(record, progress);
  }

  hardLimit(record: GroupWorkflowRunRecord, admitting = false): string | undefined {
    const cycle = this.service.cycles.get(record.groupId);
    if (cycle.cycleId !== record.cycleId) return "cycle_replaced";
    if (cycle.limited) return "round_limit";
    const root = record.budgetRootRunId;
    if (root && this.service.runs.get(root)?.status === "aborted") return "source_stopped";
    const budget = root ? this.service.deps.local.budgets.repo.get(root) : undefined;
    if (!budget) return "budget_unavailable";
    return (
      this.service.deps.local.budgets.repo.reason(budget) ??
      (admitting && budget.requests >= budget.limits.modelRequests ? "model_requests" : undefined)
    );
  }

  stop(record: GroupWorkflowRunRecord, reason: string, actor: "user" | "system" = "system") {
    const runs: string[] = [];
    const stopped = transaction(this.service.deps.db, () => {
      const latest = this.repo.get(record.id);
      if (!latest || !["running", "waiting"].includes(latest.status)) return;
      this.repo.updateRun(record.id, "failed");
      // A pending replan ends with the plan: its run is drained below, and a replacement it may
      // still submit is refused (`replacement()` requires the replaced plan to be waiting).
      const progress = progressOf(latest);
      this.save(latest, {
        ...progress,
        requested: false,
        hold: undefined,
        stoppedReason: reason,
      });
      for (const step of this.repo.steps(record.id)) {
        if (step.status !== "running") continue;
        if (step.executionRunId) runs.push(step.executionRunId);
        if (step.taskId) this.service.cycles.claimWake(step.taskId);
        this.repo.updateStep(record.id, step.stepId, { status: "blocked" });
      }
      const states = this.repo.steps(record.id);
      const supplement = states.find((step) => step.stepId === progress.review?.supplementStepId);
      const language = this.service.deps.chat.currentLanguage();
      new MessagesRepo(this.service.deps.db).create({
        conversationId: this.service.groups.get(record.groupId)?.conversationId ?? "",
        botId: record.coordinatorBotId,
        role: "assistant",
        status: "done",
        content: this.service.deps.redactor.redact(
          [
            workflowStopText(record, states, reason, actor, language),
            ...(progress.review ? reviewConclusion(progress.review, language === "zh") : []),
            ...(supplement
              ? [supplementConclusion(this.service, latest, supplement, language === "zh")]
              : []),
          ].join("\n"),
        ),
      });
      this.service.deps.local.approvals.audit.append({
        botId: record.coordinatorBotId,
        kind: "group.workflow.step_blocked",
        summary: "Group plan stopped / 群计划停止",
        detail: {
          groupId: record.groupId,
          workflowRunId: record.id,
          reasonCode: reason,
          actor,
        },
      });
      return true;
    });
    if (!stopped) return;
    const source = new MessagesRepo(this.service.deps.db).get(record.sourceMessageId);
    if (source) this.service.deps.local.memoryExtraction?.boundary(source.conversationId);
    settlePlanWebConsent(this.service, record);
    // Maintainers 2026-11-14: unmerged step workspaces and Pi Bot's folder repository go with the plan.
    this.service.workflows.merges.ended(record);
    const replan = progressOf(this.repo.get(record.id) ?? record).replanRunId;
    if (replan) runs.push(replan);
    // The user's stop also ends the plan's source run (its budget root), as its stop button does.
    if (actor === "user" && record.budgetRootRunId) runs.push(record.budgetRootRunId);
    const exhausted = record.budgetRootRunId
      ? this.service.deps.local.budgets.repo.get(record.budgetRootRunId)?.exhaustedReason
      : undefined;
    const drained = this.drain(runs, record.id, {
      code:
        actor === "user"
          ? "user_stopped"
          : reason === "cycle_replaced"
            ? "superseded"
            : exhausted === "repeated_operation"
              ? "repeated_operation"
              : exhausted
                ? "budget_exhausted"
                : "workflow_stopped",
    });
    // Unfinished steps' tasks close once their runs are gone, so none stays open after the plan.
    // A cost stop keeps them: raising the budget resumes the stopped step on its own task.
    void Promise.allSettled(drained)
      .then(() => {
        if (this.service.signal.aborted || reason === "cost") return;
        closeStepTasks(
          this.service,
          record,
          this.repo.steps(record.id).map((step) => step.stepId),
          "plan_stopped",
          actor,
        );
      })
      .catch(() =>
        this.service.deps.logger.warn(
          JSON.stringify({
            module: "group-workflow",
            event: "stopped_tasks_close_failed",
            workflowRunId: record.id,
          }),
        ),
      );
    this.service.changed(record.groupId, "updated");
  }

  quiesce(record: GroupWorkflowRunRecord) {
    const runs = this.repo
      .steps(record.id)
      .flatMap((step) =>
        step.status === "running" && step.executionRunId ? [step.executionRunId] : [],
      );
    if (record.budgetRootRunId) runs.push(record.budgetRootRunId);
    const replan = progressOf(record).replanRunId;
    if (replan) runs.push(replan);
    this.drain(runs, record.id, { code: "shutdown" });
  }

  private drain(runs: string[], workflowRunId: string, cause: RunStopCause) {
    const started: Promise<void>[] = [];
    for (const id of new Set(runs)) {
      const drain = this.service.deps.chat.queue.abortTree(id, cause);
      started.push(drain);
      this.drains.add(drain);
      void drain.then(
        () => this.drains.delete(drain),
        () => {
          this.drains.delete(drain);
          this.failedDrains.add(id);
          this.service.deps.logger.error(
            JSON.stringify({
              module: "group-workflow",
              event: "limit_drain_failed",
              workflowRunId,
            }),
          );
        },
      );
    }
    return started;
  }

  async settled() {
    await Promise.allSettled([...this.drains]);
    // A timed-out wait is not proof of release. Re-check the same queue-owned runs at shutdown;
    // only a real second drain (or an entry already removed by completion) certifies cleanup.
    for (const id of this.failedDrains) {
      await this.service.deps.chat.queue.abortTree(id);
      this.failedDrains.delete(id);
    }
  }

  /** All children must have settled before the coordinator may change their graph. */
  replan(record: GroupWorkflowRunRecord, signal: AbortSignal) {
    return this.replanner.replan(record, signal);
  }

  replacement(card: GroupPlanCard) {
    return this.replanner.replacement(card);
  }
}
