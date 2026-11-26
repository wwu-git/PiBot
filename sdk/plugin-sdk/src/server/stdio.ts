import { McpServer, ProtocolError, type Tool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  CONNECTOR_AUTH_REQUIRED_META,
  CONNECTOR_NATIVE_DIAGNOSTICS_META,
  CONNECTOR_NATIVE_FAILURE_META,
  ConnectorAuthenticationError,
  type ConnectorConnection,
  ConnectorNativeCallError,
  ConnectorNativeError,
  type ConnectorRemoteTool,
  connectorNativeDiagnostics,
} from "@pibot/protocol-base";
import { z } from "zod";
import { openNativeConnection } from "../native/driver.ts";

export interface PluginSecrets {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface PluginHost {
  enabledTools(): Promise<string[]>;
  openExternal(url: string): Promise<void>;
  startOAuthCallback(state: string): Promise<{ session: string; redirectUri: string }>;
  waitOAuthCallback(session: string): Promise<{ code: string }>;
  cancelOAuthCallback(): Promise<void>;
}

export function createStdioServer(name: string, version = "0.0.1") {
  return {
    server: new McpServer({ name, version }),
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 4 * 1024 * 1024,
    }),
  };
}

function inputSchema(tool: ConnectorRemoteTool): z.ZodType {
  const schema = tool.inputSchema as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    let value: z.ZodType;
    if (property.type === "string") {
      let string = z.string();
      if (typeof property.minLength === "number") string = string.min(property.minLength);
      if (typeof property.maxLength === "number") string = string.max(property.maxLength);
      value = string;
    } else if (property.type === "integer") {
      let number = z.number().int();
      if (typeof property.minimum === "number") number = number.min(property.minimum);
      if (typeof property.maximum === "number") number = number.max(property.maximum);
      value = number;
    } else if (property.type === "boolean") {
      value = z.boolean();
    } else if (property.type === "array") {
      const item = property.items as Record<string, unknown> | undefined;
      let array = z.array(item?.type === "string" ? z.string() : z.json());
      if (typeof property.minItems === "number") array = array.min(property.minItems);
      if (typeof property.maxItems === "number") array = array.max(property.maxItems);
      value = array;
    } else {
      value = z.json();
    }
    shape[name] = required.has(name) ? value : value.optional();
  }
  return z.strictObject(shape);
}

const result = (value: unknown) => {
  const diagnostics = connectorNativeDiagnostics({
    nativeDiagnostics:
      value && typeof value === "object" && "diagnostics" in value ? value.diagnostics : undefined,
  });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(diagnostics ? { _meta: { [CONNECTOR_NATIVE_DIAGNOSTICS_META]: diagnostics } } : {}),
  };
};

