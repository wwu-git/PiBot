// Keeps saved provider configuration and credentials consistent.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSupportedCredential,
  assertSupportedHeaders,
  type CustomProviderConfig,
  listProviderCatalog,
} from "@pibot/agent";
import {
  ADDED_MODELS_LIMIT,
  AddedModelIdSchema,
  CHATGPT_PLAN_PROVIDERS,
  type CustomProvider,
  type CustomProviderInfo,
  CustomProviderSchema,
  MAGPIE_PROVIDER,
  magpiePort,
  RpcError,
  RpcErrorCodes,
} from "@pibot/models-contract/full";
import { assertSafeSecretValue, keyHint, type Redactor, type SecretCipher } from "@pibot/secrets";
import { type SecretStore, transaction } from "@pibot/storage";
import { z } from "zod";
import { ProvidersRepo } from "../../store/index.ts";

export const providerScope = (id: string) => `provider:${id}`;
const AddedModelsSchema = z.array(AddedModelIdSchema).max(ADDED_MODELS_LIMIT);

function validMagpieConfig(config: Omit<CustomProvider, "apiKey">): boolean {
  return (
    magpiePort(config.baseUrl) !== undefined &&
    config.api === "openai-completions" &&
    !config.headers &&
    !config.imageApi &&
    !config.imageModels?.length
  );
}

