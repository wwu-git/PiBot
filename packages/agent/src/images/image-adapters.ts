import type { ImagesFunction, Usage } from "@earendil-works/pi-ai";
import { getAttributionHeaders } from "@earendil-works/pi-ai/utils/identity";
import type { ImageContent } from "@pibot/protocol-base";
import { z } from "zod";
import { AgentError, mapAgentError } from "../core/errors.ts";
import type { ImageUrlFetch } from "../core/types.ts";
import { checkedImage, imageJson, standardImages } from "./image-response.ts";
import { imageFromUrl } from "./image-url.ts";

export type ImageWire =
  | "openai-images"
  | "google-images"
  | "openrouter-images"
  | "codex-images"
  | "openai-chatgpt-images"
  | "vertex-images";

export function imageBase(base: string, wire: ImageWire): string {
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  )
    throw new AgentError("provider_error");
  if (wire === "codex-images") return "https://chatgpt.com/backend-api/codex";
  const version = wire === "google-images" ? "v1beta" : "v1";
  const pathname = url.pathname.replace(/\/+$/, "");
  // An explicit version is a user contract; don't silently guess another version.
  const explicit = pathname.match(/\/(v\d+(?:alpha|beta)?)(?:\/|$)/)?.[1];
  if (
    explicit &&
    (wire === "google-images" ? !["v1", "v1beta"].includes(explicit) : explicit !== "v1")
  )
    throw new AgentError("provider_error");
  url.pathname = explicit ? pathname : `${pathname}/${version}`;
  return url.toString().replace(/\/$/, "");
}
function accountId(token: string): string {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    );
    const parsed = z
      .object({
        "https://api.openai.com/auth": z.object({
          chatgpt_account_id: z
            .string()
            .min(1)
            .max(255)
            .regex(/^[a-zA-Z0-9_-]+$/),
        }),
      })
      .safeParse(payload);
    if (parsed.success) return parsed.data["https://api.openai.com/auth"].chatgpt_account_id;
  } catch {
    /* Invalid credential payload cannot yield an authenticated request. */
  }
  throw new AgentError("auth_failed");
}
const googleResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z
            .array(
              z.object({
                text: z.string().max(100_000).optional(),
                thought: z.boolean().optional(),
                inlineData: z.object({ data: z.string(), mimeType: z.string() }).optional(),
              }),
            )
            .max(100),
        }),
      }),
    )
    .min(1)
    .max(1),
});

// ChatGPT plan OAuth tokens are accepted by the Responses endpoint. The image
// generation tool returns its bytes on an image_generation_call output item,
// rather than using the Images API's data[] envelope.
const responsesImageResponse = z.object({
  output: z
    .array(
      z.object({
        type: z.string().max(100),
        result: z.string().max(25_000_000).optional(),
        text: z.string().max(100_000).optional(),
      }),
    )
    .max(100),
});

// OpenAI's image-generation guide uses this supported mainline model in its
// Responses example; the selected image model remains the tool's `model`.
const CHATGPT_RESPONSES_MODEL = "gpt-6-astra";

