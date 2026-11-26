import { createRequire } from "node:module";
import { isIP } from "node:net";
import type { Dispatcher, Response } from "undici";
import { withDeadline } from "../core/deadline.ts";
import { ExecError, type PageOptions } from "../core/types.ts";
import { isProxyAuthenticationFailure, proxyAgent } from "./network-proxy.ts";
import { checkedUrl, checkProxyTarget, publicAddresses, waitForWeb } from "./web-address.ts";
import { webFailure } from "./web-error.ts";

const imageLimit = 10 * 1024 * 1024;
// Untyped storage buckets often serve images this way; such callers check the bytes themselves.
const binaryTypes = new Set(["", "application/octet-stream", "binary/octet-stream"]);

async function imageBytes(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new ExecError("web_failed", "body_failed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await waitForWeb(reader.read(), signal);
      if (done) break;
      size += value.length;
      // Bound decompressed bytes, including chunked responses with no Content-Length.
      if (size > imageLimit) throw new ExecError("web_failed", "response_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    try {
      await withDeadline(reader.cancel(), 1000, new ExecError("web_failed", "cleanup_failed"));
    } finally {
      reader.releaseLock();
    }
  }
}

function release(response: Response | undefined, agent: Dispatcher | undefined) {
  return withDeadline(
    Promise.all([
      response?.body && !response.body.locked ? response.body.cancel() : Promise.resolve(),
      agent?.destroy() ?? Promise.resolve(),
    ]),
    1000,
    new ExecError("web_failed", "cleanup_failed"),
  );
}

/**
 * Explicit image requests share web_fetch's address rules. Redirects are refused unless the
 * caller allows some; each allowed hop must be https and is checked like the first request.
 */
export async function fetchImage(
  options: Omit<PageOptions, "maxChars"> & {
    redirects?: number;
    /** Also accept untyped binary bodies; the caller must check the image bytes itself. */
    binary?: boolean;
  },
) {
  const timeout = AbortSignal.timeout(20_000);
  const { Agent, fetch } = createRequire(import.meta.url)("undici") as typeof import("undici");
  const signal = AbortSignal.any([options.signal, timeout]);
  let agent: Dispatcher | undefined;
  let response: Response | undefined;
  let stage: NonNullable<ExecError["reason"]> = "dns_failed";
  try {
    let url = checkedUrl(options.url);
    for (let hop = 0; ; hop++) {
      const domain = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (options.proxy) await checkProxyTarget(url, signal);
      const addresses = options.proxy ? [] : await publicAddresses(url, signal);
      if (!(await waitForWeb(options.allowDomain(domain, signal, url.href), signal)))
        throw new ExecError("web_blocked", "domain_denied");
      signal.throwIfAborted();
      // Proxy selection is frozen for this request; never fall back to a direct connection.
      agent = options.proxy
        ? proxyAgent(options.proxy)
        : new Agent({
            connect: {
              ...(url.protocol === "https:" && !isIP(domain) ? { servername: domain } : {}),
              lookup: (_host, lookupOptions, callback) => {
                if (lookupOptions.all) callback(null, addresses);
                else {
                  const address = addresses[0];
                  if (!address) callback(new Error("No address"), "", 4);
                  else callback(null, address.address, address.family);
                }
              },
            },
          });
      stage = "connection_failed";
      response = await waitForWeb(
        fetch(url, {
          signal,
          dispatcher: agent,
          redirect: "manual",
          credentials: "omit",
          headers: { "User-Agent": "Pi Bot/0.0.0 (image_load)", Accept: "image/*" },
        }),
        signal,
      );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || hop >= (options.redirects ?? 0) || !URL.canParse(location, url))
          throw new ExecError("web_failed", "redirect_limit");
        const next = checkedUrl(new URL(location, url).href);
        if (next.protocol !== "https:") throw new ExecError("web_blocked", "unsupported_url");
        const [done, used] = [response, agent];
        response = undefined;
        agent = undefined;
        await release(done, used);
        url = next;
        stage = "dns_failed";
        continue;
      }
      if (!response.ok) throw new ExecError("web_failed", "http_status");
      const mimeType =
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!mimeType.startsWith("image/") && !(options.binary && binaryTypes.has(mimeType)))
        throw new ExecError("web_blocked", "unsupported_content_type");
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > imageLimit)
        throw new ExecError("web_failed", "response_too_large");
      stage = "body_failed";
      return { data: await imageBytes(response, signal), mimeType };
    }
  } catch (error) {
    if (options.signal.aborted) throw new ExecError("web_failed", "cancelled");
    if (timeout.aborted) throw new ExecError("web_failed", "timeout");
    if (isProxyAuthenticationFailure(error)) throw new ExecError("web_failed", "proxy_auth_failed");
    throw webFailure(error, stage);
  } finally {
    await release(response, agent);
  }
}
