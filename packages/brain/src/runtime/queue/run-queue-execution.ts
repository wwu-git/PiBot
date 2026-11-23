import { DEFAULT_EXECUTION_LIMITS, RpcError, type Run } from "@pibot/protocol-base";
import {
  ApprovalsRepo,
  ConversationsRepo,
  MessagesRepo,
  RunEventsRepo,
  SidebarRepo,
  transaction,
} from "@pibot/storage";
import { memoryRecallQuery } from "../memory/query.ts";
import { generateRun } from "./chat-run.ts";
import type { RunQueueOperations } from "./run-queue.ts";
import type { DrainedRun, Entry } from "./run-queue-shared.ts";

export function pumpStep(this: RunQueueOperations): void {
  if (this.stopping) return;
  const heads = new Set<string>();
  // User turns acquire their topic before queued automatic work, without replacing group hooks.
  for (const entry of [...this.entries.values()].sort(
    (a, b) => Number(!a.input.userInitiated) - Number(!b.input.userInitiated),
  )) {
    const { record, input, run } = entry;
    const key = this.executionKey(record);
    if (entry.admissionReady === false) {
      heads.add(key);
      continue;
    }
    if (
      this.pausedBots.has(record.botId) ||
      this.busy.has(key) ||
      this.repo.get(record.id)?.status !== "queued"
    )
      continue;
    if (
      input.userInitiated &&
      !input.routine &&
      new ApprovalsRepo(this.deps.db).hasPendingConversation(record.conversationId)
    ) {
      heads.add(key);
      continue;
    }
    // Reservation-blocked automatic work must not hide the original approved continuation.
    if (this.reservation?.(record, input) === false) continue;
    if (input.continuationAuthority && this.preparing?.(record.botId, record.conversationId))
      continue;
    if (heads.has(key)) continue;
    heads.add(key);
    if (record.afterRunId) {
      const parent = this.repo.get(record.afterRunId);
      if (parent && (parent.status === "queued" || parent.status === "running")) continue;
    }
    try {
      if (
        input.backgroundCommandId &&
        !this.deps.local?.background.continuation.canDispatch(record)
      )
        throw new RpcError(-32602, "background_source_changed");
      if (input.parentFollowThrough && input.continuationAuthority && this.deps.local) {
        const source = input.continuationAuthority.source;
        if (
          this.deps.local.execution.todo({
            botId: source.botId,
            conversationId: source.conversationId as string,
          }).version !== input.parentFollowThrough.planVersion
        )
          throw new RpcError(-32602, "task_source_changed");
      }
      this.deps.local?.tasks.verifyContinuation(record.id, run.controller.signal);
      if (this.guard?.(record) === false) continue;
    } catch {
      this.cancelQueued(entry);
      heads.delete(key);
      continue;
    }
    try {
      const claim = () => (input.routine ? input.routine.claim(run) : !!this.repo.start(record.id));
      if (!(this.deps.local ? this.deps.local.tasks.claim(record.id, claim) : claim())) {
        // A paused/sleeping routine stays queued but must not hold the Bot's place in line.
        if (input.routine) heads.delete(key);
        continue;
      }
    } catch {
      this.deps.logger.warn(`Run claim failed run=${record.id}`);
      this.cancelQueued(entry);
      heads.delete(key);
      continue;
    }
    this.busy.add(key);
    this.deps.peer.emit("inbox.changed", {});
    // State transitions are emitted by the queue only. chat-run keeps the
    // progress flags (compacting / reconnecting) that only a live session can observe, and a
    // worktree review never opens a session, so it never reported `running`.
    if (!input.executionTaskId && !input.worktreeReview) this.status(record, "running");
    run.signal = AbortSignal.any([
      run.controller.signal,
      this.shutdown.signal,
      ...(input.routine || this.deps.local
        ? []
        : [AbortSignal.timeout(DEFAULT_EXECUTION_LIMITS.activeSeconds * 1_000)]),
    ]);
    const conversation = new ConversationsRepo(this.deps.db).get(record.conversationId);
    const source = record.userMessageId
      ? new MessagesRepo(this.deps.db).get(record.userMessageId)
      : undefined;
    const request =
      source?.role === "user" && source.conversationId === record.conversationId
        ? source.content
        : "";
    // One snapshot binds pending input to both retrieval and SDK-delivery acknowledgement.
    const taskPrompt = this.deps.local?.tasks.promptParts(record.id, input.text) ?? {
      text: input.text,
      current: [input.text],
      references: [],
    };
    run.projectBackground = !!input.userInitiated && !input.routine;
    if (
      input.userInitiated &&
      !input.routine &&
      !input.executionTaskId &&
      (record.kind === "chat" || (record.kind === "group_task" && record.groupId)) &&
      source?.role === "user" &&
      source.conversationId === record.conversationId
    )
      run.interactiveChat = true;
    run.finished = generateRun(
      { ...this.deps, finished: () => {} },
      run,
      taskPrompt.text,
      conversation?.kind === "dm" ? conversation.piSessionFile : null,
      input.bot,
      input.images ?? [],
      memoryRecallQuery(request, taskPrompt.current),
    )
      .then(async () => {
        entry.drained = true;
        if (run.parking) return;
        await this.complete(entry);
      })
      .catch(() => {
        this.drainHealthy = false;
        this.drainFailedBots.add(record.botId);
        // No certified idle: keep isolation instead of starting a second session or closing its DB.
        this.deps.logger.error(`Run drain failed bot=${record.botId} run=${record.id}`);
        try {
          this.deps.peer.emit("runtime.health", {
            healthy: false,
            reason: "run_drain_failed",
            botIds: [...this.drainFailedBots],
          });
          this.deps.local?.approvals.audit.append({
            botId: record.botId,
            runId: record.id,
            kind: "runtime.drain_failed",
            summary: "Run drain failed / 会话排空失败",
            detail: { reasonCode: "run_drain_failed" },
          });
        } catch {
          // Reporting the failure must not turn it into a rejection: the run is hung by design.
          this.deps.logger.warn(`Run drain failure not reported run=${record.id}`);
        }
        return new Promise<void>(() => {});
      });
  }
}

