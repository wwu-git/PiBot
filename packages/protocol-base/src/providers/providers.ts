import { z } from "zod";
import { CustomImageModelSchema, ImageApiSchema } from "../chat/media.ts";
import { SafeSecretSchema, WebUrlSchema } from "../core/values.ts";

const name = z.string().min(1);
const count = z.number().int().nonnegative().safe();
export const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);
export const DefaultModelSchema = z.strictObject({
  provider: name,
  id: name,
  thinkingLevel: ThinkingLevelSchema,
  /** Null selects the automatic medium default; a value survives capability normalization. */
  thinkingPreference: ThinkingLevelSchema.nullable().optional(),
});
const headerValue = z
  .string()
  .refine((value) => !value.startsWith("!") && !/[\r\n]/.test(value), "Unsafe header value");
const headers = z.record(name, headerValue);
export const ApiSchema = z.enum([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);
const input = z.array(z.enum(["text", "image"])).min(1);
export const CustomModelSchema = z.strictObject({
  id: name,
  name: name.optional(),
  contextWindow: count.positive().optional(),
  maxTokens: count.positive().optional(),
  input: input.optional(),
  reasoning: z.boolean().optional(),
  /** Set only when a provider supplied a limit after rejecting a request; user edits clear it. */
  limitsSource: z.literal("provider").optional(),
});
export const CustomModelCapabilitiesSchema = z.strictObject({
  contextWindow: count.positive(),
  maxTokens: count.positive(),
  input,
  reasoning: z.boolean(),
  thinkingLevels: z.array(ThinkingLevelSchema).min(1),
  inferredFrom: z.strictObject({ provider: name, id: name }).optional(),
});
export const ResolvedCustomModelSchema = CustomModelSchema.extend({
  capabilities: CustomModelCapabilitiesSchema,
});
export const CustomProviderSchema = z.strictObject({
  id: name.optional(),
  name,
  baseUrl: WebUrlSchema,
  api: ApiSchema,
  apiKey: SafeSecretSchema.optional(),
  headers: headers.optional(),
  compat: z.record(name, z.boolean()).optional(),
  models: z.array(CustomModelSchema).max(10000),
  imageApi: ImageApiSchema.optional(),
  imageModels: z.array(CustomImageModelSchema).max(200).optional(),
});
/** Credential-bearing one-shot model discovery input, shared by the agent and RPC adapter. */
export const CustomProviderFetchSchema = CustomProviderSchema.pick({
  baseUrl: true,
  api: true,
  apiKey: true,
  headers: true,
});
/** Editable view of a saved custom provider: credentials are reported only as presence/names. */
export const CustomProviderInfoSchema = CustomProviderSchema.omit({
  apiKey: true,
  headers: true,
}).extend({
  id: name,
  hasApiKey: z.boolean(),
  // Header names remain unknown after restart until encrypted header maps are actually used.
  hasHeaders: z.boolean().optional(),
  headerNames: z.array(name),
});
/** Sign in with ChatGPT on the OpenAI row; display data only, never a token or ID token. */
export const ChatGPTSignInSchema = z.strictObject({
  available: z.boolean(),
  unavailableReason: z.literal("openai_approval_required").optional(),
  state: z.enum(["disconnected", "connecting", "connected", "reauthRequired", "error"]),
  /** The signed-in ChatGPT account's email from its verified ID token. */
  account: z.string().max(320).optional(),
  usageLimited: z.boolean().optional(),
});
export const ProviderSchema = z.strictObject({
  baseUrl: z.string().max(2048).optional(),
  chatgpt: ChatGPTSignInSchema.optional(),
  subscriptionRemoved: z.boolean().optional(),
  unavailableReason: z.literal("openai_approval_required").optional(),
  selectedAuth: z.enum(["apiKey", "oauth", "cloud", "custom"]).optional(),
  authState: z
    .enum(["disconnected", "connecting", "connected", "reauthRequired", "error"])
    .optional(),
  id: name,
  name,
  group: z.enum(["common", "cn", "gateway", "cloud", "fast", "subscription", "local", "other"]),
  auth: z.enum(["apiKey", "oauth", "cloud", "custom"]),
  modelCount: count,
  configured: z.boolean(),
  keyHint: z.string().max(4).optional(),
  envVarName: name.optional(),
  envDetected: z.boolean(),
  available: z.boolean(),
});
export const ModelInfoSchema = z.strictObject({
  provider: name,
  id: name,
  name,
  contextWindow: count.positive(),
  input,
  reasoning: z.boolean(),
  maxTokens: count.positive().optional(),
  thinkingLevels: z.array(ThinkingLevelSchema).min(1).optional(),
  /** Named by the user on a built-in provider, ahead of the pinned catalog. */
  addedByUser: z.literal(true).optional(),
  cost: z.strictObject({
    // SDK router models use negative sentinels for prices that depend on the routed model.
    input: z.number().nonnegative().nullable(),
    output: z.number().nonnegative().nullable(),
    cacheRead: z.number().nonnegative().nullable(),
    cacheWrite: z.number().nonnegative().nullable(),
  }),
});
/** A model id typed by hand for a built-in provider; it is only ever sent as that provider's model. */
export const AddedModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
export const ADDED_MODELS_LIMIT = 50;
export const StoredProviderSchema = z.strictObject({
  id: name,
  kind: z.enum(["builtin", "custom"]),
  config: z.record(name, z.json()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const label = z.string().trim().min(1).max(200);
export const ModelPreferenceSchema = z.strictObject({ provider: label, id: label });
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export type ChatGPTSignIn = z.infer<typeof ChatGPTSignInSchema>;
export type CustomProvider = z.infer<typeof CustomProviderSchema>;
export type CustomProviderInfo = z.infer<typeof CustomProviderInfoSchema>;
export type CustomModel = z.infer<typeof CustomModelSchema>;
export type CustomModelCapabilities = z.infer<typeof CustomModelCapabilitiesSchema>;
export type ResolvedCustomModel = z.infer<typeof ResolvedCustomModelSchema>;
