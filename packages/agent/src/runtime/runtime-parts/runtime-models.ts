import { defaultModelFor, isRetiredModel } from "@pibot/protocol-base";
import { isChatGPTPlanProvider } from "@pibot/protocol-base/provider-catalog";
import { chatGPTSubscriptionAccess } from "../../auth/chatgpt-access.ts";
import { CHATGPT_AGENT_NAME } from "../../auth/chatgpt-login.ts";
import { testProviderModel } from "../../auth/provider-test.ts";
import { AgentError, mapAgentError } from "../../core/errors.ts";
import type { AgentRuntime } from "../../core/types.ts";
import type { RuntimeContext } from "../runtime.ts";
import { modelInfo } from "./runtime-shared.ts";

// Model OAuth exists only for the ChatGPT plan provider, and only in a release that opened it.
function assertChatGPTOpen(id: string) {
  if (!isChatGPTPlanProvider(id)) throw new AgentError("subscription_unsupported");
  if (!chatGPTSubscriptionAccess.available) throw new AgentError("openai_approval_required");
}

export function createModelsOperations({
  customModels,
  modelCatalog,
  builtinIds,
  injectKey,
  buildRuntime,
  deps,
}: RuntimeContext): Pick<
  AgentRuntime,
  "login" | "refreshAuth" | "refreshModels" | "listModels" | "resolveCustomModels" | "testProvider"
> {
  return {
    async login(id, interaction) {
      assertChatGPTOpen(id);
      const { runtime, settleAuth } = await buildRuntime();
      try {
        await runtime.login(id, "oauth", interaction, {
          agentName: CHATGPT_AGENT_NAME,
          getDeviceId: () => deps.auth?.chatgptHostId?.() ?? "",
        });
      } finally {
        // The SDK returns on cancel before the flow's listener has closed; wait for that too.
        await settleAuth();
      }
    },
    async refreshAuth(id, signal) {
      assertChatGPTOpen(id);
      const { runtime } = await buildRuntime();
      await runtime.getAuth(id, { signal });
    },

    async refreshModels(providerId, signal) {
      if (providerId !== "openrouter") throw new AgentError("internal");
      try {
        return await modelCatalog.refresh(signal);
      } catch (error) {
        throw new AgentError(signal.aborted ? "aborted" : mapAgentError(error));
      }
    },

    async listModels(opts) {
      try {
        const { runtime } = await buildRuntime();
        const models = opts?.availableOnly ? await runtime.getAvailable() : runtime.getModels();
        const added = deps.addedModels?.() ?? {};
        return models
          .filter((model) => !isRetiredModel(model.provider, model.id))
          .map((model) =>
            added[model.provider]?.includes(model.id)
              ? { ...modelInfo(model), addedByUser: true as const }
              : modelInfo(model),
          );
      } catch (error) {
        throw new AgentError(mapAgentError(error));
      }
    },

    async resolveCustomModels(models) {
      return models.map((model) => customModels.resolve(model).resolved);
    },

    async testProvider(providerId, modelId, signal) {
      const configs = deps.customProviders();
      const imageOnly = configs.find(
        (c) => c.id === providerId && !c.models.length && c.imageModels?.length,
      );
      if (imageOnly || modelId) {
        try {
          const deadline = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000);
          const { runtime } = await buildRuntime();
          const imageModels = runtime.getModelsOfType("image", providerId);
          const image =
            imageModels.find((m) => m.id === modelId) ?? (imageOnly ? imageModels[0] : undefined);
          if (image) {
            await injectKey(runtime, providerId);
            const auth = await runtime.getAuth(image, { signal: deadline });
            deadline.throwIfAborted();
            // Credential resolution is deliberately not reported as a successful paid generation.
            return {
              ok: !!auth,
              ...(!auth ? { error: "auth_failed" as const } : {}),
              verification: "credentials" as const,
              modelCount: imageModels.length,
            };
          }
        } catch (error) {
          return { ok: false, error: mapAgentError(error) };
        }
      }
      // Without a chosen model the key is tested on the provider's default; a provider can stop
      // serving that one (404) while the key is fine, so the next two candidates get a turn.
      const tried = new Set<string>();
      let result: Awaited<ReturnType<typeof testProviderModel>> | undefined;
      for (let attempt = 0; attempt < (modelId ? 1 : 3); attempt++) {
        result = await testProviderModel(async (requestSignal) => {
          const { runtime, custom } = await buildRuntime();
          requestSignal.throwIfAborted();
          if (!builtinIds.has(providerId) && !custom.some((entry) => entry.id === providerId))
            throw new AgentError("no_model");
          const models = await runtime.getAvailable(providerId);
          requestSignal.throwIfAborted();
          const candidates = models.filter(
            (entry) => !isRetiredModel(entry.provider, entry.id) && !tried.has(entry.id),
          );
          const selectedId = modelId ?? defaultModelFor(candidates.map(modelInfo))?.id;
          const model = models.find((entry) => entry.id === selectedId);
          if (!model) throw new AgentError("no_model");
          tried.add(model.id);
          await injectKey(runtime, providerId);
          return { runtime, model, modelCount: models.length };
        }, signal);
        if (result.ok || result.httpStatus !== 404 || signal?.aborted) break;
      }
      const final = result as Awaited<ReturnType<typeof testProviderModel>>;
      // Named only when they explain something: a failure, or a fallback past the default.
      return (!final.ok && tried.size > 0) || tried.size > 1
        ? { ...final, testedModels: [...tried] }
        : final;
    },
  };
}
