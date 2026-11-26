// Runs group workflows until their steps and durable terminal state settle.
import {
  type GroupExecutionPlan,
  type GroupPlanCard,
  GroupPlanConclusionSchema,
  type KernelMethodParams,
  RpcError,
  type WorkflowStep,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  GroupWorkflowsRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import type { HandoffGate } from "./group-handoffs.ts";
import { GroupPlanMerges } from "./group-plan-merges.ts";
import { stepMerged } from "./group-plan-step-workspaces.ts";
import { planConclusionLines } from "./group-plan-summary.ts";
import type { GroupService } from "./group-service.ts";
import { settlePlanWebConsent } from "./group-web-consent.ts";
import { GroupWorkflowDecisions } from "./group-workflow-decisions.ts";
import {
  canSupplement,
  deliveryReviewComplete,
  reviewConclusion,
  summaryStep,
  supplementConclusion,
} from "./group-workflow-delivery-review.ts";
import { GroupWorkflowDispatcher } from "./group-workflow-dispatch.ts";
import { stuckSteps } from "./group-workflow-disposition.ts";
import { GroupWorkflowManualReview } from "./group-workflow-manual.ts";
import { GroupWorkflowPause } from "./group-workflow-pause.ts";
import { GroupWorkflowProgress, progressOf } from "./group-workflow-progress.ts";
import { GroupWorkflowReconciler } from "./group-workflow-reconciler.ts";
import { GroupWorkflowSettlement } from "./group-workflow-settle.ts";
import {
  type WorkflowAuditKind,
  type WorkflowEngine,
  workflowOf,
} from "./group-workflow-snapshot.ts";
import { GroupWorkflowStarter } from "./group-workflow-start.ts";
import { GroupWorkflowStatus } from "./group-workflow-status.ts";
import { closeStepTasks } from "./group-workflow-step-tasks.ts";
import { archiveCompletedPlan, clearCompletedPlanPause } from "./group-workflow-todo.ts";
import {
  unresolvedVerdicts,
  verdictDependencyReady,
  verdictRepairReady,
  verdictStepLabel,
} from "./group-workflow-verdicts.ts";

const DISPATCH_MS = 30_000;

/**
 * Deterministic, durable group workflow scheduler. It owns the lifecycle and the per-run
 * scheduling loop; admission, dispatch, settlement and dispositions live in their own parts.
 */
export class GroupWorkflowScheduler implements WorkflowEngine {
  readonly repo: GroupWorkflowsRepo;
  readonly reconciliation: GroupWorkflowReconciler;
  /** The single ledger instance: every hard stop's drain is awaited by `stop()`. */
  readonly progress: GroupWorkflowProgress;
  /** Program-written progress lines; never a model turn. */
  private readonly status: GroupWorkflowStatus;
  private readonly starter: GroupWorkflowStarter;
  private readonly dispatcher: GroupWorkflowDispatcher;
  private readonly decisions: GroupWorkflowDecisions;
  private readonly settlement: GroupWorkflowSettlement;
  /** Maintainers 2026-11-20: steps the group's pause stopped wait here and run again on continue. */
  readonly pause: GroupWorkflowPause;
  readonly merges: GroupPlanMerges;
  private readonly scheduling = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly shutdown = new AbortController();
  private stopped = false;

  constructor(readonly service: GroupService) {
    this.repo = new GroupWorkflowsRepo(service.deps.db);
    this.progress = new GroupWorkflowProgress(service, this.repo);
    this.status = new GroupWorkflowStatus(service, this.repo);
    this.starter = new GroupWorkflowStarter(
      service,
      this.repo,
      this.progress,
      this.audit.bind(this),
      (id) => this.schedule(id),
    );
    this.dispatcher = new GroupWorkflowDispatcher(this);
    this.decisions = new GroupWorkflowDecisions(this);
    this.settlement = new GroupWorkflowSettlement(this);
    this.pause = new GroupWorkflowPause(this);
    this.merges = new GroupPlanMerges(this);
    this.reconciliation = new GroupWorkflowReconciler(
      service,
      this.repo,
      (record, state, reason) => {
        const definition = workflowOf(record).contract.steps?.find(
          (step) => step.id === state.stepId,
        );
        if (definition) this.block(record, definition, state, reason);
      },
      (taskId, gate, runId) => this.handleGate(taskId, gate, runId),
      (id) => this.schedule(id),
      (record, state) => this.pause.park(record, state),
      (record, state) => this.pause.retryAfterLoop(record, state),
    );
  }

  get closed() {
    return this.stopped;
  }

  get shutdownSignal() {
    return this.shutdown.signal;
  }

  startRecovery() {
    this.reconciliation.start();
    this.merges.start();
    const main = new BotsRepo(this.service.deps.db).getMain();
    if (main)
      for (const version of [87, 88])
        this.repo.auditMigration(
          version,
          () => this.repo.hasGroups(),
          () =>
            this.service.deps.local.approvals.audit.append({
              botId: main.id,
              kind: "group.workflow.migrated",
              summary: "Group execution schema migrated / 群执行引擎迁移已应用",
              detail: { actor: "system", reasonCode: `migration_${version}` },
            }),
        );
    let afterId: string | undefined;
    for (;;) {
      const page = this.repo.active(afterId);
      for (const record of page) {
        try {
          this.settlement.recover(record);
        } catch (error) {
          this.containScheduleFailure(record.id, error);
        }
      }
      if (page.length < 100) break;
      afterId = page.at(-1)?.id;
    }
  }

  start(...args: Parameters<GroupWorkflowStarter["start"]>) {
    return this.starter.start(...args);
  }

  startPlan(...args: Parameters<GroupWorkflowStarter["startPlan"]>) {
    return this.starter.startPlan(...args);
  }

  async startCard(
    card: GroupPlanCard,
    plan: GroupExecutionPlan,
    conversationId: string,
    signal: AbortSignal,
    assertCurrent: () => GroupExecutionPlan["contract"]["budget"],
  ) {
    if (this.stopped) throw new RpcError(-32602, "group_plan_stopped");
    const result = await this.starter.startCard(card, plan, conversationId, signal, () => {
      if (this.stopped) throw new RpcError(-32602, "group_plan_stopped");
      return assertCurrent();
    });
    if (card.disposition) {
      const record = this.repo.byPlan(card.id);
      if (record) this.announce(record);
    }
    return result;
  }

  handleGate(
    taskId: string,
    gate: Exclude<HandoffGate, { kind: "plain" | "wait" }>,
    finishedRunId: string,
  ) {
    return this.settlement.handleGate(taskId, gate, finishedRunId);
  }

  resolve(params: KernelMethodParams["groups.workflow.resolve"]) {
    return this.decisions.resolve(params);
  }

  createDecision(
    record: GroupWorkflowRunRecord,
    definition: WorkflowStep,
    attempt: number,
    reasonCode?: string,
    note?: string,
  ) {
    this.decisions.createDecision(record, definition, attempt, reasonCode, note);
  }

  block(
    record: GroupWorkflowRunRecord,
    definition: WorkflowStep,
    state: GroupWorkflowStepRecord,
    reason: string,
  ) {
    this.decisions.block(record, definition, state, reason);
  }

  requestMerge(workflowRunId: string, stepId: string) {
    this.merges.request(workflowRunId, stepId);
  }

  schedule(id: string) {
    if (this.stopped) return;
    if (this.scheduling.has(id)) {
      this.pending.add(id);
      return;
    }
    const work = this.scheduleNow(id)
      .catch((error) => this.containScheduleFailure(id, error))
      .finally(() => {
        this.scheduling.delete(id);
        if (this.pending.delete(id)) this.schedule(id);
      });
    this.scheduling.set(id, work);
  }

  private scheduleFailure(id: string, error: unknown) {
    if (this.stopped || this.service.signal.aborted) return;
    this.service.deps.logger.warn(
      JSON.stringify({
        module: "group-workflow",
        event: "schedule_failed",
        workflowRunId: id,
        error: error instanceof RpcError ? error.message : "internal",
      }),
    );
    const record = this.repo.get(id);
    if (!record || !["running", "waiting"].includes(record.status)) return;
    if (progressOf(record).requested) {
      this.progress.stop(record, "replan_unavailable");
      return;
    }
    const workflow = (() => {
      try {
        return workflowOf(record);
      } catch {
        return undefined;
      }
    })();
    if (!workflow) {
      this.repo.updateRun(id, "failed");
      settlePlanWebConsent(this.service, record);
      return;
    }
    const definitions = new Map(workflow.contract.steps?.map((step) => [step.id, step]));
    for (const state of this.repo.steps(id).filter((step) => step.status === "ready")) {
      const definition = definitions.get(state.stepId);
      if (definition) this.block(record, definition, state, "scheduler_error");
    }
  }

  private containScheduleFailure(id: string, error: unknown) {
    try {
      this.scheduleFailure(id, error);
    } catch (failure) {
      this.service.deps.logger.error(
        JSON.stringify({
          module: "group-workflow",
          event: "schedule_failure_persist_failed",
          workflowRunId: id,
          error: failure instanceof RpcError ? failure.message : "internal",
        }),
      );
    }
  }

  private async scheduleNow(id: string) {
    if (this.service.deps.local.shutdown.signal.aborted) return;
    const record = this.repo.get(id);
    if (!record || !["running", "waiting"].includes(record.status) || this.stopped) {
      if (record && !this.stopped) this.merges.ended(record);
      return;
    }
    const workflow = workflowOf(record);
    // A manual gate can block before its member run ends. Refresh from durable run/task facts,
    // including after restart or a missed settled notification. A cardless block belongs to
    // automatic replanning; only explicit manual-block paths may create its first decision.
    for (const state of this.repo.steps(id)) {
      if (state.status !== "blocked" || !state.decisionMessageId) continue;
      const definition = workflow.contract.steps?.find((step) => step.id === state.stepId);
      if (definition) this.createDecision(record, definition, state.attempt);
    }
    const verdictProgress = progressOf(record);
    // The plan waits for the user's answer on its card: nothing is dispatched or replanned.
    if (verdictProgress.hold) return;
    // A recheck the program skipped with its repair is fine once the user accepted its review.
    const accepted = new Set(
      Object.entries(verdictProgress.verdictRepairs)
        .filter(([failed]) => verdictProgress.verdictAccepts?.[failed])
        .map(([, recheck]) => recheck),
    );
    if (
      this.repo
        .steps(id)
        .some(
          (state) =>
            state.status === "skipped" &&
            Object.values(verdictProgress.verdictRepairs).includes(state.stepId) &&
            !verdictProgress.verdictSkips[state.stepId] &&
            !accepted.has(state.stepId),
        )
    ) {
      this.progress.stop(record, "verdict_recheck_skipped");
      return;
    }
    if (workflow.source.kind === "dynamic") {
      const limit = this.progress.hardLimit(record);
      if (
        limit &&
        this.repo.steps(id).some((step) => step.status === "ready" || step.status === "running")
      ) {
        this.progress.stop(record, limit);
        return;
      }
      if (progressOf(record).requested) {
        await this.progress.replan(
          record,
          AbortSignal.any([
            this.service.signal,
            this.shutdown.signal,
            AbortSignal.timeout(DISPATCH_MS),
          ]),
        );
        return;
      }
    }
    if (workflow.source.kind !== "dynamic" && unresolvedVerdicts(progressOf(record)).length) {
      this.progress.stop(record, "verdict_failed");
      return;
    }
    const definitions = new Map(workflow.contract.steps?.map((step) => [step.id, step]));
    transaction(this.service.deps.db, () => {
      const current = new Map(this.repo.steps(id).map((item) => [item.stepId, item]));
      for (const item of current.values()) {
        if (item.status !== "waiting") continue;
        const definition = definitions.get(item.stepId);
        // Maintainers 2026-11-14: a dependent starts from a base that holds its inputs' merged work.
        if (
          definition?.dependsOn.every((dependency) => {
            const upstream = current.get(dependency);
            return (
              !!upstream &&
              ["passed", "skipped"].includes(upstream.status) &&
              stepMerged(this.service, upstream) &&
              verdictDependencyReady(
                progressOf(record),
                dependency,
                definition,
                workflow.contract.steps ?? [],
              )
            );
          })
        )
          this.repo.updateStep(id, item.stepId, { status: "ready" });
      }
    });
    if (
      workflow.source.kind === "dynamic" &&
      verdictRepairReady(this.repo.steps(id), progressOf(this.repo.get(id) ?? record))
    ) {
      transaction(this.service.deps.db, () => {
        this.progress.request(record);
        this.repo.updateRun(id, "waiting");
      });
      this.schedule(id);
      return;
    }
    for (const item of this.repo.steps(id).filter((step) => step.status === "ready")) {
      const definition = definitions.get(item.stepId);
      if (definition) await this.dispatcher.dispatch(record, workflow, definition, item);
    }
    const states = this.repo.steps(id);
    const latest = this.repo.get(id) ?? record;
    const review = progressOf(latest).review;
    if (
      review?.supplementStepId &&
      states.some(
        (step) =>
          step.stepId === review.supplementStepId &&
          step.status === "blocked" &&
          !step.decisionMessageId,
      )
    ) {
      this.progress.stop(latest, "supplement_unmet");
      return;
    }
    const summary = summaryStep(latest, workflow, states);
    if (
      workflow.source.kind === "dynamic" &&
      stuckSteps(this.repo, latest).length &&
      !states.some(
        (step) => step.status === "running" || (step.status === "ready" && step.stepId !== summary),
      )
    ) {
      transaction(this.service.deps.db, () => {
        this.progress.request(latest);
        this.repo.updateRun(id, "waiting");
      });
      this.schedule(id);
      return;
    }
    if (states.every((step) => ["passed", "skipped"].includes(step.status))) {
      // The plan ends only when every step's work is in the group folder.
      if (states.some((step) => !stepMerged(this.service, step))) {
        this.merges.requestAll(latest);
        return;
      }
      if (unresolvedVerdicts(progressOf(latest)).length) {
        if (workflow.source.kind !== "dynamic") {
          this.progress.stop(latest, "verdict_failed");
          return;
        }
        transaction(this.service.deps.db, () => {
          this.progress.request(latest);
          this.repo.updateRun(id, "waiting");
        });
        this.schedule(id);
        return;
      }
      if (new GroupWorkflowManualReview(this).wait(record)) return;
      if (
        canSupplement(review) &&
        progressOf(latest).replans < 2 &&
        states.length < 20 &&
        !this.progress.hardLimit(latest, true)
      ) {
        transaction(this.service.deps.db, () => {
          this.progress.request(latest);
          this.repo.updateRun(id, "waiting");
        });
        this.schedule(id);
        return;
      }
      const deliveryComplete = workflow.source.kind !== "dynamic" || deliveryReviewComplete(review);
      const completed = transaction(this.service.deps.db, () => {
        this.repo.updateRun(id, "passed");
        const pauses = clearCompletedPlanPause(this.service, record);
        this.audit(
          record,
          "group.workflow.completed",
          "Group workflow completed / 群工作流已完成",
          {
            actor: "system",
          },
        );
        const group = this.service.groups.get(record.groupId);
        if (group) {
          const zh = this.service.deps.chat.currentLanguage() === "zh";
          const supplement = states.find((state) => state.stepId === review?.supplementStepId);
          // The supplement's prose can contain self-reported coverage. Only show its check facts.
          const ordinary = states.filter((state) => state !== supplement);
          const stepLabel = (state: GroupWorkflowStepRecord) => {
            const label = verdictStepLabel(progressOf(latest), state.stepId, zh);
            if (label) return label;
            return zh ? (state.status === "passed" ? "已通过" : "已跳过") : state.status;
          };
          new MessagesRepo(this.service.deps.db).create({
            conversationId: group.conversationId,
            botId: record.coordinatorBotId,
            role: "assistant",
            content: this.service.deps.redactor.redact(
              [
                !deliveryComplete
                  ? zh
                    ? `计划「${workflow.name}」步骤已结束；需求覆盖见下方。`
                    : `Plan “${workflow.name}” steps ended; see coverage below.`
                  : zh
                    ? `计划「${workflow.name}」已完成。`
                    : `Plan “${workflow.name}” completed.`,
                ...(workflow.source.kind === "dynamic" ? reviewConclusion(review, zh) : []),
                ...(supplement ? [supplementConclusion(this.service, record, supplement, zh)] : []),
                ...planConclusionLines(ordinary).map((line) => `• ${line}`),
                ...ordinary.map(
                  (state) =>
                    `${definitions.get(state.stepId)?.title ?? state.stepId}: ${stepLabel(state)}\n${state.deliverables.flatMap((item) => (item && typeof item === "object" && "path" in item && typeof item.path === "string" ? [item.path] : [])).join("\n")}`,
                ),
              ].join("\n\n"),
            ),
            status: "done",
            usage: {
              groupPlanConclusion: GroupPlanConclusionSchema.parse({
                workflowRunId: record.id,
                cycleId: record.cycleId,
                outcome: deliveryComplete ? "completed" : "incomplete",
              }),
              groupExecution: {
                kind: "plan",
                ...(workflow.acceptanceRelaxed ? { acceptanceRelaxed: true } : {}),
                ...(workflow.relaxationDetails ? { relaxations: workflow.relaxationDetails } : {}),
                steps: this.repo.executionSummary(
                  record.groupId,
                  group.conversationId,
                  record.cycleId,
                ).steps,
              },
              // Only a dynamic plan whose every step passed (none skipped) can be saved.
              ...(workflow.source.kind === "dynamic" &&
              states.every((state) => state.status === "passed")
                ? { groupPlanDone: { workflowRunId: record.id } }
                : {}),
            },
          });
          return { todo: archiveCompletedPlan(this.service, record), pauses };
        }
        return { todo: undefined, pauses };
      });
      const source = new MessagesRepo(this.service.deps.db).get(record.sourceMessageId);
      if (source) this.service.deps.local.memoryExtraction?.boundary(source.conversationId);
      this.merges.ended(record);
      // A finished plan leaves no attempt's task open (a skipped step's retry once stayed open).
      closeStepTasks(
        this.service,
        record,
        states.map((state) => state.stepId),
        "plan_completed",
        "system",
      );
      const completedTodo = completed.todo;
      if (completedTodo) {
        this.service.deps.peer.emit("execution.todo.changed", completedTodo);
        this.service.deps.peer.emit("execution.collection.changed", {
          botId: completedTodo.botId,
          conversationId: completedTodo.conversationId,
        });
      }
      for (const { runId, message } of completed.pauses)
        this.service.deps.peer.emit("chat.message", {
          botId: record.coordinatorBotId,
          conversationId: message.conversationId,
          runId,
          messageId: message.id,
          message,
        });
      this.service.changed(record.groupId, "updated");
      // The follow-up test→review plan starts after the finished plan's own bookkeeping, and
      // nothing it does (it may wait on a start) can hold up or undo that plan.
      void Promise.resolve()
        .then(() => this.service.verification.finished(record.id))
        .catch((error) =>
          this.service.deps.logger.warn(
            JSON.stringify({
              module: "group-verification",
              event: "finished_failed",
              workflowRunId: record.id,
              error: error instanceof Error ? error.name : "unknown",
            }),
          ),
        );
    }
  }

  /** A step transition becomes one program-written line per burst. */
  announce(record: GroupWorkflowRunRecord) {
    this.status.announce(record);
  }

  /** A disposition turn that produced no replacement ends with the user's card. */
  handOver(record: GroupWorkflowRunRecord, kind: "handed_over" | "exhausted", reason?: string) {
    return this.decisions.handOver(record, kind, reason);
  }

  audit(
    record: GroupWorkflowRunRecord,
    kind: WorkflowAuditKind,
    summary: string,
    detail: Record<string, unknown>,
  ) {
    settlePlanWebConsent(this.service, record);
    this.service.deps.local.approvals.audit.append({
      botId: record.coordinatorBotId,
      kind,
      summary,
      detail: { groupId: record.groupId, workflowRunId: record.id, ...detail },
    });
  }

  async stop() {
    this.stopped = true;
    this.shutdown.abort();
    this.reconciliation.stop();
    this.dispatcher.stop();
    await this.merges.stop();
    this.status.stop();
    await Promise.allSettled(this.scheduling.values());
    let afterId: string | undefined;
    for (;;) {
      const page = this.repo.active(afterId);
      for (const record of page) this.progress.quiesce(record);
      if (page.length < 100) break;
      afterId = page.at(-1)?.id;
    }
    await this.progress.settled();
  }
}
