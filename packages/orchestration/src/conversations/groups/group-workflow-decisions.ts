import {
  type GroupWorkflowDecision,
  type KernelMethodParams,
  RpcError,
  type WorkflowStep,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import { contextFullReading, stepFailureReason } from "./group-step-failure.ts";
import { confirmationRequired } from "./group-workflow-brief.ts";
import { decisionText } from "./group-workflow-decision-text.ts";
import {
  type DispositionKind,
  dispositionFacts,
  dispositionNote,
  stuckSteps,
} from "./group-workflow-disposition.ts";
import { GroupWorkflowManualReview } from "./group-workflow-manual.ts";
import { progressOf } from "./group-workflow-progress.ts";
import {
  decisionOf,
  stepDeliverables,
  type WorkflowEngine,
  workflowOf,
} from "./group-workflow-snapshot.ts";
import { closeStepTasks } from "./group-workflow-step-tasks.ts";
import { verdictResolution } from "./group-workflow-verdicts.ts";

/** Blocked steps, their disposition cards and the user's retry / skip / reassign / accept. */
export class GroupWorkflowDecisions {
  constructor(private readonly engine: WorkflowEngine) {}

  resolve(params: KernelMethodParams["groups.workflow.resolve"]) {
    const reviewed = new GroupWorkflowManualReview(this.engine).resolve(params);
    if (reviewed) return reviewed;
    const { service, repo } = this.engine;
    const record = repo.get(params.workflowRunId);
    if (record?.groupId === params.groupId && params.action !== "skip")
      assertPlanWorkplace(service, record.id);
    if (record && progressOf(record).replanRunId)
      throw new RpcError(-32602, "group_workflow_replanning");
    const current = record
      ? repo.steps(record.id).find((step) => step.stepId === params.stepId)
      : undefined;
    if (
      !record ||
      !["running", "waiting"].includes(record.status) ||
      record.groupId !== params.groupId ||
      !current ||
      current.status !== "blocked"
    )
      throw new RpcError(-32602, "group_workflow_decision_unavailable");
    const group = service.active(record.groupId);
    const handoff = current.taskId ? service.handoffs.repo.get(current.taskId) : undefined;
    const child = current.executionRunId ? service.runs.get(current.executionRunId) : undefined;
    const workflow = workflowOf(record);
    const dynamic = workflow.source.kind === "dynamic";
    const definition = workflow.contract.steps?.find((step) => step.id === params.stepId);
    if (params.action === "accept" && (!definition || !this.canConfirm(current)))
      throw new RpcError(-32602, "group_workflow_confirmation_unavailable");
    let owner = current.ownerBotId;
    if (params.action === "reassign") {
      if (
        !params.ownerBotId ||
        params.ownerBotId === current.ownerBotId ||
        !group.members.some((member) => member.botId === params.ownerBotId)
      )
        throw new RpcError(-32602, "group_workflow_owner_unavailable");
      owner = params.ownerBotId;
    }
    let replanCancelled = false;
    let held: string[] = [];
    transaction(service.deps.db, () => {
      const latest = repo.steps(record.id).find((step) => step.stepId === params.stepId);
      if (latest?.status !== "blocked")
        throw new RpcError(-32011, "group_workflow_decision_changed");
      repo.updateStep(record.id, params.stepId, {
        status:
          params.action === "accept" ? "passed" : params.action === "skip" ? "skipped" : "ready",
        attempt:
          params.action === "skip" || params.action === "accept"
            ? latest.attempt
            : latest.attempt + 1,
        ownerBotId: owner,
        taskId: params.action === "accept" ? latest.taskId : null,
        ...(params.action === "accept" && definition
          ? {
              deliverables: stepDeliverables(
                definition,
                current.taskId ? (service.tasks.get(current.taskId)?.summary ?? "") : "",
                handoff?.result?.artifacts ?? [],
              ),
            }
          : {}),
        // Retry/reassign may fail again. The resolved card remains in message history, while a
        // later block must be able to attach a new pending decision to the step.
        decisionMessageId:
          params.action === "skip" || params.action === "accept" ? latest.decisionMessageId : null,
      });
      if (
        params.action === "skip" &&
        definition?.acceptance.some((item) => item.check === "verdict")
      ) {
        const ledger = progressOf(repo.get(record.id) ?? record);
        this.engine.progress.save(record, {
          ...ledger,
          verdictSkips: { ...ledger.verdictSkips, [params.stepId]: true },
        });
      }
      if (dynamic)
        replanCancelled = this.yieldToUser(
          record,
          params.stepId,
          params.action === "reassign" ? owner : undefined,
        );
      held = params.action === "skip" && dynamic ? this.holdSkippedFix(record, params.stepId) : [];
      if (params.action === "accept" && latest.taskId) {
        service.handoffs.repo.confirmByUser(latest.taskId);
        service.handoffs.repo.setState(latest.taskId, "met");
        service.cycles.claimWake(latest.taskId);
        this.engine.audit(
          record,
          "group.workflow.step_passed",
          "Group workflow accepted by user / 群工作流步骤由用户确认通过",
          {
            actor: "user",
            stepId: params.stepId,
            taskId: latest.taskId,
            reasonCode: "user_confirmed",
            ...(child ? { childRunId: child.id } : {}),
          },
        );
      }
      repo.rebindCycle(
        record.id,
        service.cycles.get(group.id).cycleId ?? service.cycles.reset(group.id),
      );
      repo.updateRun(record.id, held.length ? "waiting" : "running");
      if (latest.decisionMessageId) {
        const messages = new MessagesRepo(service.deps.db);
        const message = messages.get(latest.decisionMessageId);
        const decision = decisionOf(message?.usage);
        if (message && decision) {
          const resolved: GroupWorkflowDecision = {
            ...decision,
            state: "resolved",
            resolution: params.action,
            ...(params.action === "reassign"
              ? {
                  reassignedTo: service.deps.redactor.redact(
                    new BotsRepo(service.deps.db).get(owner)?.name ?? owner,
                  ),
                }
              : {}),
          };
          messages.update(message.id, {
            content: service.deps.redactor.redact(
              decisionText(resolved, service.deps.chat.currentLanguage()),
            ),
            usage: {
              ...(message.usage as Record<string, unknown>),
              groupWorkflowDecision: resolved,
            },
          });
        }
      }
      this.engine.audit(
        record,
        "group.workflow.disposition",
        "Group workflow disposition / 群工作流用户处置",
        {
          actor: "user",
          stepId: params.stepId,
          workflowAction: params.action,
          ...(params.action === "reassign" ? { targetBotId: owner } : {}),
          ...(replanCancelled ? { reasonCode: "replan_cancelled_by_user" } : {}),
        },
      );
      if (held.length)
        this.engine.audit(
          record,
          "group.workflow.disposition",
          "Repair skipped; recheck skipped, waiting for the user / 修复已跳过，复验不再进行，等你选择",
          { actor: "user", stepId: params.stepId, reasonCode: "verdict_fix_skipped" },
        );
    });
    if (current.taskId) {
      const task = service.tasks.get(current.taskId);
      if (task) service.taskChanged(task);
    }
    if (params.action === "skip" || params.action === "accept")
      closeStepTasks(
        service,
        record,
        [params.stepId],
        params.action === "skip" ? "step_skipped" : "step_accepted",
        "user",
      );
    service.changed(record.groupId, "updated");
    // A step the ledger had parked for the cancelled replan now needs its own disposition card.
    if (replanCancelled) {
      const latest = repo.get(record.id) ?? record;
      for (const state of repo.steps(record.id)) {
        if (state.status !== "blocked" || state.decisionMessageId) continue;
        const stepDefinition = workflow.contract.steps?.find((step) => step.id === state.stepId);
        if (stepDefinition) this.createDecision(latest, stepDefinition, state.attempt);
      }
    }
    this.engine.schedule(record.id);
    return { ok: true as const };
  }

  /**
   * Inside the disposition transaction, the user's explicit choice outranks a replan the
   * ledger requested but has not queued yet (otherwise dispatch silently turns a retry into a
   * replan). A reassignment also becomes the plan's truth, so a later replan that preserves the
   * passed step verbatim matches the member who actually executed it. Replan count and budget
   * root are untouched.
   */
  private yieldToUser(record: GroupWorkflowRunRecord, stepId: string, reassignedTo?: string) {
    const { repo, progress } = this.engine;
    const latest = repo.get(record.id);
    if (!latest) return false;
    const snapshot = latest.workflow as {
      dynamicPlan?: { steps?: { id: string; owner: unknown }[] };
      contract?: { steps?: { id: string; owner?: unknown }[] };
    };
    const owned = <T extends { id: string }>(steps: T[] | undefined) =>
      steps?.map((step) =>
        step.id === stepId ? { ...step, owner: { botId: reassignedTo } } : step,
      );
    const steps = snapshot.dynamicPlan?.steps;
    if (reassignedTo && steps?.some((step) => step.id === stepId)) {
      repo.updateWorkflow(record.id, {
        ...snapshot,
        dynamicPlan: { ...snapshot.dynamicPlan, steps: owned(steps) },
        contract: { ...snapshot.contract, steps: owned(snapshot.contract?.steps) },
      });
    }
    const ledger = progressOf(repo.get(record.id) ?? latest);
    if (!ledger.requested || ledger.replanRunId) return false;
    progress.save(latest, { ...ledger, requested: false });
    return true;
  }

  /**
   * Inside the disposition transaction: skipping a repair ends that repair loop. Its recheck
   * would only review the unchanged work again (the program used to dispatch it), so it is
   * skipped too, the reviewed step keeps its FAIL verdict, and the plan waits for the user to
   * accept it as it is or stop. Returns the reviewed steps now waiting for that choice.
   */
  private holdSkippedFix(record: GroupWorkflowRunRecord, stepId: string) {
    const { service, repo, progress } = this.engine;
    const latest = repo.get(record.id) ?? record;
    const ledger = progressOf(latest);
    const reviewed = Object.entries(ledger.verdictFixes)
      .filter(([failed, fix]) => fix === stepId && !verdictResolution(ledger, failed))
      .map(([failed]) => failed);
    if (!reviewed.length) return [];
    const states = repo.steps(record.id);
    for (const failed of reviewed) {
      const recheck = ledger.verdictRepairs[failed];
      const state = states.find((item) => item.stepId === recheck);
      if (recheck && state && ["waiting", "ready"].includes(state.status))
        repo.updateStep(record.id, recheck, { status: "skipped" });
    }
    const already = ledger.hold?.kind === "fix_skipped" ? ledger.hold.stepIds : [];
    progress.save(latest, {
      ...ledger,
      requested: false,
      hold: { kind: "fix_skipped", stepIds: [...new Set([...already, ...reviewed])].slice(0, 20) },
    });
    const workflow = workflowOf(latest);
    const title = (id: string) =>
      workflow.contract.steps?.find((step) => step.id === id)?.title ?? id;
    const zh = service.deps.chat.currentLanguage() === "zh";
    const names = reviewed.map(title).join(zh ? "、" : ", ");
    new MessagesRepo(service.deps.db).create({
      conversationId: service.groups.get(record.groupId)?.conversationId ?? "",
      botId: record.coordinatorBotId,
      role: "assistant",
      status: "done",
      markUnread: false,
      content: service.deps.redactor.redact(
        zh
          ? `修复「${title(stepId)}」已跳过，不再复验；「${names}」保持不通过。请在计划卡片上选择按现状接受，或停止计划。`
          : `The repair “${title(stepId)}” was skipped, so there is no recheck; “${names}” keeps its FAIL verdict. On the plan card, accept it as it is or stop the plan.`,
      ),
    });
    return reviewed;
  }

  private canConfirm(current: GroupWorkflowStepRecord) {
    const { service } = this.engine;
    if (
      !current.taskId ||
      !current.executionRunId ||
      service.tasks.get(current.taskId)?.status !== "done" ||
      service.runs.get(current.executionRunId)?.status !== "done" ||
      service.runs.hasActiveForTask(current.taskId, current.executionRunId)
    )
      return false;
    const result = service.handoffs.repo.get(current.taskId)?.result;
    return !!result && !result.items.some((item) => item.status === "fail");
  }

  createDecision(
    record: GroupWorkflowRunRecord,
    definition: WorkflowStep,
    attempt: number,
    reasonCode?: string,
    note?: string,
  ) {
    const { service, repo } = this.engine;
    if (this.engine.closed || service.deps.local.shutdown.signal.aborted) return;
    const changed = transaction(service.deps.db, () => {
      const latestRun = repo.get(record.id);
      const current = repo.steps(record.id).find((step) => step.stepId === definition.id);
      if (
        !latestRun ||
        !["running", "waiting"].includes(latestRun.status) ||
        current?.status !== "blocked" ||
        current.attempt !== attempt
      )
        return false;
      const code = reasonCode ?? this.reason(current);
      const reading =
        code === "context_full"
          ? contextFullReading(
              service,
              current.executionRunId ? service.runs.get(current.executionRunId) : undefined,
            )
          : undefined;
      const decision: GroupWorkflowDecision = {
        groupId: record.groupId,
        workflowRunId: record.id,
        stepId: definition.id,
        title: definition.title,
        ownerBotId: current.ownerBotId,
        attempt,
        state: "pending",
        reasonCode: code,
        confirmationRequired: this.canConfirm(current),
        ...(note ? { note } : {}),
        ...(reading ? { reading } : {}),
      };
      const messages = new MessagesRepo(service.deps.db);
      const existing = current.decisionMessageId
        ? messages.get(current.decisionMessageId)
        : undefined;
      const previous = decisionOf(existing?.usage);
      if (existing) {
        // Resolved/foreign cards are historical facts, never revived by a delayed run callback.
        if (
          previous?.state !== "pending" ||
          previous.workflowRunId !== record.id ||
          previous.stepId !== definition.id ||
          previous.attempt !== attempt
        )
          return false;
        const refreshed = {
          ...previous,
          confirmationRequired: decision.confirmationRequired === true,
          ...(note ? { note } : {}),
        };
        const content = service.deps.redactor.redact(
          decisionText(refreshed, service.deps.chat.currentLanguage()),
        );
        if (
          previous.confirmationRequired === refreshed.confirmationRequired &&
          existing.content === content
        )
          return false;
        messages.update(existing.id, {
          content,
          usage: {
            ...(existing.usage as Record<string, unknown>),
            groupWorkflowDecision: refreshed,
          },
        });
        return true;
      }
      const created = messages.create({
        conversationId: service.groups.get(record.groupId)?.conversationId ?? "",
        botId: record.coordinatorBotId,
        role: "assistant",
        content: service.deps.redactor.redact(
          decisionText(decision, service.deps.chat.currentLanguage()),
        ),
        status: "done",
        usage: { groupWorkflowDecision: decision },
      });
      repo.updateStep(record.id, definition.id, { decisionMessageId: created.id });
      return true;
    });
    if (changed) service.changed(record.groupId, "updated");
  }

  /**
   * The coordinator's disposition turn ended without a replacement, or ran out. The user
   * takes the stuck steps over; the note carries the program's fixed facts so the card says what
   * the coordinator saw. Clearing the pending replan keeps the scheduler from waking it again.
   */
  handOver(record: GroupWorkflowRunRecord, kind: DispositionKind, reason?: string) {
    const { service, repo, progress } = this.engine;
    if (this.engine.closed || service.deps.local.shutdown.signal.aborted) return false;
    const latest = repo.get(record.id) ?? record;
    if (!["running", "waiting"].includes(latest.status)) return false;
    const stuck = stuckSteps(repo, latest);
    if (!stuck.length) return false;
    // The coordinator's own one-line reason rides along when the program read one, so
    // the card shows why it gave up instead of only the fix counts.
    const zh = service.deps.chat.currentLanguage() === "zh";
    const note = [
      ...(reason
        ? [service.deps.redactor.redact(`${zh ? "协调者理由" : "coordinator reason"}: ${reason}`)]
        : []),
      dispositionNote(
        dispositionFacts(service, workflowOf(latest), stuck, progressOf(latest).merges),
        zh ? "zh" : "en",
        kind,
      ),
    ]
      .join("\n")
      .slice(0, 500);
    const ledger = progressOf(latest);
    if (ledger.requested || ledger.replanRunId)
      progress.save(latest, { ...ledger, requested: false, replanRunId: undefined });
    const reasonCode = kind === "exhausted" ? "dispositions_exhausted" : "coordinator_handed_over";
    for (const { state, definition } of stuck)
      this.createDecision(latest, definition, state.attempt, reasonCode, note);
    this.engine.audit(
      latest,
      "group.workflow.disposition",
      "Group workflow dispositions handed to the user / 群工作流处置交回用户",
      // The audit detail is a closed schema: the kind is its reason code, the steps a count.
      { actor: "system", reasonCode: kind, stepCount: stuck.length },
    );
    // The group sees this step move to "stuck, the coordinator handles it".
    this.engine.announce(repo.get(latest.id) ?? latest);
    return true;
  }

  private reason(current: GroupWorkflowStepRecord) {
    const { service } = this.engine;
    if (!current.executionRunId) return "step_blocked";
    if (service.runs.get(current.executionRunId)?.status !== "done")
      return stepFailureReason(
        service,
        service.runs.get(current.executionRunId),
        "execution_interrupted",
      );
    const handoff = current.taskId ? service.handoffs.repo.get(current.taskId) : undefined;
    return handoff && confirmationRequired(handoff) ? "verification_required" : "acceptance_failed";
  }

  block(
    record: GroupWorkflowRunRecord,
    definition: WorkflowStep,
    state: GroupWorkflowStepRecord,
    reason: string,
  ) {
    const { service, repo, progress } = this.engine;
    if (this.engine.closed || service.deps.local.shutdown.signal.aborted) return;
    if (workflowOf(record).source.kind === "dynamic" && reason === "budget_exhausted") {
      const limit = progress.hardLimit(record, true);
      if (limit) {
        progress.stop(record, limit);
        return;
      }
    }
    const changed = transaction(service.deps.db, () => {
      const current = repo.steps(record.id).find((step) => step.stepId === definition.id);
      if (!current || !["ready", "running"].includes(current.status)) return false;
      repo.updateStep(record.id, definition.id, { status: "blocked" });
      repo.updateRun(record.id, "waiting");
      if (state.taskId) service.cycles.claimWake(state.taskId);
      if (reason === "context_full") {
        // The next attempt's brief carries one fixed line about it (no extra model call).
        const ledger = progressOf(repo.get(record.id) ?? record);
        progress.save(record, {
          ...ledger,
          contextFull: { ...ledger.contextFull, [definition.id]: true },
        });
      }
      this.engine.audit(
        record,
        "group.workflow.step_blocked",
        "Group workflow step blocked / 群工作流步骤已阻塞",
        { actor: "system", stepId: definition.id, reason },
      );
      return true;
    });
    if (!changed) return;
    if (state.taskId) service.handoffs.settled(state.taskId);
    this.createDecision(record, definition, state.attempt, reason);
    // A hard block (dispatch failure, budget) is progress the user should see too.
    this.engine.announce(repo.get(record.id) ?? record);
  }
}
