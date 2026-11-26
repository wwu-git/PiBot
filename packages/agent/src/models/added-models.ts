import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { createCustomModelResolver } from "./custom-models.ts";
import { FAMILY_ESTIMATE } from "./custom-models.ts";

type Resolver = ReturnType<typeof createCustomModelResolver>;

function sharedPrefix(a: string, b: string) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return index;
}

/**
 * A model the user named on a built-in provider, newer than the pinned catalog. It is cloned from
 * the provider's own closest catalog entry, so it keeps that entry's endpoint, API and headers:
 * the key only ever goes to the provider it was saved for. Limits come from pi's catalog when the
 * id is known elsewhere, otherwise from the sibling (gpt-6.2-x borrows gpt-6.1-x's).
 */
function addedModel(id: string, models: readonly Model<Api>[], resolve: Resolver["resolve"]) {
  let template: Model<Api> | undefined;
  let best = -1;
  for (const model of models) {
    const length = sharedPrefix(model.id, id);
    if (length > best) {
      best = length;
      template = model;
    }
  }
  if (!template) return undefined;
  const { effective, resolved } = resolve({ id });
  const known =
    resolved.capabilities.inferredFrom &&
    resolved.capabilities.inferredFrom.provider !== FAMILY_ESTIMATE;
  const sibling = !known && best >= 4;
  return {
    ...template,
    id,
    name: id,
    ...(sibling
      ? {}
      : {
          reasoning: effective.reasoning,
          input: effective.input,
          contextWindow: effective.contextWindow,
          maxTokens: effective.maxTokens,
          thinkingLevelMap: effective.thinkingLevelMap,
        }),
    // A catalog price for another model would misstate this one.
    cost: { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 },
  } satisfies Model<Api>;
}

export function withAddedModels(
  provider: Provider,
  ids: readonly string[] | undefined,
  resolve: Resolver["resolve"],
): Provider {
  if (!ids?.length) return provider;
  const text = () =>
    [...provider.getModels()].filter((model) => (model as { type?: string }).type !== "image");
  const extra = () => {
    const models = text();
    const listed = new Set(models.map((model) => model.id));
    return ids.flatMap((id) => {
      if (listed.has(id)) return [];
      const model = addedModel(id, models, resolve);
      return model ? [model] : [];
    });
  };
  return {
    ...provider,
    getModels: () => [...provider.getModels(), ...extra()],
    ...(provider.getAllModels
      ? { getAllModels: () => [...(provider.getAllModels?.() ?? []), ...extra()] }
      : {}),
  } as Provider;
}
