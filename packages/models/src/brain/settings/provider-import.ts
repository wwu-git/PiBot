import { createHash, randomUUID } from "node:crypto";
import type { CapabilityContext } from "@pibot/brain/kit";
import {
  type Bot,
  type CustomProvider,
  IMPORTED_MAGPIE_PREFIX,
  IMPORTED_PROVIDER_PREFIX,
  importedMagpieRoute,
  type ProviderImportDecision,
  type ProviderImportIntent,
  type ProviderImportRequest,
  parseProviderImportEndpoint,
  RpcError,
  RpcErrorCodes,
  resolveThinkingLevel,
} from "@pibot/models-contract/full";
import { AuditRepo, BotsRepo, SettingsRepo } from "@pibot/storage";
import { type ProviderStore, providerScope } from "../catalog/providers.ts";

const MAX_BOTS = 500;
const REVIEW_MS = 120_000;

function eligible(bot: Bot | undefined): bot is Bot {
  return !!bot && !bot.archivedAt && bot.category !== "image" && bot.kind !== "agent";
}

function invalid(message = "provider_import_expired") {
  return new RpcError(RpcErrorCodes.invalidParams, message);
}

function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    // Non-UTF8 percent escapes can only match a credential in their literal representation.
    return value;
  }
}

function previewSafe(ctx: CapabilityContext, request: ProviderImportRequest) {
  const { key, ...publicFields } = request;
  const field = JSON.stringify(publicFields);
  const decoded = decode(field);
  return (
    ctx.redactor.redact(field) === field &&
    ctx.redactor.redact(decoded) === decoded &&
    (!key || !(field.includes(key) || decoded.includes(key)))
  );
}

type Pending = { id: string; request: ProviderImportRequest; botIds: Set<string>; expires: number };

export function registerProviderImport(ctx: CapabilityContext, providers: ProviderStore) {
  const bots = new BotsRepo(ctx.db);
  const settings = new SettingsRepo(ctx.db);
  const audit = new AuditRepo(ctx.db, ctx.redactor);
  let pending: Pending | undefined;
  let expiration: ReturnType<typeof setTimeout> | undefined;
  const drop = () => {
    pending = undefined;
    clearTimeout(expiration);
    expiration = undefined;
  };
  ctx.rpc.handle("providerImport.stage", (intent: ProviderImportIntent, context) => {
    if (!context.desktopMain) throw invalid();
    drop();
    // A refusal names the requesting app only when that name is safe to show, like a preview.
    const shown = (name?: string) =>
      name && ctx.redactor.redact(name) === name && ctx.redactor.redact(decode(name)) === name
        ? { status: "refused" as const, name }
        : { status: "refused" as const };
    if (intent.status !== "review") return shown(intent.name);
    if (!previewSafe(ctx, intent.request)) return shown();
    const refused = shown(intent.request.name);
    if (!settings.get().onboardingCompleted) return refused;
    const request = intent.request;
    const active = bots.list().filter(eligible);
    if (!active.length || active.length > MAX_BOTS) return refused;
    const named = request.scope === "default" ? undefined : request.scope.slice(4);
    const initiallySelected = active.filter((bot) => named === undefined || bot.name === named);
    if (!initiallySelected.length || (named !== undefined && initiallySelected.length !== 1))
      return refused;

    const id = randomUUID();
    const { name, baseUrl, model, api, scope, key } = request;
    const botIds = active.map((bot) => bot.id);
    pending = { id, request, botIds: new Set(botIds), expires: Date.now() + REVIEW_MS };
    expiration = setTimeout(drop, REVIEW_MS);
    expiration.unref();
    return {
      status: "review" as const,
      id,
      name,
      baseUrl,
      api,
      model,
      scope,
      bots: active.map(({ id, name, avatarShape, avatarColor, avatarEyes }) => ({
        id,
        name,
        avatarShape,
        avatarColor,
        avatarEyes,
      })),
      initiallySelected: initiallySelected.map((bot) => bot.id),
      hasKey: key !== undefined,
    };
  });

  ctx.rpc.handle("providerImport.resolve", async (decision: ProviderImportDecision, context) => {
    if (!context.desktopMain) throw invalid();
    const review = pending;
    if (!review || review.id !== decision.id || Date.now() >= review.expires) {
      if (decision.botIds === null) return { ok: true as const };
      throw invalid();
    }
    drop();
    if (decision.botIds === null) return { ok: true as const };
    if (
      new Set(decision.botIds).size !== decision.botIds.length ||
      decision.botIds.some((id) => !review.botIds.has(id))
    )
      throw invalid("provider_import_targets_changed");

    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]);
    const botIds = decision.botIds;
    await providers.serialize(() =>
      applyImport(ctx, providers, bots, audit, review, botIds, signal),
    );
    ctx.peer.emit("providers.changed", {});
    for (const botId of botIds) ctx.peer.emit("bots.changed", { botId, reason: "updated" });
    return { ok: true as const };
  });
  return drop;
}

