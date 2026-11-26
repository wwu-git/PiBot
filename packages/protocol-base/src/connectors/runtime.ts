import type { JSONType } from "zod";
import type { Connector, ConnectorTool, ConnectorToolRef } from "./connectors.ts";
import type { ConnectorNativeDiagnostics } from "./native-errors.ts";
import type { ConnectorAccess } from "./operations.ts";

/** Validated connector call retained in a prepared tool; raw model input never supplies this. */
export interface ConnectorCallInput extends ConnectorToolRef {
  args: Record<string, JSONType>;
}

/** Trusted connector snapshot shared by preparation and dispatch without importing brain types. */
export interface PreparedConnector {
  groupId?: string;
  secretUses?: { name: string; revision: number }[];
  pluginRevision: number;
  pluginDigest: string;
  connector: Connector;
  access: ConnectorAccess;
  tool: ConnectorTool;
  argsDigest: string;
}

/** Raw metadata stays untrusted until brain validates schema, limits and current revision. */
export interface ConnectorRemoteTool {
  name: string;
  /** MCP `title` (or annotations.title): a name for people, shown only. */
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
}

export interface ConnectorToolPage {
  tools: ConnectorRemoteTool[];
  nextCursor?: string;
}

/** Request `_meta` entry carrying Pi Bot's idempotency key of one intended operation. */
export const IDEMPOTENCY_KEY_META = "pibot/idempotencyKey";
/** Trusted built-in stdio services only: asks the owning connector to enter needs_auth. */
export const CONNECTOR_AUTH_REQUIRED_META = "pibot/authRequired";

/** A connection belongs to the brain pool, not an SDK session. */
export interface ConnectorConnection {
  listTools(input: { cursor?: string; signal: AbortSignal }): Promise<ConnectorToolPage>;
  callTool(input: {
    tool: string;
    args: Record<string, unknown>;
    signal: AbortSignal;
    /**
     * Pi Bot's idempotency key of this operation, sent as request `_meta`
     * (`IDEMPOTENCY_KEY_META`) where the transport supports it; the same key means the same
     * intended operation.
     */
    idempotencyKey?: string;
  }): Promise<unknown>;
  onToolsChanged(listener: () => void): () => void;
  /** Resolves only after calls and owned transport/process resources have actually drained. */
  close(): Promise<void>;
}

/** Credentials are resolved by brain for this connection only; never serialized to renderer. */
export type ConnectorConnectionOptions =
  | {
      transport: "http";
      /** Initialization only; later tool calls retain their normal timeout. */
      startupTimeoutMs?: number;
      url: string;
      headers: Readonly<Record<string, string>>;
      sseFallback?: boolean;
      oauth?: ConnectorOAuthStorage;
      signal: AbortSignal;
    }
  | {
      transport: "stdio";
      /** Initialization only; later tool calls retain their normal timeout. */
      startupTimeoutMs?: number;
      stream: ConnectorStream;
      /** Only the builtin registry may enable this; remote MCP metadata is otherwise untrusted. */
      trustedAuthErrors?: boolean;
      /** Fixed system failure metadata, enabled only by the builtin system-service registry. */
      trustedNativeErrors?: boolean;
      signal: AbortSignal;
    };

/** Exec owns process creation and group termination; agent only consumes this injected stream. */
export interface ConnectorStream {
  write(message: string, signal: AbortSignal): Promise<void>;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface ConnectorConnectionFactory {
  connect(options: ConnectorConnectionOptions): Promise<ConnectorConnection>;
  authorizeOAuth?(input: ConnectorOAuthAuthorization): Promise<void>;
  /** Full SDK schema validation is used only for the built-in, fixed official service catalog. */
  validateArguments?(
    schema: Record<string, unknown>,
    args: Record<string, unknown>,
  ): "valid" | "invalid" | "unsupported";
}

/** The SDK's token/client/discovery types never leave agent. The whole state is encrypted. */
export interface ConnectorOAuthStorage {
  load(): Promise<string | undefined>;
  save(value: string): Promise<void>;
}
export interface ConnectorOAuthAuthorization {
  url: string;
  storage: ConnectorOAuthStorage;
  openExternal(url: string): Promise<void>;
  signal: AbortSignal;
}
export class ConnectorAuthenticationError extends Error {
  constructor() {
    super("connector_auth_required");
    this.name = "ConnectorAuthenticationError";
  }
}

export const CONNECTOR_SERVICE_MESSAGE_MAX_CHARS = 800;

/**
 * Bounds a service's own failure text. A cut can land inside a credential the redactor would
 * only match whole, so the partial trailing token is dropped instead of kept.
 */
export function boundedConnectorServiceMessage(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= CONNECTOR_SERVICE_MESSAGE_MAX_CHARS) return trimmed;
  const cut = trimmed
    .slice(0, CONNECTOR_SERVICE_MESSAGE_MAX_CHARS - 1)
    .replace(/\S*$/u, "")
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trimEnd();
  return cut ? `${cut}…` : undefined;
}

/** A reported failure is never permission to replay a write; partial side effects remain possible. */
export class ConnectorCallError extends Error {
  readonly code = "connector_tool_failed";
  /** A fixed adapter code (e.g. a native app's "not_found"), for logs only; never free text. */
  readonly reason?: string;
  /**
   * The service's own failure text (e.g. "token lacks repo scope"), unredacted. Only for the
   * model after brain redacts it: never in logs, audit, error codes or `message`.
   */
  readonly serviceMessage?: string;
  readonly outcome: "failed" | "unknown";
  readonly nativeDiagnostics?: ConnectorNativeDiagnostics;
  constructor(
    outcome: "failed" | "unknown" = "failed",
    reason?: unknown,
    nativeDiagnostics?: ConnectorNativeDiagnostics,
    serviceMessage?: unknown,
  ) {
    super("connector_tool_failed");
    this.outcome = outcome;
    this.nativeDiagnostics = nativeDiagnostics;
    if (typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason)) this.reason = reason;
    const bounded = boundedConnectorServiceMessage(serviceMessage);
    if (bounded) this.serviceMessage = bounded;
    this.name = "ConnectorCallError";
  }
}

/** Trusted dispatch snapshot, constructed after policy resolution; never accepted from a plugin. */
export interface ConnectorDispatchTarget extends ConnectorToolRef {
  revision: number;
  runId: string;
  botId: string;
  argsDigest: string;
}
