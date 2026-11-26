// Scope SDK transport, local endpoint checks, and diagnostics to the current request.
import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import type { Api, Model, Provider, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { IMPORTED_PROVIDER_PREFIX, parseProviderImportEndpoint } from "@pibot/protocol-base";
import { MAGPIE_PROVIDER, magpieBaseUrl, magpiePort } from "@pibot/protocol-base/provider-catalog";
import { AgentError, mapAgentError } from "../core/errors.ts";
import { cacheRequestFields } from "./cache-request-fields.ts";

export interface AgentNetwork {
  enabled(): boolean;
  wrap(provider: Provider): Provider;
  withLocalModelOrigin?<T>(origin: string, send: () => T): T;
  observeRequest?<T>(record: (fields: string[]) => void, send: () => T): T;
  dispose(): void;
}
/**
 * Marks a provider whose every request (including auth) uses the global fetch. Only
 * memoryVertex sets it: pi's own Vertex provider exchanges tokens through gaxios/node-fetch.
 */
const FETCH_ONLY_PROVIDER = Symbol.for("pibot.agent.fetch-only");
// An enumerable own symbol survives the provider spreads in runtime registration.
export function markFetchOnly<T extends Provider>(provider: T): T {
  return Object.assign(provider, { [FETCH_ONLY_PROVIDER]: true });
}

/**
 * Loopback never leaves this machine, and a proxy elsewhere would resolve "localhost" to itself.
 * Only literal loopback names bypass the proxy; LAN and public hosts always use it, so a
 * hostname that merely resolves to 127.0.0.1 still goes through the proxy.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return host === "::1" || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host);
}

/** pi OAuth and Google use global fetch; one brain owns this process-wide adapter. */
export function installAgentNetwork(
  transport: typeof globalThis.fetch,
  enabled: () => boolean,
  // Bedrock's AWS SDK cannot use fetch; pi accepts an explicit per-request HTTP(S) proxy instead.
  proxyUrl?: () => string | undefined,
): AgentNetwork {
  const original = globalThis.fetch;
  const ownership = Symbol.for("pibot.agent.network");
  if (Reflect.get(original, ownership)) throw new AgentError("internal");
  const scope = new AsyncLocalStorage<{
    pinnedOrigin?: string;
    proxyFailure?: "proxy_unavailable" | "proxy_credentials_unavailable" | "proxy_auth_failed";
    response?(response: Response): Promise<void>;
  }>();
  const localModelOrigin = new AsyncLocalStorage<string>();
  const requestMetrics = new AsyncLocalStorage<(fields: string[]) => void>();
  let disposed = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (disposed) throw new AgentError("aborted");
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const pinnedOrigin = scope.getStore()?.pinnedOrigin;
      if (pinnedOrigin && (url.origin !== pinnedOrigin || url.username || url.password))
        throw new AgentError("provider_error");
      const dreamOrigin = localModelOrigin.getStore();
      const loopback = isLoopbackHost(url.hostname);
      if (dreamOrigin && (!loopback || url.origin !== dreamOrigin || url.username || url.password))
        throw new AgentError("provider_error");
      const record = requestMetrics.getStore();
      if (record) {
        const fields = cacheRequestFields(init?.body);
        if (fields) record(fields);
      }
      // Local model servers (Ollama, LM Studio, vLLM) and local MCP servers stay on this machine.
      // A followed redirect would leave loopback without the proxy, so it fails instead.
      if (loopback && (dreamOrigin || pinnedOrigin || enabled())) {
        const response = await original(input, {
          ...init,
          redirect: !dreamOrigin && init?.redirect === "manual" ? "manual" : "error",
        });
        await scope.getStore()?.response?.(response);
        return response;
      }
      // pi's fixed Codex refresh endpoint omits a redirect policy; never forward the refresh token.
      const oauthRefresh = url.hostname === "auth.openai.com" && url.pathname === "/oauth/token";
      const response = await transport(
        input,
        oauthRefresh || pinnedOrigin ? { ...init, redirect: "error" } : init,
      );
      await scope.getStore()?.response?.(response);
      return response;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "proxy_unavailable" ||
          error.code === "proxy_credentials_unavailable" ||
          error.code === "proxy_auth_failed")
      ) {
        const state = scope.getStore();
        if (state) state.proxyFailure = error.code;
        throw new AgentError(error.code);
      }
      throw error;
    }
  };
  Object.defineProperty(fetch, ownership, { value: true });
  globalThis.fetch = fetch;
  type Stream = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: StreamOptions,
  ) => AssistantMessageEventStream;
  // Only the AWS SDK path receives the proxy URL; it never reaches logs or error messages here.
  function bedrockProxy(): { env: Record<string, string>; address: string } {
    let url: string | undefined;
    try {
      url = proxyUrl?.();
    } catch (error) {
      // The brain throws this when the saved proxy account cannot be decrypted.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "proxy_credentials_unavailable"
      )
        throw new AgentError("proxy_credentials_unavailable");
      throw error;
    }
    if (!url) throw new AgentError("proxy_unsupported");
    // pi falls back to process proxy variables for empty values; brain sanitizes those away and
    // literalBedrock re-checks that this exact proxy is the one the SDK resolves. Socket errors
    // name the proxy host (no credentials), which is how a dead proxy is told from a dead AWS.
    const address = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return { env: { HTTPS_PROXY: url, HTTP_PROXY: url }, address };
  }
  function wrap<T extends Provider["stream"] | Provider["streamSimple"]>(
    stream: T,
    fetchOnly: boolean,
  ): T {
    // Both SDK entry points retain their specific options; only transport is added.
    const wrapped: Stream = (model, context, options) => {
      // Vertex through pi's own provider exchanges tokens with gaxios/node-fetch, outside fetch.
      if (enabled() && model.api === "google-vertex" && !fetchOnly)
        throw new AgentError("proxy_unsupported");
      const bedrock =
        enabled() && model.api === "bedrock-converse-stream" ? bedrockProxy() : undefined;
      const magpie = model.provider === MAGPIE_PROVIDER.id;
      const base = magpie ? model.baseUrl.replace(/\/$/, "") : undefined;
      // URL canonicalization removes an explicit HTTP port 80 from the SDK's base URL.
      if (
        base !== undefined &&
        magpiePort(base) === undefined &&
        base !== new URL(magpieBaseUrl(80)).href
      )
        throw new AgentError("provider_error");
      const imported = model.provider.startsWith(IMPORTED_PROVIDER_PREFIX);
      const pinnedOrigin = magpie
        ? new URL(model.baseUrl).origin
        : imported
          ? parseProviderImportEndpoint(model.baseUrl)?.origin
          : undefined;
      if (imported && !pinnedOrigin) throw new AgentError("provider_error");
      const state: {
        pinnedOrigin?: string;
        proxyFailure?: "proxy_unavailable" | "proxy_credentials_unavailable" | "proxy_auth_failed";
        response?(response: Response): Promise<void>;
      } = {
        pinnedOrigin,
        // SDKs can flatten HTTP errors before onResponse runs. Forward only Retry-After,
        // scoped to this provider attempt; never retain headers or share a process-wide value.
        async response(response) {
          if (response.status !== 429) return;
          const retryAfter = response.headers.get("retry-after");
          await options?.onResponse?.(
            { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} },
            model,
          );
        },
      };
      const source = scope.run(state, () =>
        (stream as Stream)(model, context, {
          ...options,
          ...(enabled() && model.api === "openai-codex-responses"
            ? { transport: "sse" as const }
            : {}),
          ...(bedrock ? { env: { ...options?.env, ...bedrock.env } } : {}),
        }),
      );
      const output = new AssistantMessageEventStream();
      void scope.run(state, async () => {
        try {
          for await (const event of source) {
            // The AWS SDK reports its proxy socket failures as plain connection errors.
            if (
              bedrock &&
              event.type === "error" &&
              mapAgentError(event.error.errorMessage) === "network" &&
              event.error.errorMessage?.includes(bedrock.address)
            )
              state.proxyFailure = "proxy_unavailable";
            if (
              event.type === "error" &&
              state.proxyFailure &&
              event.error.stopReason !== "aborted"
            )
              event.error.errorMessage = state.proxyFailure;
            output.push(event);
          }
        } catch (error) {
          const code = state.proxyFailure ?? mapAgentError(error);
          const reason = code === "aborted" ? "aborted" : "error";
          output.push({
            type: "error",
            reason,
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: reason,
              errorMessage: code,
              timestamp: Date.now(),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          });
        } finally {
          output.end();
        }
      });
      return output;
    };
    return wrapped as T;
  }
  return {
    enabled,
    withLocalModelOrigin: (origin, send) => localModelOrigin.run(origin, send),
    observeRequest: (record, send) => requestMetrics.run(record, send),
    wrap(provider) {
      const generateImages = provider.generateImages;
      const fetchOnly = Reflect.get(provider, FETCH_ONLY_PROVIDER) === true;
      return {
        ...provider,
        stream: wrap(provider.stream, fetchOnly),
        streamSimple: wrap(provider.streamSimple, fetchOnly),
        ...(generateImages
          ? {
              generateImages: async (
                ...args: Parameters<NonNullable<Provider["generateImages"]>>
              ) => {
                const state: {
                  proxyFailure?:
                    | "proxy_unavailable"
                    | "proxy_credentials_unavailable"
                    | "proxy_auth_failed";
                } = {};
                const result = await scope.run(state, () => generateImages(...args));
                if (result.stopReason === "error" && state.proxyFailure)
                  return { ...result, errorMessage: state.proxyFailure };
                return result;
              },
            }
          : {}),
      };
    },
    dispose() {
      disposed = true;
      if (globalThis.fetch === fetch) globalThis.fetch = original;
      scope.disable();
      localModelOrigin.disable();
      requestMetrics.disable();
    },
  };
}
