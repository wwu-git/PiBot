// Defines shared provider and model RPC contracts.
import {
  AddedModelIdSchema,
  AgentErrorCodeSchema,
  ApiSchema,
  CloudConfigSchema,
  CloudCredentialsSchema,
  CustomModelSchema,
  CustomProviderInfoSchema,
  CustomProviderSchema,
  IdSchema,
  ImageModelInfoSchema,
  ImageModelPageSchema,
  LoginStepSchema,
  ModelInfoSchema,
  ProviderAuthStateSchema,
  ProviderImportDecisionSchema,
  ProviderImportIntentSchema,
  ProviderImportPreviewSchema,
  ProviderImportResultSchema,
  ProviderSchema,
  ResolvedCustomModelSchema,
  SafeSecretSchema,
  WebUrlSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const name = z.string().min(1);
const label = z.string().trim().min(1).max(200);
const count = z.number().int().nonnegative().safe();
const ok = z.strictObject({ ok: z.literal(true) });
const noParams = z.union([z.undefined(), z.strictObject({})]);
const providerId = z.strictObject({ providerId: name });
const magpiePort = z.number().int().min(1).max(65535);
const models = z.array(z.strictObject({ id: name }));
const headers = z.record(
  name,
  z.string().refine((v) => !/[\r\n]/.test(v) && !v.startsWith("!")),
);
export const ProviderMethods = {
  "providers.getConfig": {
    params: z.strictObject({ providerId: label }),
    result: CloudConfigSchema.nullable(),
  },
  "providers.setCredentials": { params: CloudCredentialsSchema, result: ok },
  "providers.authState": {
    params: z.strictObject({ providerId: label }),
    result: ProviderAuthStateSchema,
  },
  "providers.login": {
    params: z.strictObject({
      // Keep legacy requests decodable so every provider receives the same retirement code.
      providerId: label,
      riskAcknowledged: z.boolean().optional(),
    }),
    result: ProviderAuthStateSchema,
  },
  "providers.logout": { params: z.strictObject({ providerId: label }), result: ok },
  "providers.cancelLogin": { params: z.strictObject({ providerId: label }), result: ok },
} as const;
export const ProviderEvents = {
  "providers.loginState": ProviderAuthStateSchema,
} as const;

export const AuthMethods = {
  "providers.selectAuth": {
    params: z.strictObject({
      providerId: z.string().min(1).max(200),
      auth: z.enum(["apiKey", "oauth"]),
    }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "providers.loginStep": {
    params: z.strictObject({ providerId: z.string().min(1).max(200) }),
    result: LoginStepSchema.nullable(),
  },
  "providers.loginInput": {
    params: z.strictObject({
      providerId: z.string().min(1).max(200),
      promptId: IdSchema,
      value: z.string().max(16384),
    }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;
export const AuthEvents = { "providers.loginStep": LoginStepSchema } as const;

export const ModelHealthReasonSchema = z.enum([
  "no_model",
  "auth_failed",
  "chatgpt_plan_not_eligible",
  "model_not_found",
]);

export const ModelProviderMethods = {
  "providerImport.stage": {
    params: ProviderImportIntentSchema,
    result: ProviderImportPreviewSchema,
  },
  "providerImport.resolve": {
    params: ProviderImportDecisionSchema,
    result: ProviderImportResultSchema,
  },
  ...ProviderMethods,
  ...AuthMethods,
  "models.health": {
    params: z.strictObject({
      models: z.array(z.strictObject({ provider: label, id: label })).max(2),
    }),
    result: z.array(ModelHealthReasonSchema.nullable()).max(2),
  },
  "providers.list": { params: noParams, result: z.array(ProviderSchema) },
  "providers.setApiKey": {
    params: z.strictObject({ providerId: name, apiKey: SafeSecretSchema }),
    result: ok,
  },
  "providers.importFromEnv": { params: providerId, result: ok },
  /** A model id for a built-in API-key provider that its pinned catalog does not list yet. */
  "providers.addModel": {
    params: z.strictObject({ providerId: name, modelId: AddedModelIdSchema }),
    result: ok,
  },
  "providers.removeModel": {
    params: z.strictObject({ providerId: name, modelId: AddedModelIdSchema }),
    result: ok,
  },
  "providers.remove": {
    params: providerId.extend({ auth: z.enum(["apiKey", "cloud"]).optional() }),
    result: ok,
  },
  "providers.test": {
    // Up to three 25 s attempts when the default model is gone (404 fallback).
    timeoutMs: 80_000,
    params: z.strictObject({ providerId: name, modelId: name.optional() }),
    result: z.strictObject({
      ok: z.boolean(),
      verification: z.enum(["credentials", "generation"]).optional(),
      keyPlanMismatch: z.boolean().optional(),
      modelCount: count.optional(),
      error: AgentErrorCodeSchema.optional(),
    }),
  },
  "customProviders.fetchModels": {
    params: z.strictObject({
      baseUrl: WebUrlSchema,
      api: ApiSchema,
      apiKey: SafeSecretSchema.optional(),
      headers: headers.optional(),
    }),
    result: z.strictObject({ models }),
  },
  /** Saved credentials are reused but never returned. */
  "customProviders.fetchSavedModels": { params: providerId, result: z.strictObject({ models }) },
  "customProviders.get": { params: providerId, result: CustomProviderInfoSchema },
  /** Omitted apiKey/headers keep the saved values. */
  "customProviders.upsert": { params: CustomProviderSchema, result: z.strictObject({ id: name }) },
  "customProviders.resolveModels": {
    params: z.strictObject({ models: z.array(CustomModelSchema).max(10000) }),
    result: z.strictObject({ models: z.array(ResolvedCustomModelSchema) }),
  },
  "models.refresh": {
    params: z.strictObject({ providerId: z.literal("openrouter") }),
    result: z.strictObject({
      providerId: z.literal("openrouter"),
      count: z.number().int().positive().max(10000),
      updatedAt: z.iso.datetime(),
    }),
  },
  "models.list": {
    params: z.strictObject({ availableOnly: z.boolean().optional() }),
    result: z.array(ModelInfoSchema),
  },
  "models.images": {
    params: ImageModelPageSchema,
    result: z.array(ImageModelInfoSchema).max(200),
  },
  "local.detectMagpie": {
    params: z.strictObject({ port: magpiePort.optional() }),
    result: z.discriminatedUnion("running", [
      z.strictObject({ running: z.literal(false) }),
      z.strictObject({
        running: z.literal(true),
        port: magpiePort,
        version: z.string().min(1).max(80),
      }),
    ]),
  },
  "local.configureMagpie": {
    timeoutMs: 15_000,
    params: z.strictObject({ port: magpiePort }),
    result: z.strictObject({ count: count.positive().max(10000) }),
  },
  "local.detectOllama": {
    params: noParams,
    result: z.strictObject({ running: z.boolean(), baseUrl: WebUrlSchema, models }),
  },
} as const;
export const ModelProviderEvents = {
  ...ProviderEvents,
  ...AuthEvents,
  "providers.changed": z.strictObject({}),
} as const;
