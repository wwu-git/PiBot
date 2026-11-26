// Owns Bot changes and private topic lifecycle operations.
import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import {
  type KernelEvents,
  type KernelMethodParams,
  type KernelMethods,
  type Peer,
  RpcError,
  resolveThinkingLevel,
} from "@pibot/protocol-base";
import {
  BotCleanupRepo,
  BotsRepo,
  ConversationsRepo,
  SettingsRepo,
  SidebarRepo,
  TopicsRepo,
  transaction,
} from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import { businessResult } from "../../core/business-errors.ts";
import { fallbackPersona } from "../../core/personas/bot.ts";
import { resolvePersonaLanguage } from "../../core/personas/language.ts";
import type { BrainRedactor } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import { TopicWorkplaceService } from "../../resources/workplaces/topic-workplace.ts";
import { requireImageModel } from "../../runtime/media/image-preflight.ts";
import type { ModelSettingsPort } from "../../runtime/models/port.ts";
import type { ChatService } from "../chat/chat.ts";
import { TopicArchiveService } from "../chat/topic-archive.ts";
import { avatarColors, avatarShapes, checkAvatar, unusedAvatar } from "./avatars.ts";
import { BotCleanupService } from "./bot-cleanup.ts";

export class BotService {
  readonly topicWorkplace: TopicWorkplaceService;
  readonly topicArchive: TopicArchiveService;
  readonly bots: BotsRepo;
  readonly conversations: ConversationsRepo;
  private readonly shutdown = new AbortController();
  private readonly changing = new Set<string>();
  private readonly archiving = new Set<string>();
  private creating = 0;
  private readonly cleanup: BotCleanupService;
  pauseMaintenance() {
    return this.cleanup.pause();
  }
  resumeMaintenance() {
    this.cleanup.resume();
  }
  constructor(
    private readonly deps: {
      db: DatabaseSync;
      dataDir: string;
      agent: AgentRuntime;
      modelSettings: Pick<ModelSettingsPort, "updateBot">;
      chat: ChatService;
      local: LocalService;
      peer: Peer<typeof KernelMethods, typeof KernelEvents>;
      redactor: BrainRedactor;
      logger: Logger;
      requireCredentials(providerId: string): Promise<void>;
    },
  ) {
    this.bots = new BotsRepo(deps.db);
    this.topicWorkplace = new TopicWorkplaceService(deps.local, deps.chat, this.shutdown.signal);
    this.topicArchive = new TopicArchiveService(deps.local, deps.chat, this.shutdown.signal, (id) =>
      this.active(id),
    );
    this.conversations = new ConversationsRepo(deps.db);
    this.cleanup = new BotCleanupService(deps.db, deps.dataDir, deps.logger);
  }
  private language() {
    return resolvePersonaLanguage(
      new SettingsRepo(this.deps.db).get().language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    );
  }
  active(botId: string) {
    const bot = this.bots.get(botId);
    if (!bot || bot.archivedAt || this.archiving.has(botId))
      throw new RpcError(-32602, "Unknown active Bot");
    return bot;
  }
  list(params: KernelMethodParams["bots.list"]) {
    const { includeArchived, ...page } = params ?? {};
    return this.bots.page(page, includeArchived ?? false);
  }
  private avatar(preferred?: { avatarShape?: string; avatarColor?: string }) {
    const used = new Set<string>();
    let before: string | undefined;
    for (;;) {
      const page = this.bots.page({ before, limit: 200 }, true);
      for (const bot of page)
        if (avatarShapes.includes(bot.avatarShape) && avatarColors.includes(bot.avatarColor))
          used.add(`${bot.avatarShape}:${bot.avatarColor}`);
      if (page.length < 200 || used.size === avatarShapes.length * avatarColors.length) break;
      before = page.at(-1)?.id;
    }
    const { avatarShape, avatarColor } = preferred ?? {};
    if (avatarShape && avatarColor && !used.has(`${avatarShape}:${avatarColor}`))
      return { avatarShape, avatarColor, avatarEyes: "marks" };
    return unusedAvatar(used);
  }
  private changed(botId: string, reason: "created" | "updated" | "archived" | "removed") {
    this.deps.peer.emit("bots.changed", { botId, reason });
    this.deps.peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
  }
  /**
   * Opens the new Bot's first topic. Maintainers 2026-11-13: it starts empty like every new topic, so it
   * shows the same greeting page (avatar, "Hi, I'm …", suggestions, folder line); a stored
   * self-introduction made the first topic look different from all later ones.
   */
  introduce(botId: string) {
    this.active(botId);
    const topic = this.conversations.create({ botId });
    this.conversations.switchTopic(botId, topic.id);
    new SidebarRepo(this.deps.db).open(`dm:${botId}`);
    this.deps.chat.openConversation(topic.id);
  }
  async create(params: KernelMethodParams["bots.create"]) {
    this.shutdown.signal.throwIfAborted();
    checkAvatar(params);
    if (this.creating >= 8) throw new RpcError(-32011, "Bot creation busy");
    this.creating++;
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(25_000)]);
    const language = this.language();
    let persona: ReturnType<typeof fallbackPersona> | undefined;
    try {
      if (params.category === "image") {
        if (params.systemPrompt !== undefined || params.norms !== undefined)
          throw new RpcError(-32602, "Image Bots do not use text personas or norms");
        const model = await requireImageModel(
          this.deps.local.images,
          params.model,
          undefined,
          signal,
        );
        await abortable(this.deps.requireCredentials(model.provider), signal);
        signal.throwIfAborted();
        const description = this.deps.redactor.redact(params.description);
        const defaults = new SettingsRepo(this.deps.db).get().defaultModel;
        const main = this.bots.getMain();
        const name =
          params.name ??
          (await this.deps.local.images.name({
            agent: this.deps.agent,
            description,
            language,
            signal,
            preferences: [
              defaults,
              main?.modelProvider && main.modelId
                ? { provider: main.modelProvider, id: main.modelId }
                : null,
            ],
            credentials: this.deps.requireCredentials,
            logger: this.deps.logger,
          }));
        signal.throwIfAborted();
        const bot = transaction(this.deps.db, () => {
          const value = this.bots.create(
            {
              category: "image",
              imageMode: model.modes[0],
              name: this.deps.redactor.redact(name),
              systemPrompt: "",
              description,
              isMain: false,
              ...this.avatar(params),
              modelProvider: model.provider,
              modelId: model.id,
              thinkingLevel: "off",
              permissionOverrides: {},
              memoryMode: "auto",
            },
            { exactName: params.name !== undefined },
          );
          this.introduce(value.id);
          return value;
        });
        this.changed(bot.id, "created");
        return bot;
      }
      if (params.imageMode !== undefined) throw new RpcError(-32602, "image_mode_mismatch");
      const defaults = new SettingsRepo(this.deps.db).get().defaultModel;
      const requested = params.model ?? defaults ?? undefined;
      const available = await abortable(
        this.deps.agent.listModels({ availableOnly: true }),
        signal,
      );
      const model = requested
        ? available.find((m) => m.provider === requested.provider && m.id === requested.id)
        : undefined;
      if (requested && !model) throw new RpcError(-32602, "Model unavailable");
      if (params.systemPrompt !== undefined) {
        persona = {
          name: params.name ?? fallbackPersona(params.description, language).name,
          systemPrompt: params.systemPrompt,
        };
      } else if (model) {
        try {
          await abortable(this.deps.requireCredentials(model.provider), signal);
          persona = await abortable(
            this.deps.agent.generatePersona({
              description: this.deps.redactor.redact(params.description),
              language,
              model,
              signal,
            }),
            signal,
          );
        } catch {
          if (this.shutdown.signal.aborted) throw new RpcError(-32001, "Brain stopping");
          this.deps.logger.warn("Bot persona generation failed; using safe fallback");
        }
      }
      this.shutdown.signal.throwIfAborted();
      const preference =
        params.thinkingLevel ??
        (!params.model && defaults
          ? defaults.thinkingPreference === undefined
            ? defaults.thinkingLevel
            : defaults.thinkingPreference
          : null);
      const thinkingLevel = model ? resolveThinkingLevel(model, preference) : "off";
      const description = this.deps.redactor.redact(params.description);
      const safePersona = persona ?? fallbackPersona(description, language);
      const bot = transaction(this.deps.db, () => {
        const value = this.bots.create(
          {
            name: this.deps.redactor.redact(params.name ?? safePersona.name),
            systemPrompt: this.deps.redactor.redact(safePersona.systemPrompt),
            ...(params.norms !== undefined
              ? { norms: this.deps.redactor.redact(params.norms) }
              : {}),
            description,
            isMain: false,
            ...this.avatar(params),
            modelProvider: requested?.provider ?? null,
            modelId: requested?.id ?? null,
            thinkingLevel,
            thinkingPreference: preference,
            permissionOverrides: {},
            memoryMode: "auto",
          },
          { exactName: params.name !== undefined },
        );
        this.introduce(value.id);
        return value;
      });
      this.changed(bot.id, "created");
      return bot;
    } finally {
      this.creating--;
    }
  }
  private async exclusive<T>(botId: string, action: () => Promise<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    if (this.changing.has(botId)) throw new RpcError(-32011, "Bot update busy");
    this.changing.add(botId);
    try {
      return await action();
    } finally {
      this.changing.delete(botId);
    }
  }
  async update(params: KernelMethodParams["bots.update"]) {
    return this.exclusive(params.botId, async () => {
      checkAvatar(params);
      // A reviewer must be a live chat Bot; the review run itself stays read-only.
      if (params.reviewBotId) {
        const reviewer = this.bots.get(params.reviewBotId);
        if (!reviewer || reviewer.archivedAt || reviewer.category !== "chat")
          throw new RpcError(-32602, "review_bot_unavailable");
      }
      const patch = { ...params };
      for (const key of ["name", "description", "systemPrompt", "norms"] as const)
        if (patch[key] !== undefined) patch[key] = this.deps.redactor.redact(patch[key]);
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(25_000)]);
      const bot = await this.deps.modelSettings.updateBot(patch, signal);
      this.changed(bot.id, "updated");
      return bot;
    });
  }
  async duplicate(botId: string) {
    return this.exclusive(botId, async () => {
      const original = this.active(botId);
      const colors = avatarColors.filter((c) => c !== original.avatarColor);
      const bot = transaction(this.deps.db, () => {
        const value = this.bots.duplicate(botId, colors[randomInt(colors.length)] ?? "violet");
        this.introduce(value.id);
        return value;
      });
      this.changed(bot.id, "created");
      return bot;
    });
  }
  profile(botId: string) {
    const bot = this.active(botId);
    return {
      bot,
      memories: this.deps.local.memory.list(botId),
      proposals: this.deps.local.memory.proposals(botId),
      permissionOverrides: bot.permissionOverrides ?? {},
      undoable: this.deps.local.memory.undoable(botId),
    };
  }
  archived(params: KernelMethodParams["bots.archived"]) {
    return this.bots.archivedBefore(new Date().toISOString(), params);
  }
  async restore(botId: string) {
    return this.exclusive(botId, async () => {
      const bot = transaction(this.deps.db, () => {
        const current = this.bots.get(botId);
        if (!current || current.isMain) throw new RpcError(-32602, "bot_archive_unavailable");
        if (!current.archivedAt) return current;
        if (Date.now() - Date.parse(current.archivedAt) >= 30 * 86400000)
          throw new RpcError(-32602, "bot_archive_expired");
        const restored = this.bots.update(botId, { archivedAt: null });
        if (!restored) throw new RpcError(-32602, "bot_archive_unavailable");
        new SidebarRepo(this.deps.db).open(`dm:${botId}`);
        this.deps.local.approvals.audit.append({
          botId,
          kind: "bot.updated",
          summary: "Bot restored / Bot 已恢复",
          detail: { actor: "user", reasonCode: "restored" },
        });
        return restored;
      });
      this.deps.chat.restoreBot(botId);
      this.changed(botId, "updated");
      return bot;
    });
  }
  async remove(botId: string) {
    return this.exclusive(botId, async () => {
      // The purge deletes this Bot's working-folder rows inside the transaction, so the
      // code index paths are read first; the cleanup runs after commit and never fails the delete.
      const folderPaths = this.deps.local.workplaces.repo.pathsForBot(botId);
      transaction(this.deps.db, () => {
        const bot = this.bots.get(botId);
        if (!bot || bot.isMain || !bot.archivedAt)
          throw new RpcError(-32602, "bot_archive_unavailable");
        let manifest: ReturnType<BotsRepo["purgeArchived"]>;
        try {
          manifest = this.bots.purgeArchived(botId, new Date(), { userConfirmed: true });
        } catch (error) {
          if (error instanceof TypeError && error.message === "Archived Bot still belongs to group")
            throw new RpcError(-32602, "bot_archive_has_groups");
          throw error;
        }
        if (!manifest) throw new RpcError(-32602, "bot_archive_unavailable");
        new BotCleanupRepo(this.deps.db).enqueue(botId, manifest);
        this.deps.local.approvals.audit.append({
          botId,
          kind: "bot.updated",
          summary: "Archived Bot permanently deleted / 已归档 Bot 已彻底删除",
          detail: { actor: "user", reasonCode: "removed" },
        });
      });
      this.deps.local.codeMap.forgetPaths(folderPaths);
      this.changed(botId, "removed");
      this.deps.peer.emit("inbox.changed", {});
      // The deletion is committed above; file cleanup is a durable job retried like timed
      // retention, so a slow or failed sweep must not make the UI report the delete as failed.
      void this.cleanup
        .sweep()
        .catch(() =>
          this.deps.logger.warn(
            JSON.stringify({ module: "bots", event: "purge_cleanup_deferred" }),
          ),
        );
      return { ok: true as const };
    });
  }
  async archive(botId: string) {
    return this.exclusive(botId, async () => {
      const bot = this.bots.get(botId);
      if (!bot || bot.isMain) throw new RpcError(-32602, "Cannot archive main or unknown Bot");
      this.archiving.add(botId);
      try {
        this.deps.local.approvals.cancelBot(botId);
        await this.deps.chat.retireBot(botId);
        // An archived Bot's servers would have no chat left to stop them from.
        await this.deps.local.background.stopWhere((row) => row.botId === botId, "bot_archived");
        this.bots.archive(botId);
      } catch (error) {
        this.deps.chat.restoreBot(botId);
        throw error;
      } finally {
        this.archiving.delete(botId);
      }
      this.changed(botId, "archived");
      this.deps.peer.emit("inbox.changed", {});
      return { ok: true as const };
    });
  }
  async topicMetadata({ botId, topicId }: KernelMethodParams["topics.metadata"]) {
    this.active(botId);
    this.shutdown.signal.throwIfAborted();
    const topic = this.conversations.get(topicId);
    if (
      topic?.kind !== "dm" ||
      topic.botId !== botId ||
      topic.archivedAt ||
      this.conversations.isInternal(topicId)
    )
      return null;
    const { title, routineId, importSource, readOnly } = topic;
    return { title, routineId, importSource, readOnly: !!readOnly };
  }

  async topics(params: KernelMethodParams["topics.list"]) {
    this.active(params.botId);
    this.shutdown.signal.throwIfAborted();
    return new TopicsRepo(this.deps.db)
      .list(params, this.conversations.currentDmIfPresent(params.botId)?.id)
      .map((topic) => ({
        ...topic,
        workplaceBusy: topic.workplaceBusy || this.deps.chat.topicBusy(params.botId, topic.id),
      }));
  }
  async renameTopic({ botId, topicId, title }: KernelMethodParams["topics.rename"]) {
    this.active(botId);
    this.shutdown.signal.throwIfAborted();
    const topic = businessResult(() =>
      new TopicsRepo(this.deps.db).rename(botId, topicId, this.deps.redactor.redact(title)),
    );
    this.deps.peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
    return topic;
  }
  async newTopic(botId: string) {
    this.active(botId);
    // The same start as the desktop's new-topic draft: the previous topic's folders, or the Bot's
    // own folder when they cannot be used now. Inheriting a folder on an offline runner made
    // every message in a phone's new topic fail at once (v0.0.2 B7).
    const { selection } = await this.topicWorkplace.initial({ botId });
    this.active(botId);
    const previous = this.conversations.currentDmIfPresent(botId)?.id;
    const topic = transaction(this.deps.db, () => {
      const topic = this.conversations.create({ botId, workplace: selection });
      this.conversations.switchTopic(botId, topic.id);
      return topic;
    });
    this.deps.chat.openConversation(topic.id, previous);
    this.deps.peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
    return topic;
  }
  async switchTopic(botId: string, topicId: string) {
    this.active(botId);
    const previous = this.conversations.currentDmIfPresent(botId)?.id;
    const topic = businessResult(() => this.conversations.switchTopic(botId, topicId));
    this.deps.chat.openConversation(topic.id, previous);
    return topic;
  }
  start() {
    const repaired = new SidebarRepo(this.deps.db).repairMissing();
    if (repaired)
      this.deps.logger.info(
        JSON.stringify({ module: "bots", event: "sidebar_rows_repaired", count: repaired }),
      );
    return this.cleanup.start();
  }
  async stop() {
    this.shutdown.abort();
    await this.cleanup.stop();
  }
}
