import { IMAGE_LIMIT, type ImageContent } from "@pibot/protocol-base";
import { AgentError } from "../core/errors.ts";
import type { ImageUrlFetch } from "../core/types.ts";
import { boundedBody, checkedImage } from "./image-response.ts";

export interface ImageUrlContext {
  /** The provider's own endpoint origin, already trusted with its credentials. */
  providerOrigin: string;
  providerHeaders: Headers;
  providerFetch: typeof globalThis.fetch;
  /** Host port for any other origin; it enforces the public-destination rules. */
  fetchPublic?: ImageUrlFetch;
  signal: AbortSignal;
}

/**
 * A supplier link is untrusted: only the provider's own origin may receive its headers (that
 * server already holds them); anything else must be https and goes through the host port with
 * no headers at all. The bytes pass the same magic-byte check as inline results.
 */
export async function imageFromUrl(raw: string, context: ImageUrlContext): Promise<ImageContent> {
  const { signal } = context;
  try {
    const url = new URL(raw);
    if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:"))
      throw new AgentError("image_url_unavailable");
    url.hash = "";
    let bytes: Uint8Array;
    if (url.origin === context.providerOrigin) {
      const headers = new Headers(context.providerHeaders);
      headers.delete("Content-Type");
      headers.set("Accept", "image/*");
      const response = await context.providerFetch(url, {
        method: "GET",
        headers,
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AgentError("image_url_unavailable");
      }
      if (Number(response.headers.get("content-length")) > IMAGE_LIMIT) {
        await response.body?.cancel();
        throw new AgentError("image_url_unavailable");
      }
      bytes = await boundedBody(response, IMAGE_LIMIT, signal);
    } else {
      if (url.protocol !== "https:" || !context.fetchPublic)
        throw new AgentError("image_url_unavailable");
      bytes = (await context.fetchPublic({ url: url.href, signal })).data;
    }
    if (bytes.byteLength > IMAGE_LIMIT) throw new AgentError("image_url_unavailable");
    // The served Content-Type is not trusted; the bytes decide the type.
    return checkedImage(Buffer.from(bytes).toString("base64"));
  } catch {
    signal.throwIfAborted();
    // Network, address, size and format failures share one code; details could echo the link.
    throw new AgentError("image_url_unavailable");
  }
}
