// Combines localized provider display names with the setup catalog.
import {
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_PLAN_PROVIDER,
  isChatGPTPlanProvider,
  MAGPIE_PROVIDER,
  type ModelInfo,
  type Provider,
  providerFamily,
} from "@pibot/models-contract/full";
import { providerIdentity } from "../../setup/operations.ts";
import { customPresets } from "./custom-presets.ts";

export const providerGroups = [
  "common",
  "gateway",
  "cloud",
  "fast",
  "local",
  "other",
  // Sign-in plans (today only the ChatGPT plan) sit apart from key providers.
  "subscription",
  "all",
] as const;

function localCatalog(customName: string, paygLabel: string): Provider[] {
  return [
    { id: "ollama", name: "Ollama" },
    { id: "lmstudio", name: "LM Studio" },
    { id: "vllm", name: "vLLM" },
    ...Object.entries(customPresets)
      .filter(([id]) => id.endsWith("-api"))
      .map(([id, preset]) => ({ id, name: `${preset.name} · ${paygLabel}` })),
    { id: "new-custom", name: customName },
  ].map((entry) => ({
    ...entry,
    group: "local",
    auth: "custom",
    modelCount: 0,
    configured: false,
    envDetected: false,
    available: true,
  }));
}

/**
 * The brain names providers without a language; the ChatGPT plan reads 「ChatGPT 计划」 /
 * "ChatGPT plan" so it never looks like a second OpenAI.
 */
export function namedProviders<T extends Provider>(
  providers: readonly T[],
  planName: string,
  codexName: string,
  magpieName: string,
): T[] {
  return providers.map((provider) =>
    provider.id === CHATGPT_PLAN_PROVIDER
      ? { ...provider, name: planName }
      : provider.id === CHATGPT_CODEX_PROVIDER
        ? { ...provider, name: codexName }
        : provider.id === MAGPIE_PROVIDER.id
          ? { ...provider, name: magpieName }
          : provider,
  );
}

export function providerCatalog(
  providers: Provider[],
  customName: string,
  paygLabel = "API",
): Provider[] {
  // The only model sign-in left is the ChatGPT plan; any other OAuth entry is retired.
  const entries = providers.filter(
    (provider) =>
      (provider.auth !== "oauth" || isChatGPTPlanProvider(provider.id)) &&
      (provider.id !== "custom" || provider.configured),
  );
  const identities = new Set(entries.map(providerIdentity));
  return [
    ...entries,
    ...localCatalog(customName, paygLabel).filter(
      (entry) => !identities.has(providerIdentity(entry)),
    ),
  ];
}

/** A catalog entry or saved credential is not a usable main-Pi model. */
export function configuredTextModels(providers: Provider[], models: ModelInfo[]): ModelInfo[] {
  const active = new Set(
    providers
      .filter(
        (provider) =>
          provider.available &&
          (provider.auth === "oauth"
            ? // The ChatGPT plan has no key; its models are usable while it is signed in.
              isChatGPTPlanProvider(provider.id) && provider.chatgpt?.state === "connected"
            : provider.configured &&
              (provider.selectedAuth === undefined || provider.selectedAuth === provider.auth)),
      )
      .map((provider) => provider.id),
  );
  return models.filter((model) => active.has(model.provider) && model.input.includes("text"));
}

/** Collapse only directory tiles; saved region identities stay individually manageable. */
export function groupedProviderCatalog(providers: Provider[]): Provider[] {
  const families = new Map<string, Provider>();
  const entries: Provider[] = [];
  for (const provider of providers) {
    const family = provider.auth !== "custom" && providerFamily(provider.id);
    if (!family) {
      entries.push(provider);
      continue;
    }
    const previous = families.get(family.name);
    if (!previous || (!previous.configured && provider.configured))
      families.set(family.name, provider);
  }
  return [...entries, ...families.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}
