// Lists model providers from pi and the Pi Bot gateway presets.
// `./env-api-keys` (add-only patch) has no SDK imports; `./compat` would load pi-ai and typebox.
import { findEnvKeys } from "@earendil-works/pi-ai/env-api-keys";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
// Subpath: reached from the owner's env sanitizer before the brain fork.
import {
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_PROVIDERS,
  MAGPIE_PROVIDER,
  providerFamily,
  providerPlan,
} from "@pibot/protocol-base/provider-catalog";
import type { ProviderCatalogEntry } from "../core/types.ts";

const groups: Partial<Record<ProviderCatalogEntry["group"], string[]>> = {
  common: [
    "anthropic",
    "openai",
    "google",
    "xai",
    "deepseek",
    "moonshotai",
    "moonshotai-cn",
    "minimax",
    "minimax-cn",
    "mistral",
    "meta",
    "ant-ling",
    "xiaomi",
  ],
  other: ["radius"],
  gateway: ["openrouter", "vercel-ai-gateway", "cloudflare-ai-gateway", "opencode", "opencode-go"],
  cloud: ["amazon-bedrock", "google-vertex", "azure", "cloudflare-workers-ai"],
  fast: ["groq", "cerebras", "fireworks", "huggingface", "baseten", "nvidia", "together"],
};
const cloudAuth = new Set([
  "amazon-bedrock",
  "google-vertex",
  "azure",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
]);
// Only synthetic values are queried: findEnvKeys otherwise consults the inherited environment.
const syntheticEnv = new Proxy<Record<string, string>>({}, { get: () => "pibot-discovery" });

export function providerEnvNames(id: string): string[] {
  return findEnvKeys(id, syntheticEnv) ?? [];
}

export function listProviderCatalog(): ProviderCatalogEntry[] {
  const builtin = builtinProviders();
  const entries = builtin
    .filter(
      (provider) =>
        !["openai-codex", "github-copilot", "typesafe", ...CHATGPT_PLAN_PROVIDERS].includes(
          provider.id,
        ) &&
        (!!provider.auth.apiKey || cloudAuth.has(provider.id)),
    )
    .map((provider): ProviderCatalogEntry => {
      const group = Object.entries(groups).find(([, ids]) => ids.includes(provider.id))?.[0] as
        | ProviderCatalogEntry["group"]
        | undefined;
      const auth = cloudAuth.has(provider.id) ? "cloud" : "apiKey";
      return {
        id: provider.id,
        name: providerFamily(provider.id)?.name ?? providerPlan(provider.id)?.name ?? provider.name,
        group: providerPlan(provider.id) ? "other" : (group ?? "other"),
        auth,
        modelCount: provider.getModels().length,
        ...(cloudAuth.has(provider.id) ? {} : { baseUrl: provider.getModels()[0]?.baseUrl }),
        // Anthropic's discovery also lists bearer/OAuth tokens, which are not API Keys.
        envVarName:
          provider.id === "anthropic" ? "ANTHROPIC_API_KEY" : providerEnvNames(provider.id)[0],
        available: true,
      };
    });
  // The ChatGPT plan is its own 订阅 entry with pi's ChatGPT-backend
  // (openai-codex) chat catalog; the runtime registers it only while the release gate is open.
  const codex = builtin.find((provider) => provider.id === "openai-codex");
  if (codex)
    entries.push(
      {
        id: CHATGPT_PLAN_PROVIDER,
        name: "ChatGPT",
        group: "subscription",
        auth: "oauth",
        modelCount: codex.getModels().length,
        available: true,
      },
      // Maintainers 2026-11-15: the same plan signed in through pi's legacy Codex login.
      {
        id: CHATGPT_CODEX_PROVIDER,
        name: "ChatGPT (Codex)",
        group: "subscription",
        auth: "oauth",
        modelCount: codex.getModels().length,
        available: true,
      },
    );
  for (const [id, name] of [
    [MAGPIE_PROVIDER.id, MAGPIE_PROVIDER.name],
    ["ollama", "Ollama"],
    ["lmstudio", "LM Studio"],
    ["vllm", "vLLM"],
    ["custom", "Custom"],
  ]) {
    if (id && name)
      entries.push({ id, name, group: "local", auth: "custom", modelCount: 0, available: true });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
