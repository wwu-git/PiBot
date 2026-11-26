import { randomUUID } from "node:crypto";
import type { WorkflowRun } from "@pibot/brain/orchestration-kit";
import {
  groupWorkplace,
  resolveWorkflowFolder,
  workflowLimits,
  workspaceFiles,
} from "@pibot/brain/orchestration-kit";
import {
  type GroupExecutionPlan,
  GroupExecutionPlanSchema,
  type GroupPlanCard,
  GroupPlanSchema,
  type GroupTask,
  hasAcceptanceRelaxation,
  type KernelMethodResults,
  PlanRelaxationHistorySchema,
  RpcError,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  type GroupWorkflowRunRecord,
  type GroupWorkflowsRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import { bindMethodFolderInputs } from "./group-method-inputs.ts";
import { assertRelaxationConfirmation } from "./group-plan-relaxations.ts";
import { planRequestInputs } from "./group-plan-template.ts";
import { assertPlanWorkplace, PlanWorkplaceSchema } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { settlePlanWebConsent } from "./group-web-consent.ts";
import { canSupplement, supplementStep } from "./group-workflow-delivery-review.ts";
import { type GroupWorkflowProgress, progressOf } from "./group-workflow-progress.ts";
import { retirePlanTasks } from "./group-workflow-retire.ts";
import { type StoredWorkflow, workflowOf } from "./group-workflow-snapshot.ts";
import {
  unresolvedVerdicts,
  verdictRepairPairs,
  verdictRepairReady,
} from "./group-workflow-verdicts.ts";

const DISPATCH_MS = 30_000;

/** Admission/persistence only; lifecycle and subsequent scheduling remain owned by the scheduler. */
export class GroupWorkflowStarter {
  constructor(
    private readonly service: GroupService,
    private readonly repo: GroupWorkflowsRepo,
    private readonly progress: GroupWorkflowProgress,
    private readonly audit: (
      record: GroupWorkflowRunRecord,
      kind: "group.workflow.started",
      summary: string,
      detail: Record<string, unknown>,
    ) => void,
    private readonly schedule: (id: string) => void,
  ) {}

  async startCard(
    card: GroupPlanCard,
    plan: GroupExecutionPlan,
    conversationId: string,
    signal: AbortSignal,
    assertCurrent: () => GroupExecutionPlan["contract"]["budget"],
  ) {
    const previous = this.progress.replacement(card);
    assertRelaxationConfirmation(previous, card);
    return this.launch(
      card.groupId,
      this.service.active(card.groupId).coordinatorBotId,
      plan,
      card.owners,
      conversationId,
      previous ? (previous.workflow as StoredWorkflow) : undefined,
      card.budgetRootRunId,
      { card, previous, signal, assertCurrent },
    );
  }

  async start(
    groupId: string,
    initiatorBotId: string,
    input: WorkflowRun,
    conversationId?: string,
  ): Promise<KernelMethodResults["chat.send"]> {
    const plan = GroupExecutionPlanSchema.parse({
      source: { kind: "contract", skillId: input.skillId, version: input.version },
      name: input.name,
      contract: input.contract,
      inputs: input.inputs,
    });
    return this.launch(
      groupId,
      initiatorBotId,
      plan,
      input.stepOwners ?? [],
      conversationId,
      input,
    );
  }

  async startPlan(
    groupId: string,
    coordinatorBotId: string,
    input: GroupExecutionPlan,
    conversationId?: string,
  ): Promise<KernelMethodResults["chat.send"]> {
    const plan = GroupExecutionPlanSchema.parse(input);
    const group = this.service.active(groupId, coordinatorBotId, conversationId);
    if (plan.source.kind !== "dynamic" || group.coordinatorBotId !== coordinatorBotId)
      throw new RpcError(-32602, "group_plan_source_invalid");
    const origin = this.service.runs.get(plan.source.originRunId);
    if (!origin || origin.groupId !== groupId || origin.botId !== coordinatorBotId)
      throw new RpcError(-32602, "group_plan_origin_invalid");
    const bots = new BotsRepo(this.service.deps.db);
    const owners = (plan.contract.steps ?? []).map((step) => {
      const owner = step.owner;
      const candidates = group.members.filter((member) => {
        const bot = bots.get(member.botId);
        return (
          bot &&
          !bot.archivedAt &&
          ("botId" in owner ? bot.id === owner.botId : bot.role?.id === owner.role)
        );
      });
      if (candidates.length !== 1 || !candidates[0])
        throw new RpcError(-32602, "workflow_step_owners_missing");
      return { stepId: step.id, botId: candidates[0].botId };
    });
    const root = this.service.deps.local.tasks.budgetRoot(origin);
    if (this.service.runs.get(root)?.groupId !== groupId)
      throw new RpcError(-32602, "group_plan_budget_origin_invalid");
    return this.launch(groupId, coordinatorBotId, plan, owners, conversationId, undefined, root);
  }

  private async launch(
    groupId: string,
    initiatorBotId: string,
    input: GroupExecutionPlan,
    stepOwners: { stepId: string; botId: string }[],
    conversationId?: string,
    placeOverride?: Pick<WorkflowRun, "folder" | "previous">,
    budgetRootRunId?: string,
    dynamic?: {
      card: GroupPlanCard;
      previous?: GroupWorkflowRunRecord;
      signal: AbortSignal;
      assertCurrent: () => GroupExecutionPlan["contract"]["budget"];
    },
  ): Promise<KernelMethodResults["chat.send"]> {
    const definitions = input.contract.steps;
    if (!definitions?.length) throw new RpcError(-32602, "workflow_steps_missing");
    const currentGroup = this.service.active(groupId, initiatorBotId, conversationId);
    if (dynamic?.previous) assertPlanWorkplace(this.service, dynamic.previous.id);
    const frozen = dynamic?.previous ? workflowOf(dynamic.previous).workplace : undefined;
    const group = frozen ? { ...currentGroup, ...frozen } : currentGroup;
    const owners = new Map(stepOwners.map((owner) => [owner.stepId, owner.botId]));
    if (owners.size !== definitions.length)
      throw new RpcError(-32602, "workflow_step_owners_missing");
    for (const owner of owners.values())
      if (!group.members.some((member) => member.botId === owner))
        throw new RpcError(-32602, "workflow_step_owner_unavailable");
    const signal = AbortSignal.any([
      this.service.signal,
      ...(dynamic ? [dynamic.signal] : []),
      AbortSignal.timeout(DISPATCH_MS),
    ]);
    const workplace = await groupWorkplace(this.service.deps.local, initiatorBotId, group, signal);
    const access = workspaceFiles(this.service.deps.local, workplace.boundary, () => {
      signal.throwIfAborted();
      dynamic?.assertCurrent();
      if (dynamic?.previous) assertPlanWorkplace(this.service, dynamic.previous.id);
      else {
        const current = this.service.active(groupId, initiatorBotId, group.conversationId);
        if (
          JSON.stringify(PlanWorkplaceSchema.parse(current)) !==
          JSON.stringify(PlanWorkplaceSchema.parse(group))
        )
          throw new RpcError(-32602, "group_plan_workplace_changed");
      }
    });
    const primary = workplace.cwd;
    const delivery = dynamic?.card.delivery;
    if (delivery && delivery.workspaceRoot !== primary)
      throw new RpcError(-32602, "group_plan_workplace_changed");
    // A pending confirmation is not a reservation: never overwrite another run's new period.
    if (delivery && !dynamic?.previous) {
      // The card's own folder segment: a card from before plan folders were slugged keeps its name.
      const root = access.paths.basename(access.paths.dirname(delivery.folder));
      const current = await resolveWorkflowFolder(
        primary,
        { ...input, root },
        signal,
        undefined,
        access,
      );
      if (current.folder !== delivery.folder)
        throw new RpcError(-32602, "group_plan_output_folder_changed");
    }
    const place = delivery
      ? { folder: delivery.folder, previous: placeOverride?.previous }
      : placeOverride?.folder
        ? { folder: placeOverride.folder, previous: placeOverride.previous }
        : await resolveWorkflowFolder(primary, input, signal);
    // A replacement keeps the inputs it was built on; a new plan brings its request's attachments
    // and, for a saved plan's run, the inputs the user filled in.
    const attached = dynamic
      ? dynamic.previous
        ? ((dynamic.previous.workflow as Partial<StoredWorkflow>).inputs ?? [])
        : await planRequestInputs(this.service, dynamic.card, place.folder, signal, access)
      : [];
    const boundInputs = new Map(input.inputs.map((item) => [item.name, item]));
    for (const item of attached) {
      const existing = boundInputs.get(item.name);
      if (existing && (existing.kind !== item.kind || existing.value !== item.value))
        throw new RpcError(-32602, "group_plan_method_inputs_invalid");
      boundInputs.set(item.name, item);
    }
    if (boundInputs.size > 12) throw new RpcError(-32602, "group_plan_method_inputs_invalid");
    input = { ...input, inputs: [...boundInputs.values()] };
    if (dynamic) {
      const bots = new BotsRepo(this.service.deps.db);
      const roles = new Set(
        group.members.flatMap(({ botId }) => {
          const bot = bots.get(botId);
          return bot && !bot.archivedAt && bot.role ? [bot.role.id] : [];
        }),
      );
      input = await bindMethodFolderInputs(
        input,
        dynamic.card,
        primary,
        roles,
        (botId, method) =>
          this.service.deps.local.skills?.findWorkflow(botId, method, group.id) ??
          Promise.resolve(undefined),
        signal,
        access.paths.join(place.folder, "inputs"),
        access,
      );
    }
    const priorDetails =
      (dynamic?.previous?.workflow as Partial<StoredWorkflow> | undefined)?.relaxationDetails ?? [];
    const relaxationDetails = PlanRelaxationHistorySchema.parse([
      ...priorDetails,
      ...(dynamic?.card.relaxations ?? []),
    ]);
    const workflow: StoredWorkflow = {
      ...input,
      workplace: PlanWorkplaceSchema.parse(group),
      ...(relaxationDetails.length ? { relaxationDetails } : {}),
      ...(delivery ? { delivery } : {}),
      ...(hasAcceptanceRelaxation(relaxationDetails) ||
      (!priorDetails.length &&
        (dynamic?.previous?.workflow as Partial<StoredWorkflow> | undefined)?.acceptanceRelaxed)
        ? { acceptanceRelaxed: true }
        : {}),
      inputs: input.inputs,
      folder: place.folder,
      ...(place.previous ? { previous: place.previous } : {}),
    };
    const id = dynamic?.card.id ?? randomUUID();
    const cycleId = dynamic?.card.cycleId ?? this.service.cycles.reset(groupId);
    const messages = new MessagesRepo(this.service.deps.db);
    const retiredTasks: GroupTask[] = [];
    const source = transaction(this.service.deps.db, () => {
      signal.throwIfAborted();
      if (dynamic?.previous) assertPlanWorkplace(this.service, dynamic.previous.id);
      const currentGroup = this.service.active(groupId, initiatorBotId, group.conversationId);
      if (
        delivery &&
        !frozen &&
        JSON.stringify(PlanWorkplaceSchema.parse(currentGroup)) !==
          JSON.stringify(workflow.workplace)
      )
        throw new RpcError(-32602, "group_plan_workplace_changed");
      if (
        dynamic &&
        (this.service.cycles.get(groupId).cycleId !== cycleId ||
          this.service.cycles.get(groupId).limited ||
          group.paused)
      )
        throw new RpcError(-32602, "group_plan_stale");
      if (dynamic && this.repo.byPlan(id)) return undefined;
      // Method binding parses a copy; apply final authority to the exact snapshot being saved.
      if (dynamic) workflow.contract.budget = dynamic.assertCurrent();
      if (dynamic)
        assertRelaxationConfirmation(this.progress.replacement(dynamic.card), dynamic.card);
      const message = messages.create({
        conversationId: group.conversationId,
        role: "user",
        content: this.service.deps.redactor.redact(`运行群工作流：${workflow.name}`),
        status: "done",
        mentions: [group.coordinatorBotId],
        markUnread: false,
      });
      const prior = dynamic?.previous ? progressOf(dynamic.previous) : undefined;
      const review = prior?.review;
      const supplement =
        dynamic?.previous &&
        prior &&
        !unresolvedVerdicts(prior).length &&
        review &&
        canSupplement(review)
          ? supplementStep(
              GroupPlanSchema.parse(
                (dynamic.previous.workflow as { dynamicPlan?: unknown }).dynamicPlan,
              ),
              dynamic.card,
            )
          : undefined;
      const repairs =
        dynamic?.previous &&
        prior &&
        verdictRepairReady(this.repo.steps(dynamic.previous.id), prior)
          ? verdictRepairPairs(
              GroupPlanSchema.parse(
                (dynamic.previous.workflow as { dynamicPlan?: unknown }).dynamicPlan,
              ),
              dynamic.card,
              this.repo.steps(dynamic.previous.id),
              prior,
              currentGroup.coordinatorBotId,
            )
          : undefined;
      const created = this.repo.create({
        id,
        groupId,
        skillId:
          workflow.source.kind === "contract" ? workflow.source.skillId : workflow.source.planId,
        contractVersion: workflow.source.kind === "contract" ? workflow.source.version : null,
        status: "running",
        initiatorBotId,
        coordinatorBotId: group.coordinatorBotId,
        cycleId,
        sourceMessageId: message.id,
        budgetRootRunId: budgetRootRunId ?? null,
        workflow: dynamic
          ? {
              ...workflow,
              dynamicPlan: dynamic.card.plan,
              progress: dynamic.previous
                ? {
                    ...progressOf(dynamic.previous),
                    verdictRepairs: {
                      ...progressOf(dynamic.previous).verdictRepairs,
                      ...repairs?.rechecks,
                    },
                    verdictFixes: {
                      ...progressOf(dynamic.previous).verdictFixes,
                      ...repairs?.fixes,
                    },
                    requested: false,
                    replanRunId: undefined,
                    ...(supplement && review
                      ? { review: { ...review, supplementStepId: supplement } }
                      : {}),
                    steps: Object.fromEntries(
                      Object.entries(progressOf(dynamic.previous).steps).filter(([id]) =>
                        definitions.some((step) => step.id === id),
                      ),
                    ),
                  }
                : {
                    version: 1,
                    replans: 0,
                    requested: false,
                    steps: {},
                    ...(dynamic.card.verification
                      ? { implementation: dynamic.card.verification }
                      : {}),
                  },
            }
          : workflow,
      });
      if (budgetRootRunId) {
        const budgets = this.service.deps.local.budgets.repo;
        if (!budgets.get(budgetRootRunId))
          throw new RpcError(-32602, "group_plan_budget_origin_invalid");
        budgets.change(budgetRootRunId, (snapshot) => {
          snapshot.limits = workflowLimits(snapshot.limits, workflow, true);
        });
      }
      const previousSteps = dynamic?.previous ? this.repo.steps(dynamic.previous.id) : [];
      const passed = new Map(
        previousSteps.filter((step) => step.status === "passed").map((step) => [step.stepId, step]),
      );
      // Only the user skips a step; a replacement carries that decision instead of rerunning it.
      const skipped = new Set(
        previousSteps.filter((step) => step.status === "skipped").map((step) => step.stepId),
      );
      // A step redone after a disposition keeps the rounds it already spent, and the
      // rewrite itself is one more fix round; resetting to zero would hand it a fresh budget and
      // make the coordinator's "fix rounds used" facts lie.
      const previousAttempt = new Map(previousSteps.map((step) => [step.stepId, step]));
      const carriedAttempt = (stepId: string) => {
        const before = previousAttempt.get(stepId);
        if (!before) return 0;
        const selected = dynamic?.card.disposition?.stepId;
        return before.status === "blocked" && (!selected || selected === stepId)
          ? before.attempt + 1
          : before.attempt;
      };
      for (const step of definitions) {
        const retainedBlock =
          !!dynamic?.card.disposition &&
          dynamic.card.disposition.stepId !== step.id &&
          previousAttempt.get(step.id)?.status === "blocked";
        this.repo.createStep({
          workflowRunId: id,
          stepId: step.id,
          status: passed.has(step.id)
            ? "passed"
            : skipped.has(step.id)
              ? "skipped"
              : retainedBlock
                ? "blocked"
                : step.dependsOn.length
                  ? "waiting"
                  : "ready",
          attempt: passed.has(step.id) || skipped.has(step.id) ? 0 : carriedAttempt(step.id),
          taskId: null,
          executionRunId:
            (retainedBlock ? previousAttempt : passed).get(step.id)?.executionRunId ?? null,
          deliverables: passed.get(step.id)?.deliverables ?? [],
          ownerBotId: owners.get(step.id) as string,
          decisionMessageId: null,
        });
      }
      if (dynamic?.previous) {
        retiredTasks.push(...retirePlanTasks(this.service, dynamic.previous, previousSteps));
        this.repo.updateRun(dynamic.previous.id, "cancelled");
      }
      this.audit(created, "group.workflow.started", "Group workflow started / 群工作流已启动", {
        actor: workflow.source.kind === "dynamic" ? "automatic" : "user",
        reasonCode: workflow.source.kind,
        stepCount: definitions.length,
      });
      const acknowledged = messages.create({
        conversationId: group.conversationId,
        botId: group.coordinatorBotId,
        role: "assistant",
        content: this.service.deps.redactor.redact(
          this.service.deps.chat.currentLanguage() === "zh"
            ? `已登记计划「${workflow.name}」，正在安排步骤。`
            : `Plan “${workflow.name}” registered; scheduling steps.`,
        ),
        status: "done",
      });
      return { message, acknowledged };
    });
    if (dynamic?.previous) settlePlanWebConsent(this.service, dynamic.previous);
    for (const task of retiredTasks) {
      this.service.handoffs.settled(task.id);
      this.service.taskChanged(task);
    }
    // A durable acknowledgement must not wait for up to 20 model/credential preflights; otherwise
    // the RPC timeout could invite a duplicate launch even though persistence already succeeded.
    this.schedule(id);
    if (!source)
      return {
        userMessageId: "",
        assistantMessageId: "",
        runId: id,
        conversationId: group.conversationId,
        groupId,
        runs: [],
      };
    return {
      userMessageId: source.message.id,
      assistantMessageId: source.acknowledged.id,
      runId: id,
      conversationId: group.conversationId,
      groupId,
      runs: [],
    };
  }
}
