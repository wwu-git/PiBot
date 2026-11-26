// Serializes admitted runs and owns their admission and drain state.
import {
  abortStep,
  abortTreeStep,
  cancelQueuedStep,
  cancelStep,
  drainInteractiveStep,
  forceReleaseStep,
  stopStep,
} from "./run-queue-cancellation.ts";
import {
  completeStep,
  drainResourcesStep,
  pumpStep,
  settleRoutineStep,
} from "./run-queue-execution.ts";
import type { CancelReason, DrainedRun, Entry, QueueInput } from "./run-queue-shared.ts";
import { abortRun } from "./run-queue-shared.ts";

export type { CancelReason, DrainedRun, QueueInput } from "./run-queue-shared.ts";
export type RunQueueOperations = ReturnType<RunQueue["operationContext"]>;

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import {
  type KernelEvents,
  type KernelMethods,
  type Peer,
  RpcError,
  type Run,
  type RunStopCause,
  type RuntimeHealth,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  ChatAdditionsRepo,
  ConversationsRepo,
  GroupCyclesRepo,
  GroupsRepo,
  MessagesRepo,
  RunRecoveryRepo,
  RunsRepo,
  ToolJournalRepo,
  transaction,
} from "@pibot/storage";
import type { BrainRedactor } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import { FORCE_RELEASE_TIMEOUT_MS } from "../continuation/continuation-limits.ts";
import { workflowIdentity } from "../workflows/workflow-recovery.ts";
import type { ChatRun } from "./chat-run.ts";
import { stopSession } from "./run-stop.ts";
export class RunQueue {
  readonly repo: RunsRepo;
  readonly retired = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  private readonly busy = new Set<string>();
  private readonly shutdown = new AbortController();
  private stopping = false;
  private settling = 0;
  private drainHealthy = true;
  private readonly drainFailedBots = new Set<string>();
  private readonly availability = new Set<() => void>();
  private readonly drainedListeners = new Set<(run: DrainedRun) => Promise<void>>();
  onDrained(listener: (run: DrainedRun) => Promise<void>) {
    this.drainedListeners.add(listener);
    return () => {
      this.drainedListeners.delete(listener);
    };
  }
  preparing?: (botId: string, conversationId: string) => boolean;
  get acceptingContinuations() {
    return this.interactive && !this.stopping && this.drainHealthy;
  }
  onAvailable(listener: () => void) {
    this.availability.add(listener);
    return () => {
      this.availability.delete(listener);
    };
  }
  private notifyAvailable() {
    this.available?.();
    for (const listener of this.availability) listener();
  }
  canContinue(botId: string, conversationId: string, drainingSourceRunId?: string) {
    return (
      this.drainHealthy &&
      !this.stopping &&
      this.interactive &&
      !this.pausedBots.has(botId) &&
      !this.retired.has(botId) &&
      !this.changingTopics.has(conversationId) &&
      !this.preparing?.(botId, conversationId) &&
      ![...this.entries.values()].some(
        (entry) =>
          entry.record.botId === botId &&
          entry.record.conversationId === conversationId &&
          !this.drainingSource(entry.record.id, drainingSourceRunId),
      )
    );
  }
  private readonly botWorkListeners = new Set<(botId: string) => void>();
  onBotWork(listener: (botId: string) => void) {
    this.botWorkListeners.add(listener);
    return () => {
      this.botWorkListeners.delete(listener);
    };
  }
  botPreparing?: (botId: string) => boolean;
  // A correction can settle during preflight, before it has admitted any new model work.
  isBotIdle(botId: string, allowWaitingPreflights = false) {
    return (
      this.drainHealthy &&
      !this.stopping &&
      !this.pausedBots.has(botId) &&
      !this.retired.has(botId) &&
      (allowWaitingPreflights || !this.botPreparing?.(botId)) &&
      ![...this.busy].some((key) => (JSON.parse(key) as string[])[0] === botId) &&
      !this.deps.db
        .prepare("SELECT 1 FROM approvals WHERE bot_id=? AND status='pending' LIMIT 1")
        .get(botId) &&
      !this.deps.db
        .prepare("SELECT 1 FROM background_commands WHERE bot_id=? AND status='running' LIMIT 1")
        .get(botId) &&
      ![...this.entries.values()].some((entry) => entry.record.botId === botId)
    );
  }
  isIdle() {
    return (
      this.drainHealthy &&
      this.entries.size === 0 &&
      this.busy.size === 0 &&
      this.settling === 0 &&
      this.pausedBots.size === 0 &&
      (this.deps.local?.tasks.continuations.isIdle() ?? true)
    );
  }
  /** A failed drain stays failed until a restart; the UI names the busy Bots. */
  health(): RuntimeHealth {
    return {
      healthy: this.drainHealthy,
      reason: this.drainHealthy ? null : "run_drain_failed",
      botIds: [...this.drainFailedBots],
    };
  }
  /**
   * The user confirmed releasing the sessions whose drain failed. The failure state is
   * re-read here, not taken from the caller, and only a session that really ended may clear the
   * isolation the failure path put in place. A stuck `finished` therefore keeps the Bot unhealthy.
   */
  forceRelease(botId: string | undefined, ms = FORCE_RELEASE_TIMEOUT_MS): Promise<RuntimeHealth> {
    return forceReleaseStep.call(this.operationContext(), botId, ms);
  }
  /** Includes queued and SDK-draining entries, even when their persisted run is already terminal. */
  resources() {
    return {
      healthy: this.drainHealthy,
      contexts: [...this.entries.values()].map(({ record, run, input, observingDrained }) => ({
        botId: record.botId,
        runId: record.id,
        messageId: record.messageId,
        conversationId: record.conversationId,
        signal: run.signal,
        drained: observingDrained === true,
        ...(record.groupId ? { groupId: record.groupId } : {}),
        ...(input.executionTaskId ? { executionTaskId: input.executionTaskId } : {}),
        ...(run.routine
          ? { routineRunId: run.routine.id, routineWorkplace: run.routine.workplace }
          : {}),
      })),
    };
  }
  private readonly pausedBots = new Set<string>();
  private readonly changingTopics = new Set<string>();
  reservation?: (record: Run, input: QueueInput) => boolean;
  guard?: (record: Run) => boolean | undefined;
  available?: () => void;
  settled?: (record: Run, input: QueueInput) => Promise<void>;
  beforeUser?: (botId: string, conversationId: string) => Promise<void>;
  interactive = true;
  constructor(
    private readonly deps: {
      db: DatabaseSync;
      dataDir: string;
      agent: AgentRuntime;
      peer: Peer<typeof KernelMethods, typeof KernelEvents>;
      logger: Logger;
      redactor: BrainRedactor;
      local?: LocalService;
      language(): "zh" | "en";
      isOpen(conversationId: string): boolean;
    },
  ) {
    this.repo = new RunsRepo(deps.db);
    this.recoverRuns();
    new ChatAdditionsRepo(deps.db).recover();
  }
  /** One audit per interrupted run, written with the state change. */
  private recoverRuns() {
    const { db, redactor } = this.deps;
    const journal = new ToolJournalRepo(db);
    const interrupted = transaction(db, () => {
      const rows = this.repo.recover();
      const audit = this.deps.local?.approvals.audit ?? new AuditRepo(db, redactor);
      for (const run of rows)
        audit.append({
          botId: run.botId,
          runId: run.id,
          kind: "run.interrupted",
          summary: "Run interrupted by a restart / 运行因重启中断",
          detail: {
            actor: "system",
            conversationId: run.conversationId,
            reasonCode: "restart_interrupted",
            entryCount: journal.uncertainCount(run.id),
          },
        });
      return rows.length;
    });
    if (interrupted)
      this.deps.logger.warn(
        JSON.stringify({ module: "chat", event: "runs_interrupted", count: interrupted }),
      );
  }
  appendTarget(botId: string, conversationId: string, runId: string, groupId?: string) {
    const entry = this.entries.get(runId);
    if (
      this.stopping ||
      this.pausedBots.has(botId) ||
      this.retired.has(botId) ||
      !entry ||
      entry.record.botId !== botId ||
      entry.record.conversationId !== conversationId ||
      (entry.record.groupId ?? undefined) !== groupId ||
      (entry.input.groupId ?? undefined) !== groupId ||
      entry.input.executionTaskId ||
      entry.run.parking ||
      entry.run.aborted ||
      entry.run.signal.aborted ||
      this.repo.get(runId)?.status !== "running" ||
      !entry.run.session?.canAppend?.() ||
      new ChatAdditionsRepo(this.deps.db).hasApproval(runId)
    )
      throw new RpcError(-32011, "append_unavailable");
    return { bot: entry.input.bot, run: entry.run };
  }
  groupAppendTarget(
    groupId: string,
    botId: string,
    conversationId: string,
    runId: string,
    targetBotId?: string,
  ) {
    const target = this.appendTarget(botId, conversationId, runId, groupId);
    if (new GroupCyclesRepo(this.deps.db).get(groupId).cycleId !== this.repo.get(runId)?.cycleId)
      throw new RpcError(-32011, "append_unavailable");
    if (targetBotId && targetBotId !== botId) throw new RpcError(-32602, "append_identity");
    if (!targetBotId) {
      const group = new GroupsRepo(this.deps.db).get(groupId);
      if (!group || group.coordinatorBotId !== botId || group.conversationId !== conversationId)
        throw new RpcError(-32011, "append_target_required");
    }
    return target;
  }
  capacity(botIds: string[]) {
    if (this.stopping) throw new RpcError(-32001, "Brain stopping");
    if (this.entries.size + botIds.length > 128) throw new RpcError(-32011, "Run queue full");
    const counts = new Map<string, number>();
    for (const e of this.entries.values())
      counts.set(e.record.botId, (counts.get(e.record.botId) ?? 0) + 1);
    for (const id of botIds) {
      if (this.pausedBots.has(id)) throw new RpcError(-32011, "Bot workspace changing");
      if (this.retired.has(id)) throw new RpcError(-32602, "Bot retired");
      const n = (counts.get(id) ?? 0) + 1;
      if (n > 16) throw new RpcError(-32011, "Bot queue full");
      counts.set(id, n);
    }
  }
  async appendTask(runId: string, requestId: string, text: string) {
    const entry = this.entries.get(runId);
    if (
      !entry?.input.executionTaskId ||
      entry.run.signal.aborted ||
      !entry.run.session?.canAppend?.()
    )
      return false;
    return (await entry.run.session.append?.(requestId, "steer", text)) ?? false;
  }
  pendingTaskReplies(taskId: string, runId: string) {
    // Cancelling a queued question cannot turn its source's receipt into a final delivery.
    if (this.entries.get(runId)?.acceptedReply) return true;
    // A delivered answer can already have queued a continuation while another turn drains.
    return [...this.entries.values()].some(
      ({ record, input }) =>
        record.id !== runId &&
        record.taskId === taskId &&
        (!!input.replyToRunId || input.triggerKey?.startsWith("reply:")),
    );
  }
  // All persistent rows are created under the caller's transaction; publish only after commit.
  insert(input: QueueInput): Run {
    this.assertTopicAdmission(input.conversationId);
    if (!this.interactive && !input.routine)
      throw new RpcError(-32001, "Interactive client unavailable");
    const existing = input.triggerKey ? this.repo.trigger(input.triggerKey) : undefined;
    if (existing) {
      if (
        existing.botId !== input.bot.id ||
        existing.conversationId !== input.conversationId ||
        existing.groupId !== (input.groupId ?? null) ||
        existing.userMessageId !== (input.userMessageId ?? null)
      )
        throw new RpcError(-32602, "Wrong duplicate run identity");
      return existing;
    }
    this.capacity([input.bot.id]);
    const id = input.runId ?? randomUUID();
    const message = new MessagesRepo(this.deps.db).create({
      conversationId: input.conversationId,
      role: "assistant",
      botId: input.bot.id,
      content: "",
      status: "streaming",
      runId: id,
      markUnread: false,
    });
    const record = this.repo.create({
      id,
      botId: input.bot.id,
      conversationId: input.conversationId,
      groupId: input.groupId ?? null,
      kind: input.kind ?? "chat",
      messageId: message.id,
      userMessageId: input.userMessageId ?? null,
      taskId: input.taskId ?? null,
      cycleId: input.cycleId ?? null,
      automatic: input.automatic ?? false,
      parentRunId: input.parentRunId ?? null,
      afterRunId: input.afterRunId ?? null,
      ancestry: input.ancestry ?? [],
      triggerKey: input.triggerKey ?? null,
    });
    // In the same transaction as the run row, so a restart finds what it needs.
    if (input.workflow || input.resume || input.budgetRootRunId)
      new RunRecoveryRepo(this.deps.db).record(id, {
        ...(input.budgetRootRunId ? { rootRunId: input.budgetRootRunId } : {}),
        ...(input.resume ? { resumedFrom: input.resume.fromRunId } : {}),
        ...(input.workflow ? { workflow: workflowIdentity(input.workflow) } : {}),
      });
    return record;
  }
  publish(record: Run, input: QueueInput) {
    if (this.entries.has(record.id) || this.repo.get(record.id)?.status !== "queued") return;
    if (input.continuationAuthority)
      this.deps.local?.tasks.bindContinuation(
        record.id,
        input.continuationAuthority,
        !!input.parentFollowThrough,
      );
    const source = input.replyToRunId ? this.entries.get(input.replyToRunId) : undefined;
    if (source) source.acceptedReply = true;
    const controller = new AbortController();
    const run: ChatRun = {
      backgroundResults: input.backgroundResults,
      worktreeReview: input.worktreeReview,
      executionTaskId: input.executionTaskId,
      parentFollowThrough: input.parentFollowThrough,
      budgetRootRunId: input.budgetRootRunId,
      budgetWorkflow: input.budgetWorkflow,
      enforceBudgetCost: input.enforceBudgetCost,
      imageOperation: input.imageOperation,
      workflow: input.workflow,
      ...(input.modelTier ? { modelTier: input.modelTier } : {}),
      resume: input.resume,
      runId: record.id,
      botId: record.botId,
      messageId: this.repo.get(record.id)?.messageId ?? record.messageId,
      conversationId: record.conversationId,
      groupId: input.groupId,
      threadId: input.threadId,
      taskId: input.taskId,
      cycleId: input.cycleId,
      aborted: false,
      controller,
      signal: controller.signal,
      finished: Promise.resolve(),
    };
    controller.signal.addEventListener(
      "abort",
      () => {
        const cause = run.stopCause;
        // Normal finalization also aborts the controller to release resources; it is not a stop.
        if (!cause || cause.code === "completed") return;
        try {
          if (!this.repo.recordStop(record.id, cause)) return;
        } catch {
          // A failed diagnostic write must not prevent cancellation or throw out of an event listener.
          this.deps.logger.error(
            JSON.stringify({ module: "runs", event: "run_stop_record_failed", runId: record.id }),
          );
        }
        this.deps.logger.info(
          JSON.stringify({
            module: "runs",
            event: "run.stopped",
            runId: record.id,
            botId: record.botId,
            cause,
          }),
        );
      },
      { once: true },
    );
    const entry: Entry = {
      record,
      run,
      input,
      admissionReady: !(input.userInitiated && !input.routine && this.beforeUser),
    };
    this.entries.set(record.id, entry);
    for (const listener of this.botWorkListeners) listener(record.botId);
    this.status(record, "queued");
    // No model may start inside the creating transaction, or before every @ target is published.
    if (input.userInitiated && !input.routine && this.beforeUser)
      void this.beforeUser(record.botId, record.conversationId)
        .then(() => {
          if (this.entries.get(record.id) !== entry) return;
          entry.admissionReady = true;
          this.pump();
        })
        .catch(() => this.deps.logger.warn("Routine still draining; user turn remains queued"));
    else queueMicrotask(() => this.pump());
  }
  private executionKey(
    record: Pick<Run, "botId" | "conversationId"> & Partial<Pick<Run, "groupId">>,
  ) {
    return JSON.stringify([
      record.botId,
      record.groupId ? `group:${record.groupId}` : record.conversationId,
    ]);
  }
  private status(record: Run, state: "queued" | "running" | "idle") {
    // Internal child runs have no chat status bubble, but still change active task counts.
    this.deps.peer.emit("inbox.changed", {});
    if (this.deps.local?.tasks.tasks.isInternalConversation(record.conversationId)) return;
    const c = new ConversationsRepo(this.deps.db).get(record.conversationId);
    this.deps.peer.emit("chat.status", {
      botId: record.botId,
      conversationId: record.conversationId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(c?.kind === "thread" ? { threadId: c.id } : {}),
      messageId: this.repo.get(record.id)?.messageId ?? record.messageId,
      runId: record.id,
      state,
      ...(state === "queued"
        ? {
            queuePosition:
              [...this.entries.values()]
                .filter((e) => this.executionKey(e.record) === this.executionKey(record))
                .findIndex((e) => e.record.id === record.id) + 1,
          }
        : {}),
    });
  }
  private pump(): void {
    pumpStep.call(this.operationContext());
  }
  // generateRun certifies SDK idle before this runs. Only then may a continuation acquire its topic.
  private complete(entry: Entry): Promise<void> {
    return completeStep.call(this.operationContext(), entry);
  }
  private drainResources(entry: Entry, record: Run | undefined): Promise<void> {
    return drainResourcesStep.call(this.operationContext(), entry, record);
  }
  /** The SDK is already idle, so a failed routine bookkeeping write must not keep the Bot busy. */
  private settleRoutine(entry: Entry, current: Run | undefined): Promise<void> {
    return settleRoutineStep.call(this.operationContext(), entry, current);
  }
  /**
   * A publish that throws before the run enters `entries` leaves only a durable queued row, which
   * no scheduler will ever pick up. Reclaim exactly that row; a run already in memory is the
   * normal path's responsibility, so this stays out of its way.
   *
   * No `notifyAvailable()`: the row never held `entries` or `busy`, so reclaiming it frees no
   * capacity. Notifying would make continuations re-dispatch into the same full queue and burn
   * their retries within milliseconds; only a run that really ends may wake them.
   */
  abandon(record: Run, input: Pick<QueueInput, "groupId" | "threadId">, reason: string) {
    if (this.entries.has(record.id)) return;
    const reclaimed = transaction(this.deps.db, () => this.repo.abandonQueued(record.id, reason));
    if (!reclaimed) return;
    this.deps.peer.emit("chat.error", {
      botId: record.botId,
      conversationId: record.conversationId,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      runId: record.id,
      messageId: record.messageId,
      code: "aborted",
      message: "aborted",
    });
    this.status(record, "idle");
  }
  private cancelQueued(entry: Entry): void {
    cancelQueuedStep.call(this.operationContext(), entry);
  }
  resume() {
    queueMicrotask(() => {
      this.notifyAvailable();
      this.pump();
    });
  }
  assertTopicAdmission(conversationId: string) {
    if (this.changingTopics.has(conversationId)) throw new RpcError(-32011, "topic_workplace_busy");
  }
  private drainingSource(runId: string, sourceRunId?: string) {
    return runId === sourceRunId && !!this.repo.get(runId)?.finishedAt;
  }
  topicBusy(conversationId: string, drainingSourceRunId?: string) {
    return (
      this.changingTopics.has(conversationId) ||
      !!this.deps.local?.tasks.tasks.sourceBusy(conversationId) ||
      [...this.entries.values()].some(
        (entry) =>
          entry.record.conversationId === conversationId &&
          !this.drainingSource(entry.record.id, drainingSourceRunId),
      )
    );
  }
  async changeTopic<T>(conversationId: string, action: () => Promise<T>) {
    if (this.topicBusy(conversationId)) throw new RpcError(-32011, "topic_workplace_busy");
    this.changingTopics.add(conversationId);
    try {
      return await action();
    } finally {
      this.changingTopics.delete(conversationId);
    }
  }
  async pauseBot(botId: string) {
    if (this.pausedBots.has(botId)) throw new RpcError(-32011, "Bot workspace changing");
    this.pausedBots.add(botId);
    const release = () => {
      this.pausedBots.delete(botId);
      this.resume();
    };
    try {
      await this.cancel((r) => r.botId === botId, "aborted", {
        cause: { code: "workspace_changed" },
      });
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  async park(id: string, commit: () => void) {
    const entry = this.entries.get(id);
    if (!entry?.run.parking || !entry.run.routine) throw new RpcError(-32602, "Not a routine gate");
    const run = entry.run;
    try {
      abortRun(run, { code: "park" });
      await stopSession(run);
      await this.drainResources(entry, this.repo.get(entry.record.id));
      commit();
    } catch (error) {
      // Not parked: the run was aborted, so hand it back to the normal completion path, which
      // releases the Bot once the SDK is idle (now, if it already is).
      run.parking = false;
      if (entry.drained) await this.complete(entry);
      throw error;
    }
    run.routine?.clock.dispose();
    this.entries.delete(id);
    this.busy.delete(this.executionKey(entry.record));
    await this.settleRoutine(entry, this.repo.get(id));
    this.status(entry.record, "idle");
    this.notifyAvailable();
    this.pump();
  }
  /** Single-run stop: abort and wait for the session (kept next to `cancel`). */
  abort(
    id: string,
    routineFailureCode?: string,
    cause: RunStopCause = { code: "user_stopped" },
  ): Promise<void> {
    return abortStep.call(this.operationContext(), id, routineFailureCode, cause);
  }
  abortTree(id: string, cause?: RunStopCause): Promise<void> {
    return abortTreeStep.call(this.operationContext(), id, cause);
  }
  cancel(
    filter: (record: Run) => boolean,
    reason: CancelReason,
    options: { queuedOnly?: boolean; cause?: RunStopCause } = {},
  ): Promise<void> {
    return cancelStep.call(this.operationContext(), filter, reason, options);
  }
  stop(): Promise<void> {
    return stopStep.call(this.operationContext());
  }

  drainInteractive(): Promise<void> {
    return drainInteractiveStep.call(this.operationContext());
  }

  // Keep live access to private state: an awaited step must observe later cancellation and scope changes.
  private operationContext() {
    const owner = this;
    return {
      owner,
      abort: owner.abort.bind(owner),
      get availability() {
        return owner.availability;
      },
      get busy() {
        return owner.busy;
      },
      cancel: owner.cancel.bind(owner),
      cancelQueued: owner.cancelQueued.bind(owner),
      complete: owner.complete.bind(owner),
      get deps() {
        return owner.deps;
      },
      get drainFailedBots() {
        return owner.drainFailedBots;
      },
      get drainHealthy() {
        return owner.drainHealthy;
      },
      set drainHealthy(value: RunQueue["drainHealthy"]) {
        owner.drainHealthy = value;
      },
      drainResources: owner.drainResources.bind(owner),
      get drainedListeners() {
        return owner.drainedListeners;
      },
      get entries() {
        return owner.entries;
      },
      executionKey: owner.executionKey.bind(owner),
      get guard() {
        return owner.guard;
      },
      set guard(value: RunQueue["guard"]) {
        owner.guard = value;
      },
      health: owner.health.bind(owner),
      notifyAvailable: owner.notifyAvailable.bind(owner),
      get pausedBots() {
        return owner.pausedBots;
      },
      get preparing() {
        return owner.preparing;
      },
      set preparing(value: RunQueue["preparing"]) {
        owner.preparing = value;
      },
      pump: owner.pump.bind(owner),
      get repo() {
        return owner.repo;
      },
      get reservation() {
        return owner.reservation;
      },
      set reservation(value: RunQueue["reservation"]) {
        owner.reservation = value;
      },
      settleRoutine: owner.settleRoutine.bind(owner),
      get settled() {
        return owner.settled;
      },
      set settled(value: RunQueue["settled"]) {
        owner.settled = value;
      },
      get settling() {
        return owner.settling;
      },
      set settling(value: RunQueue["settling"]) {
        owner.settling = value;
      },
      get shutdown() {
        return owner.shutdown;
      },
      status: owner.status.bind(owner),
      get stopping() {
        return owner.stopping;
      },
      set stopping(value: RunQueue["stopping"]) {
        owner.stopping = value;
      },
    };
  }
}
