// Keeps model selections consistent with the available catalog.
import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import { abortable, requireImageModel } from "@pibot/brain/kit";
import {
  type Bot,
  type CustomProvider,
  MAGPIE_PROVIDER,
  type MethodParams,
  type ModelInfo,
  RpcError,
  RpcErrorCodes,
  resolveThinkingLevel,
} from "@pibot/models-contract/full";
import { type BotsRepo, type SettingsRepo, transaction } from "@pibot/storage";
import type { ProviderStore } from "../catalog/providers.ts";

export class ModelSettings {
  constructor(
    private readonly deps: {
      db: DatabaseSync;
      agent: AgentRuntime;
      providers: ProviderStore;
      bots: BotsRepo;
      settings: SettingsRepo;
      images?(): import("@pibot/brain/kit").ImagesPort | undefined;
    },
  ) {}

  upsert(config: CustomProvider, signal?: AbortSignal): Promise<string> {
    const { agent, providers, bots, settings } = this.deps;
    return providers.serialize(async () => {
      signal?.throwIfAborted();
      if (config.id === MAGPIE_PROVIDER.id) {
        const previous = providers.configs().find((item) => item.id === config.id);
        const byId = new Map(
          previous?.baseUrl === config.baseUrl
            ? previous.models.map((model) => [model.id, model])
            : [],
        );
        config = { ...config, models: config.models.map((model) => byId.get(model.id) ?? model) };
      }
      const models = await agent.resolveCustomModels(config.models);
      signal?.throwIfAborted();
      const capabilities = new Map(models.map((model) => [model.id, model.capabilities]));
      return providers.upsert(config, (providerId) => {
        signal?.throwIfAborted();
        const current = settings.get().defaultModel;
        const model = current?.provider === providerId ? capabilities.get(current.id) : undefined;
        if (current && model) {
          const level = resolveThinkingLevel(
            model,
            current.thinkingPreference === undefined
              ? current.thinkingLevel
              : current.thinkingPreference,
          );
          if (level !== current.thinkingLevel)
            settings.set({ defaultModel: { ...current, thinkingLevel: level } });
        }
        for (const bot of bots.list()) {
          const model =
            bot.modelProvider === providerId && bot.modelId
              ? capabilities.get(bot.modelId)
              : undefined;
          if (!model || bot.category === "image") continue;
          const level = resolveThinkingLevel(
            model,
            bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference,
          );
          if (level !== bot.thinkingLevel) bots.update(bot.id, { thinkingLevel: level });
        }
      });
    });
  }

  setSettings(params: MethodParams["settings.set"], signal: AbortSignal) {
    const { db, agent, providers, bots, settings } = this.deps;
    const pending = providers.serialize(async () => {
      signal.throwIfAborted();
      const { initializeMainBot, ...patch } = params;
      if (initializeMainBot && settings.get().onboardingCompleted)
        throw new RpcError(-32602, "Onboarding already completed");
      if (patch.defaultModel || patch.auxiliaryModel) {
        const lookup = agent.listModels({ availableOnly: true });
        let models: ModelInfo[];
        try {
          models = await abortable(lookup, signal);
        } finally {
          // SDK catalog construction is not abortable. Keep its owner alive until it settles.
          if (signal.aborted) await lookup.catch(() => undefined);
        }
        for (const selected of [patch.defaultModel, patch.auxiliaryModel]) {
          if (!selected) continue;
          const model = models.find(
            (m) => m.provider === selected.provider && m.id === selected.id,
          );
          if (!model) throw new RpcError(-32602, "Model unavailable");
          if (selected === patch.defaultModel)
            patch.defaultModel = {
              ...patch.defaultModel,
              thinkingPreference:
                patch.defaultModel.thinkingPreference === undefined
                  ? patch.defaultModel.thinkingLevel
                  : patch.defaultModel.thinkingPreference,
              thinkingLevel: resolveThinkingLevel(
                model,
                patch.defaultModel.thinkingPreference === undefined
                  ? patch.defaultModel.thinkingLevel
                  : patch.defaultModel.thinkingPreference,
              ),
            };
        }
      }
      signal.throwIfAborted();
      return transaction(db, () => {
        const value = settings.set(patch);
        const selected = value.defaultModel;
        let main: Bot | undefined;
        if (initializeMainBot) {
          const pi = bots.getMain();
          if (!pi || !selected) throw new RpcError(-32602, "Main Bot or model unavailable");
          main = bots.update(pi.id, {
            modelProvider: selected.provider,
            modelId: selected.id,
            thinkingLevel: selected.thinkingLevel,
            thinkingPreference: selected.thinkingPreference ?? null,
          });
        }
        return { settings: value, main };
      });
    });
    // A cancelled queued action cannot write later; provider shutdown drains the actual owner.
    return abortable(pending, signal).catch((error: unknown) => {
      if (signal.aborted)
        throw new RpcError(
          signal.reason instanceof Error && signal.reason.name === "TimeoutError"
            ? RpcErrorCodes.timeout
            : RpcErrorCodes.closed,
          "Settings save cancelled",
        );
      throw error;
    });
  }