function importConfig(providers: ProviderStore, request: ProviderImportRequest) {
  const url = parseProviderImportEndpoint(request.baseUrl, request.api);
  if (!url) throw invalid("provider_import_refused");
  const { baseUrl, api, name, key } = request;
  const digest = createHash("sha256")
    .update(JSON.stringify([name, api, baseUrl]))
    .digest("hex");
  const prefix =
    !key && importedMagpieRoute(request) ? IMPORTED_MAGPIE_PREFIX : IMPORTED_PROVIDER_PREFIX;
  const stable = prefix + digest;
  const existing = providers.configs().find((config) => config.id === stable);
  // A link supplying a key must never replace credentials used by an unselected Bot. A route
  // manually edited after import is likewise left alone. Identical keyless links may add models.
  const isolated =
    !!key ||
    (!!existing &&
      (existing.name !== name ||
        existing.api !== api ||
        existing.baseUrl !== baseUrl ||
        !!existing.imageApi ||
        !!existing.imageModels?.length ||
        !!existing.compat ||
        providers.secrets.has(providerScope(stable), "apiKey") ||
        providers.secrets.has(providerScope(stable), "headers")));
  const id = isolated ? prefix + randomUUID() : stable;
  const models = new Map(
    (isolated ? [] : (existing?.models ?? [])).map((model) => [model.id, model]),
  );
  for (const model of request.models) if (!models.has(model)) models.set(model, { id: model });
  const config: CustomProvider = {
    id,
    name,
    baseUrl,
    api,
    models: [...models.values()],
    ...(key ? { apiKey: key } : {}),
  };
  return config;
}

async function applyImport(
  ctx: CapabilityContext,
  providers: ProviderStore,
  bots: BotsRepo,
  audit: AuditRepo,
  review: Pending,
  botIds: string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const config = importConfig(providers, review.request);
  const modelId = review.request.model;
  const [model] = await ctx.agent.resolveCustomModels([{ id: modelId }]);
  if (!model) throw invalid("provider_import_refused");
  signal.throwIfAborted();
  await providers.upsert(config, (providerId) => {
    // Encryption can await. Recheck identities inside the actual write transaction.
    signal.throwIfAborted();
    if (Date.now() >= review.expires) throw invalid();
    for (const botId of botIds) {
      const bot = bots.get(botId);
      if (!eligible(bot)) throw invalid("provider_import_targets_changed");
      const preference =
        bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference;
      bots.update(botId, {
        modelProvider: providerId,
        modelId,
        thinkingLevel: resolveThinkingLevel(model.capabilities, preference),
        thinkingPreference: preference,
      });
    }
    audit.append({
      botId: botIds[0] as string,
      kind: "provider.imported",
      summary: "Provider link applied / 模型厂商链接已应用",
      detail: { providerId, botIds },
    });
  });
}
