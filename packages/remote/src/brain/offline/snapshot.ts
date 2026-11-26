import { phoneSystemPrompt, resolvePersonaLanguage } from "@pibot/brain/kit";
import { ExecError } from "@pibot/execution";
import {
  type Bot,
  type EndpointRegistrySource,
  RpcError,
  RpcErrorCodes,
  USER_MEMORY_MAX_CHARS,
} from "@pibot/protocol";
import {
  OFFLINE_MAX_BOTS,
  OFFLINE_MAX_GROUPS,
  OFFLINE_MAX_MODELS,
  OFFLINE_MAX_MODELS_PER_PROVIDER,
  OFFLINE_RUNNER_TOOLS,
  OFFLINE_TOOL_NAMES,
  type OfflineManifest,
  type OfflineModel,
  type OfflineSnapshot,
  remoteEndpointCapabilities,
} from "@pibot/remote-contract";
import {
  BotsRepo,
  ConversationsRepo,
  GroupsRepo,
  PermissionsRepo,
  SettingsRepo,
} from "@pibot/storage";
import type { OfflineGrantRecord, RemoteOfflineRepo } from "../../store/index.ts";
import type { RemoteResources } from "../runtime/context.ts";
import { digest, type OfflineModels } from "./models.ts";
import { hasRunners, type RunnerNote, runnerName, runnerNoteText } from "./runner-note.ts";

// A phone message keeps the whole snapshot in memory and on disk; a few thousand notes do not fit.
const MEMORY_CHARS = USER_MEMORY_MAX_CHARS;
const ALWAYS = new Set<string>(["ask_user", "memory_add"]);
const capabilityOfTool = new Map(
  remoteEndpointCapabilities.flatMap((cap) => cap.toolNames.map((tool) => [tool, cap.id] as const)),
);

function withoutSendMark(overrides: Bot["permissionOverrides"]) {
  if (!overrides?.confirmEverySend) return overrides;
  const { confirmEverySend: _mark, ...rest } = overrides;
  return rest;
}