  updateBot(
    { botId, expectedNorms, ...patch }: MethodParams["bots.update"],
    signal?: AbortSignal,
  ): Promise<Bot> {
    const { agent, providers, bots } = this.deps;
    const pending = providers.serialize(async () => {
      signal?.throwIfAborted();
      const bot = bots.get(botId);
      if (!bot || bot.archivedAt) throw new RpcError(-32602, "Unknown active Bot");
      const preference =
        patch.thinkingPreference !== undefined
          ? patch.thinkingPreference
          : patch.thinkingLevel !== undefined
            ? patch.thinkingLevel
            : bot.thinkingPreference === undefined
              ? bot.thinkingLevel
              : bot.thinkingPreference;
      if (bot.category === "image") {
        const changingModel =
          (patch.modelProvider !== undefined && patch.modelProvider !== bot.modelProvider) ||
          (patch.modelId !== undefined && patch.modelId !== bot.modelId);
        if (changingModel) {
          const provider =
            patch.modelProvider === undefined ? bot.modelProvider : patch.modelProvider;
          const id = patch.modelId === undefined ? bot.modelId : patch.modelId;
          const imageSignal = signal ?? AbortSignal.timeout(25_000);
          const selected = await requireImageModel(
            this.deps.images?.(),
            provider && id ? { provider, id } : undefined,
            undefined,
            imageSignal,
          );
          patch.modelProvider = selected.provider;
          patch.modelId = selected.id;
          imageSignal.throwIfAborted();
          const latest = bots.get(botId);
          if (
            !latest ||
            latest.archivedAt ||
            latest.modelId !== bot.modelId ||
            latest.modelProvider !== bot.modelProvider ||
            latest.imageMode !== bot.imageMode
          )
            throw new RpcError(-32602, "image_model_unavailable");
        }
        patch.thinkingLevel = "off";
      } else {
        if (patch.imageMode !== undefined) throw new RpcError(-32602, "image_mode_mismatch");
        if (
          patch.modelProvider !== undefined ||
          patch.modelId !== undefined ||
          patch.thinkingLevel !== undefined ||
          patch.thinkingPreference !== undefined
        ) {
          const lookup = agent.listModels({ availableOnly: true });
          const models = await (signal ? abortable(lookup, signal) : lookup);
          signal?.throwIfAborted();
          const provider =
            patch.modelProvider === undefined ? bot.modelProvider : patch.modelProvider;
          const id = patch.modelId === undefined ? bot.modelId : patch.modelId;
          if ((provider === null) !== (id === null))
            throw new RpcError(-32602, "Model needs both provider and ID");
          if (provider === null) {
            patch.thinkingLevel = "off";
          } else {
            const model = models.find((entry) => entry.provider === provider && entry.id === id);
            if (!model) throw new RpcError(-32602, "Model unavailable");
            patch.thinkingLevel = resolveThinkingLevel(model, preference);
          }
          patch.thinkingPreference = preference;
        }
      }
      signal?.throwIfAborted();
      const latest = bots.get(botId);
      if (!latest || latest.archivedAt) throw new RpcError(-32602, "Unknown active Bot");
      // Compare after queued model lookups, immediately before the synchronous write.
      // A preview in another window must not overwrite newer custom norms.
      if (expectedNorms !== undefined) {
        if (patch.norms === undefined) throw new RpcError(-32602, "Norms replacement missing");
        if ((latest.norms ?? "") !== expectedNorms)
          throw new RpcError(RpcErrorCodes.busy, "bot_norms_changed");
      }
      return bots.update(botId, patch) as Bot;
    });
    // Cancelling a queued update releases its caller; the late action checks before writing.
    return signal ? abortable(pending, signal) : pending;
  }
}