// generateRun certifies SDK idle before this runs. Only then may a continuation acquire its topic.
export async function completeStep(this: RunQueueOperations, entry: Entry): Promise<void> {
  const { record, input, run } = entry;
  this.settling++;
  try {
    const current = this.repo.get(record.id);
    run.routine?.clock.dispose();
    await this.settleRoutine(entry, current);
    await this.drainResources(entry, current);
    if (current) this.deps.local?.tasks.settled(current);
    this.entries.delete(record.id);
    if (!record.groupId) this.busy.delete(this.executionKey(record));
    this.status(record, "idle");
    if (!record.groupId) this.notifyAvailable();
    if (current)
      try {
        await this.settled?.(current, input);
      } catch {
        this.deps.logger.warn(`Group continuation deferred run=${record.id}`);
      }
    // Shutdown still has to append its interrupted correction. Its owner seals all terminal
    // entries after that correction; every other path is now fully drained and may be sealed.
    if (!this.stopping)
      transaction(this.deps.db, () => new RunEventsRepo(this.deps.db).sealTerminal(record.id));
    if (record.groupId) {
      this.busy.delete(this.executionKey(record));
      this.notifyAvailable();
    }
    if (!input.executionTaskId) {
      const key = record.groupId ? `group:${record.groupId}` : `dm:${record.botId}`;
      new SidebarRepo(this.deps.db).activity(key, !this.deps.isOpen(record.conversationId));
      this.deps.peer.emit("sidebar.changed", { conversationKey: key });
    }
    this.pump();
  } finally {
    this.settling--;
  }
}

export async function drainResourcesStep(
  this: RunQueueOperations,
  entry: Entry,
  record: Run | undefined,
): Promise<void> {
  const local = this.deps.local;
  const observe = async () => {
    await local?.browserProvider?.drainedRun(entry.record.botId, entry.record.id);
    entry.observingDrained = true;
    if (record?.finishedAt && !entry.run.parking) {
      const observation: DrainedRun = {
        record,
        context: local?.drainedContext(record.id),
        signal: AbortSignal.timeout(120_000),
      };
      for (const listener of this.drainedListeners) await listener(observation);
    }
  };
  if (local) await local.runCleanup.drain(entry.record.id, observe);
  else await observe();
  local?.releaseContext(entry.record.id);
}

/** The SDK is already idle, so a failed routine bookkeeping write must not keep the Bot busy. */
export async function settleRoutineStep(
  this: RunQueueOperations,
  entry: Entry,
  current: Run | undefined,
): Promise<void> {
  if (!current || !entry.input.routine) return;
  try {
    await entry.input.routine.settled(entry.run, current);
  } catch {
    this.deps.logger.error(`Routine settle failed run=${entry.record.id}`);
  }
}
