// Registers the brain-side model and provider operations.
import type { CapabilityContext } from "@pibot/brain/kit";
import {
  canonicalImageModelId,
  isChatGPTPlanProvider,
  MAGPIE_PROVIDER,
  type MethodParams,
  magpieBaseUrl,
  magpiePort,
  providerPlan,
  RpcError,
} from "@pibot/models-contract/full";
import { SettingsRepo } from "@pibot/storage";
import { recordedModelHealth } from "../../store/index.ts";
import type { ProviderAuth } from "../auth/provider-auth.ts";
import type { ModelSettings } from "../settings/model-settings.ts";
import { detectMagpie, fetchMagpieModels } from "./magpie.ts";
import { detectOllama } from "./ollama.ts";
import { type ProviderStore, providerScope } from "./providers.ts";

export function registerModelProviderRpc(
  ctx: CapabilityContext,
  providers: ProviderStore,
  auth: ProviderAuth,
  modelSettings: ModelSettings,
) {
  const { agent, logger, redactor, peer } = ctx;
  const settings = new SettingsRepo(ctx.db);
  const handle = ctx.rpc.handle;
  const changed = () => peer.emit("providers.changed", {});
  handle("models.health", ({ models }) => recordedModelHealth(ctx.db, models));
  handle("providers.list", async () => {
    const envNames = new Set(await ctx.host.env.detect());
    // Use the same catalog as the model picker, including retirement and snapshot overlays.
    const modelCounts = new Map<string, number>();
    for (const model of await agent.listModels())
      modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
    const saved = providers.configs();
    const catalog = providers.catalog.map((entry) => {
      const custom = saved.find((cfg) => cfg.id === entry.id && entry.auth === "custom");
      return custom
        ? {
            ...entry,
            name: custom.name,
            ...(entry.id === MAGPIE_PROVIDER.id ? { baseUrl: custom.baseUrl } : {}),
            modelCount: custom.models.length + (custom.imageModels?.length ?? 0),
          }
        : entry.auth !== "custom"
          ? { ...entry, modelCount: modelCounts.get(entry.id) ?? entry.modelCount }
          : entry;
    });
    for (const cfg of saved) {
      if (!catalog.some((entry) => entry.id === cfg.id && entry.auth === "custom"))
        catalog.push({
          id: cfg.id,
          name: cfg.name,
          group: "local",
          auth: "custom",
          modelCount: cfg.models.length + (cfg.imageModels?.length ?? 0),
          available: true,
        });
    }
    return catalog.map((entry) => {
      if (entry.id === MAGPIE_PROVIDER.id)
        return {
          ...entry,
          configured: saved.some((cfg) => cfg.id === entry.id),
          envDetected: false,
        };
      const enabled = entry.auth === "apiKey" || entry.auth === "custom";
      const configured =
        enabled &&
        (providers.secrets.has(providerScope(entry.id), "apiKey") ||
          (entry.auth === "custom" && providers.repo.get(entry.id)?.kind === "custom"));
      const hint = enabled ? providers.secrets.hint(providerScope(entry.id), "apiKey") : undefined;
      return {
        ...entry,
        available: entry.available,
        // A sign-in provider (the ChatGPT plan) is configured while its credential is stored.
        configured:
          entry.auth === "cloud" || entry.auth === "oauth"
            ? auth.has(entry.id, entry.auth)
            : configured,
        selectedAuth: auth.mode(entry.id),
        ...(providers.repo.get(entry.id)?.config.subscriptionRemoved === true
          ? { subscriptionRemoved: true }
          : {}),
        ...(hint === undefined ? {} : { keyHint: hint }),
        ...(isChatGPTPlanProvider(entry.id) ? { chatgpt: auth.chatgpt(entry.id) } : {}),
        envDetected:
          entry.auth === "apiKey" && !!entry.envVarName && envNames.has(entry.envVarName),
      };
    });
  });
  handle("providers.setApiKey", async ({ providerId, apiKey }) => {
    await providers.serialize(() => providers.setKey(providerId, apiKey));
    changed();
    return { ok: true };
  });
  handle("providers.addModel", async ({ providerId, modelId }) => {
    // The pinned catalog already offers it: a duplicate entry would hide which one a Bot uses.
    const listed = (await agent.listModels()).some(
      (model) => model.provider === providerId && model.id === modelId && !model.addedByUser,
    );
    if (listed) throw new RpcError(-32602, "model_already_listed");
    const changedList = await providers.serialize(async () =>
      providers.changeAddedModel(providerId, modelId, true),
    );
    if (changedList) changed();
    return { ok: true };
  });
  handle("providers.removeModel", async ({ providerId, modelId }) => {
    const changedList = await providers.serialize(async () =>
      providers.changeAddedModel(providerId, modelId, false),
    );
    if (changedList) changed();
    return { ok: true };
  });
  handle("providers.importFromEnv", async ({ providerId }) => {
    await providers.serialize(async () => {
      providers.assertWritable(providerId);
      const entry = providers.catalog.find((p) => p.id === providerId && p.auth === "apiKey");
      if (!entry?.envVarName) throw new RpcError(-32602, "No importable environment variable");
      const key = await ctx.host.env.read(entry.envVarName);
      if (key === undefined) throw new RpcError(-32602, "Environment variable unavailable");
      await providers.setKey(providerId, key);
    });
    changed();
    return { ok: true };
  });
  handle("providers.remove", async ({ providerId, auth: mode }) => {
    if (mode) {
      await providers.serialize(async () => {
        if (!providers.catalog.some((p) => p.id === providerId && p.auth === mode))
          throw new RpcError(-32602, "unsupported_auth");
        if (mode === "apiKey") providers.secrets.remove(providerScope(providerId), "apiKey");
        else {
          auth.vault.secrets.remove(`provider:${providerId}:cloud`, "credential");
          const { cloud: _cloud, ...config } = providers.repo.get(providerId)?.config ?? {};
          providers.repo.upsert({
            id: providerId,
            kind: "builtin",
            config: { ...config, selectedAuth: "apiKey" },
          });
        }
      });
      changed();
      return { ok: true };
    }
    if (isChatGPTPlanProvider(providerId) && auth.has(providerId, "oauth"))
      await auth.logout(providerId);
    auth.vault.secrets.remove(`provider:${providerId}:cloud`, "credential");
    await providers.serialize(async () => providers.remove(providerId));
    changed();
    return { ok: true };
  });
  handle("providers.test", async ({ providerId, modelId }) => {
    await providers.requireCredentials(providerId);
    const { httpStatus, testedModels, ...result } = await agent.testProvider(
      providerId,
      modelId,
      ctx.models.signal(),
    );
    if (!result.ok || (testedModels?.length ?? 0) > 1)
      logger.warn(
        JSON.stringify({
          providerId,
          ...(result.ok ? { event: "test_fell_back" } : { error: result.error ?? "internal" }),
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(providerId !== MAGPIE_PROVIDER.id && testedModels?.length ? { testedModels } : {}),
        }),
      );
    return {
      ...result,
      ...(httpStatus === 401 && providerPlan(providerId) ? { keyPlanMismatch: true } : {}),
    };
  });
  handle("customProviders.fetchModels", async (cfg) => {
    if (cfg.apiKey) redactor.add(cfg.apiKey);
    for (const value of Object.values((cfg.headers ?? {}) as Record<string, string>))
      if (value.trim()) redactor.add(value.trim());
    return { models: await agent.fetchCustomModels(cfg) };
  });
  handle("customProviders.get", async ({ providerId }) => providers.info(providerId));
  handle("customProviders.fetchSavedModels", async ({ providerId }, { signal }) => {
    if (providerId === MAGPIE_PROVIDER.id) {
      const port = magpiePort(providers.get(providerId).baseUrl);
      if (port === undefined) throw new RpcError(-32602, "magpie_port_invalid");
      return {
        models: await fetchMagpieModels(
          port,
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        ),
      };
    }
    await providers.requireCredentials(providerId);
    const { baseUrl, api, headers } = providers.get(providerId);
    const apiKey = await providers.secrets.get(providerScope(providerId), "apiKey");
    return {
      models: await agent.fetchCustomModels({
        baseUrl,
        api,
        ...(headers ? { headers } : {}),
        ...(apiKey ? { apiKey } : {}),
      }),
    };
  });
  handle("customProviders.upsert", async (cfg) => {
    if (cfg.id === MAGPIE_PROVIDER.id) throw new RpcError(-32602, "magpie_requires_local_setup");
    const id = await modelSettings.upsert(cfg);
    peer.emit("settings.changed", settings.get());
    changed();
    return { id };
  });
  handle("customProviders.resolveModels", async ({ models }) => ({
    models: await agent.resolveCustomModels(models),
  }));
  handle("models.refresh", async ({ providerId }) => {
    if (!agent.refreshModels) throw new RpcError(-32601, "Model refresh unavailable");
    const result = await agent.refreshModels(providerId, ctx.models.signal());
    peer.emit("providers.changed", {});
    logger.info(
      JSON.stringify({
        module: "models",
        event: "catalog_refreshed",
        providerId,
        count: result.count,
      }),
    );
    return result;
  });
  handle("models.list", async (params) => agent.listModels(params));
  handle("models.images", async ({ before, limit = 200, selected, ...params }) => {
    const signal = AbortSignal.any([ctx.models.signal(), AbortSignal.timeout(10_000)]);
    const entries = (await agent.listImageModels?.({ ...params, signal })) ?? [];
    const key = (model: { provider: string; id: string }) =>
      JSON.stringify([model.provider, model.id]);
    if (selected)
      return entries
        .filter(
          (model) =>
            model.provider === selected.provider &&
            model.id === canonicalImageModelId(selected.provider, selected.id),
        )
        .slice(0, 1);
    return entries
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .filter((model) => !before || key(model) > before)
      .slice(0, limit);
  });
  handle(
    "local.detectMagpie",
    ({ port = MAGPIE_PROVIDER.defaultPort }: MethodParams["local.detectMagpie"], { signal }) =>
      detectMagpie(port, AbortSignal.any([signal, ctx.models.signal()])),
  );
  handle(
    "local.configureMagpie",
    async ({ port }: MethodParams["local.configureMagpie"], { signal }) => {
      const deadline = AbortSignal.any([signal, ctx.models.signal(), AbortSignal.timeout(10_000)]);
      const gateway = await detectMagpie(port, deadline);
      if (!gateway.running) throw new RpcError(-32602, "magpie_models_unavailable");
      const discovered = await fetchMagpieModels(port, deadline);
      await modelSettings.upsert(
        {
          id: MAGPIE_PROVIDER.id,
          name: MAGPIE_PROVIDER.name,
          baseUrl: magpieBaseUrl(port),
          api: "openai-completions",
          models: discovered,
        },
        deadline,
      );
      peer.emit("settings.changed", settings.get());
      changed();
      return { count: discovered.length };
    },
  );
  handle("local.detectOllama", async () => detectOllama());
}
