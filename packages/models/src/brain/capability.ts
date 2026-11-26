import { createHash } from "node:crypto";
import { chatGPTPlanModels } from "@pibot/agent";
import { auditProviderName, type BrainCapability, type ModelProvidersPort } from "@pibot/brain/kit";
import { RpcError } from "@pibot/models-contract/full";
import { AuditRepo, BotsRepo, SettingsRepo } from "@pibot/storage";
import { moveChatGPTPlanOffOpenAI } from "../store/index.ts";
import { ProviderAuth } from "./auth/provider-auth.ts";
import { registerProviderAuthRpc } from "./auth/provider-auth-rpc.ts";
import { ProviderStore, providerScope } from "./catalog/providers.ts";
import { registerModelProviderRpc } from "./catalog/rpc.ts";
import { ModelSettings } from "./settings/model-settings.ts";
import { registerProviderImport } from "./settings/provider-import.ts";

export function providersCapability(): BrainCapability {
  return {
    id: "providers",
    async register(ctx) {
      const { db, redactor, logger, peer, local } = ctx;
      const bots = new BotsRepo(db);
      // Before any provider state is read: the plan's sign-in and choices leave the OpenAI row.
      const moved = moveChatGPTPlanOffOpenAI(db, chatGPTPlanModels());
      if (moved)
        logger.info(JSON.stringify({ module: "providers", event: "chatgpt_plan_moved", ...moved }));
      const providers = new ProviderStore(db, ctx.host.secrets, redactor, ctx.secrets);
      await providers.initialize();
      const audit = new AuditRepo(db, redactor);
      const changed = () => peer.emit("providers.changed", {});
      const cancelProviderImport = registerProviderImport(ctx, providers);
      const auth = new ProviderAuth(
        db,
        ctx.host.secrets,
        redactor,
        providers,
        {
          home: local.deps.userHome,
          platform: local.deps.platform,
          appData: local.deps.env.APPDATA,
        },
        changed,
        {
          refreshFailed: (providerId, code) =>
            logger.warn(
              JSON.stringify({
                module: "provider-auth",
                event: "oauth_refresh_failed",
                providerId,
                code,
              }),
            ),
          stateChanged: (state) => {
            peer.emit("providers.loginState", state);
            peer.emit("inbox.changed", {});
          },
          stepChanged: (step) => peer.emit("providers.loginStep", step),
          // Route codes only: which API family and host a plan request used.
          planRequest: (route) =>
            logger.info(
              JSON.stringify({ module: "provider-auth", event: "chatgpt_plan_request", ...route }),
            ),
          openExternal: async (url, signal) => {
            if (!ctx.host.openExternal) throw new RpcError(-32603, "browser_unavailable");
            await ctx.host.openExternal(url, signal);
          },
          audit: (id, event) => {
            const main = bots.getMain();
            if (!main) throw new RpcError(-32603, "main_bot_unavailable");
            audit.append({
              botId: main.id,
              kind: "oauth.changed",
              summary: event,
              detail: { providerId: id, providerName: auditProviderName(id), authEvent: event },
            });
          },
        },
      );
      auth.agent = ctx.agent;
      const modelSettings = new ModelSettings({
        db,
        agent: ctx.agent,
        providers,
        bots,
        settings: new SettingsRepo(db),
        images: () => local.imageProvider,
      });
      const port: ModelProvidersPort = {
        changed,
        hasApiKey: (id) => providers.secrets.has(providerScope(id), "apiKey"),
        getApiKey: (id) => providers.secrets.get(providerScope(id), "apiKey"),
        customProviders: providers.configs,
        addedModels: providers.addedModels,
        auth: auth.ports,
        settings: modelSettings,
        credentials: (id) => providers.requireCredentials(id),
        providerName(id) {
          const entry = providers.catalog.find((item) => item.id === id);
          const custom = providers.configs().find((item) => item.id === id);
          return entry?.group === "local"
            ? null
            : (custom?.name ?? entry?.name ?? id).slice(0, 200);
        },
        configurationKey(id) {
          const row = providers.repo.get(id);
          return row?.kind === "custom"
            ? createHash("sha256").update(JSON.stringify(row.config)).digest("hex")
            : null;
        },
        updateCustomModelLimits: (providerId, modelId, limits) =>
          providers.updateModelLimits(providerId, modelId, limits),
        drainInteractive: () => auth.drainInteractive(),
        cancelAll: () => auth.cancelAll(),
        async stop() {
          cancelProviderImport();
          await auth.stop();
          await providers.settled();
        },
        settled: () => providers.settled(),
      };
      ctx.models.provide(port);
      ctx.sleep.participate({
        idle: () => auth.isIdle(),
        async pause() {
          await auth.pauseMaintenance();
          await providers.settled();
        },
        async resume() {
          auth.resumeMaintenance();
        },
      });
      registerProviderAuthRpc(ctx.rpc.handle, auth);
      registerModelProviderRpc(ctx, providers, auth, modelSettings);
      // Agent consumers still need authentication while other capabilities and runs drain.
      // The kernel owns final port.stop(), after those consumers have actually stopped.
      return { start: () => auth.start() };
    },
  };
}
