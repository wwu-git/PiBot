import type {
  ChatConfirmation,
  PreparedAttachments,
  QueueInput,
  WorkflowRun,
} from "@pibot/brain/orchestration-kit";
import {
  quotedAttachmentIds,
  quotedPrompt,
  resolveMessageQuote,
  type UserMessageDisplay,
  userMessageUsage,
  validateImageInputs,
} from "@pibot/brain/orchestration-kit";
import type { GroupPlanTemplateRun, GroupTask, KernelMethodParams } from "@pibot/protocol-base";
import { RpcError } from "@pibot/protocol-base";
import { MessagesRepo, transaction } from "@pibot/storage";
import { chatControl } from "./group-chat-control.ts";
import { confirmGroupNotice } from "./group-confirmation.ts";
import { mentions } from "./group-context.ts";
import { planSupplement } from "./group-plan-supplement.ts";
import type { GroupService } from "./group-service.ts";

interface SendPreparation {
  groupId: string;
  controller: AbortController;
  tasks: GroupTask[];
}

export class GroupSender {
  readonly preparing = new Map<string, AbortController>();
  private readonly requests = new Map<Promise<unknown>, SendPreparation>();
  private readonly shutdown = new AbortController();
  constructor(private readonly service: GroupService) {}
  confirmNotice(
    groupId: string,
    conversationId: string,
    botId: string,
    text: string,
    confirmation: ChatConfirmation,
    display?: UserMessageDisplay,
  ) {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.shutdown.signal,
      confirmation.signal,
      AbortSignal.timeout(25_000),
    ]);
    const pending = confirmGroupNotice(
      this.service,
      this.preparing,
      { groupId, conversationId, botId, text, ...(display ? { display } : {}) },
      { ...confirmation, signal },
      controller,
    );
    this.requests.set(pending, { groupId, controller, tasks: [] });
    void pending
      .finally(() => this.requests.delete(pending))
      .catch(() => {
        /* The proposal RPC owns the rejection. */
      });
    return pending;
  }
  send(
    params: KernelMethodParams["chat.send"] & { groupId: string },
    confirmation?: ChatConfirmation,
    workflow?: { botId: string; run: WorkflowRun },
    display?: UserMessageDisplay,
    template?: GroupPlanTemplateRun,
    coordinatorOnly = false,
  ) {
    const preparation = { groupId: params.groupId, controller: new AbortController(), tasks: [] };
    const pending = this.sendNow(
      params,
      preparation,
      confirmation,
      workflow,
      display,
      template,
      coordinatorOnly,
    );
    this.requests.set(pending, preparation);
    void pending
      .finally(() => this.requests.delete(pending))
      .catch(() => {
        /* RPC owns the rejection. */
      });
    return pending;
  }
  private async sendNow(
    params: KernelMethodParams["chat.send"] & { groupId: string },
    preparation: SendPreparation,
    confirmation?: ChatConfirmation,
    workflow?: { botId: string; run: WorkflowRun },
    display?: UserMessageDisplay,
    template?: GroupPlanTemplateRun,
    coordinatorOnly = false,
  ) {
    const { groupId, threadId, text } = params;
    // A workflow runs on exactly the member that owns the skill, never in a task thread.
    // A saved plan is always a fresh main-chat request to the coordinator.
    if ((workflow || template) && (threadId || params.replyToMessageId))
      throw new RpcError(-32602, "workflow_group_target");
    if (this.service.changing(groupId)) throw new RpcError(-32011, "Group changing");
    const group = this.service.active(groupId, undefined, threadId ?? params.topicId);
    if (this.preparing.has(groupId)) throw new RpcError(-32011, "Group message preparing");
    // Maintainers 2026-11-20: the user's own typed 「暂停」/「继续」 works the group's pause switch
    // directly; forwards, card answers, workflows and external agents (ACP) are never commands.
    if (
      !workflow &&
      !template &&
      !coordinatorOnly &&
      !confirmation &&
      (display?.inputOrigin === "user" || display?.inputOrigin === "phone") &&
      !display.forward
    ) {
      const handled = await chatControl(this.service, params, display);
      if (handled) return handled;
    }

    const task = threadId ? this.service.tasks.forThread(threadId) : undefined;
    if (threadId && (!task || task.groupId !== groupId)) {
      throw new RpcError(-32602, "Task is missing");
    }
    if (task) this.service.active(groupId, task.assigneeBotId, threadId);
    if (params.topicId && params.topicId !== (threadId ?? group.conversationId))
      throw new RpcError(-32602, "group_topic_stale");
    const conversationId = threadId ?? group.conversationId;
    const quoteScope = { groupId, conversationId };
    const quote = resolveMessageQuote(
      this.service.deps.db,
      params.replyToMessageId,
      quoteScope,
      this.service.deps.redactor,
    );
    const explicit = coordinatorOnly
      ? [group.coordinatorBotId]
      : workflow
        ? [workflow.botId]
        : template
          ? [group.coordinatorBotId]
          : threadId
            ? []
            : quote?.botId
              ? [quote.botId]
              : mentions(this.service.deps.db, group, text, params.mentions ?? []);
    const ids = task
      ? [task.assigneeBotId]
      : quote?.botId
        ? [quote.botId]
        : explicit.length
          ? explicit
          : [group.coordinatorBotId];
    preparation.tasks = task ? [task] : [];
    const { controller } = preparation;
    this.preparing.set(groupId, controller);
    const signal = AbortSignal.any([
      controller.signal,
      this.shutdown.signal,
      AbortSignal.timeout(25_000),
      ...(confirmation ? [confirmation.signal] : []),
    ]);
    const prepared: PreparedAttachments[] = [];
    let committed = false;
    try {
      this.service.deps.chat.queue.capacity(ids);
      const targets: {
        bot: Awaited<ReturnType<GroupService["model"]>>["bot"];
        files: PreparedAttachments;
      }[] = [];
      for (const id of ids) {
        const { bot, model } = await this.service.model(id, signal);
        const files = await this.service.deps.chat.attachments.prepare(
          id,
          params.attachments ?? [],
          [
            ...(params.attachmentIds ?? []),
            ...quotedAttachmentIds(
              quote,
              !!(params.attachments?.length || params.attachmentIds?.length),
              model.input.includes("image"),
            ),
          ],
          model,
          signal,
          groupId,
        );
        prepared.push(files);
        await validateImageInputs(
          this.service.deps.agent,
          bot,
          files,
          signal,
          this.service.deps.local.imageProvider,
        );
        targets.push({ bot, files });
      }
      signal.throwIfAborted();
      await confirmation?.beforeCommit();
      signal.throwIfAborted();
      this.service.active(groupId);
      this.service.deps.chat.queue.capacity(ids);
      const result = transaction(this.service.deps.db, () => {
        // A closure can finish and release its lock before an older preflight returns.
        for (const before of preparation.tasks) {
          const current = this.service.tasks.get(before.id);
          if (
            !current ||
            current.status !== before.status ||
            current.finishedAt !== before.finishedAt
          )
            throw new RpcError(-32011, "Task changed while preparing; send again");
        }
        resolveMessageQuote(
          this.service.deps.db,
          params.replyToMessageId,
          quoteScope,
          this.service.deps.redactor,
          quote,
        );
        confirmation?.commit();
        // A task-thread supplement continues this collaboration. Resetting the whole group's
        // cycle here silently discards completion wakes from every other assigned member.
        // A main-chat message during a pending or running dynamic plan supplements it likewise.
        const supplement = task ? undefined : planSupplement(this.service, group);
        // A saved plan starts new plan work; it never silently replaces one in progress.
        if (template && supplement) throw new RpcError(-32011, "group_plan_in_progress");
        const cycleId = task
          ? (this.service.cycles.get(groupId).cycleId ?? this.service.cycles.reset(groupId))
          : (supplement?.cycleId ?? this.service.cycles.reset(groupId));
        if (task) this.service.cycles.continueTask(task.id, cycleId);
        const usage = userMessageUsage(quote, display).usage;
        const user = new MessagesRepo(this.service.deps.db).create({
          conversationId,
          role: "user",
          content: this.service.deps.redactor.redact(text),
          status: "done",
          mentions: explicit,
          ...(usage || template
            ? { usage: { ...usage, ...(template ? { groupPlanTemplate: template } : {}) } }
            : {}),
          markUnread: false,
        });
        const first = targets[0];
        if (!first) throw new RpcError(-32602, "No reply Bot");
        this.service.deps.chat.attachments.persist(user.id, first.files, first.bot.id);
        let afterRunId: string | undefined;
        const entries = targets.map(({ bot, files }) => {
          // Only an explicit task thread is a clarification; direct requests keep their actor.
          const direct = !threadId
            ? this.service.tasks.bindUserSource(
                this.service.tasks.create({
                  groupId,
                  assigneeBotId: bot.id,
                  createdByBotId: group.coordinatorBotId,
                  title: text.trim().slice(0, 200) || bot.name,
                  instructions: text.trim().slice(0, 16000) || bot.name,
                  executionMode: "serial",
                }).id,
                user.id,
              )
            : undefined;
          const input: QueueInput = {
            userInitiated: true,
            bot,
            conversationId,
            groupId,
            threadId,
            taskId: task?.id ?? direct?.id,
            userMessageId: user.id,
            cycleId,
            triggerKey: `user:${cycleId}:${user.id}:${bot.id}`,
            afterRunId,
            ...(supplement?.budgetRootRunId
              ? { budgetRootRunId: supplement.budgetRootRunId, enforceBudgetCost: true }
              : {}),
            text: this.service.deps.redactor.redact(
              [
                bot.id === group.coordinatorBotId && !workflow ? supplement?.note : undefined,
                quotedPrompt(text, quote),
                files.text,
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
            images: files.images,
            ...(template
              ? { budgetWorkflow: { contract: template.contract }, enforceBudgetCost: true }
              : {}),
            ...(workflow && bot.id === workflow.botId ? { workflow: workflow.run } : {}),
          };
          const record = this.service.deps.chat.queue.insert(input);
          afterRunId = record.id;
          return { input, record, task: direct };
        });
        return { user, entries, supplementing: !!supplement };
      });
      committed = true;
      // Only a new group instruction supersedes queued automatic replies; task and plan
      // supplements do not (queued plan steps are automatic runs of the same cycle).
      // Publish without yielding after commit: another send must see every reserved queue slot.
      if (!task && !result.supplementing)
        await this.service.deps.chat.queue.cancel(
          (r) => r.groupId === groupId && r.automatic,
          "superseded",
          { queuedOnly: true },
        );
      for (const e of result.entries) {
        this.service.deps.chat.queue.publish(e.record, e.input);
        if (e.task) this.service.taskChanged(e.task);
      }
      this.service.deps.chat.openConversation(conversationId);
      this.service.changed(groupId, "updated");
      const first = result.entries[0];
      if (!first) throw new RpcError(-32603, "Missing first run");
      return {
        ...(quote ? { quote } : {}),
        userMessageId: result.user.id,
        assistantMessageId: first.record.messageId,
        runId: first.record.id,
        conversationId,
        groupId,
        ...(threadId ? { threadId } : {}),
        runs: result.entries.map((e) => ({
          botId: e.record.botId,
          runId: e.record.id,
          assistantMessageId: e.record.messageId,
        })),
        ...(prepared[0]?.items.length
          ? { attachments: prepared[0].items.map((i) => i.metadata) }
          : {}),
      };
    } finally {
      this.preparing.delete(groupId);
      await Promise.all(prepared.slice(committed ? 1 : 0).map((p) => p.discard()));
    }
  }
  async cancelTask(task: GroupTask) {
    const pending = [...this.requests].filter(
      ([, preparation]) =>
        preparation.groupId === task.groupId && preparation.tasks.some((t) => t.id === task.id),
    );
    for (const [, preparation] of pending) preparation.controller.abort();
    await Promise.allSettled(pending.map(([request]) => request));
  }
  async cancelGroups(ids: Set<string>) {
    for (const id of ids) this.preparing.get(id)?.abort();
    await Promise.allSettled(
      [...this.requests].filter(([, p]) => ids.has(p.groupId)).map(([pending]) => pending),
    );
  }
  async stop() {
    this.shutdown.abort();
    for (const c of this.preparing.values()) c.abort();
    await Promise.allSettled([...this.requests.keys()]);
  }
}
