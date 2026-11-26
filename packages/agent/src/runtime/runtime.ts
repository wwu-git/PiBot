// Builds the pi runtime using Pi Bot configuration and credential ports.
import { resolve } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  CustomProviderFetchSchema,
  IMPORTED_MAGPIE_PREFIX,
  importedMagpieRoute,
} from "@pibot/protocol-base";
import {
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_PROVIDERS,
  isChatGPTPlanProvider,
  MAGPIE_PROVIDER,
  magpiePort,
} from "@pibot/protocol-base/provider-catalog";
import { assertSafeSecretValue } from "@pibot/secrets";
import { cloudAuth, oauthStore } from "../auth/auth-adapter.ts";
import { literalBedrock } from "../auth/bedrock-literal.ts";
import { chatGPTSubscriptionAccess } from "../auth/chatgpt-access.ts";
import {
  chatGPTCodexSignIn,
  chatGPTPlanFromCodex,
  chatGPTSignIn,
} from "../auth/chatgpt-provider.ts";
import { assertSupportedCredential, assertSupportedHeaders } from "../auth/claude-subscription.ts";
import { literalCredentials } from "../auth/credentials.ts";
import { customProviderEndpoints } from "../auth/custom-endpoints.ts";
import { openaiGoogle } from "../auth/openai-google.ts";
import { memoryVertex } from "../auth/vertex-memory.ts";
import { sanitizeBrainEnv } from "../core/env.ts";
import { AgentError, agentHttpStatus, mapAgentError } from "../core/errors.ts";
import type {
  AgentRuntime,
  AgentRuntimeDeps,
  CustomProviderConfig,
  FetchCustomModelsOptions,
} from "../core/types.ts";
import { CheckpointCache } from "../extensions/checkpoint-result.ts";
import { imageProvider } from "../images/image-catalog.ts";
import { withAddedModels } from "../models/added-models.ts";
import { listProviderCatalog } from "../models/catalog.ts";
import { identifyProvider } from "../models/client-identity.ts";
import { createCustomModelResolver } from "../models/custom-models.ts";
import { createModelCatalogCache } from "../models/model-catalog-cache.ts";
import { type CatalogSnapshot, withOpenRouterCatalog } from "../models/openrouter-catalog.ts";
import { createAuxiliaryModelSelector } from "./auxiliary-model.ts";
import { CacheDiagnosticsMemory } from "./cache-diagnostic.ts";
import { loadPiSdk, piSdkLoaded, sdkWarmupCode, warmPiSdkCompileCache } from "./pi-sdk.ts";
import { createAuxiliaryOperations } from "./runtime-parts/runtime-auxiliary.ts";
import { createCompactionOperations } from "./runtime-parts/runtime-compaction.ts";
import { createImagesOperations } from "./runtime-parts/runtime-images.ts";
import { createModelsOperations } from "./runtime-parts/runtime-models.ts";
import { createPageExtractOperation } from "./runtime-parts/runtime-page-extract.ts";
import { createPortableOperations } from "./runtime-parts/runtime-portable.ts";
import { createSessionOperations } from "./runtime-parts/runtime-session.ts";
import { customConfigSchema, literalAuth } from "./runtime-parts/runtime-shared.ts";
export function createRuntimeContext(deps: AgentRuntimeDeps) {
  const dataDir = resolve(deps.dataDir);
  const checkpointCache = new CheckpointCache();
  const cacheDiagnosticsMemory = new CacheDiagnosticsMemory();
  sanitizeBrainEnv(process.env, dataDir);
  // The SDK captures auxiliary directories at import time, so import it after sanitization.
  let sdkNotBefore = 0;
  const deferSdk = (milliseconds: number) => {
    sdkNotBefore = performance.now() + milliseconds;
  };
  const waitForSdkAdmission = async () => {
    // Native module evaluation cannot yield; local history must get its turn before it starts.
    while (performance.now() < sdkNotBefore)
      await new Promise<void>((resolve) => setTimeout(resolve, sdkNotBefore - performance.now()));
  };
  const sdk = async () => {
    await waitForSdkAdmission();
    sanitizeBrainEnv(process.env, dataDir);
    return loadPiSdk();
  };
  const catalog = listProviderCatalog();
  const customModels = createCustomModelResolver();
  const modelCatalog = createModelCatalogCache(dataDir);
  const builtinIds = new Set(
    catalog.filter((entry) => entry.auth !== "custom").map((entry) => entry.id),
  );
  const enabledIds = new Set(
    catalog.filter((entry) => entry.auth === "apiKey").map((entry) => entry.id),
  );

  function configs(): CustomProviderConfig[] {
    const ids = new Set<string>();
    return deps.customProviders().map((config) => {
      const parsed = customConfigSchema.safeParse(config);
      if (
        !parsed.success ||
        !parsed.data.id ||
        ["openai-codex", "github-copilot", ...CHATGPT_PLAN_PROVIDERS].includes(parsed.data.id) ||
        builtinIds.has(parsed.data.id) ||
        ids.has(parsed.data.id)
      )
        throw new AgentError("internal");
      if (
        parsed.data.id === MAGPIE_PROVIDER.id &&
        (magpiePort(parsed.data.baseUrl) === undefined ||
          parsed.data.api !== "openai-completions" ||
          parsed.data.headers ||
          parsed.data.imageApi ||
          parsed.data.imageModels?.length)
      )
        throw new AgentError("internal");
      ids.add(parsed.data.id);
      return { ...parsed.data, id: parsed.data.id };
    });
  }

  async function injectKey(runtime: ModelRuntime, id: string): Promise<void> {
    if (id === MAGPIE_PROVIDER.id) return;
    if (isChatGPTPlanProvider(id)) {
      // The ChatGPT plan authenticates through its stored OAuth credential, never an API key.
      if (chatGPTSubscriptionAccess.available) return;
      throw new AgentError("openai_approval_required");
    }
    if (deps.auth?.mode(id) === "oauth") throw new AgentError("subscription_unsupported");
    if (deps.auth?.mode(id) === "cloud") return;
    const saved = await deps.getApiKey(id);
    const magpie = id.startsWith(IMPORTED_MAGPIE_PREFIX)
      ? deps.customProviders().find((config) => config.id === id)
      : undefined;
    const key = saved ?? (magpie && importedMagpieRoute(magpie) ? "magpie-pibot" : undefined);
    if (key !== undefined) {
      assertSupportedCredential(key);
      assertSafeSecretValue(key);
      await runtime.setRuntimeApiKey(id, key);
    } else await runtime.removeRuntimeApiKey(id);
  }

  const auxiliaryModel = createAuxiliaryModelSelector(deps, injectKey);
  async function summaryModel(
    runtime: ModelRuntime,
    primary: Parameters<ModelRuntime["completeSimple"]>[0],
    signal: AbortSignal,
  ) {
    const selected = await auxiliaryModel(runtime, primary, "compaction", signal);
    // A large helper must not produce checkpoints that overflow the original chat's window.
    return {
      ...selected,
      contextWindow: Math.min(primary.contextWindow, selected.contextWindow),
      maxTokens: Math.min(primary.maxTokens, selected.maxTokens),
    };
  }

  // Building registers every provider and holds the brain's event loop for ~90ms (measured),
  // stalling every UI request; it ran on each chat, routine, persona and model listing. Share one
  // runtime while its build inputs are unchanged. Every caller still injects the current key
  // before use, availability rechecks credentials per call, and the proxy is read per request.
  let shared:
    | { key: string; snapshot?: CatalogSnapshot; built: ReturnType<typeof createRuntime> }
    | undefined;
  async function buildRuntime() {
    await waitForSdkAdmission();
    const snapshot = await modelCatalog.get();
    sanitizeBrainEnv(process.env, dataDir);
    // Key presence is part of the identity: removing a key drops the runtime that held it, so a
    // deleted secret never lingers in a long-lived object. A replaced value is re-injected per use.
    const custom = configs();
    const key = JSON.stringify([
      snapshot?.updatedAt,
      custom,
      deps.addedModels?.() ?? {},
      catalog.map((provider) => [
        deps.auth?.mode(provider.id) ?? null,
        deps.hasApiKey(provider.id),
      ]),
      custom.map((provider) => deps.hasApiKey(provider.id)),
    ]);
    if (shared?.key !== key || shared.snapshot !== snapshot) {
      const built = createRuntime(snapshot);
      shared = { key, snapshot, built };
      // A failed build must not be remembered; the caller still receives the error.
      built.catch(() => {
        if (shared?.built === built) shared = undefined;
      });
    }
    return shared.built;
  }

  async function createRuntime(snapshot?: CatalogSnapshot) {
    let settleAuth = async () => {};
    sanitizeBrainEnv(process.env, dataDir);
    await warmPiSdkCompileCache().catch((error: unknown) => {
      // Compile-cache warmup is an optimization. The main-thread import remains the source of
      // truth, but a warm-up that never works must be visible in the log.
      deps.sdkWarmupFailed?.(sdkWarmupCode(error));
    });
    const pi = await sdk();
    const custom = configs();
    const added = deps.addedModels?.() ?? {};
    const runtime = await pi.ModelRuntime.create({
      credentials: deps.auth ? oauthStore(deps.auth) : literalCredentials(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const registerNativeProvider = (provider: Provider, config?: CustomProviderConfig) => {
      const catalogued = withOpenRouterCatalog(provider, snapshot);
      const images = identifyProvider(
        imageProvider(
          openaiGoogle(
            builtinIds.has(provider.id)
              ? withAddedModels(catalogued, added[provider.id], customModels.resolve)
              : catalogued,
          ),
          config,
          { fetchImageUrl: deps.fetchImageUrl },
        ),
      );
      runtime.registerNativeProvider(deps.network?.wrap(images) ?? images);
    };
    // Disable ambient auth before the first refresh, including Vertex's default ADC file check.
    // RuntimeCredentials supplies setRuntimeApiKey as a literal credential to these resolvers.
    // registerNativeProvider starts a background refresh. Replace Vertex first so even that
    // refresh never captures the ambient resolver which checks the default ADC path.
    const providers = [...runtime.getProviders()].sort(
      (a, b) => Number(b.id === "google-vertex") - Number(a.id === "google-vertex"),
    );
    for (const provider of providers) {
      if (!builtinIds.has(provider.id)) {
        // unregisterProvider restores the SDK builtin. A tombstone must replace that builtin instead.
        runtime.registerNativeProvider({
          ...provider,
          auth: {},
          refreshModels: undefined,
          getModels: () => [],
          getAllModels: () => [],
          stream() {
            throw new AgentError("subscription_unsupported");
          },
          streamSimple() {
            throw new AgentError("subscription_unsupported");
          },
          generateImages: undefined,
          classify: undefined,
        });
        continue;
      }
      registerNativeProvider({
        ...(provider.id === "google-vertex" && deps.auth
          ? memoryVertex(provider, deps.auth)
          : provider.id === "amazon-bedrock" && deps.auth
            ? literalBedrock(provider)
            : provider),
        refreshModels: undefined,
        auth: {
          apiKey:
            deps.auth && catalog.some((p) => p.id === provider.id && p.auth === "cloud")
              ? cloudAuth(deps.auth, provider.id)
              : literalAuth(
                  enabledIds.has(provider.id) && deps.auth?.mode(provider.id) !== "oauth",
                  () => deps.hasApiKey(provider.id),
                ),
        },
      });
    }
    // Built from pi's own ChatGPT-backend provider as captured before its retired id was replaced
    // above, so the plan gets Pi Bot's wrappers once through registerNativeProvider. A closed
    // release registers no plan provider.
    const chatgpt = chatGPTSignIn(CHATGPT_PLAN_PROVIDER, deps.auth);
    const codex = providers.find((provider) => provider.id === "openai-codex");
    const codexSignIn = chatGPTCodexSignIn(codex?.auth?.oauth, deps.auth);
    if (chatgpt && codex && deps.auth) {
      registerNativeProvider(
        chatGPTPlanFromCodex(
          codex,
          chatgpt.oauth,
          deps.auth,
          providers.find((provider) => provider.id === "openai"),
        ),
      );
    }
    // Maintainers 2026-11-15: the same plan through pi's legacy Codex login and route.
    if (codexSignIn && codex && deps.auth)
      registerNativeProvider(
        chatGPTPlanFromCodex(codex, codexSignIn.oauth, deps.auth, undefined, {
          id: CHATGPT_CODEX_PROVIDER,
          name: "ChatGPT (Codex)",
        }),
      );
    if (chatgpt || codexSignIn)
      settleAuth = async () => {
        await Promise.all([chatgpt?.settled(), codexSignIn?.settled()]);
      };
    for (const config of custom) {
      const endpoint = customProviderEndpoints(config);
      const headers =
        config.headers &&
        Object.fromEntries(
          Object.entries(config.headers).map(([name, value]) => [
            name,
            value.replaceAll("$", "$$"),
          ]),
        );
      runtime.registerProvider(config.id, {
        name: config.name,
        baseUrl: endpoint.sdkBaseUrl,
        api: config.api,
        headers,
        models: config.models.map((model) => ({
          ...customModels.resolve(model).effective,
          compat: customCompat(config),
        })),
      });
      const provider = runtime.getProvider(config.id);
      if (!provider) throw new AgentError("internal");
      // The native registration replaces the config registration, while its model/stream
      // closures retain the validated config. Native auth takes literal headers directly,
      // supporting keyless local servers without inventing a credential or Bearer token.
      registerNativeProvider(
        {
          ...provider,
          // Keep unrelated provider catalogs usable, but never invoke a client at a guessed version.
          ...(!endpoint.supported
            ? {
                stream: () => {
                  throw new AgentError("provider_error");
                },
                streamSimple: () => {
                  throw new AgentError("provider_error");
                },
              }
            : {}),
          auth: {
            apiKey: literalAuth(
              true,
              () =>
                deps.hasApiKey(config.id) ||
                (config.id.startsWith(IMPORTED_MAGPIE_PREFIX) && importedMagpieRoute(config)),
              true,
              config.id === MAGPIE_PROVIDER.id
                ? { authorization: `Bearer ${MAGPIE_PROVIDER.attribution}` }
                : config.headers,
            ),
          },
        },
        config,
      );
    }
    await runtime.refresh({ allowNetwork: false });
    return { pi, runtime, custom, settleAuth };
  }

  async function fetchCustomModels(cfg: FetchCustomModelsOptions): Promise<{ id: string }[]> {
    try {
      const parsed = CustomProviderFetchSchema.safeParse(cfg);
      if (!parsed.success) throw new AgentError("internal");
      const input = parsed.data;
      const endpoint = customProviderEndpoints(input);
      if (!endpoint.supported) throw new AgentError("provider_error");
      assertSupportedCredential(input.apiKey);
      assertSupportedHeaders(input.headers);
      const headers = new Headers(input.headers);
      if (input.apiKey) {
        assertSafeSecretValue(input.apiKey);
        if (input.api === "anthropic-messages") headers.set("x-api-key", input.apiKey);
        else if (input.api === "google-generative-ai") headers.set("x-goog-api-key", input.apiKey);
        else headers.set("Authorization", `Bearer ${input.apiKey}`);
      }
      if (input.api === "anthropic-messages" && !headers.has("anthropic-version"))
        headers.set("anthropic-version", "2023-06-01");
      // Reject redirects so credentials never leave the endpoint the user configured.
      const response = await fetch(endpoint.modelsUrl, {
        headers,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) throw { status: response.status };
      const body: unknown = await response.json().catch(() => {
        throw new AgentError("provider_error");
      });
      if (!body || typeof body !== "object") throw new AgentError("provider_error");
      const record = body as { data?: unknown; models?: unknown };
      const models = input.api === "google-generative-ai" ? record.models : record.data;
      if (!Array.isArray(models)) throw new AgentError("provider_error");
      const ids = models.map((model: unknown) => {
        if (!model || typeof model !== "object") throw new AgentError("provider_error");
        const entry = model as { id?: unknown; name?: unknown };
        const id = input.api === "google-generative-ai" ? entry.name : entry.id;
        if (typeof id !== "string" || !id) throw new AgentError("provider_error");
        return input.api === "google-generative-ai" ? id.replace(/^models\//, "") : id;
      });
      return [...new Set(ids)].map((id) => ({ id }));
    } catch (error) {
      throw new AgentError(mapAgentError(error), agentHttpStatus(error));
    }
  }
  return {
    fetchCustomModels,
    injectKey,
    buildRuntime,
    deferSdk,
    sdk,
    deps,
    auxiliaryModel,
    customModels,
    modelCatalog,
    builtinIds,
    configs,
    dataDir,
    checkpointCache,
    cacheDiagnosticsMemory,
    summaryModel,
    catalog,
    onCustomModelLimit: deps.onCustomModelLimit,
  };
}
export type RuntimeContext = ReturnType<typeof createRuntimeContext>;
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const context = createRuntimeContext(deps);
  const images = createImagesOperations(context);
  const auxiliary = createAuxiliaryOperations(context);
  const pages = createPageExtractOperation(context);
  const models = createModelsOperations(context);
  const compaction = createCompactionOperations(context);
  const session = createSessionOperations(context);
  const portable = createPortableOperations(context);
  return {
    deferSdk: context.deferSdk,
    preloadSdk: async () => {
      sanitizeBrainEnv(process.env, context.dataDir);
      try {
        await warmPiSdkCompileCache();
      } catch (error) {
        throw new Error(sdkWarmupCode(error));
      }
    },
    loadSdkWhenIdle: async () => {
      if (piSdkLoaded()) return "already_loaded";
      await context.sdk();
      return "loaded";
    },
    listImageModels: images.listImageModels,
    generateImage: images.generateImage,
    login: models.login,
    refreshAuth: models.refreshAuth,
    transformMessage: auxiliary.transformMessage,
    generatePersona: auxiliary.generatePersona,
    draftCommitMessage: auxiliary.draftCommitMessage,
    draftSkill: auxiliary.draftSkill,
    draftMemories: auxiliary.draftMemories,
    extractPage: pages.extractPage,
    refreshModels: models.refreshModels,
    listModels: models.listModels,
    fetchCustomModels: context.fetchCustomModels,
    resolveCustomModels: models.resolveCustomModels,
    testProvider: models.testProvider,
    compactHistory: compaction.compactHistory,
    estimateContext: compaction.estimateContext,
    openSession: session.openSession,
    portableModel: portable.portableModel,
    seedSession: portable.seedSession,
  };
}

/**
 * GitHub #5: for an OpenAI-compatible URL it does not recognize, pi sends a reasoning model's
 * system prompt as role "developer", which most gateways (SiliconFlow, AMD, InternLM) reject. Every
 * compatible server accepts "system"; only OpenAI's own API keeps "developer". A saved explicit
 * setting still wins.
 */
function customCompat(config: CustomProviderConfig) {
  if (config.api !== "openai-completions" || config.compat?.supportsDeveloperRole !== undefined)
    return config.compat;
  let host = "";
  try {
    host = new URL(config.baseUrl).hostname.toLowerCase();
  } catch {
    // An unparsable URL was refused when the provider was saved; keep pi's default here.
    return config.compat;
  }
  return host === "api.openai.com"
    ? config.compat
    : { ...config.compat, supportsDeveloperRole: false };
}