/** The manifest and each offline Bot's prompt snapshot for one phone. */
export class OfflineSnapshots {
  constructor(
    private readonly r: RemoteResources,
    private readonly repo: RemoteOfflineRepo,
    private readonly models: OfflineModels,
  ) {}
  language() {
    return resolvePersonaLanguage(
      new SettingsRepo(this.r.ctx.db).get().language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    );
  }
  activeBots() {
    return new BotsRepo(this.r.ctx.db)
      .list()
      .filter((bot) => !bot.archivedAt)
      .slice(0, OFFLINE_MAX_BOTS);
  }
  /**
   * Maintainers 2026-11-12: a Bot uses on the phone the model it uses on the computer; one whose model
   * cannot be handed to a phone (subscription login, …) is not available offline.
   */
  grantFor(bot: Bot, models: readonly OfflineModel[]) {
    return models.find((m) => m.providerId === bot.modelProvider && m.modelId === bot.modelId);
  }
  /**
   * Active Bots that may answer offline on this phone: all except those switched off. An external
   * agent Bot never does: it runs the user's own program on the computer, not a model.
   */
  enabled(deviceId: string) {
    const off = this.repo.offBots(deviceId);
    return new Set(
      this.activeBots()
        .filter((bot) => !off.has(bot.id) && bot.kind !== "agent")
        .map((bot) => bot.id),
    );
  }
  async usableModels(grants: readonly OfflineGrantRecord[], bots: readonly Bot[]) {
    const models: OfflineModel[] = [];
    for (const grant of grants) {
      // The whole catalog of a router provider is hundreds of models,
      // all marked delivered, so the phone's lists could not be shortened. Only the models the
      // Bots use (and a grant's own model) go to the phone; a model picked there offline is one
      // of these, and it becomes a Bot's model when the choice is written back on reconnect.
      const ids = [
        ...new Set([
          grant.modelId,
          ...bots.filter((bot) => bot.modelProvider === grant.providerId).map((bot) => bot.modelId),
        ]),
      ]
        .filter((id): id is string => !!id)
        .slice(0, OFFLINE_MAX_MODELS_PER_PROVIDER);
      for (const modelId of ids) {
        if (models.length >= OFFLINE_MAX_MODELS) return models;
        const user = bots.find(
          (bot) => bot.modelProvider === grant.providerId && bot.modelId === modelId,
        );
        const model = await this.models.describe(grant, user?.thinkingLevel ?? "off", modelId);
        if (model) models.push(model);
      }
    }
    return models;
  }
  /**
   * Phone tools only where the computer would let this Bot use them on this phone right now
   *, plus the choice card and memory proposals. The definitions are
   * the computer's own (same descriptions and JSON schemas as a desktop run), never load groups:
   * the phone has no tool discovery.
   */
  private tools(deviceId: string, botId: string) {
    const registry = this.r.ctx.ports.get<EndpointRegistrySource>("endpoints.registry");
    const enabled = new Set(registry?.enabled(deviceId) ?? []);
    const endpoints = this.r.ctx.local.endpoints;
    return this.r.ctx.local.toolDefinitions
      .filter((tool) => (OFFLINE_TOOL_NAMES as readonly string[]).includes(tool.name))
      .filter((tool) => {
        if (ALWAYS.has(tool.name)) return true;
        const capability = capabilityOfTool.get(tool.name);
        return (
          !!capability &&
          enabled.has(capability) &&
          !!endpoints?.allows(tool.name, { botId, endpointPhoneId: deviceId })
        );
      })
      .map((tool) => ({
        name: tool.name as OfflineSnapshot["tools"][number]["name"],
        description: tool.description,
        parameters: tool.parameters,
      }));
  }
  async snapshot(
    deviceId: string,
    bot: Bot,
    model: OfflineModel,
    signal: AbortSignal,
  ): Promise<OfflineSnapshot> {
    const language = this.language();
    const tools = this.tools(deviceId, bot.id);
    const topic = new ConversationsRepo(this.r.ctx.db).currentDmIfPresent(bot.id);
    let runner: OfflineSnapshot["runner"];
    let note: RunnerNote = { kind: "none" };
    if (topic) {
      const selection = this.r.ctx.local.workplaces.topic(topic.id);
      // Hidden registry records included: a topic still works in a folder the user removed from
      // the list, and missing it told the phone "not on a runner" for a runner topic (v0.0.2 B14).
      const primary = this.r.ctx.local.workplaces.repo
        .folders(bot.id, [selection.selection.primary])
        .get(selection.selection.primary);
      if (primary?.location?.startsWith("runner:")) {
        try {
          const place = await this.r.ctx.local.workplaces.context(bot.id, signal, selection);
          const target = place.boundary.location?.target;
          if (target?.startsWith("runner:") && !place.boundary.readonlySource) {
            const endpoint = this.r.ctx.local.executionTargets.require(target);
            const allowed = OFFLINE_RUNNER_TOOLS.filter((name) =>
              this.r.ctx.local.endpoints?.allows(name, {
                botId: bot.id,
                runWorkplace: { boundary: place.boundary },
              }),
            );
            runner = {
              botId: bot.id,
              topicId: topic.id,
              name: endpoint.name ?? target,
              workplace: place.value,
              boundary: place.boundary,
              settings: new PermissionsRepo(this.r.ctx.db).get(),
              // A runner never sends outward, and a runner built before the send mark would
              // refuse its unknown key in a strict permission object.
              overrides: withoutSendMark(bot.permissionOverrides),
              tools: [...allowed],
            };
            for (const tool of this.r.ctx.local.toolDefinitions)
              if (allowed.includes(tool.name as never))
                tools.push({
                  name: tool.name as (typeof tools)[number]["name"],
                  description: tool.description,
                  parameters: tool.parameters,
                });
            if (allowed.length)
              note = { kind: "ready", name: runner.name, folder: place.boundary.primaryPath };
          }
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof RpcError) && !(error instanceof ExecError)) throw error;
          // Offline/moved roots cannot be certified for a new snapshot. Phone-only replies stay usable.
          const reason = error instanceof ExecError ? error.code : error.message;
          this.r.ctx.logger.warn(
            `offline_runner_snapshot_unavailable ${/^[a-z][a-z0-9_]{2,60}$/.test(reason) ? reason : "other"}`,
          );
          note = {
            kind: "unreachable",
            name: runnerName(this.r.devices, primary.location) ?? primary.location,
            folder: primary.path,
          };
        }
      }
    }
    // Only where runners are paired: elsewhere the line would be noise in every offline prompt.
    const runnerLine =
      note.kind !== "none" || hasRunners(this.r.devices)
        ? runnerNoteText(language, note)
        : undefined;
    const systemPrompt = this.r.ctx.redactor.redact(
      phoneSystemPrompt(
        bot,
        language,
        {
          provider: model.providerId,
          id: model.modelId,
          name: model.modelName,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          input: model.input,
          reasoning: model.reasoning,
          cost: model.cost,
        },
        model.providerName,
        tools,
        this.r.ctx.local.deps.capabilityTools,
      ) + (runnerLine ? `\n\n${runnerLine}` : ""),
    );
    const reference =
      this.r.ctx.local.memory.curated?.(bot.id, { maxChars: MEMORY_CHARS, signal }) ?? "";
    signal.throwIfAborted();
    const body = {
      botId: bot.id,
      grantId: model.grantId,
      language,
      systemPrompt,
      reference,
      tools,
      ...(runner ? { runner } : {}),
    };
    return { ...body, version: digest(JSON.stringify(body)) };
  }
  async manifest(deviceId: string, signal: AbortSignal) {
    const bots = this.activeBots();
    const offline = this.enabled(deviceId);
    const models = await this.usableModels(this.repo.grants(deviceId), bots);
    signal.throwIfAborted();
    const delivered = models.filter((m) => m.delivered);
    const entries: OfflineManifest["bots"] = [];
    for (const bot of bots) {
      const grant = offline.has(bot.id) ? this.grantFor(bot, delivered) : undefined;
      const snapshot = grant ? await this.snapshot(deviceId, bot, grant, signal) : undefined;
      entries.push({
        id: bot.id,
        name: bot.name.slice(0, 200),
        avatarShape: bot.avatarShape,
        avatarColor: bot.avatarColor,
        avatarEyes: bot.avatarEyes,
        isMain: !!bot.isMain,
        offline: offline.has(bot.id),
        grantId: grant?.grantId ?? null,
        modelId: grant ? bot.modelId : null,
        snapshotVersion: snapshot?.version ?? null,
        ...(bot.kind === "agent" ? { kind: "agent" as const } : {}),
      });
    }
    const groups = new GroupsRepo(this.r.ctx.db)
      .list({ limit: OFFLINE_MAX_GROUPS })
      .filter((group) => !group.archivedAt)
      .map((group) => ({
        id: group.id,
        name: group.name.slice(0, 200),
        memberIds: group.members.map((member) => member.botId).slice(0, OFFLINE_MAX_BOTS),
      }));
    const body = { language: this.language(), models, bots: entries, groups };
    return { ...body, version: digest(JSON.stringify(body)) } satisfies OfflineManifest;
  }
  /** The snapshot of one offline Bot, refused when the user did not make it available. */
  async forBot(deviceId: string, botId: string, signal: AbortSignal) {
    const bot = this.activeBots().find((entry) => entry.id === botId);
    if (!bot || !this.enabled(deviceId).has(botId))
      throw new RpcError(RpcErrorCodes.invalidParams, "offline_bot_unavailable");
    const models = (await this.usableModels(this.repo.grants(deviceId), [bot])).filter(
      (m) => m.delivered,
    );
    const grant = models.find(
      (m) => m.providerId === bot.modelProvider && m.modelId === bot.modelId,
    );
    if (!grant) throw new RpcError(RpcErrorCodes.invalidParams, "offline_model_unavailable");
    return this.snapshot(deviceId, bot, grant, signal);
  }
}