// Async cipher work finishes before a synchronous SQLite transaction. RPCs never hold a
// database transaction over an await, and failed encryption cannot partially replace a provider.
export class ProviderStore {
  readonly catalog = listProviderCatalog();
  readonly repo: ProvidersRepo;
  readonly secrets: SecretStore;
  private readonly custom = new Map<string, CustomProviderConfig>();
  private readonly lockedHeaders = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: SecretCipher,
    private readonly redactor: Redactor,
    secrets: SecretStore,
  ) {
    this.repo = new ProvidersRepo(db);
    this.secrets = secrets;
  }

  configs = (): CustomProviderConfig[] => structuredClone([...this.custom.values()]);

  updateModelLimits(
    id: string,
    modelId: string,
    limits: { maxTokens?: number; contextWindow?: number },
  ) {
    const current = this.custom.get(id);
    if (!current) return;
    const models = current.models.map((model) => {
      if (model.id !== modelId) return model;
      const next = {
        ...model,
        ...(model.maxTokens === undefined && limits.maxTokens
          ? { maxTokens: limits.maxTokens }
          : {}),
        ...(model.contextWindow === undefined && limits.contextWindow
          ? { contextWindow: limits.contextWindow }
          : {}),
      };
      return next.maxTokens !== model.maxTokens || next.contextWindow !== model.contextWindow
        ? { ...next, limitsSource: "provider" as const }
        : model;
    });
    if (models.every((model, index) => model === current.models[index])) return;
    const next = { ...current, models };
    this.custom.set(id, next);
    this.repo.upsert({ id, kind: "custom", config: next });
  }

  async requireCredentials(id: string): Promise<void> {
    if (id === MAGPIE_PROVIDER.id) return;
    await this.secrets.get(providerScope(id), "apiKey");
    if (this.lockedHeaders.has(id)) {
      const headers = await this.readHeaders(id);
      this.custom.set(id, { ...this.get(id), headers });
      this.lockedHeaders.delete(id);
    }
  }

  private async readHeaders(id: string) {
    const encoded = await this.secrets.get(providerScope(id), "headers");
    const headers = encoded
      ? CustomProviderSchema.shape.headers.parse(JSON.parse(encoded))
      : undefined;
    this.registerHeaders(headers);
    return headers;
  }

  get = (id: string): CustomProviderConfig => {
    const config = this.custom.get(id);
    if (!config) throw new RpcError(-32602, "Unknown custom provider");
    return structuredClone(config);
  };

  /** Non-secret fields only; built field by field so new secret fields cannot leak by default. */
  info(id: string): CustomProviderInfo {
    const { name, baseUrl, api, compat, models, headers, imageApi, imageModels } = this.get(id);
    return {
      id,
      name,
      baseUrl,
      api,
      ...(compat ? { compat } : {}),
      models,
      ...(imageApi ? { imageApi } : {}),
      ...(imageModels ? { imageModels } : {}),
      hasApiKey: this.secrets.has(providerScope(id), "apiKey"),
      hasHeaders: this.secrets.has(providerScope(id), "headers"),
      headerNames: Object.keys(headers ?? {}),
    };
  }

  async initialize(): Promise<void> {
    for (const row of this.repo.list()) {
      if (row.kind !== "custom") continue;
      const cfg = CustomProviderSchema.omit({ apiKey: true }).parse(row.config);
      if (row.id === MAGPIE_PROVIDER.id && !validMagpieConfig(cfg)) continue;
      if (row.id !== MAGPIE_PROVIDER.id && this.secrets.has(providerScope(row.id), "headers"))
        this.lockedHeaders.add(row.id);
      this.custom.set(row.id, { ...cfg, id: row.id });
    }
    // No plaintext enters memory at startup. Reads register keys and individual header
    // values with the redactor before exposing them to request code or diagnostics.
  }

  private registerHeaders(headers?: Record<string, string>) {
    for (const value of Object.values(headers ?? {})) {
      if (value.trim()) this.redactor.add(value.trim());
    }
  }

  serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  async settled() {
    await this.tail;
  }

  /** Hand-added model ids per built-in provider; a malformed stored list is ignored, not trusted. */
  addedModels = (): Record<string, string[]> => {
    const result: Record<string, string[]> = {};
    for (const row of this.repo.list()) {
      if (row.kind !== "builtin") continue;
      const parsed = AddedModelsSchema.safeParse(row.config.addedModels);
      if (parsed.success && parsed.data.length) result[row.id] = parsed.data;
    }
    return result;
  };

  /** Only built-in API-key providers: their key and endpoint stay pi's catalog entry. */
  changeAddedModel(id: string, modelId: string, add: boolean): boolean {
    if (this.custom.has(id) || !this.catalog.some((p) => p.id === id && p.auth === "apiKey"))
      throw new RpcError(-32602, "added_model_unsupported");
    const config = { ...this.repo.get(id)?.config };
    const current = AddedModelsSchema.safeParse(config.addedModels);
    const list = current.success ? current.data : [];
    const next = add
      ? list.includes(modelId)
        ? list
        : [...list, modelId]
      : list.filter((entry) => entry !== modelId);
    if (next.length > ADDED_MODELS_LIMIT) throw new RpcError(-32602, "added_models_limit");
    if (next === list || next.length === list.length) return false;
    if (next.length) config.addedModels = next;
    else delete config.addedModels;
    this.repo.upsert({ id, kind: "builtin", config });
    return true;
  }

  assertWritable(id: string) {
    if (!this.custom.has(id) && !this.catalog.some((p) => p.id === id && p.auth === "apiKey"))
      throw new RpcError(-32602, "Provider is unavailable");
  }

  async setKey(id: string, value: string): Promise<void> {
    if (id === MAGPIE_PROVIDER.id) throw new RpcError(-32602, "magpie_requires_local_setup");
    this.assertWritable(id);
    assertSupportedCredential(value);
    await this.secrets.set(providerScope(id), "apiKey", value);
    if (!this.custom.has(id))
      this.repo.upsert({
        id,
        kind: "builtin",
        config: { ...this.repo.get(id)?.config, selectedAuth: "apiKey" },
      });
  }

  async upsert(input: CustomProvider, afterWrite?: (providerId: string) => void): Promise<string> {
    if (
      (!input.models.length && !input.imageModels?.length) ||
      (!!input.imageModels?.length && !input.imageApi)
    )
      throw new RpcError(-32602, "image_model_unavailable");
    const imageIds = new Set(input.imageModels?.map((model) => model.id));
    if (
      imageIds.size !== (input.imageModels?.length ?? 0) ||
      input.models.some((model) => imageIds.has(model.id))
    )
      throw new RpcError(-32602, "image_mode_mismatch");
    const id = input.id ?? randomUUID();
    if (["openai-codex", "github-copilot", ...CHATGPT_PLAN_PROVIDERS].includes(id))
      throw new RpcError(-32602, "subscription_unsupported");
    if (this.catalog.some((p) => p.id === id && p.auth !== "custom"))
      throw new RpcError(-32602, "Cannot replace a builtin provider");
    if (id === MAGPIE_PROVIDER.id && (!validMagpieConfig(input) || input.apiKey !== undefined))
      throw new RpcError(-32602, "magpie_requires_local_setup");
    const { apiKey, headers, ...publicConfig } = input;
    assertSupportedCredential(apiKey);
    assertSupportedHeaders(headers);
    const config = {
      ...publicConfig,
      id,
      ...(id === "ollama"
        ? {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions" as const,
            compat: { ...input.compat, supportsDeveloperRole: false },
          }
        : {}),
    };
    CustomProviderSchema.omit({ apiKey: true }).parse(config);
    const url = new URL(config.baseUrl);
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((name) => /key|token|secret|password|auth/i.test(name))
    )
      throw new RpcError(-32602, "Put credentials in API Key or headers");
    if (apiKey) this.redactor.add(apiKey);
    this.registerHeaders(headers);
    if (this.redactor.redact(JSON.stringify(config)) !== JSON.stringify(config))
      throw new RpcError(-32602, "Provider metadata must not contain secrets");
    const clearHeaders = headers !== undefined && Object.keys(headers).length === 0;
    const pending: Array<{ name: string; value: string; cipher: Uint8Array }> = [];
    for (const [name, value] of [
      ["apiKey", apiKey],
      ["headers", headers === undefined || clearHeaders ? undefined : JSON.stringify(headers)],
    ] as const) {
      if (value === undefined) continue;
      assertSafeSecretValue(value);
      if (!(await this.cipher.isAvailable()))
        throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
      pending.push({ name, value, cipher: await this.cipher.encrypt(value) });
    }
    transaction(this.db, () => {
      this.repo.upsert({ id, kind: "custom", config });
      // Clearing headers needs only a database delete, not an encrypted empty credential.
      if (clearHeaders) this.secrets.remove(providerScope(id), "headers");
      for (const entry of pending) {
        this.db
          .prepare(`INSERT INTO secrets (id, scope, name, ciphertext, hint, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, name) DO UPDATE
          SET ciphertext = excluded.ciphertext, hint = excluded.hint, last_used_at = NULL`)
          .run(
            randomUUID(),
            providerScope(id),
            entry.name,
            entry.cipher,
            keyHint(entry.value) ?? null,
            new Date().toISOString(),
          );
      }
      // Model metadata and affected Bot thinking levels must commit together.
      afterWrite?.(id);
    });
    for (const entry of pending) this.redactor.add(entry.value);
    this.registerHeaders(headers);
    const previous = this.custom.get(id);
    this.custom.set(id, { ...config, headers: headers ?? previous?.headers });
    if (headers !== undefined) this.lockedHeaders.delete(id);
    return id;
  }

  remove(id: string): void {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM secrets WHERE scope = ?").run(providerScope(id));
      this.repo.remove(id);
    });
    this.custom.delete(id);
    this.lockedHeaders.delete(id);
  }
}
