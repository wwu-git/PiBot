import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime, LocalToolCall, LocalToolResult, PromptContext } from "@pibot/agent";
import type {
  BrainRedactor,
  ChatConfirmation,
  ChatService,
  CollaborationPort,
  GroupWorktreesPort,
  LocalService,
  ToolInput,
  ToolRunContext,
  UserMessageDisplay,
  WorkflowRun,
} from "@pibot/brain/orchestration-kit";
import {
  abortable,
  activeGroup,
  attachmentModelForBot,
  GroupFilesService,
  GroupFoldersService,
} from "@pibot/brain/orchestration-kit";
import type { Logger } from "@pibot/observability";
import {
  type EventTable,
  type Group,
  type GroupExecutionPlan,
  GroupPlanTemplateRunSchema,
  type GroupTask,
  HANDOFF_LIMIT,
  type KernelMethodParams,
  type MethodTable,
  type ModelInfo,
  type Peer,
  RpcError,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  GroupCyclesRepo,
  GroupsRepo,
  GroupTasksRepo,
  ManagedWorktreesRepo,
  MessagesRepo,
  RunsRepo,
  transaction,
} from "@pibot/storage";
import { archiveGroup, restoreGroup } from "./group-archive.ts";
import { GroupAutoVerification } from "./group-auto-verification.ts";
import { postProgramNotice } from "./group-chat-control.ts";
import { GroupCleanup } from "./group-cleanup.ts";
import { GroupCompletion } from "./group-completion.ts";
import { agentStepBrief, groupPrompt, guardGroupRun } from "./group-context.ts";
import { groupExecutionReceipt } from "./group-execution-receipt.ts";
import { GroupHandoffs } from "./group-handoffs.ts";
import { GroupImageContextLoader } from "./group-image-context.ts";
import { GroupPlanAttemptsController } from "./group-plan-attempts.ts";
import { planBudgetResume } from "./group-plan-budget-resume.ts";
import { stepOutputNames } from "./group-plan-filenames.ts";
import { planStepRetried, planStepRetryInput } from "./group-plan-retry.ts";
import { planStepWorkspace } from "./group-plan-step-workspaces.ts";
import { type GroupPlanMethodOwner, groupPlanInstruction } from "./group-plan-validation.ts";
import { planWorkplaceGroup } from "./group-plan-workplace.ts";
import { GroupDynamicPlans } from "./group-plans.ts";
import { GroupSender } from "./group-send.ts";
import { soloDeliveryMethods } from "./group-solo-delivery.ts";
import { answerStepQuestion } from "./group-step-question.ts";
import { GroupTools } from "./group-tools.ts";
import { GroupTopicsService } from "./group-topics.ts";
import { GroupWakes } from "./group-wakes.ts";
import { publicWebTaskScope } from "./group-web-consent.ts";
import { settleWebTaskConsent } from "./group-web-task.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";
import { stepProvenance } from "./group-workflow-sources.ts";
import { GroupWorkflowScheduler } from "./group-workflows.ts";
import { ReferencePurge } from "./reference-purge.ts";

export interface GroupDependencies {
  db: DatabaseSync;
  dataDir: string;
  chat: ChatService;
  agent: AgentRuntime;
  local: LocalService;
  peer: Peer<MethodTable, EventTable>;
  redactor: BrainRedactor;
  logger: Logger;
  requireCredentials(id: string): Promise<void>;
}
/** groups.update fields that never require stopping the group's runs. */
const COSMETIC_GROUP_FIELDS = new Set([
  "name",
  "announcement",
  "autoRoundLimit",
  "externalAgentStepContext",
]);

export class GroupService implements CollaborationPort {
  interactive = true;
  agentStepBrief(context: ToolRunContext, signal: AbortSignal) {
    return agentStepBrief(this.deps.db, this.deps.redactor, context, signal);
  }
  readonly groups: GroupsRepo;
  readonly tasks: GroupTasksRepo;
  readonly cycles: GroupCyclesRepo;
  readonly runs: RunsRepo;
  readonly cleanup: GroupCleanup;
  /** Removes saved group references from Bots' session files when content goes away. */
  readonly purge: ReferencePurge;
  readonly files: GroupFilesService;
  readonly folders: GroupFoldersService;
  readonly wakes: GroupWakes;
  readonly completion: GroupCompletion;
  readonly verification: GroupAutoVerification;
  readonly topics: GroupTopicsService;
  readonly handoffs: GroupHandoffs;
  readonly plans: GroupDynamicPlans;
  readonly planAttempts: GroupPlanAttemptsController;
  readonly workflows: GroupWorkflowScheduler;
  get memberWorktrees(): GroupWorktreesPort {
    const services = this.deps.local.workspaceServices;
    if (!services) throw new RpcError(-32601, "workspaces_unavailable");
    return services.members;
  }
  private readonly tools: GroupTools;
  private readonly sender: GroupSender;
  private readonly locked = new Map<string, boolean>();
  /** Groups whose pause is cancelling runs right now; the flag itself is written after that. */
  private readonly pausing = new Set<string>();
  private readonly shutdown = new AbortController();
  get signal() {
    return this.shutdown.signal;
  }

