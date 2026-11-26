// Manages chat admission, conversation selection and durable runs.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import {
  type AgentErrorCode,
  type AttachmentInput,
  type ExecutionMode,
  type FolderSelection,
  type KernelEvents,
  type KernelMethodParams,
  type KernelMethods,
  type Peer,
  RpcError,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  ChatAdditionsRepo,
  ConversationsRepo,
  MessagesRepo,
  RunsRepo,
  SettingsRepo,
  TopicFoldersRepo,
  transaction,
} from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import { resolvePersonaLanguage } from "../../core/personas/language.ts";
import type { BrainRedactor } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import { attachmentModelForBot, validateImageInputs } from "../../runtime/media/image-preflight.ts";
import { republishQueuedWorkflows } from "../../runtime/queue/queued-recovery.ts";
import { RunQueue } from "../../runtime/queue/run-queue.ts";
import type { WorkflowRun } from "../../runtime/workflows/workflow-prepare.ts";
import { workflowUserText } from "../../runtime/workflows/workflow-text.ts";
import type { AttachmentHost } from "../attachments/attachment-types.ts";
import { AttachmentService, type PreparedAttachments } from "../attachments/attachments.ts";
import { ChatAdditionService } from "./chat-additions.ts";
import { quotedAttachmentIds, quotedPrompt, resolveMessageQuote } from "./message-quote.ts";
import { type UserMessageDisplay, userMessageUsage } from "./user-message-display.ts";

type BusinessPeer = Peer<typeof KernelMethods, typeof KernelEvents>;

