import { createTranslator } from "@pibot/i18n";
import {
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_PLAN_PROVIDER,
  type ModelInfo,
  type Provider,
} from "@pibot/protocol";
import type { ComboboxOption } from "@pibot/ui";
import { useMemo } from "react";
import { useSettings } from "../settings/context.ts";

export function modelDisplayName(name: string): string {
  // Registries may repeat the vendor as "DeepSeek: DeepSeek V4.1 Flash".
  const separator = name.indexOf(": ");
  if (separator < 1) return name;
  const prefix = name.slice(0, separator).trim();
  const model = name.slice(separator + 2).trim();
  const suffix = model.slice(prefix.length);
  return model.toLowerCase().startsWith(prefix.toLowerCase()) && (!suffix || /^[\s_-]/.test(suffix))
    ? model
    : name;
}

export function useModelOptions(
  models: readonly ModelInfo[],
  providers: readonly Provider[],
  grouped = false,
): ComboboxOption[] {
  const { language } = useSettings();
  return useMemo(() => {
    const t = createTranslator(language);
    const names = new Map(providers.map((provider) => [provider.id, provider.name]));
    // The ChatGPT plan and OpenAI share model names; a localized group keeps them apart
    // (「OpenAI」 = API key, 「ChatGPT 计划」 = the plan).
    names.set(CHATGPT_PLAN_PROVIDER, t("chatgpt.title"));
    names.set(CHATGPT_CODEX_PROVIDER, t("chatgpt.codex.title"));
    const options = models.map((model) => ({
      value: grouped ? JSON.stringify([model.provider, model.id]) : model.id,
      label: modelDisplayName(model.name),
      keywords: [model.name, model.id, model.provider, names.get(model.provider) ?? ""],
      group: grouped ? (names.get(model.provider) ?? model.provider) : undefined,
      secondary: [
        ...(model.addedByUser ? [t("models.addedByUser")] : []),
        t("models.contextWindow", { count: model.contextWindow.toLocaleString(language) }),
        ...(model.input.includes("image") ? [t("models.images")] : []),
        ...(model.reasoning ? [t("models.reasoning")] : []),
        `${model.cost.input === null ? t("models.unknownPrice") : `$${model.cost.input}`} / ${model.cost.output === null ? t("models.unknownPrice") : `$${model.cost.output}`}`,
      ].join(" · "),
    }));
    // Group once when the catalog changes, not whenever the user types into the picker.
    if (!grouped) return options;
    const groups = new Map<string | undefined, ComboboxOption[]>();
    for (const option of options) {
      const group = groups.get(option.group);
      if (group) group.push(option);
      else groups.set(option.group, [option]);
    }
    return [...groups.values()].flat();
  }, [models, providers, language, grouped]);
}

export function useComboboxText() {
  const { t } = useSettings();
  return {
    searchPlaceholder: t("combobox.searchPlaceholder"),
    noResultsText: t("combobox.noResults"),
    moreResultsText: (count: number) => t("combobox.moreResults", { count }),
  };
}
