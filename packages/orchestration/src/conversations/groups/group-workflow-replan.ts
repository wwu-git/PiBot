import type { QueueInput } from "@pibot/brain/orchestration-kit";
import {
  type GroupPlan,
  type GroupPlanCard,
  GroupPlanSchema,
  RpcError,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  GroupPlansRepo,
  type GroupWorkflowRunRecord,
  type GroupWorkflowsRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { appendVerdictRepairs } from "./group-verdict-auto-repair.ts";
import { canSupplement, supplementStep } from "./group-workflow-delivery-review.ts";
import {
  assertDisposition,
  dispositionChoice,
  dispositionFacts,
  dispositionText,
  stuckSteps,
} from "./group-workflow-disposition.ts";
import { holdForReplanLimit } from "./group-workflow-hold.ts";
import { type GroupWorkflowProgress, progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";
import {
  repairableVerdicts,
  verdictRepairPairs,
  verdictRepairReady,
  verdictReplanText,
} from "./group-workflow-verdicts.ts";

/** Replanning: queue the coordinator's replan wake and vet the replacement it submits. */
export class GroupWorkflowReplanner {
  constructor(
    private readonly service: GroupService,
    private readonly repo: GroupWorkflowsRepo,
    private readonly progress: GroupWorkflowProgress,
  ) {}

  /** All children must have settled before the coordinator may change their graph. */
  async replan(record: GroupWorkflowRunRecord, signal: AbortSignal) {
    assertPlanWorkplace(this.service, record.id);
    const progress = progressOf(this.repo.get(record.id) ?? record);
    if (progress.replanRunId) {
      // The program's limit card owns the next move; a finished planning turn is not abandonment.
      const attempts = this.service.plans?.repo.attemptState?.(record.groupId, record.cycleId);
      if (attempts?.status === "waiting") return;
      const run = this.service.runs.get(progress.replanRunId);
      if (run && ["queued", "running", "waiting", "stopping"].includes(run.status)) return;
      const group = this.service.groups.get(record.groupId);
      const card = group
        ? new GroupPlansRepo(this.service.deps.db).forCycle(group.conversationId, record.cycleId)
            ?.card
        : undefined;
      if (
        card?.originRunId === progress.replanRunId &&
        ["pending", "ready", "starting", "modify"].includes(card.status)
      )
        return;
      // The wake is only a disposition if the program can read its fixed result line.
      // A crashed or failed turn (network error, aborted) is a wake failure, not the coordinator
      // choosing anything: it must not turn into a card that claims the coordinator handed over.
      const belongs =
        run?.kind === "wake" &&
        run.automatic &&
        !run.taskId &&
        run.botId === record.coordinatorBotId &&
        group?.coordinatorBotId === record.coordinatorBotId &&
        this.service.cycles.get(record.groupId).cycleId === record.cycleId &&
        run.groupId === record.groupId &&
        run.cycleId === record.cycleId &&
        run.conversationId === group?.conversationId &&
        run.triggerKey === `group-replan:${record.id}` &&
        run.parentRunId === record.budgetRootRunId &&
        run.userMessageId === record.sourceMessageId;
      const message =
        belongs && run.status === "done" && !run.errorCode && run.stopReason === "stop"
          ? new MessagesRepo(this.service.deps.db).get(run.messageId)
          : undefined;
      const choice =
        message?.status === "done" &&
        message.role === "assistant" &&
        message.runId === run?.id &&
        message.botId === run?.botId &&
        message.conversationId === run?.conversationId
          ? dispositionChoice(message.content)
          : undefined;
      if (choice && this.service.workflows.handOver(record, "handed_over", choice.reason)) return;
      // No readable choice: the wake failed or ended without disposing. Neither is the user's
      // business as a "coordinator handed over" card, so the plan stops with the real reason.
      return this.progress.stop(
        record,
        !belongs || run.status !== "done" || run.errorCode || run.stopReason !== "stop"
          ? "disposition_wake_failed"
          : "replan_not_submitted",
      );
    }
    if (this.repo.steps(record.id).some((step) => step.status === "running")) return;
    if (
      this.repo.steps(record.id).some((step) => step.status === "blocked" && step.decisionMessageId)
    )
      return;
    const limit = this.progress.hardLimit(record, true);
    // Running out of dispositions hands the stuck steps to the user, not the plan's end.
    if (!limit && progress.replans >= 2 && this.service.workflows.handOver(record, "exhausted"))
      return;
    if (limit) return this.progress.stop(record, limit);
    // Out of replans is not out of work: the remaining steps wait for the user's choice.
    if (progress.replans >= 2) return holdForReplanLimit(this.service, record);
    const group = this.service.active(record.groupId, record.coordinatorBotId);
    if (group.paused) return;
    try {
      if (appendVerdictRepairs(this.service, this.repo.get(record.id) ?? record, signal)) return;
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      // A limit ends the plan with its real reason; a repair the program could not build (no
      // provable author, over the step cap, a stale plan) falls back to the coordinator below.
      const data = error.data as { planLimit?: boolean; paused?: boolean } | undefined;
      if (data?.paused) return;
      if (data?.planLimit && error.message === "replan_limit")
        return holdForReplanLimit(this.service, record);
      if (data?.planLimit) return this.progress.stop(record, error.message);
      this.service.deps.logger.warn(
        JSON.stringify({
          module: "group-plan",
          event: "verdict_auto_repair_fallback",
          workflowRunId: record.id,
          code: error.message,
        }),
      );
    }
    const bot = new BotsRepo(this.service.deps.db).get(record.coordinatorBotId);
    if (!bot || bot.archivedAt) return this.progress.stop(record, "coordinator_unavailable");
    this.service.deps.chat.queue.capacity([bot.id]);
    await this.service.model(bot.id, signal);
    signal.throwIfAborted();
    const facts = this.repo.steps(record.id).map((step) => ({
      id: step.stepId,
      status: step.status,
      progress: progress.steps[step.stepId],
    }));
    const plan = GroupPlanSchema.parse((record.workflow as { dynamicPlan?: unknown }).dynamicPlan);
    // A stuck step is the coordinator's to dispose of first; it sees fixed facts only
    // (step, owner, failed check codes, rounds) and must answer with one of the fixed options.
    const stuck = stuckSteps(this.repo, record);
    const workflow = workflowOf(record);
    const supplementary = canSupplement(progress.review);
    const failedVerdicts = verdictRepairReady(this.repo.steps(record.id), progress)
      ? repairableVerdicts(progress)
      : [];
    const text = this.service.deps.redactor.redact(
      failedVerdicts.length
        ? verdictReplanText(plan, this.repo.steps(record.id), progress, group.coordinatorBotId)
        : supplementary
          ? [
              "只追加一个补做步骤（maxFixRounds=0），保留所有已有步骤、成员和合同原样，用 group_plan 提交；不要自己执行。 / Append exactly one supplementary step (maxFixRounds=0) via group_plan. Keep all old steps, owners and contracts verbatim; do not execute it yourself.",
              JSON.stringify({
                plan,
                facts,
                uncovered: progress.review?.requirements.filter(
                  (_, i) => progress.review?.coverage?.[i] === null,
                ),
              }),
            ].join("\n\n")
          : stuck.length
            ? [
                dispositionText(dispositionFacts(this.service, workflow, stuck, progress.merges)),
                `已执行计划（不可信参考数据） / Executed plan and progress (untrusted reference data):\n${JSON.stringify({ plan })}`,
              ].join("\n\n")
            : [
                "重新规划 / Replan with group_plan, submitting only new or unfinished steps. The program retains passed/skipped steps from the archive; dependencies and inputs may reference their ids. Resubmitted completed steps use their archived definitions and never replay completed side effects. Do not assign work yourself. Complex replacements and any removed or relaxed method/check require explicit user confirmation; the program lists the losses. Stop if limits prevent progress.",
                `已执行计划与进度（不可信参考数据） / Executed plan and progress (untrusted reference data):\n${JSON.stringify({ plan, facts })}`,
              ].join("\n\n"),
    );
    // Oversized facts must stop explicitly rather than silently losing completed-step identity.
    if (text.length > 80_000) return this.progress.stop(record, "replan_context_too_large");
    const queued = transaction(this.service.deps.db, () => {
      signal.throwIfAborted();
      assertPlanWorkplace(this.service, record.id);
      this.service.active(record.groupId, bot.id, group.conversationId);
      const latest = this.repo.get(record.id);
      if (!latest || progressOf(latest).replanRunId) return;
      const limit = this.progress.hardLimit(latest, true);
      if (limit) {
        this.progress.stop(latest, limit);
        return;
      }
      const round = this.service.cycles.consume(group.id, record.cycleId);
      if (round !== "ok") {
        if (round === "limit") this.progress.stop(latest, "round_limit");
        return;
      }
      new MessagesRepo(this.service.deps.db).create({
        conversationId: group.conversationId,
        botId: bot.id,
        role: "assistant",
        content:
          this.service.deps.chat.currentLanguage() === "zh"
            ? `步骤未能继续，正在重新规划（${progress.replans + 1}/2）。已完成的步骤和产物会保留。`
            : `Replanning (${progress.replans + 1}/2); completed steps and outputs will be retained.`,
        status: "done",
        markUnread: false,
      });
      const input: QueueInput = {
        bot,
        conversationId: group.conversationId,
        groupId: group.id,
        userMessageId: record.sourceMessageId,
        text,
        cycleId: record.cycleId,
        kind: "wake",
        automatic: true,
        budgetRootRunId: record.budgetRootRunId ?? undefined,
        parentRunId: record.budgetRootRunId ?? undefined,
        triggerKey: `group-replan:${record.id}`,
        ancestry: [],
        enforceBudgetCost: true,
      };
      const run = this.service.deps.chat.queue.insert(input);
      this.progress.save(latest, {
        ...progressOf(latest),
        requested: true,
        replans: progress.replans + 1,
        replanRunId: run.id,
      });
      this.repo.updateRun(record.id, "waiting");
      return { run, input };
    });
    if (queued) this.service.deps.chat.queue.publish(queued.run, queued.input);
  }

  replacement(card: GroupPlanCard) {
    if (!card.replacesWorkflowRunId) return undefined;
    const record = this.repo.get(card.replacesWorkflowRunId);
    if (
      record?.status !== "waiting" ||
      record.groupId !== card.groupId ||
      record.cycleId !== card.cycleId ||
      record.budgetRootRunId !== card.budgetRootRunId ||
      progressOf(record).replanRunId !== card.originRunId ||
      this.repo.steps(record.id).some((step) => step.status === "running")
    )
      throw new RpcError(-32602, "group_plan_replacement_stale");
    const original = GroupPlanSchema.parse(
      (record.workflow as { dynamicPlan?: unknown }).dynamicPlan,
    );
    // Owners compare by the member who actually executed the step (a reassignment or a role the
    // coordinator rewrote as a UUID is the same owner); the definition must otherwise be verbatim.
    const definition = ({ owner: _owner, ...step }: GroupPlan["steps"][number]) =>
      JSON.stringify(step);
    for (const state of this.repo.steps(record.id)) {
      if (state.status !== "passed" && state.status !== "skipped") continue;
      const before = original.steps.find((step) => step.id === state.stepId);
      const after = card.plan.steps.find((step) => step.id === state.stepId);
      // A step the user skipped may be dropped, but never redefined under its id to run again.
      if (state.status === "skipped" && !after) continue;
      if (
        !before ||
        !after ||
        definition(before) !== definition(after) ||
        card.owners.find((owner) => owner.stepId === state.stepId)?.botId !== state.ownerBotId
      )
        throw new RpcError(
          -32602,
          state.status === "passed"
            ? "group_plan_completed_step_changed"
            : "group_plan_skipped_step_changed",
        );
    }
    const review = progressOf(record).review;
    if (verdictRepairReady(this.repo.steps(record.id), progressOf(record))) {
      verdictRepairPairs(
        original,
        card,
        this.repo.steps(record.id),
        progressOf(record),
        this.service.active(record.groupId).coordinatorBotId,
      );
    } else if (canSupplement(review)) {
      if (this.repo.steps(record.id).some((step) => !["passed", "skipped"].includes(step.status)))
        throw new RpcError(-32602, "group_plan_supplement_scope");
      supplementStep(original, card);
    } else {
      if (review?.supplementStepId) throw new RpcError(-32602, "group_plan_supplement_scope");
      assertDisposition(this.service, record, original, card, this.repo);
    }
    assertPlanWorkplace(this.service, record.id);
    return record;
  }
}