export class ChatService {
  readonly queue: RunQueue;
  abortRoutine?: (runId: string) => Promise<boolean>;
  retiring?: (botId: string) => Promise<void>;
  private readonly retired = new Set<string>();
  private readonly preparing = new Map<string, AbortController>();
  private readonly preflights = new Map<Promise<unknown>, string>();
  private readonly additions: ChatAdditionService;
  private openedConversation?: string;
  private stopping = false;
  private readonly bots: BotsRepo;
  private readonly conversations: ConversationsRepo;
  private readonly messages: MessagesRepo;
  private readonly settings: SettingsRepo;
  readonly attachments: AttachmentService;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly db: DatabaseSync,
    readonly dataDir: string,
    private readonly agent: AgentRuntime,
    private readonly peer: BusinessPeer,
    readonly logger: Logger,
    private readonly redactor: BrainRedactor,
    attachmentHost?: AttachmentHost,
    readonly local?: LocalService,
    private readonly requireCredentials?: (provider: string) => Promise<void>,
  ) {
    this.bots = new BotsRepo(db);
    this.conversations = new ConversationsRepo(db);
    this.messages = new MessagesRepo(db);
    this.settings = new SettingsRepo(db);
    this.attachments = new AttachmentService(
      db,
      dataDir,
      attachmentHost,
      local ? () => local.office : undefined,
    );
    this.queue = new RunQueue({
      db,
      dataDir,
      agent,
      peer,
      logger,
      redactor,
      local,
      language: () => this.language(),
      isOpen: (id) => this.openedConversation === id,
    });
    this.queue.preparing = (botId, conversationId) =>
      this.preparing.has(`${botId}:${conversationId}`);
    this.queue.botPreparing = (botId) =>
      [...this.preflights.values()].includes(botId) ||
      [...this.preparing.keys()].some((key) => key.startsWith(`${botId}:`));
    local?.tasks.attachQueue(this.queue);
    local?.background.continuation.attach(this);
    this.additions = new ChatAdditionService({
      db,
      agent,
      peer,
      logger,
      redactor,
      queue: this.queue,
      attachments: this.attachments,
      preparing: this.preparing,
      preflights: this.preflights,
      retired: this.retired,
      shutdown: this.shutdown.signal,
      language: () => this.language(),
      isStopping: () => this.stopping || !this.interactive,
    });
  }

  private language() {
    return resolvePersonaLanguage(
      this.settings.get().language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    );
  }

  private interactive = true;
  topicBusy(botId: string, topicId: string) {
    return this.preparing.has(`${botId}:${topicId}`) || this.queue.topicBusy(topicId);
  }
  async changeTopicWorkplace<T>(botId: string, topicId: string, action: () => Promise<T>) {
    if (this.preparing.has(`${botId}:${topicId}`))
      throw new RpcError(-32011, "topic_workplace_busy");
    return this.queue.changeTopic(topicId, action);
  }
  admitInteractive(connected: boolean) {
    this.interactive = connected;
    this.queue.interactive = connected;
  }
  async drainInteractive() {
    this.admitInteractive(false);
    for (const controller of this.preparing.values()) controller.abort();
    await Promise.allSettled([...this.preflights.keys()]);
    await this.queue.drainInteractive();
  }

  withTopicOperation<T>(
    botId: string,
    conversationId: string,
    action: (signal: AbortSignal) => Promise<T>,
  ) {
    const pending = this.changeTopicWorkplace(botId, conversationId, async () => {
      if (this.stopping || !this.interactive || this.retired.has(botId))
        throw new RpcError(-32001, "chat_unavailable");
      if (
        this.preparing.size >= 128 ||
        [...this.preparing.keys()].filter((key) => key.startsWith(`${botId}:`)).length >= 16
      )
        throw new RpcError(-32011, "compaction_busy");
      const key = `${botId}:${conversationId}`;
      const controller = new AbortController();
      this.preparing.set(key, controller);
      try {
        return await action(AbortSignal.any([controller.signal, this.shutdown.signal]));
      } finally {
        if (this.preparing.get(key) === controller) this.preparing.delete(key);
      }
    });
    this.preflights.set(pending, botId);
    void pending
      .finally(() => this.preflights.delete(pending))
      .catch(() => {
        // The RPC caller receives the original refusal; tracking only retains cleanup ownership.
      });
    return pending;
  }

  private error(
    runId: string,
    messageId: string,
    code: AgentErrorCode,
    route?: { botId: string; conversationId?: string },
  ) {
    this.peer.emit("chat.error", {
      ...route,
      runId,
      messageId,
      code,
      message: code,
    });
  }

  send(
    botId: string,
    text: string,
    attachments: AttachmentInput[] = [],
    attachmentIds: string[] = [],
    topicId?: string,
    newTopic = false,
    workplace?: FolderSelection,
    initialMode?: ExecutionMode,
    replyToMessageId?: string,
    /** Internal callers only (never an RPC input): how the user's bubble shows this text. */
    display?: UserMessageDisplay,
  ) {
    const pending = this.prepare(
      botId,
      text,
      attachments,
      attachmentIds,
      topicId,
      newTopic,
      undefined,
      workplace,
      initialMode,
      replyToMessageId,
      undefined,
      display,
    );
    this.preflights.set(pending, botId);
    void pending.finally(() => this.preflights.delete(pending)).catch(() => {});
    return pending;
  }

  append(params: KernelMethodParams["chat.append"]) {
    if (this.bots.get(params.botId)?.category === "image")
      throw new RpcError(-32602, "image_steer_unsupported");
    // ACP has no "add to the running turn"; the user sends after the agent's turn ends.
    if (this.bots.get(params.botId)?.kind === "agent" && params.mode === "steer")
      throw new RpcError(-32602, "agent_steer_unsupported");
    return this.additions.append(params);
  }
  appendStatus(params: KernelMethodParams["chat.appendStatus"]) {
    return this.additions.appendStatus(params);
  }

  appendMode(params: KernelMethodParams["chat.appendMode"]) {
    return this.additions.switchMode(params);
  }
  appendGroupMode(params: KernelMethodParams["groups.appendMode"]) {
    const { conversationId, ...input } = params;
    const runId = new ChatAdditionsRepo(this.db).get(params.requestId)?.runId;
    const botId = runId ? new RunsRepo(this.db).get(runId)?.botId : undefined;
    if (!botId) throw new RpcError(-32011, "append_unavailable");
    return this.additions.switchMode({ ...input, botId, topicId: conversationId });
  }

  appendGroup(params: KernelMethodParams["groups.append"]) {
    if (this.bots.get(params.botId)?.category === "image")
      throw new RpcError(-32602, "image_steer_unsupported");
    const { conversationId, ...input } = params;
    if (this.bots.get(params.botId)?.kind === "agent" && input.mode === "steer")
      throw new RpcError(-32602, "agent_steer_unsupported");
    return this.additions.append({ ...input, topicId: conversationId });
  }
  appendGroupStatus(params: KernelMethodParams["groups.appendStatus"]) {
    const { conversationId, ...input } = params;
    return this.additions.appendStatus({ ...input, topicId: conversationId });
  }

  /**
   * Start a workflow run (pre-checks already passed) as an ordinary user turn whose visible
   * message names the workflow, its parameters and inputs. Same admission, locks and queue as
   * `send`; the run engine injects the skill body and checks delivery afterwards.
   */
  sendWorkflow(botId: string, workflow: WorkflowRun, topicId?: string) {
    const pending = this.prepare(
      botId,
      workflowUserText(workflow, this.language()),
      [],
      [],
      topicId,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      workflow,
    );
    this.preflights.set(pending, botId);
    void pending.finally(() => this.preflights.delete(pending)).catch(() => {});
    return pending;
  }

  /**
   * Once capabilities are registered (skills can be read), the private-chat workflow runs
   * a restart left queued go back into the queue. Tracked like a send, so stop waits for it.
   */
  recoverQueued() {
    const pending = republishQueuedWorkflows({
      db: this.db,
      queue: this.queue,
      local: this.local,
      logger: this.logger,
      language: () => this.language(),
      signal: this.shutdown.signal,
    });
    this.preflights.set(pending, "");
    void pending
      .finally(() => this.preflights.delete(pending))
      .catch(() => {
        if (!this.shutdown.signal.aborted) this.logger.error("Queued workflow recovery failed");
      });
  }

  /** The persona language runs use; workflow text for other entry points follows it. */
  currentLanguage() {
    return this.language();
  }

  // User acceptance and its ordinary queued reply commit together; no independent model loop.
  confirmRoutine(
    botId: string,
    text: string,
    topicId: string | undefined,
    commit: () => void,
    beforeCommit: () => Promise<void>,
    signal: AbortSignal,
    display?: UserMessageDisplay,
  ) {
    const pending = this.prepare(
      botId,
      text,
      [],
      [],
      topicId,
      false,
      {
        commit,
        beforeCommit,
        signal,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      display,
    );
    this.preflights.set(pending, botId);
    void pending.finally(() => this.preflights.delete(pending)).catch(() => {});
    return pending;
  }

  private async prepare(
    botId: string,
    text: string,
    attachments: AttachmentInput[],
    attachmentIds: string[],
    topicId?: string,
    newTopic = false,
    confirmation?: { commit(): void; beforeCommit(): Promise<void>; signal: AbortSignal },
    workplace?: FolderSelection,
    initialMode?: ExecutionMode,
    replyToMessageId?: string,
    workflow?: WorkflowRun,
    display?: UserMessageDisplay,
  ) {
    if (topicId && this.local?.tasks.tasks.isInternalConversation(topicId))
      throw new RpcError(-32602, "Unknown topic");
    if (initialMode && !newTopic) throw new RpcError(-32602, "Initial mode requires a new topic");
    if (this.stopping || !this.interactive)
      throw new RpcError(-32001, "Interactive client unavailable");
    this.queue.capacity([botId]);
    const bot = this.bots.get(botId);
    if (!bot || bot.archivedAt || this.retired.has(botId))
      throw new RpcError(-32602, "Unknown active Bot");
    const selected = newTopic
      ? undefined
      : topicId
        ? this.conversations.get(topicId)
        : this.conversations.currentDm(botId);
    if (!newTopic && (selected?.kind !== "dm" || selected.botId !== botId || selected.archivedAt))
      throw new RpcError(-32602, "Unknown topic");
    if (selected?.readOnly) throw new RpcError(-32602, "import_topic_read_only");
    if (selected) this.queue.assertTopicAdmission(selected.id);
    // The folders chosen on a new-topic draft must be this Bot's registered folders.
    if (workplace) this.validateFolders(botId, workplace);
    // Reserve before async availability lookup; concurrent sends cannot both pass preflight.

    let accepted = false;
    const runId = randomUUID();
    const admission = `${botId}:${selected?.id ?? runId}`;
    if (this.preparing.has(admission)) throw new RpcError(-32011, "busy");
    if (
      this.preparing.size >= 128 ||
      [...this.preparing.keys()].filter((key) => key.startsWith(`${botId}:`)).length >= 16
    )
      throw new RpcError(-32011, "Chat preparation capacity exceeded");
    const controller = new AbortController();
    this.preparing.set(admission, controller);
    const signal = AbortSignal.any([
      controller.signal,
      ...(confirmation ? [confirmation.signal] : []),
      this.shutdown.signal,
      AbortSignal.timeout(25_000),
    ]);
    let prepared: PreparedAttachments | undefined;
    try {
      await this.local?.memoryExtraction?.waitForCorrection(botId, selected?.id, signal);
      signal.throwIfAborted();
      const folders =
        newTopic && this.local ? (workplace ?? this.local.workplaces.initial(botId)) : null;
      if (folders?.writable?.length && this.local)
        await this.local.workplaces.context(botId, signal, { selection: folders });
      if (bot.modelProvider && this.requireCredentials)
        await abortable(this.requireCredentials(bot.modelProvider), signal);
      const model = await attachmentModelForBot(
        this.agent,
        bot,
        signal,
        this.local?.imageProvider,
      ).catch((error: unknown) => {
        if (error instanceof RpcError && error.message === "no_model")
          this.error(runId, randomUUID(), "no_model", { botId, conversationId: selected?.id });
        throw error;
      });
      if (this.stopping) throw new RpcError(-32001, "Brain stopping");
      const quote = resolveMessageQuote(
        this.db,
        replyToMessageId,
        { botId, conversationId: selected?.id, importedSource: newTopic === true },
        this.redactor,
      );
      const refs = quotedAttachmentIds(
        quote,
        !!(attachments.length || attachmentIds.length),
        model.input.includes("image"),
      );
      prepared = await this.attachments.prepare(
        botId,
        attachments,
        [...attachmentIds, ...refs],
        model,
        signal,
      );
      await validateImageInputs(this.agent, bot, prepared, signal, this.local?.imageProvider);
      if (this.stopping) throw new RpcError(-32001, "Brain stopping");
      signal.throwIfAborted();
      const currentBot = this.bots.get(botId);
      if (!currentBot || currentBot.archivedAt || this.retired.has(botId))
        throw new RpcError(-32602, "Bot archived");
      if (
        bot.category === "image" &&
        (currentBot.modelProvider !== bot.modelProvider || currentBot.modelId !== bot.modelId)
      )
        throw new RpcError(-32602, "image_model_unavailable");
      this.queue.capacity([botId]);
      await confirmation?.beforeCommit();
      signal.throwIfAborted();
      if (confirmation) {
        const latest = this.bots.get(botId);
        if (
          !latest ||
          latest.archivedAt ||
          latest.modelProvider !== bot.modelProvider ||
          latest.modelId !== bot.modelId
        )
          throw new RpcError(-32602, "routine_proposal_unavailable");
      }
      const previousTopic = newTopic ? this.conversations.currentDmIfPresent(botId)?.id : undefined;
      const [conversation, user, record] = transaction(this.db, () => {
        resolveMessageQuote(
          this.db,
          replyToMessageId,
          { botId, conversationId: selected?.id, importedSource: newTopic === true },
          this.redactor,
          quote,
        );
        confirmation?.commit();
        if (workplace) this.validateFolders(botId, workplace);
        const conversation = newTopic
          ? this.conversations.create({ botId, ...(workplace ? { workplace } : {}) })
          : selected;
        if (!conversation) throw new RpcError(-32602, "Unknown topic");
        if (newTopic) this.conversations.switchTopic(botId, conversation.id);
        if (initialMode) {
          if (!this.local) throw new RpcError(-32001, "Execution service unavailable");
          this.local.execution.initialize({ botId, conversationId: conversation.id }, initialMode);
        }
        const user = this.messages.create({
          conversationId: conversation.id,
          role: "user",
          content: this.redactor.redact(text),
          status: "done",
          runId,
          markUnread: false,
          ...userMessageUsage(quote, display),
        });
        this.attachments.persist(user.id, prepared as PreparedAttachments);
        const record = this.queue.insert({
          userInitiated: true,
          runId,
          bot,
          conversationId: conversation.id,
          userMessageId: user.id,
          text,
          ...(workflow ? { workflow } : {}),
        });
        return [conversation, user, record] as const;
      });
      accepted = true;
      this.openConversation(conversation.id, previousTopic);
      this.queue.publish(record, {
        userInitiated: true,
        bot,
        conversationId: conversation.id,
        userMessageId: user.id,
        text: [quotedPrompt(text, quote), prepared.text].filter(Boolean).join("\n\n"),
        images: prepared.images,
        ...(workflow ? { workflow } : {}),
      });
      this.peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
      return {
        ...(quote ? { quote } : {}),
        userMessageId: user.id,
        assistantMessageId: record.messageId,
        runId: record.id,
        conversationId: conversation.id,
        ...(prepared.items.length
          ? { attachments: prepared.items.map((item) => item.metadata) }
          : {}),
      };
    } finally {
      if (this.preparing.get(admission) === controller) this.preparing.delete(admission);
      this.queue.resume();
      if (!accepted) {
        await prepared?.discard();
      }
    }
  }

  private validateFolders(botId: string, workplace: FolderSelection) {
    try {
      new TopicFoldersRepo(this.db).validate(botId, workplace);
    } catch (error) {
      if (error instanceof TypeError) throw new RpcError(-32602, error.message);
      throw error;
    }
  }

  async abort(runId: string): Promise<void> {
    await this.abortRoutine?.(runId);
    await this.queue.abortTree(runId, { code: "user_stopped" });
  }
  async stop() {
    this.stopping = true;
    this.shutdown.abort();
    await this.local?.background.retirePromoted();
    await Promise.allSettled([...this.preflights.keys()]);
    await this.queue.stop();
  }
  async retireBot(botId: string) {
    this.retired.add(botId);
    this.queue.retired.add(botId);
    await this.local?.background.retirePromoted(botId);
    await this.retiring?.(botId);
    for (const [key, controller] of this.preparing)
      if (key.startsWith(`${botId}:`)) controller.abort();
    await Promise.allSettled(
      [...this.preflights].filter(([, id]) => id === botId).map(([pending]) => pending),
    );
    await this.queue.cancel((record) => record.botId === botId, "aborted", {
      cause: { code: "bot_retired" },
    });
  }
  restoreBot(botId: string) {
    this.retired.delete(botId);
    this.queue.retired.delete(botId);
    this.local?.background.foreground.restore(botId);
  }
  openConversation(conversationId: string, previousTopic = this.openedConversation) {
    if (this.local?.tasks.tasks.isInternalConversation(conversationId))
      throw new RpcError(-32602, "Unknown topic");
    this.openedConversation = conversationId;
    if (previousTopic && previousTopic !== conversationId)
      this.local?.memoryExtraction?.boundary(previousTopic);
  }
  history(botId: string, topicId?: string, page: { before?: string; limit?: number } = {}) {
    if (topicId && this.local?.tasks.tasks.isInternalConversation(topicId))
      throw new RpcError(-32602, "Unknown topic");
    const bot = this.bots.get(botId);
    if (!bot || bot.archivedAt || this.retired.has(botId))
      throw new RpcError(-32602, "Unknown active Bot");
    const topic = topicId ? this.conversations.get(topicId) : this.conversations.currentDm(botId);
    if (topic?.kind !== "dm" || topic.botId !== botId || topic.archivedAt)
      throw new RpcError(-32602, "Unknown topic");
    return this.messages.list(topic.id, page);
  }
}
