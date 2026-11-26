import {
  PROVIDER_IMPORT_LINK_LIMIT,
  type ProviderImportIntent,
  ProviderImportRequestSchema,
  parseProviderImportEndpoint,
} from "@pibot/protocol-base";

const prefix = /^pibot:\/\/provider\/import(?=[?#]|$)/i;
export function isProviderImportUrl(value: string): boolean {
  return prefix.test(value);
}

export function parseProviderImportUrl(value: string): ProviderImportIntent {
  const refused = { status: "refused" } as const;
  if (
    !isProviderImportUrl(value) ||
    value.length > PROVIDER_IMPORT_LINK_LIMIT ||
    /[\s\\#\p{Cc}\p{Cf}]|%(?![0-9a-f]{2})/iu.test(value) ||
    !URL.canParse(value)
  )
    return refused;

  const url = new URL(value);
  // Only a well-formed name is echoed on the refusal card; anything else stays anonymous.
  const named = (text: string | null) => {
    const parsed = ProviderImportRequestSchema.shape.name.safeParse(text);
    return parsed.success ? ({ status: "refused", name: parsed.data } as const) : refused;
  };
  const keys = new Set(["name", "chat", "anthropic", "gemini", "models", "model", "scope", "key"]);
  const query = new Map<string, string>();
  for (const [key, text] of url.searchParams) {
    if (!keys.has(key) || query.has(key) || text.includes("\uFFFD")) return refused;
    query.set(key, text);
  }
  const routes = [
    ["chat", "openai-completions"],
    ["anthropic", "anthropic-messages"],
    ["gemini", "google-generative-ai"],
  ] as const;
  const endpoints = [];
  for (const [field, api] of routes) {
    const value = query.get(field);
    if (value === undefined) continue;
    if (value.length > 2048) return named(url.searchParams.get("name"));
    const endpoint = parseProviderImportEndpoint(value, api);
    if (!endpoint) return named(url.searchParams.get("name"));
    endpoints.push({ baseUrl: endpoint.href, api });
  }
  const endpoint = endpoints[0];
  if (!endpoint) return named(url.searchParams.get("name"));
  const model = query.get("model");
  const models = query.get("models")?.split(",") ?? (model ? [model] : []);
  const parsed = ProviderImportRequestSchema.safeParse({
    ...endpoint,
    name: query.get("name"),
    model,
    models: [...new Set(models)],
    scope: query.get("scope") ?? "default",
    key: query.get("key"),
  });
  return parsed.success
    ? { status: "review", request: parsed.data }
    : named(url.searchParams.get("name"));
}
