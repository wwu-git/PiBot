import type { ImageApi, ImageModel, Provider } from "@earendil-works/pi-ai";
import type { ImageModelInfo } from "@pibot/protocol-base";
import {
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_PLAN_PROVIDER,
} from "@pibot/protocol-base/provider-catalog";
import type { CustomProviderConfig, ImageUrlFetch } from "../core/types.ts";
import { type ImageWire, imageAdapter } from "./image-adapters.ts";

function models(
  provider: string,
  baseUrl: string,
  api: ImageWire,
  ids: string[],
): ImageModel<ImageApi>[] {
  return ids.map((id) => ({
    type: "image",
    provider,
    id,
    name: id,
    baseUrl,
    api,
    input: ["text", "image"],
    output: [
      "image",
      ...(api === "google-images" || api === "vertex-images" ? ["text" as const] : []),
    ],
    cost: { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 },
  }));
}
export function imageProvider(
  provider: Provider,
  config?: CustomProviderConfig,
  ports: { fetchImageUrl?: ImageUrlFetch } = {},
): Provider {
  let extra: ImageModel<ImageApi>[] = [];
  let wire: ImageWire | undefined;
  if (config?.imageApi && config.imageModels?.length) {
    wire = config.imageApi;
    const api = wire;
    extra = config.imageModels.flatMap((entry) =>
      models(config.id, config.baseUrl, api, [entry.id]).map((model) => ({
        ...model,
        name: entry.name ?? entry.id,
        input: entry.modes.includes("image-to-image")
          ? ["text" as const, "image" as const]
          : ["text" as const],
      })),
    );
  } else if (provider.id === "openai") {
    wire = "openai-images";
    extra = models(provider.id, "https://api.openai.com/v1", wire, [
      "gpt-image-2",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-1-mini",
      "gpt-image-1.5",
      "gpt-image-2-2026-04-21",
      "gpt-image-2.5-sunburst-2026-09-08",
      "gpt-image-2.5-flare-2026-09-08",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
      "chatgpt-image-latest",
    ]);
  } else if (provider.id === "google") {
    wire = "google-images";
    extra = models(provider.id, "https://generativelanguage.googleapis.com/v1beta", wire, [
      "gemini-nano-banana-2.1",
      "gemini-2.5-flash-image",
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
    ]);
  } else if (provider.id === "google-vertex") {
    // Vertex's Cloud credential is exchanged for a short-lived bearer token by memoryVertex;
    // the static catalog cannot use the generic API-key image adapter.
    wire = "vertex-images";
    extra = models(provider.id, "https://aiplatform.googleapis.com/v1", wire, [
      "gemini-nano-banana-2.1",
      "gemini-3.1-flash-lite-image",
      "gemini-3.1-flash-image",
      "gemini-3-pro-image",
      "gemini-2.5-flash-image",
    ]);
  } else if (provider.id === CHATGPT_PLAN_PROVIDER) {
    // ChatGPT plan OAuth is a Responses credential, not a Codex account token.
    // Keep this on the official image_generation tool route; the Codex backend
    // requires a chatgpt_account_id claim that plan tokens do not provide.
    wire = "openai-chatgpt-images";
    extra = models(provider.id, "https://api.openai.com/v1", wire, [
      "gpt-image-2",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
      "gpt-image-1-mini",
      "gpt-image-1.5",
    ]);
  } else if (provider.id === "openai-codex" || provider.id === CHATGPT_CODEX_PROVIDER) {
    wire = "codex-images";
    // Built-in role installs take the first available image model, so gpt-image-2 stays first.
    extra = models(provider.id, "https://chatgpt.com/backend-api/codex", wire, [
      "gpt-image-2",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
    ]);
  } else if (provider.id === "openrouter") wire = "openrouter-images";
  if (!wire || (wire === "vertex-images" && !provider.generateImages)) return provider;
  const all = provider.getAllModels?.() ?? provider.getModels();
  const supported =
    !config && provider.id === "openrouter" && wire === "openrouter-images"
      ? all
          .filter((entry) => entry.type === "image")
          .map((entry) => ({
            ...entry,
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openrouter-images",
          }))
      : extra;
  return {
    ...provider,
    getAllModels: () => [...all.filter((entry) => entry.type !== "image"), ...supported],
    generateImages: wire === "vertex-images" ? provider.generateImages : imageAdapter(wire, ports),
  };
}
export function imageInfo(
  model: ImageModel<ImageApi>,
  configured: boolean,
  config?: CustomProviderConfig,
): ImageModelInfo {
  const declared = config?.imageModels?.find((entry) => entry.id === model.id);
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    modes: declared?.modes ?? [
      "text-to-image",
      ...(model.input.includes("image") ? ["image-to-image" as const] : []),
    ],
    output: [...model.output],
    configured,
    recipient: new URL(model.baseUrl).hostname,
    source: config ? "custom" : model.provider === "openrouter" ? "sdk" : "official",
    ...(model.provider === "openai-codex" ||
    model.provider === CHATGPT_CODEX_PROVIDER ||
    model.provider === CHATGPT_PLAN_PROVIDER
      ? { experimental: true }
      : {}),
  };
}
