import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { SafeSecretSchema } from "../core/values.ts";
import {
  explicitProviderEndpointVersion,
  supportsProviderEndpointVersion,
} from "./endpoint-version.ts";
import { ApiSchema } from "./providers.ts";

const label = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/);
const scope = z.union([z.literal("default"), label(204).refine((v) => /^bot:\S.*$/u.test(v))]);
export const PROVIDER_IMPORT_LINK_LIMIT = 16_384;
export const IMPORTED_PROVIDER_PREFIX = "provider-link-";
export const IMPORTED_MAGPIE_PREFIX = `${IMPORTED_PROVIDER_PREFIX}magpie-`;

function isPrivateIpv4(host: string) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const [a, b = -1] = host.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function loopbackProviderHost(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d+){3}$/.test(host);
}

/** Plain HTTP is allowed only for a local name or a literal, private address; no DNS heuristics. */
export function parseProviderImportEndpoint(value: string, api?: string): URL | undefined {
  if (!/^https?:\/\/[^/]+/i.test(value) || /[\s\\?#\p{Cc}\p{Cf}]/u.test(value)) return;
  if (value.split("/", 3)[2]?.includes("@")) return;
  if (!URL.canParse(value)) return;
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port === "0" ||
    (api && !supportsProviderEndpointVersion(api, explicitProviderEndpointVersion(url.pathname)))
  )
    return;
  const host = url.hostname;
  if (
    url.protocol !== "https:" &&
    !(loopbackProviderHost(host) || isPrivateIpv4(host) || /^\[f[cd][a-f0-9]{2}:/i.test(host))
  )
    return;
  return url;
}

export function importedMagpieRoute(config: {
  name: string;
  api: string;
  baseUrl: string;
}): boolean {
  if (config.name.toLowerCase() !== "magpie" || config.api !== "openai-completions") return false;
  const url = parseProviderImportEndpoint(config.baseUrl);
  return (
    url?.protocol === "http:" &&
    url.hostname !== "localhost" &&
    loopbackProviderHost(url.hostname) &&
    /^\/v1\/?$/.test(url.pathname)
  );
}

const endpoint = z
  .string()
  .max(2048)
  .refine((value) => !!parseProviderImportEndpoint(value));
const fields = {
  name: label(120),
  baseUrl: endpoint,
  api: ApiSchema.exclude(["openai-responses"]),
  model: modelId,
  scope,
};
const key = SafeSecretSchema.refine((value) => value.length <= 4096 && !/\p{Cc}/u.test(value));

export const ProviderImportRequestSchema = z
  .strictObject({ ...fields, models: z.array(modelId).min(1).max(100), key: key.optional() })
  .refine(
    (request) =>
      request.models.includes(request.model) &&
      !!parseProviderImportEndpoint(request.baseUrl, request.api),
  );
export type ProviderImportRequest = z.infer<typeof ProviderImportRequestSchema>;

export const ProviderImportIntentSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("review"), request: ProviderImportRequestSchema }),
  // The requesting app's own name, when the link carried a valid one, so the card can say who.
  z.strictObject({ status: z.literal("refused"), name: label(120).optional() }),
]);
export type ProviderImportIntent = z.infer<typeof ProviderImportIntentSchema>;

export const ProviderImportPreviewSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...fields,
    status: z.literal("review"),
    id: IdSchema,
    hasKey: z.boolean(),
    bots: z
      .array(
        z.strictObject({
          id: IdSchema,
          name: z.string().min(1).max(200),
          avatarShape: z.string().max(200),
          avatarColor: z.string().max(200),
          avatarEyes: z.string().max(200),
        }),
      )
      .max(500),
    initiallySelected: z.array(IdSchema).max(500),
  }),
  // The requesting app's own name, when the link carried a valid one, so the card can say who.
  z.strictObject({ status: z.literal("refused"), name: label(120).optional() }),
]);

export const ProviderImportDecisionSchema = z.strictObject({
  id: IdSchema,
  // Null is cancellation; an explicit nonempty list is the only way to apply.
  botIds: z.array(IdSchema).min(1).max(500).nullable(),
});
export type ProviderImportDecision = z.infer<typeof ProviderImportDecisionSchema>;

export const ProviderImportResultSchema = z.strictObject({ ok: z.literal(true) });
export const PROVIDER_IMPORT_RESOLVE = "desktop.providerImport.resolve";
