import type { ClientIdentity, Provider } from "@earendil-works/pi-ai";
import { withAnthropicThreadPolicy } from "./anthropic-threads.ts";

function retention(model: { api: string; provider: string }, current?: "none" | "short" | "long") {
  if (current === "none") return current;
  return ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(
    model.api,
  ) ||
    (model.api === "openai-completions" && model.provider === "openai")
    ? ("long" as const)
    : current;
}

function prefixRetention(
  model: { api: string; provider: string; compat?: unknown },
  current?: "none" | "short" | "long",
) {
  const compat = model.compat;
  return (
    model.api === "anthropic-messages" &&
    model.provider === "anthropic" &&
    current !== "none" &&
    !(
      compat &&
      typeof compat === "object" &&
      "supportsLongCacheRetention" in compat &&
      compat.supportsLongCacheRetention === false
    )
  );
}

function fixedPrefixCache(payload: unknown) {
  if (!payload || typeof payload !== "object") return payload;
  const value = payload as Record<string, unknown>;
  // pi already places short conversation breakpoints. Only existing fixed-prefix breakpoints
  // get the longer TTL, so all 1h breakpoints precede the 5m message breakpoint.
  for (const section of [value.tools, value.system]) {
    if (!Array.isArray(section)) continue;
    for (const item of section) {
      if (item && typeof item === "object" && item.cache_control?.type === "ephemeral")
        item.cache_control = { ...item.cache_control, ttl: "1h" };
    }
  }
  return payload;
}

function identity(current?: ClientIdentity): ClientIdentity {
  // The coding agent supplies its own identity even with install telemetry disabled.
  // Attribution describes this app's existing provider requests; it enables no reporting.
  return {
    ...current,
    attribution: { name: "Pi Bot", url: "https://pibot.space" },
  };
}

export function identifyProvider(provider: Provider): Provider {
  const generateImages = provider.generateImages?.bind(provider);
  const classify = provider.classify?.bind(provider);
  return {
    ...provider,
    stream: (model, context, options) =>
      provider.stream(
        withAnthropicThreadPolicy(model),
        context,
        Object.assign({}, options, {
          identity: identity(options?.identity),
          cacheRetention: retention(model, options?.cacheRetention),
          ...(prefixRetention(model, options?.cacheRetention)
            ? {
                onPayload: async (payload: unknown, selected: typeof model) =>
                  fixedPrefixCache((await options?.onPayload?.(payload, selected)) ?? payload),
              }
            : {}),
        }),
      ),
    streamSimple: (model, context, options) =>
      provider.streamSimple(withAnthropicThreadPolicy(model), context, {
        ...options,
        identity: identity(options?.identity),
        cacheRetention: retention(model, options?.cacheRetention),
        ...(prefixRetention(model, options?.cacheRetention)
          ? {
              onPayload: async (payload: unknown, selected: typeof model) =>
                fixedPrefixCache((await options?.onPayload?.(payload, selected)) ?? payload),
            }
          : {}),
      }),
    ...(generateImages
      ? ({
          generateImages: (model, context, options) =>
            generateImages(model, context, {
              ...options,
              identity: identity(options?.identity),
            }),
        } satisfies Pick<Provider, "generateImages">)
      : {}),
    ...(classify
      ? ({
          classify: (model, context, options) =>
            classify(model, context, {
              ...options,
              identity: identity(options?.identity),
            }),
        } satisfies Pick<Provider, "classify">)
      : {}),
  };
}