export function imageAdapter(
  wire: ImageWire,
  ports: { fetchImageUrl?: ImageUrlFetch } = {},
): ImagesFunction {
  return async (model, context, options) => {
    const timestamp = Date.now();
    try {
      const signal = options?.signal ?? AbortSignal.timeout(300_000);
      signal.throwIfAborted();
      const prompt = context.input
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      const images = context.input.filter((part) => part.type === "image");
      const base = imageBase(model.baseUrl, wire);
      const headers = new Headers();
      for (const [key, value] of Object.entries({
        ...getAttributionHeaders(model, options?.identity),
        ...model.headers,
        ...options?.headers,
      }))
        if (value !== null && value !== undefined) headers.set(key, value);
      const key = options?.apiKey;
      if (key && key !== "pibot-keyless") {
        if (wire === "google-images") headers.set("x-goog-api-key", key);
        else headers.set("Authorization", `Bearer ${key}`);
      }
      let url: string;
      let body: BodyInit;
      if (wire === "google-images") {
        if (images.length > (model.id === "gemini-2.5-flash-image" ? 3 : 5))
          throw new AgentError("provider_error");
        url = `${base}/models/${encodeURIComponent(model.id)}:generateContent`;
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                ...images.map((image) => ({
                  inlineData: { data: image.data, mimeType: image.mimeType },
                })),
              ],
            },
          ],
          generationConfig: { responseModalities: ["IMAGE", "TEXT"], candidateCount: 1 },
        });
      } else if (wire === "openai-chatgpt-images") {
        if (!key) throw new AgentError("auth_failed");
        url = `${base}/responses`;
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
          model: CHATGPT_RESPONSES_MODEL,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                ...images.map((image) => ({
                  type: "input_image",
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                })),
              ],
            },
          ],
          tools: [
            {
              type: "image_generation",
              model: model.id,
              action: images.length ? "edit" : "generate",
            },
          ],
          tool_choice: { type: "image_generation" },
        });
      } else if (wire === "codex-images") {
        if (!key) throw new AgentError("auth_failed");
        headers.set("ChatGPT-Account-ID", accountId(key));
        headers.set("originator", "pi");
        headers.set("Content-Type", "application/json");
        url = `${base}/images/${images.length ? "edits" : "generations"}`;
        body = JSON.stringify({
          model: model.id,
          prompt,
          n: 1,
          quality: "auto",
          size: "auto",
          background: "auto",
          ...(images.length
            ? {
                images: images.map((image) => ({
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                })),
              }
            : {}),
        });
      } else if (wire === "openrouter-images") {
        url = `${base}/images`;
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
          model: model.id,
          prompt,
          n: 1,
          ...(images.length
            ? {
                input_references: images.map((image) => ({
                  type: "image_url",
                  image_url: { url: `data:${image.mimeType};base64,${image.data}` },
                })),
              }
            : {}),
        });
      } else {
        url = `${base}/images/${images.length ? "edits" : "generations"}`;
        if (images.length) {
          headers.delete("Content-Type");
          const form = new FormData();
          for (const [key, value] of Object.entries({
            model: model.id,
            prompt,
            n: "1",
            quality: "auto",
            size: "auto",
            output_format: "png",
          }))
            form.set(key, value);
          for (const [index, image] of images.entries()) {
            const bytes = Uint8Array.from(Buffer.from(image.data, "base64"));
            form.append(
              "image[]",
              new Blob([bytes], { type: image.mimeType }),
              `reference-${index}`,
            );
          }
          body = form;
        } else {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify({
            model: model.id,
            prompt,
            n: 1,
            quality: "auto",
            size: "auto",
            output_format: "png",
          });
        }
      }
      const fetch = options?.fetch ?? globalThis.fetch;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
        redirect: "error",
      });
      const value = await imageJson(response, signal);
      let result: { text: string; images: ImageContent[]; usage?: Usage };
      if (wire === "google-images") {
        const parsed = googleResponse.safeParse(value);
        if (!parsed.success) throw new AgentError("provider_error");
        const parts = parsed.data.candidates[0]?.content.parts ?? [];
        const outputs = parts.flatMap((part) =>
          !part.thought && part.inlineData
            ? [checkedImage(part.inlineData.data, part.inlineData.mimeType)]
            : [],
        );
        if (!outputs.length || outputs.length > 5) throw new AgentError("provider_error");
        const textParts = parts.filter((part) => !part.thought).map((part) => part.text ?? "");
        if (textParts.reduce((total, text) => total + text.length, 0) > 100_000)
          throw new AgentError("provider_error");
        result = {
          images: outputs,
          text: textParts.join(""),
        };
      } else if (wire === "openai-chatgpt-images") {
        const parsed = responsesImageResponse.safeParse(value);
        if (!parsed.success) throw new AgentError("provider_error");
        const outputs = parsed.data.output.flatMap((part) =>
          part.type === "image_generation_call" && part.result ? [checkedImage(part.result)] : [],
        );
        if (!outputs.length || outputs.length > 5) throw new AgentError("provider_error");
        const text = parsed.data.output
          .filter((part) => part.type === "output_text")
          .map((part) => part.text ?? "")
          .join("");
        result = { images: outputs, text };
      } else
        result = await standardImages(value, (link) =>
          imageFromUrl(link, {
            providerOrigin: new URL(base).origin,
            providerHeaders: headers,
            providerFetch: fetch,
            fetchPublic: ports.fetchImageUrl,
            signal,
          }),
        );
      // The complete response has been decoded and validated. Brain retains its paid bytes,
      // then enforces cancellation before any workspace export or follow-up action.
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp,
        stopReason: "stop",
        output: [
          ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
          ...result.images,
        ],
        ...("usage" in result ? { usage: result.usage } : {}),
      };
    } catch (error) {
      const code = options?.signal?.aborted ? "aborted" : mapAgentError(error);
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp,
        output: [],
        stopReason: code === "aborted" ? "aborted" : "error",
        errorMessage: code,
      };
    }
  };
}
