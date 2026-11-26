// Pi Bot glue between the derived host-managed adapter and the protocol
// ConnectorConnection contract. One factory instance per brain pool; each
// connect() owns exactly one SDK Client so two runtimes never share a wire.
// Brain resolves credentials and approvals; this module never reads secrets.
import { randomUUID } from "node:crypto";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import type {
  ConnectorConnection,
  ConnectorConnectionFactory,
  ConnectorConnectionOptions,
  ConnectorRemoteTool,
  ConnectorStream,
  ConnectorToolPage,
} from "@pibot/protocol-base";
import {
  boundedConnectorServiceMessage,
  CONNECTOR_AUTH_REQUIRED_META,
  CONNECTOR_NATIVE_DIAGNOSTICS_META,
  CONNECTOR_NATIVE_FAILURE_META,
  CONNECTOR_SERVICE_MESSAGE_MAX_CHARS,
  ConnectorAuthenticationError,
  ConnectorCallError,
  type ConnectorNativeCallFailure,
  ConnectorNativeCallFailureSchema,
  type ConnectorNativeDiagnostics,
  ConnectorNativeError,
  type ConnectorNativeFailure,
  ConnectorNativeFailureSchema,
  connectorNativeDiagnostics,
  IDEMPOTENCY_KEY_META,
} from "@pibot/protocol-base";
import {
  type CatalogTool,
  createHostManagedMcpAdapter,
  HostManagedMcpError,
} from "./adapter/host-managed.ts";
import { argumentValidator } from "./arguments.ts";
import { createHttpTransport } from "./http-transport.ts";
import { authorizeConnectorOAuth, connectorAuthError } from "./oauth.ts";

const PAGE_SIZE = 50;

/**
 * Bridges an exec-owned ConnectorStream into the SDK Transport interface.
 * Exec owns the process and its group; this class only moves JSON-RPC frames.
 */
class StreamBridgeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private unsubscribeMessage?: () => void;
  private unsubscribeClose?: () => void;
  private closed = false;

  constructor(
    private readonly stream: ConnectorStream,
    private readonly signal: AbortSignal,
    private readonly nativeFailure?: (value: unknown) => void,
  ) {}

  async start(): Promise<void> {
    this.unsubscribeMessage = this.stream.onMessage((message) => {
      try {
        const parsed = JSON.parse(message) as JSONRPCMessage;
        if ("error" in parsed) this.nativeFailure?.(parsed.error.data);
        this.onmessage?.(parsed);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.unsubscribeClose = this.stream.onClose(() => this.handleClosed());
    if (this.closed) this.unsubscribeClose();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await this.stream.write(JSON.stringify(message), this.signal);
  }

  async close(): Promise<void> {
    this.handleClosed();
    await this.stream.close();
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeMessage?.();
    this.unsubscribeClose?.();
    this.onclose?.();
  }
}

function toRemoteTool(tool: CatalogTool): ConnectorRemoteTool {
  const annotations = tool.definition.annotations;
  // The spec's `title` wins over the older annotations.title; both are display names only.
  const title = (tool.definition.title ?? annotations?.title)?.trim().slice(0, 200);
  return {
    name: tool.definition.name,
    ...(title ? { title } : {}),
    ...(tool.definition.description !== undefined
      ? { description: tool.definition.description }
      : {}),
    inputSchema: (tool.definition.inputSchema ?? { type: "object", properties: {} }) as Record<
      string,
      unknown
    >,
    ...(annotations?.readOnlyHint === undefined ? {} : { readOnlyHint: annotations.readOnlyHint }),
    ...(annotations?.idempotentHint === undefined
      ? {}
      : { idempotentHint: annotations.idempotentHint }),
    ...(annotations?.destructiveHint === undefined
      ? {}
      : { destructiveHint: annotations.destructiveHint }),
  };
}

/** Only the server's text blocks; the adapter's "Error: " prefix is ours, not the service's. */
function toolErrorText(content: readonly unknown[]): string | undefined {
  const parts: string[] = [];
  let length = 0;
  for (const block of content) {
    if (length > CONNECTOR_SERVICE_MESSAGE_MAX_CHARS) break;
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
      length += block.text.length;
    }
  }
  return boundedConnectorServiceMessage(parts.join("\n").replace(/^Error: /u, ""));
}

export function createConnectorConnectionFactory(): ConnectorConnectionFactory {
  return {
    validateArguments: argumentValidator(),
    authorizeOAuth: authorizeConnectorOAuth,
    async connect(options: ConnectorConnectionOptions): Promise<ConnectorConnection> {
      let authFailure = false;
      const callSignals = new Map<string, AbortSignal>();
      // Per-call ownership prevents simultaneous native calls from exchanging failure codes.
      const callFailures = new Map<
        string,
        { code?: ConnectorNativeCallFailure; diagnostics?: ConnectorNativeDiagnostics }
      >();
      let nativeFailure: ConnectorNativeFailure | undefined;
      let openDiagnostics: ConnectorNativeDiagnostics | undefined;
      const transport: Transport =
        options.transport === "stdio"
          ? new StreamBridgeTransport(options.stream, options.signal, (data) => {
              if (!options.trustedNativeErrors || !data || typeof data !== "object") return;
              const code = ConnectorNativeFailureSchema.safeParse(
                (data as Record<string, unknown>)[CONNECTOR_NATIVE_FAILURE_META],
              );
              if (code.success) {
                nativeFailure = code.data;
                openDiagnostics = connectorNativeDiagnostics({
                  nativeDiagnostics: (data as Record<string, unknown>)[
                    CONNECTOR_NATIVE_DIAGNOSTICS_META
                  ],
                });
              }
            })
          : await createHttpTransport(
              options,
              (value) => {
                authFailure = value;
              },
              "streamable",
              callSignals,
            );
      let catalog: readonly CatalogTool[] = [];
      const changeListeners = new Set<() => void>();
      const createAdapter = (ownedTransport: Transport) =>
        createHostManagedMcpAdapter({
          ...(options.startupTimeoutMs ? { openTimeoutMs: options.startupTimeoutMs } : {}),
          servers: {
            connector: { createTransport: () => ownedTransport },
          },
          // Approval already happened in the brain policy layer; the call object
          // still guarantees one dispatch per call record.
          onToolCall: async (call) => {
            try {
              const response = await call.dispatch();
              if (
                options.transport === "stdio" &&
                options.trustedAuthErrors &&
                response._meta?.[CONNECTOR_AUTH_REQUIRED_META] === true
              )
                authFailure = true;
              if (options.transport === "stdio" && options.trustedNativeErrors) {
                const failure = ConnectorNativeCallFailureSchema.safeParse(
                  response._meta?.[CONNECTOR_NATIVE_FAILURE_META],
                );
                const outcome = callFailures.get(call.toolCallId);
                if (outcome)
                  outcome.diagnostics = connectorNativeDiagnostics({
                    nativeDiagnostics: response._meta?.[CONNECTOR_NATIVE_DIAGNOSTICS_META],
                  });
                if (response.isError && failure.success && outcome) outcome.code = failure.data;
              }
              return response;
            } catch (error) {
              if (connectorAuthError(error)) authFailure = true;
              // Keep definite SDK/server failures distinct from an uncertain in-flight transport loss.
              if (
                error instanceof HostManagedMcpError &&
                ["server_error", "not_sent"].includes(error.delivery)
              )
                return {
                  isError: true,
                  content: [{ type: "text", text: "connector_tool_failed" }],
                };
              throw error;
            }
          },
          onCatalogChanged: (_server, tools) => {
            catalog = tools;
            for (const listener of changeListeners) listener();
          },
        });
      let adapter = createAdapter(transport);

      // The pool cancels opens through this signal; aborting closes the adapter.
      let abortClose: Promise<void> | undefined;
      const abortOpen = () => {
        abortClose ??= adapter.close();
        // Observe immediately; finally below owns reporting a failed drain.
        void abortClose.catch(() => undefined);
      };
      options.signal.addEventListener("abort", abortOpen, { once: true });
      try {
        // A stop may arrive while brain is resolving credentials, before this
        // factory receives the signal. Close the owned transport without opening it.
        if (options.signal.aborted) abortOpen();
        await adapter.ready();
        options.signal.throwIfAborted();
        catalog = adapter.catalog();
      } catch (error) {
        await adapter.close();
        options.signal.throwIfAborted();
        if (nativeFailure) throw new ConnectorNativeError(nativeFailure, openDiagnostics);
        const authenticationFailed = authFailure || connectorAuthError(error);
        const shouldFallback =
          options.transport === "http" &&
          options.sseFallback === true &&
          !options.signal.aborted &&
          !authenticationFailed;
        if (!shouldFallback) {
          if (authenticationFailed) throw new ConnectorAuthenticationError();
          throw error;
        }
        authFailure = false;
        adapter = createAdapter(
          await createHttpTransport(
            options,
            (value) => {
              authFailure = value;
            },
            "sse",
            callSignals,
          ),
        );
        try {
          await adapter.ready();
          options.signal.throwIfAborted();
          catalog = adapter.catalog();
        } catch (fallbackError) {
          await adapter.close();
          if (authFailure || connectorAuthError(fallbackError))
            throw new ConnectorAuthenticationError();
          throw fallbackError;
        }
      } finally {
        options.signal.removeEventListener("abort", abortOpen);
        await abortClose;
      }

      return {
        async listTools({
          cursor,
          signal,
        }: {
          cursor?: string;
          signal: AbortSignal;
        }): Promise<ConnectorToolPage> {
          signal.throwIfAborted();
          const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
          if (!Number.isInteger(offset) || offset < 0)
            throw new Error("Invalid connector tool cursor");
          const page = catalog.slice(offset, offset + PAGE_SIZE);
          const next = offset + page.length;
          return {
            tools: page.map(toRemoteTool),
            ...(next < catalog.length ? { nextCursor: String(next) } : {}),
          };
        },
        async callTool(input: {
          tool: string;
          args: Record<string, unknown>;
          signal: AbortSignal;
          idempotencyKey?: string;
        }) {
          input.signal.throwIfAborted();
          const tool = catalog.find((candidate) => candidate.definition.name === input.tool);
          if (!tool) throw new Error(`MCP tool "${input.tool}" is not in the current catalog`);
          const callId = randomUUID();
          callFailures.set(callId, {});
          const stream = new AbortController();
          callSignals.set(callId, AbortSignal.any([input.signal, stream.signal]));
          try {
            const result = await adapter.callTool(
              "connector",
              tool.toolName,
              callId,
              input.args,
              input.signal,
              // Servers that deduplicate can recognise a repeat of the same operation.
              input.idempotencyKey ? { [IDEMPOTENCY_KEY_META]: input.idempotencyKey } : undefined,
            );
            if (authFailure) throw new ConnectorAuthenticationError();
            const failure = callFailures.get(callId)?.code;
            if (failure)
              throw new ConnectorCallError(
                "failed",
                failure,
                callFailures.get(callId)?.diagnostics,
              );
            if (typeof result.details.error === "string") {
              const unknown =
                ["may_have_run", "invalid_result"].includes(result.details.error) ||
                (result.details.error === "host_error" && result.details.sent !== false);
              throw new ConnectorCallError(
                unknown ? "unknown" : "failed",
                undefined,
                undefined,
                result.details.error === "tool_error" ? toolErrorText(result.content) : undefined,
              );
            }
            const diagnostics = callFailures.get(callId)?.diagnostics;
            return diagnostics ? { ...result, nativeDiagnostics: diagnostics } : result;
          } catch (error) {
            if (authFailure || connectorAuthError(error)) throw new ConnectorAuthenticationError();
            throw error;
          } finally {
            // SDK timeouts do not abort legacy per-request streams. End them on every outcome.
            stream.abort();
            callSignals.delete(callId);
            callFailures.delete(callId);
          }
        },
        onToolsChanged(listener: () => void): () => void {
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
        close: () => adapter.close(),
      };
    },
  };
}