  constructor(readonly deps: GroupDependencies) {
    this.groups = new GroupsRepo(deps.db);
    this.tasks = new GroupTasksRepo(deps.db, (t) => deps.redactor.redact(t));
    this.cycles = new GroupCyclesRepo(deps.db);
    this.runs = new RunsRepo(deps.db);
    this.cleanup = new GroupCleanup(deps.db, deps.dataDir, deps.logger);
    this.purge = new ReferencePurge(deps.db, deps.dataDir, deps.logger, (job, counts) =>
      deps.local.approvals.audit.append({
        botId: job.botId,
        kind: "group.reference.purged",
        summary: "Group references removed from Bot sessions",
        detail: {
          groupId: job.groupId,
          ...(job.conversationId ? { conversationId: job.conversationId } : {}),
          reason: job.reason,
          fileCount: counts.files,
          entryCount: counts.entries,
          actor: "system",
        },
      }),
    );
    this.files = new GroupFilesService(deps.local, (id) => this.active(id));
    this.folders = new GroupFoldersService(this);
    this.tools = new GroupTools(this);
    this.sender = new GroupSender(this);
    this.wakes = new GroupWakes(this);
    this.completion = new GroupCompletion(this);
    this.verification = new GroupAutoVerification(this);
    this.topics = new GroupTopicsService(this);
    this.handoffs = new GroupHandoffs(this);
    this.plans = new GroupDynamicPlans(this);
    this.planAttempts = new GroupPlanAttemptsController(this);
    this.workflows = new GroupWorkflowScheduler(this);
    deps.local.collaboration = this;
    deps.chat.queue.guard = (record) => {
      const bot = new BotsRepo(deps.db).get(record.botId);
      if (!bot || bot.archivedAt) throw new RpcError(-32602, "Archived Bot");
      if (record.groupId && this.locked.has(record.groupId)) return false;
      if (this.completion.blocks(record.taskId)) return false;
      if (record.groupId && record.cycleId) {
        const state = this.plans.repo.attemptState(record.groupId, record.cycleId);
        if (
          state?.status === "ended" ||
          (state?.status === "waiting" && record.automatic) ||
          (state?.status === "solo" &&
            record.botId !== this.groups.get(record.groupId)?.coordinatorBotId)
        )
          throw new RpcError(-32602, "group_plan_waits_for_user");
      }
      guardGroupRun(deps.db, record);
    };
    deps.chat.retiring = (botId) => this.retireBot(botId);
    deps.chat.queue.settled = async (record, input) => {
      try {
        await deps.local.workspaceServices?.members.settled(record);
        await this.verification.settled(record);
        await this.tools.continue(record, input);
      } finally {
        this.workflows.reconciliation.settled(record);
      }
    };
    deps.chat.queue.available = () => this.wakes.schedule();
    this.cleanup.start();
    void this.purge.sweep();
  }
  /** Capability ports must exist before persisted completions can wake a run. */
  startWorkspaceRouting() {
    this.wakes.start();
    this.workflows.startRecovery();
    this.verification.recover();
  }
  changing(groupId: string) {
    return this.locked.has(groupId) || this.completion.changing(groupId);
  }
  /** Paused, or being paused: runs stopped in this window ended because of the pause. */
  pausedFor(groupId: string) {
    return this.pausing.has(groupId) || this.groups.get(groupId)?.paused === true;
  }
  active(groupId: string, botId?: string, conversationId?: string) {
    if (!this.interactive) throw new RpcError(-32001, "Interactive client unavailable");
    if (this.shutdown.signal.aborted) throw new RpcError(-32001, "Brain stopping");
    if (this.locked.get(groupId) === false) throw new RpcError(-32011, "Group changing");
    return activeGroup(this.deps.db, groupId, botId, conversationId);
  }
  changed(groupId: string, reason: "created" | "updated" | "members" | "deleted") {
    this.deps.peer.emit("groups.changed", { groupId, reason });
    this.deps.peer.emit("sidebar.changed", { conversationKey: `group:${groupId}` });
    // Group folders live in the group record; an update may have moved the changes sidebar's root.
    if (reason === "updated")
      this.deps.peer.emit("changes.changed", {
        conversationKey: `group:${groupId}`,
        reason: "folder",
      });
    this.deps.peer.emit("inbox.changed", {});
  }
  taskChanged(task: ReturnType<GroupTasksRepo["create"]>) {
    settleWebTaskConsent(this, task);
    this.deps.peer.emit("group.task", { task });
    this.changed(task.groupId, "updated");
  }
  observePdf(
    context: ToolRunContext,
    progress: NonNullable<import("@pibot/protocol-base").AuditDetail["pdfProgress"]>,
    path: string,
    readable: boolean,
  ) {
    this.workflows.progress.reading(context, progress, path, readable);
  }
  admitPdf(context: ToolRunContext, path: string) {
    return this.workflows.progress.admit(context, path);
  }
  deliveryProvenance(runId: string, taskId?: string) {
    return stepProvenance(this, runId, taskId);
  }
  publicWebTaskScope(context: ToolRunContext) {
    return this.signal.aborted ? undefined : publicWebTaskScope(this, context);
  }
  deliveryRun(
    context: ToolRunContext,
    workflow?: import("@pibot/brain/orchestration-kit").WorkflowRun,
  ) {
    return this.handoffs.deliveryRun(context, workflow);
  }
  deliveryOutputNames(runId: string) {
    return stepOutputNames(this, runId);
  }
  soloDelivery(context: ToolRunContext, signal: AbortSignal) {
    return soloDeliveryMethods(this, context, signal);
  }
  groupExecution(context: ToolRunContext) {
    return groupExecutionReceipt(this, context);
  }
  planStepRetryInput(failedRunId: string) {
    return planStepRetryInput(this, failedRunId);
  }
  planStepRetried(failedRunId: string, newRunId: string) {
    planStepRetried(this, failedRunId, newRunId);
  }
  planBudgetResume(runId: string) {
    return planBudgetResume(this, runId);
  }
  private safe<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof TypeError && error.message === "image_coordinator_unsupported")
        throw new RpcError(-32602, error.message);
      if (
        error instanceof TypeError &&
        [
          "Unknown group",
          "Unknown active Bot",
          "Coordinator must be a member",
          "Group is full",
          "Cannot remove required member",
          "Cancel member tasks first",
          "Invalid group workplace",
        ].includes(error.message)
      )
        throw new RpcError(-32602, "Invalid group operation");
      throw error;
    }
  }
  create(params: KernelMethodParams["groups.create"]) {
    this.shutdown.signal.throwIfAborted();
    const group = this.safe(() =>
      this.groups.create({
        ...params,
        name: this.deps.redactor.redact(params.name),
        announcement: this.deps.redactor.redact(params.announcement ?? ""),
      }),
    );
    this.changed(group.id, "created");
    return group;
  }
  /**
   * Windows retest 2026-11-21: killing a running command's process tree took 13 s during a brain
   * stall, the stop's own bound answered busy after 5 s, and the pause was never saved although
   * the step had already been stopped; the next step then started. A pause commits once the stop
   * is issued: the reconciler parks the step when its run settles (pausedFor is true by then).
   */
  private async cancelForMutation(
    groupId: string,
    filter: Parameters<GroupService["deps"]["chat"]["queue"]["cancel"]>[0],
  ) {
    try {
      await this.deps.chat.queue.cancel(filter, "superseded");
    } catch (error) {
      if (!(this.pausing.has(groupId) && error instanceof RpcError && error.code === -32011))
        throw error;
      this.deps.logger.warn(
        JSON.stringify({ module: "groups", event: "pause_runs_still_stopping", groupId }),
      );
    }
  }
  async mutate(
    groupId: string,
    operation: () => Group | { ok: true },
    reason: "updated" | "members" | "deleted",
    automaticOnly = false,
    idleOnly = false,
    preservePlans = false,
    prepare?: () => Promise<void>,
  ) {
    if (this.changing(groupId) || this.sender.preparing.has(groupId))
      throw new RpcError(-32011, "Group busy");
    if (idleOnly && this.deps.chat.queue.resources().contexts.some((r) => r.groupId === groupId))
      throw new RpcError(-32011, "group_topic_busy");
    this.locked.set(groupId, automaticOnly || preservePlans);
    try {
      await prepare?.();
      // Cancel approval waiters and queue before taking any persistent membership/work-root changes.
      if (!idleOnly)
        this.deps.logger.info(
          JSON.stringify({
            module: "groups",
            event: "runs_interrupted",
            groupId,
            reason,
            automaticOnly,
          }),
        );
      if (!idleOnly)
        await this.cancelForMutation(
          groupId,
          (r) =>
            r.groupId === groupId &&
            (!automaticOnly || r.automatic) &&
            !(
              preservePlans &&
              this.workplaceGroup({
                botId: r.botId,
                runId: r.id,
                messageId: r.messageId,
                conversationId: r.conversationId,
                groupId: r.groupId ?? undefined,
                taskId: r.taskId ?? undefined,
                signal: this.signal,
                language: this.deps.chat.currentLanguage(),
              })
            ),
        );
      const result = this.safe(operation);
      this.changed(groupId, reason);
      return result;
    } finally {
      this.locked.delete(groupId);
      this.deps.chat.queue.resume();
      this.wakes.schedule();
    }
  }
  async update({ groupId, ...given }: KernelMethodParams["groups.update"]) {
    const old = this.groups.get(groupId);
    if (!old) throw new RpcError(-32602, "Unknown group");
    // Pause test 2026-11-20: the parsed RPC params always carry the schema default
    // externalAgentStepContext, so the header switch and the input bar's pause counted as a full
    // update (every run aborted, the step blocked as interrupted, continue did nothing). Only
    // fields that change something decide the path.
    const current = old as unknown as Record<string, unknown>;
    const patch = Object.fromEntries(
      Object.entries(given).filter(
        ([key, value]) =>
          value !== undefined && JSON.stringify(value) !== JSON.stringify(current[key]),
      ),
    ) as typeof given;
    // Name, announcement and the round limit change nothing a running Bot depends on. They used
    // to go through mutate(), which aborts every run of the group: saving a group setting killed a
    // member's run right after it posted a choice card, and the card was lost (maintainers 2026-11-05,
    // 安全学习小组). Only coordinator / workplace changes (and pause) need the run boundary.
    if (Object.keys(patch).every((key) => COSMETIC_GROUP_FIELDS.has(key))) {
      if (this.changing(groupId) || this.sender.preparing.has(groupId))
        throw new RpcError(-32011, "Group busy");
      const group = transaction(this.deps.db, () =>
        this.groups.update(groupId, {
          ...patch,
          ...(patch.name !== undefined ? { name: this.deps.redactor.redact(patch.name) } : {}),
          ...(patch.announcement !== undefined
            ? { announcement: this.deps.redactor.redact(patch.announcement) }
            : {}),
        }),
      );
      if (!group) throw new RpcError(-32602, "Unknown group");
      this.changed(groupId, "updated");
      return group;
    }
    const pauseOnly = Object.keys(patch).every((k) => k === "paused");
    if (pauseOnly && patch.paused) this.pausing.add(groupId);
    let result: Group;
    try {
      result = await this.updateNow(groupId, patch, pauseOnly);
    } finally {
      this.pausing.delete(groupId);
    }
    if (result.paused)
      this.deps.peer.emit("group.paused", {
        groupId,
        reason: "user",
        rounds: this.cycles.get(groupId).rounds,
        limit: result.autoRoundLimit,
      });
    // The chat's own 「继续」 resumes after storing the user's message (group-chat-control.ts).
    if (old.paused && !result.paused && !this.chatResuming.has(groupId))
      this.resumeAfterPause(result, true);
    // The switch and the input bar post the same line as the chat words and group_pause, which
    // post their own after storing what the user said.
    if (!old.paused && result.paused && pauseOnly && !this.chatPausing.has(groupId))
      postProgramNotice(this, result, "pause");
    return result;
  }
  /** Groups whose continue came from the chat's words, which resume and post a line themselves. */
  readonly chatResuming = new Set<string>();
  /** Groups whose pause came from the chat's words or group_pause, which post their own line. */
  readonly chatPausing = new Set<string>();
  /**
   * Maintainers 2026-11-20: continuing the group reruns the plan steps its pause stopped. The switch
   * gets a fixed program line naming the first resumed step; nothing resumed, no line.
   */
  resumeAfterPause(group: Group, announce: boolean) {
    const resumed = this.workflows.pause.resume(group.id);
    if (announce && resumed.length)
      postProgramNotice(
        this,
        group,
        "resume",
        resumed.map((step) => step.title),
      );
    return resumed;
  }
  private async updateNow(
    groupId: string,
    patch: Omit<KernelMethodParams["groups.update"], "groupId">,
    pauseOnly: boolean,
  ) {
    return (await this.mutate(
      groupId,
      () =>
        transaction(this.deps.db, () => {
          const previous = this.groups.get(groupId);
          const group = this.groups.update(groupId, {
            ...patch,
            ...(patch.name !== undefined ? { name: this.deps.redactor.redact(patch.name) } : {}),
            ...(patch.announcement !== undefined
              ? { announcement: this.deps.redactor.redact(patch.announcement) }
              : {}),
          });
          if (!group) throw new RpcError(-32602, "Unknown group");
          // The legacy update RPC can change the effective root without using GroupFoldersService.
          if (
            previous &&
            (previous.coordinatorBotId !== group.coordinatorBotId ||
              previous.primaryFolderId !== group.primaryFolderId ||
              JSON.stringify(previous.workplace) !== JSON.stringify(group.workplace))
          )
            new ManagedWorktreesRepo(this.deps.db).unbind(`group:${groupId}|`);
          return group;
        }),
      "updated",
      pauseOnly,
    )) as Group;
  }
  async addMember(groupId: string, botId: string) {
    return (await this.mutate(
      groupId,
      () => this.groups.addMember(groupId, botId),
      "members",
    )) as Group;
  }
  async removeMember(groupId: string, botId: string) {
    const group = this.groups.get(groupId);
    if (!group) throw new RpcError(-32602, "Unknown group");
    if (
      group.coordinatorBotId === botId ||
      group.members.length <= 2 ||
      (group.workplace.kind === "folder" && group.workplace.botId === botId)
    )
      throw new RpcError(-32602, "Cannot remove required member");
    const cancelled: GroupTask[] = [];
    const result = (await this.mutate(
      groupId,
      () =>
        transaction(this.deps.db, () => {
          cancelled.push(...this.tasks.cancelOpen(groupId, botId));
          // The Bot no longer sees this group; its saved group references go.
          this.purge.enqueue({
            groupId,
            botId,
            member: botId,
            reason: "member_removed",
          });
          return this.groups.removeMember(groupId, botId);
        }),
      "members",
    )) as Group;
    await this.purge.sweep();
    for (const task of cancelled) this.deps.peer.emit("group.task", { task });
    // A Bot that left the group no longer belongs to the chat its servers were started in.
    await this.deps.local.background.stopWhere(
      (row) => row.groupId === groupId && row.botId === botId,
      "left_group",
    );
    return result;
  }
  archive(groupId: string) {
    return archiveGroup(this, groupId);
  }
  restore(groupId: string) {
    return restoreGroup(this, groupId);
  }
  async remove(groupId: string) {
    // Background servers are stopped before the group's conversations go away (the chat they belong to).
    await this.deps.local.background.stopWhere((row) => row.groupId === groupId, "chat_deleted");
    await this.mutate(
      groupId,
      () =>
        transaction(this.deps.db, () => {
          const group = this.groups.get(groupId);
          if (!group) throw new RpcError(-32602, "Unknown group");
          const manifest = this.groups.remove(groupId);
          this.cleanup.enqueue(groupId, manifest);
          this.deps.local.approvals.audit.append({
            botId: group.coordinatorBotId,
            kind: "execution.todo.changed",
            summary: "Group dissolved / 群已解散",
            detail: { groupId, reasonCode: "group_deleted", actor: "user" },
          });
          return { ok: true as const };
        }),
      "deleted",
    );
    await this.cleanup.sweep();
    return { ok: true as const };
  }
  history(
    groupId: string,
    threadId: string | undefined,
    page: { before?: string; limit?: number },
  ) {
    const group = activeGroup(this.deps.db, groupId, undefined, threadId, true);
    if (threadId && this.tasks.forThread(threadId)?.groupId !== groupId)
      throw new RpcError(-32602, "Unknown task thread");
    this.deps.chat.openConversation(threadId ?? group.conversationId);
    return new MessagesRepo(this.deps.db).list(threadId ?? group.conversationId, page);
  }
  async model(
    botId: string,
    signal: AbortSignal,
    selection?: Pick<
      Extract<KernelMethodParams["runs.retry"], { source: "group" }>,
      "model" | "thinkingLevel"
    >,
  ) {
    const profile = new BotsRepo(this.deps.db).get(botId);
    const bot = profile && {
      ...profile,
      ...(selection?.model
        ? { modelProvider: selection.model.provider, modelId: selection.model.id }
        : {}),
      ...(selection?.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
    };
    // An external agent Bot thinks in its own program and account; it has no Pi Bot model.
    if (bot && !bot.archivedAt && bot.kind === "agent")
      return {
        bot,
        model: await attachmentModelForBot(
          this.deps.agent,
          bot,
          signal,
          this.deps.local.imageProvider,
        ),
      };
    if (!bot || bot.archivedAt || !bot.modelProvider || !bot.modelId)
      throw new RpcError(-32010, "no_model");
    await abortable(this.deps.requireCredentials(bot.modelProvider), signal);
    const model = await attachmentModelForBot(
      this.deps.agent,
      bot,
      signal,
      this.deps.local.imageProvider,
    );
    return { bot, model };
  }
  confirmNotice(
    groupId: string,
    conversationId: string,
    botId: string,
    text: string,
    confirmation: ChatConfirmation,
    display?: UserMessageDisplay,
  ) {
    return this.sender.confirmNotice(groupId, conversationId, botId, text, confirmation, display);
  }
  sendAcp(params: KernelMethodParams["groups.acp.send"]) {
    return this.sender.send(params, undefined, undefined, { inputOrigin: "acp" }, undefined, true);
  }
  send(
    params: KernelMethodParams["chat.send"] & { groupId: string },
    confirmation?: ChatConfirmation,
    workflow?: {
      botId: string;
      run: WorkflowRun;
    },
    display?: UserMessageDisplay,
  ) {
    return this.sender.send(params, confirmation, workflow, display);
  }
  startWorkflow(groupId: string, botId: string, workflow: WorkflowRun, conversationId?: string) {
    return this.workflows.start(groupId, botId, workflow, conversationId);
  }
  startPlan(groupId: string, botId: string, plan: GroupExecutionPlan, conversationId?: string) {
    return this.workflows.startPlan(groupId, botId, plan, conversationId);
  }
  /**
   * A saved plan runs as a fresh request to the coordinator. Its run becomes the plan's
   * origin and budget root, and submits the snapshotted template before the model starts.
   */
  startPlanTemplate(groupId: string, workflow: WorkflowRun, text: string, conversationId?: string) {
    const template = GroupPlanTemplateRunSchema.parse({
      skillId: workflow.skillId,
      version: workflow.version,
      name: workflow.name,
      contract: workflow.contract,
      inputs: workflow.inputs.map((input) =>
        input.kind === "text" ? { ...input, value: this.deps.redactor.redact(input.value) } : input,
      ),
    });
    return this.sender.send(
      { groupId, ...(conversationId ? { topicId: conversationId } : {}), text },
      undefined,
      undefined,
      undefined,
      template,
    );
  }
  cancelTaskSends(task: GroupTask) {
    return this.sender.cancelTask(task);
  }
  answerStepQuestion(messageId: string, text: string, confirmation: ChatConfirmation) {
    return answerStepQuestion(this, messageId, text, confirmation);
  }
  guardTool(context: ToolRunContext, tool: string) {
    this.planAttempts.guard(context, tool);
  }
  planInputFailure(context: ToolRunContext, call: LocalToolCall, failure: LocalToolResult) {
    return this.planAttempts.failure(context, call, failure);
  }
  answerPlanLimit(
    messageId: string,
    reply: KernelMethodParams["execution.question.answer"]["reply"],
    signal: AbortSignal,
  ) {
    return this.planAttempts.answer(messageId, reply, signal);
  }
  validate(context: ToolRunContext, input: ToolInput) {
    this.tools.validate(context, input);
  }
  completeRun(
    context: ToolRunContext,
    finalText: string,
    stopReason: string,
    calledTools?: readonly string[],
  ) {
    return this.completion.completeRun(context, finalText, stopReason, calledTools);
  }
  execute(
    context: ToolRunContext,
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<LocalToolResult> {
    return this.tools.execute(context, call, signal);
  }
  /**
   * The coordinator's method hint follows this group's actual members. Building it from
   * `planMethodKeys` keeps prompt, validation errors and the engine on one definition of "usable
   * method"; the keys are redacted like every other prompt part, and a member with none is skipped
   * rather than listed as able to run something.
   */
  private async planInstruction(group: Group, signal: AbortSignal): Promise<string> {
    const skills = this.deps.local.skills;
    if (!skills) return groupPlanInstruction([]);
    const bots = new BotsRepo(this.deps.db);
    const owners: GroupPlanMethodOwner[] = [];
    for (const member of group.members) {
      const bot = bots.get(member.botId);
      if (!bot || bot.archivedAt) continue;
      const keys = (await skills.planMethodKeys(bot.id, group.id, signal))
        .filter((key) => this.deps.redactor.redact(key) === key)
        .sort();
      if (keys.length) owners.push({ name: bot.name, roleId: bot.role?.id, keys });
    }
    return groupPlanInstruction(owners);
  }
  async refresh(
    context: ToolRunContext,
    signal: AbortSignal,
    model: Pick<ModelInfo, "input">,
  ): Promise<PromptContext> {
    const activeSignal = AbortSignal.any([
      context.signal,
      signal,
      this.shutdown.signal,
      AbortSignal.timeout(20_000),
    ]);
    activeSignal.throwIfAborted();
    this.active(context.groupId as string, context.botId, context.conversationId);
    const images = await new GroupImageContextLoader(this.deps.db, this.deps.dataDir).prepare(
      context,
      model,
      activeSignal,
    );
    activeSignal.throwIfAborted();
    const group = this.active(context.groupId as string, context.botId, context.conversationId);
    const instruction =
      group.coordinatorBotId === context.botId && !context.threadId
        ? await this.planInstruction(group, activeSignal)
        : undefined;
    const value = groupPrompt(
      this.deps.db,
      this.deps.redactor,
      { ...context, signal: activeSignal },
      this.deps.local.groupMemory.prompt(context.groupId as string, context.botId, {
        query: context.memoryQuery ?? "",
        runId: context.runId,
        runSignal: context.signal,
        signal: activeSignal,
      }),
      instruction,
    );
    if (value.group) {
      const workplace = await this.workplace(context, activeSignal);
      const source = this.deps.local.tasks.source(context);
      value.group.workplace = JSON.stringify({
        cwd: workplace.cwd,
        readonly: workplace.boundary.roots
          .filter((r) => r.role === "readonly")
          .map((r) => r.canonicalPath),
        memberWorktree: !!source.groupMemberWorktreeId,
      });
      const visible = new Set(
        value.group.messages.flatMap((m) => m.attachments?.map((a) => `${m.id}:${a.id}`) ?? []),
      );
      value.group.images = images.images?.filter((image) =>
        visible.has(`${image.messageId}:${image.attachmentId}`),
      );
      const states = new Map(images.imageStatus?.map((state) => [state.attachmentId, state]));
      value.group.imageStatus = value.group.imageStatus?.map(
        (state) => states.get(state.attachmentId) ?? state,
      );
    }
    return value;
  }
  /** A writing plan step's workspace facts; other runs (and frozen continuations) get none. */
  private planStep(context: ToolRunContext) {
    if (!context.taskId) return undefined;
    if (this.tasks.get(context.taskId)?.executionMode !== "parallel") return undefined;
    const step = this.handoffs.repo.get(context.taskId)?.spec.workflowStep;
    const record = step ? this.workflows.repo.get(step.workflowRunId) : undefined;
    return record ? planStepWorkspace(record, workflowOf(record)) : undefined;
  }
  workplaceGroup(context: ToolRunContext) {
    return planWorkplaceGroup(this, context);
  }
  async workplace(context: ToolRunContext, signal: AbortSignal) {
    if (this.deps.local.tasks.hasAuthority(context))
      return this.deps.local.tasks.workplace(context, signal);
    const current = this.active(context.groupId as string, context.botId, context.conversationId);
    const group = this.workplaceGroup(context) ?? current;
    return this.memberWorktrees.workplace(context, group, signal);
  }
  async prepare(context: ToolRunContext, signal: AbortSignal) {
    this.active(context.groupId as string, context.botId, context.conversationId);
    // A saved plan is submitted by the program before the coordinator's model starts.
    await this.plans.submitTemplate(context, signal);
    const current = this.active(context.groupId as string, context.botId, context.conversationId);
    const group = this.workplaceGroup(context) ?? current;
    const frozen = this.deps.local.tasks.hasAuthority(context);
    // A parallel task on a runner folder uses the runner's managed Git; an older runner
    // stops with runner_update_required (GroupMemberWorktrees.host), never plain commands.
    if (!frozen) {
      const step = this.planStep(context);
      const prepared = await this.memberWorktrees.prepare(context, group, signal, step);
      if (prepared?.fallback && step) {
        this.workflows.merges.tookTurns(context, prepared.fallback);
        // Taking turns means the run starts only after the sibling ahead of it in the folder.
        await this.memberWorktrees.waitTurn(context, signal);
      }
    }
    const workplace = frozen
      ? await this.deps.local.tasks.workplace(context, signal)
      : await this.memberWorktrees.workplace(context, group, signal);
    const source = frozen ? this.deps.local.tasks.source(context) : context;
    const currentGroup = this.active(
      context.groupId as string,
      context.botId,
      context.conversationId,
    );
    const instruction =
      currentGroup.coordinatorBotId === context.botId && !context.threadId
        ? await this.planInstruction(currentGroup, signal)
        : undefined;
    const value = groupPrompt(
      this.deps.db,
      this.deps.redactor,
      { ...context, signal },
      this.deps.local.groupMemory.prompt(context.groupId as string, context.botId, {
        query: context.memoryQuery ?? "",
        runId: context.runId,
        runSignal: context.signal,
        signal,
      }),
      instruction,
    );
    if (value.group)
      value.group.workplace = JSON.stringify({
        cwd: workplace.cwd,
        readonly: workplace.boundary.roots
          .filter((r) => r.role === "readonly")
          .map((r) => r.canonicalPath),
        memberWorktree: !!source.groupMemberWorktreeId,
      });
    return value;
  }
  /** `kind` picks the counter: structured hand-offs do not spend automatic rounds. */
  auto<T>(
    groupId: string,
    cycleId: string,
    action: () => T,
    kind: "free" | "handoff" = "free",
  ): { value?: T; reason?: string } {
    if (!this.interactive) return { reason: "client_offline" };
    if (this.locked.has(groupId)) return { reason: "group_changing" };
    const result = transaction(this.deps.db, () => {
      const reason = this.cycles.consume(groupId, cycleId, kind);
      return reason === "ok" ? { value: action() } : { reason };
    });
    if (result.reason === "limit")
      queueMicrotask(() => {
        if (this.shutdown.signal.aborted) return;
        try {
          const cycle = this.cycles.get(groupId),
            group = this.groups.get(groupId);
          if (!group || cycle.cycleId !== cycleId || !cycle.limited) return;
          this.deps.peer.emit("group.paused", {
            groupId,
            reason: "limit",
            rounds: cycle.rounds,
            limit: group.autoRoundLimit,
          });
          const handoffs = cycle.handoffs ?? 0;
          const content =
            kind === "handoff" && handoffs >= HANDOFF_LIMIT
              ? `结构化交接已达 ${handoffs} 次上限，停下来等你 / Structured hand-offs reached their limit of ${handoffs}; waiting for you`
              : `Bot 之间已自动来回 ${cycle.rounds} 次，停下来等你 / Bots reached ${cycle.rounds} automatic rounds; waiting for you`;
          const last = new MessagesRepo(this.deps.db).list(group.conversationId, { limit: 1 })[0];
          if (last?.content !== content)
            new MessagesRepo(this.deps.db).create({
              conversationId: group.conversationId,
              botId: group.coordinatorBotId,
              role: "assistant",
              content,
              status: "done",
            });
          this.changed(groupId, "updated");
        } catch {
          this.deps.logger.warn("Group limit notice deferred");
        }
      });
    return result;
  }
  async retireBot(botId: string) {
    const affected: Group[] = [];
    let before: string | undefined;
    for (;;) {
      const page = this.groups.forBot(botId, { before, limit: 200 });
      affected.push(...page);
      if (page.length < 200) break;
      before = page.at(-1)?.id;
    }
    await this.sender.cancelGroups(new Set(affected.map((g) => g.id)));
    const ids = new Set(affected.map((g) => g.id));
    await this.deps.chat.queue.cancel((r) => !!r.groupId && ids.has(r.groupId), "aborted", {
      cause: { code: "bot_retired" },
    });
    for (const group of affected)
      for (const task of this.tasks.cancelOpen(group.id, botId)) this.taskChanged(task);
  }
  async stop() {
    const verificationStopping = this.verification.stop();
    const plansStopping = this.plans.stop();
    // Existing run cleanup still needs the group's workplace port; close it after owned drains.
    await this.workflows.stop();
    this.shutdown.abort();
    await plansStopping;
    await verificationStopping;
    await this.planAttempts.stop();
    const topicsStopping = this.topics.stop();
    this.deps.local.workspaceServices?.members.cancel();
    this.wakes.stop();
    // Abort file reads immediately, without delaying cancellation of group/model preparation.
    const filesStopping = this.files.stop();
    const foldersStopping = this.folders.stop();
    await this.sender.stop();
    await this.completion.stop();
    await this.handoffs.stop();
    await filesStopping;
    await foldersStopping;
    await topicsStopping;
    await this.cleanup.stop();
    await this.purge.stop();
    await this.deps.local.workspaceServices?.members.dispose();
    this.deps.local.collaboration = undefined;
  }

  async drainInteractive() {
    this.interactive = false;
    const scans = Promise.all([this.files.drainInteractive(), this.folders.drainInteractive()]);
    await this.sender.cancelGroups(new Set(this.sender.preparing.keys()));
    await this.deps.chat.queue.drainInteractive();
    await this.completion.stop();
    await scans;
    let after = "";
    for (;;) {
      const page = this.cycles.pendingWakes(after, 200, true);
      for (const id of page) this.cycles.claimWake(id);
      if (page.length < 200) break;
      after = page.at(-1) ?? "";
    }
  }
  admitInteractive(connected: boolean) {
    this.interactive = connected;
    if (connected) this.wakes.schedule();
  }
  async pauseMaintenance() {
    await Promise.all([this.cleanup.pause(), this.purge.pause()]);
  }
  resumeMaintenance() {
    this.cleanup.resume();
    this.purge.resume();
  }
}