/** Serve one compiled-in adapter over the same stdio MCP protocol used by every external server. */
export async function serveStdio(input: {
  id: string;
  open?(input: {
    token?: string;
    signal: AbortSignal;
    secrets: PluginSecrets;
    host: PluginHost;
  }): Promise<import("@pibot/protocol-base").ConnectorConnection>;
  native?: {
    app: string;
    tools: readonly ConnectorRemoteTool[];
    scripts: Readonly<Partial<Record<"darwin" | "win32", string>>>;
    accessPromptMs?: number;
  };
}): Promise<void> {
  const lifetime = new AbortController();
  const { server, transport } = createStdioServer(`pibot-${input.id}`);
  const secrets: PluginSecrets = {
    get: async (name) =>
      (
        await server.server.request(
          { method: "pibot/secrets", params: { method: "get", name } },
          z.object({
            value: z
              .string()
              .max(64 * 1024)
              .optional(),
          }),
          { signal: lifetime.signal },
        )
      ).value,
    set: async (name, value) => {
      await server.server.request(
        { method: "pibot/secrets", params: { method: "set", name, value } },
        z.object({ value: z.string().optional() }),
        { signal: lifetime.signal },
      );
    },
    delete: async (name) => {
      await server.server.request(
        { method: "pibot/secrets", params: { method: "delete", name } },
        z.object({ value: z.string().optional() }),
        { signal: lifetime.signal },
      );
    },
  };
  const token = process.env.PIBOT_MCP_TOKEN;
  const host: PluginHost = {
    enabledTools: async () =>
      (
        await server.server.request(
          { method: "pibot/enabled-tools", params: {} },
          z.object({ tools: z.array(z.string()).max(1000) }),
          { signal: lifetime.signal },
        )
      ).tools,
    openExternal: async (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error("plugin_external_url_denied");
      await server.server.request(
        { method: "pibot/open-external", params: { url } },
        z.object({}),
        { signal: lifetime.signal },
      );
    },
    startOAuthCallback: (state) =>
      server.server.request(
        { method: "pibot/oauth-loopback", params: { action: "start", state } },
        z.object({ session: z.string(), redirectUri: z.string().url() }),
        { signal: lifetime.signal },
      ),
    waitOAuthCallback: (session) =>
      server.server.request(
        { method: "pibot/oauth-loopback", params: { action: "wait", session } },
        z.object({ code: z.string().max(4096) }),
        { timeout: 310000, signal: lifetime.signal },
      ),
    cancelOAuthCallback: async () => {
      await server.server.request(
        { method: "pibot/oauth-loopback", params: { action: "cancel" } },
        z.object({}),
        { signal: lifetime.signal },
      );
    },
  };
  delete process.env.PIBOT_MCP_TOKEN;
  let connection: ConnectorConnection | undefined;
  const closeConnection = () => {
    const current = connection;
    connection = undefined;
    return current?.close();
  };
  let opening: Promise<ConnectorRemoteTool[]> | undefined;
  const pending = new Set<Promise<unknown>>();
  // Open only after a host request: transport attachment alone is not the MCP handshake.
  // Secrets and native setup may call the host, while tools/list must await their completion.
  const ready = () => {
    opening ??= (async () => {
      lifetime.signal.throwIfAborted();
      try {
        connection = input.native
          ? await openNativeConnection(
              input.native.app,
              input.native.tools,
              {
                scripts: input.native.scripts,
                requestSchema: z.strictObject({
                  app: z.literal(input.native.app),
                  tool: z.enum(["check", ...input.native.tools.map((tool) => tool.name)] as [
                    string,
                    ...string[],
                  ]),
                  args: z
                    .record(z.string(), z.json())
                    .refine((value) => JSON.stringify(value).length <= 64 * 1024),
                }),
                ...(input.native.accessPromptMs === undefined
                  ? {}
                  : { accessPromptMs: input.native.accessPromptMs }),
              },
              lifetime.signal,
            )
          : await input.open?.({ token, signal: lifetime.signal, secrets, host });
        // An adapter may finish opening after shutdown. Its resources still belong to us.
        if (lifetime.signal.aborted) {
          await closeConnection();
          lifetime.signal.throwIfAborted();
        }
        if (!connection) throw new Error("mcp_app_service_unavailable");
        return (await connection.listTools({ signal: lifetime.signal })).tools;
      } catch (error) {
        await closeConnection();
        throw error;
      }
    })();
    return opening;
  };
  const nativeError = (error: ConnectorNativeError) =>
    new ProtocolError(-32000, "native_app_failed", {
      [CONNECTOR_NATIVE_FAILURE_META]: error.failureCode,
      ...(error.nativeDiagnostics
        ? { [CONNECTOR_NATIVE_DIAGNOSTICS_META]: error.nativeDiagnostics }
        : {}),
    });
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler("tools/list", async () => {
    try {
      const tools = await ready();
      return {
        tools: tools.map((definition) => ({
          name: definition.name,
          // A name for people; "中文 / English" is shown in the reader's language.
          ...(definition.title ? { title: definition.title } : {}),
          description: definition.description,
          // Zod emits a JSON object; MCP's narrower recursive JSON type cannot express it.
          inputSchema: {
            ...z.toJSONSchema(inputSchema(definition)),
            type: "object",
          } as unknown as Tool["inputSchema"],
          annotations: {
            ...(definition.title ? { title: definition.title } : {}),
            ...(definition.readOnlyHint === undefined
              ? {}
              : { readOnlyHint: definition.readOnlyHint }),
            ...(definition.idempotentHint === undefined
              ? {}
              : { idempotentHint: definition.idempotentHint }),
            ...(definition.destructiveHint === undefined
              ? {}
              : { destructiveHint: definition.destructiveHint }),
          },
        })),
      };
    } catch (error) {
      if (error instanceof ConnectorNativeError) throw nativeError(error);
      throw error;
    }
  });
  server.server.setRequestHandler("tools/call", async (request, context) => {
    const work = (async () => {
      try {
        const tools = await ready();
        const definition = tools.find((tool) => tool.name === request.params.name);
        if (!connection || !definition) throw new ProtocolError(-32602, "mcp_tool_unavailable");
        const parsed = inputSchema(definition).safeParse(request.params.arguments ?? {});
        if (!parsed.success) throw new ProtocolError(-32602, "mcp_tool_arguments_invalid");
        const signal = AbortSignal.any([lifetime.signal, context.mcpReq.signal]);
        signal.throwIfAborted();
        return result(
          await connection.callTool({
            tool: definition.name,
            args: parsed.data as Record<string, unknown>,
            signal,
          }),
        );
      } catch (error) {
        if (error instanceof ConnectorNativeCallError)
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: error.failureCode }],
            _meta: {
              [CONNECTOR_NATIVE_FAILURE_META]: error.failureCode,
              ...(error.nativeDiagnostics
                ? { [CONNECTOR_NATIVE_DIAGNOSTICS_META]: error.nativeDiagnostics }
                : {}),
            },
          };
        if (error instanceof ConnectorAuthenticationError)
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "connector_auth_required" }],
            _meta: { [CONNECTOR_AUTH_REQUIRED_META]: true },
          };
        if (error instanceof ConnectorNativeError) throw nativeError(error);
        throw error;
      }
    })();
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    lifetime.abort();
    closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([closeConnection(), server.close()]);
      await Promise.allSettled([...pending, opening]);
    });
    return closing;
  };
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  server.server.onclose = () => {
    void close().finally(finish);
  };
  const interrupt = () => {
    void close().finally(finish);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await server.connect(transport);
    await ended;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await close();
  }
}
