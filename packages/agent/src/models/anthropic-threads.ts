// Keep Anthropic server threads off until resume, compaction and billing are evaluated.
const enableAnthropicMessageThreads = false;

export function withAnthropicThreadPolicy<T extends { api: string; compat?: unknown }>(
  model: T,
): T {
  if (enableAnthropicMessageThreads || model.api !== "anthropic-messages") return model;
  const compat = model.compat;
  return {
    ...model,
    compat: {
      ...(compat && typeof compat === "object" ? compat : {}),
      supportsMessageThreads: false,
    },
  };
}
