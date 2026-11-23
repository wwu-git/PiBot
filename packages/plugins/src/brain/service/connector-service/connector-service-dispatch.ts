// Brain-side connector orchestration: the 13 registered RPCs, lifecycle
// operations, the connection pool and tool catalog publishing live here. The
// pool borrows connections; dispatch permissions are enforced per call and
// never inherited from a plugin manifest.

import {
  type ConnectorCallInput,
  type ConnectorDiscoverInput,
  ConnectorToolError,
  connectorDigest,
  type PreparedConnector,
  type SecretUse,
  validateConnectorArgs,
} from "@pibot/brain/kit";
import {
  accessAllows,
  ConnectorAuthenticationError,
  ConnectorCallError,
  connectorNativeDiagnostics,
  connectorResultCount,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { connectionConfirmation } from "@pibot/policy";
import type { z } from "zod";
import { connectionAvailability } from "../connection-availability.ts";
import { connectorSecretUses } from "../connector-secrets.ts";
import type { ConnectorServiceOperations } from "../connector-service.ts";
import { discoveryCursor } from "./connector-service-shared.ts";

/** Metadata only: never opens a transport or imports plugin code. */
export function discoverToolsForBotStep(
  this: ConnectorServiceOperations,
  botId: string,
  input: ConnectorDiscoverInput,
  readOnly = false,
  groupId?: string,
) {
  let cursor: z.output<typeof discoveryCursor> | undefined;
  if (input.cursor) {
    try {
      cursor = discoveryCursor.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new ConnectorToolError("connector_cursor_invalid");
    }
  }
  const page = this.deps.connectors.discover(botId, groupId, {
    ...input,
    after: cursor?.after,
    readOnly,
  });
  const snapshot = connectorDigest([
    botId,
    groupId,
    input.connectorId,
    input.query,
    readOnly,
    page.versions,
  ]);
  if (cursor && cursor.snapshot !== snapshot)
    throw new ConnectorToolError("connector_catalog_changed");
  const items = page.items.flatMap((tool) => {
    const connector = this.deps.connectors.get(tool.connectorId);
    const plugin = connector && this.deps.plugins.get(connector.pluginInstallationId);
    const trustedRead =
      plugin?.sourceKind !== "builtin" ||
      this.registry.toolPolicy(plugin.pluginId, tool.tool).readOnly;
    const effective = trustedRead || !tool.readOnly ? tool : { ...tool, readOnly: false };
    return connector &&
      connectionConfirmation(connector.confirmationMode, !effective.readOnly) === "blocked"
      ? []
      : [effective];
  });
  return {
    items,
    nextCursor:
      page.after === undefined
        ? null
        : Buffer.from(JSON.stringify({ snapshot, after: page.after })).toString("base64url"),
  };
}

/** Trusted target resolution precedes policy. A plugin hint is never a read grant. */
export function resolveToolStep(
  this: ConnectorServiceOperations,
  botId: string,
  input: ConnectorCallInput,
  groupId?: string,
): PreparedConnector {
  const availability = connectionAvailability(
    { ...this.deps, registry: this.registry, platform: this.deps.platform ?? process.platform },
    groupId ? { kind: "group", id: groupId } : { kind: "bot", id: botId },
    input.connectorId,
    input.tool,
  );
  if (availability.reason !== "available")
    throw new ConnectorToolError(
      availability.reason === "tool_disabled" || availability.reason === "read_only_mode"
        ? "connector_tool_denied"
        : "connector_unavailable",
    );
  const connector = this.deps.connectors.get(input.connectorId);
  const plugin = connector ? this.deps.plugins.get(connector.pluginInstallationId) : undefined;
  if (
    !connector ||
    !plugin?.enabled ||
    plugin.status !== "installed" ||
    !connector.enabled ||
    !["ready", "idle"].includes(connector.status) ||
    !["mcp_remote", "mcp_stdio", "builtin", "rest"].includes(connector.kind)
  )
    throw new ConnectorToolError("connector_unavailable");
  const server = this.deps.connectors.configuration(connector.id);
  if (!server) throw new ConnectorToolError("connector_unavailable");
  let secretUses: SecretUse[];
  try {
    secretUses = connectorSecretUses(
      server,
      connector.pluginInstallationId,
      this.deps.userSecrets,
      botId,
    );
  } catch {
    throw new ConnectorToolError("connector_secret_denied");
  }
  if (
    this.secretBindings.has(connector.id) &&
    connectorDigest(secretUses) !== connectorDigest(this.secretBindings.get(connector.id))
  )
    throw new ConnectorToolError("connector_secret_denied");
  const access = this.deps.connectors.access(connector.id);
  if (!accessAllows(access, botId, groupId)) throw new ConnectorToolError("connector_unavailable");
  if (connector.catalogVersion !== input.catalogVersion)
    throw new ConnectorToolError("connector_catalog_changed");
  const persistedTool = this.deps.connectors.tool(
    connector.id,
    connector.catalogVersion,
    input.tool,
  );
  if (!persistedTool?.enabled) throw new ConnectorToolError("connector_tool_denied");
  // Runtime authorization uses the persisted user policy. Trusted builtin metadata may only add
  // the draft target and argument validator; it cannot silently restore a manifest default.
  const tool =
    plugin.sourceKind === "builtin"
      ? {
          ...persistedTool,
          readOnly:
            persistedTool.readOnly &&
            this.registry.toolPolicy(plugin.pluginId, persistedTool.tool).readOnly,
          draftBinding: this.registry.toolPolicy(
            plugin.pluginId,
            persistedTool.tool,
            persistedTool.schema,
            input.args,
          ).draftBinding,
        }
      : persistedTool;
  // Dispatch repeats the policy's read-only decision; nothing between them may reopen a write.
  if (connectionConfirmation(connector.confirmationMode, !tool.readOnly) === "blocked")
    throw new ConnectorToolError("connector_tool_denied");
  if (plugin.sourceKind === "builtin" && this.deps.factory.validateArguments) {
    const validation = this.deps.factory.validateArguments(tool.schema, input.args);
    if (validation !== "valid")
      throw new ConnectorToolError(
        validation === "invalid" ? "connector_args_invalid" : "connector_schema_unsupported",
      );
  } else validateConnectorArgs(tool.schema, input.args);
  return {
    ...(groupId ? { groupId } : {}),
    secretUses,
    pluginRevision: plugin.revision,
    pluginDigest: plugin.digest,
    connector,
    access,
    tool,
    argsDigest: connectorDigest(input.args),
  };
}

export async function dispatchDraftStep(
  this: ConnectorServiceOperations,
  approvalId: string,
  botId: string,
  input: ConnectorCallInput,
  approved: PreparedConnector,
  signal: AbortSignal,
  authorize: () => void,
): Promise<unknown> {
  const draft = this.deps.drafts?.get(approvalId);
  if (
    draft?.view.status !== "sending" ||
    draft.view.botId !== botId ||
    draft.view.draft.connectorId !== input.connectorId ||
    draft.view.draft.tool !== input.tool ||
    draft.view.draft.catalogVersion !== input.catalogVersion
  )
    throw new RpcError(RpcErrorCodes.draftDenied, "draft_dispatch_denied");
  const args =
    draft.payload.contentField === null
      ? draft.payload.args
      : { ...draft.payload.args, [draft.payload.contentField]: draft.payload.content };
  if (connectorDigest(args) !== connectorDigest(input.args) || approved.tool.readOnly)
    throw new RpcError(RpcErrorCodes.draftChanged, "draft_arguments_changed");
  this.deps.drafts?.beginDispatch(approvalId);
  // The journal key of the tool call that made the draft (else the draft's own id, which is
  // equally sent at most once) travels as request `_meta`.
  const key = draft.payload.origin?.idempotencyKey ?? approvalId;
  return this.dispatchChecked(botId, input, approved, signal, authorize, true, key);
}

export async function dispatchStep(
  this: ConnectorServiceOperations,
  botId: string,
  input: ConnectorCallInput,
  approved: PreparedConnector,
  signal: AbortSignal,
  authorize: () => void,
): Promise<unknown> {
  if (!approved.tool.readOnly) throw new ConnectorToolError("connector_tool_denied");
  return this.dispatchChecked(botId, input, approved, signal, authorize, false);
}

export async function dispatchCheckedStep(
  this: ConnectorServiceOperations,
  botId: string,
  input: ConnectorCallInput,
  approved: PreparedConnector,
  signal: AbortSignal,
  authorize: () => void,
  draft: boolean,
  idempotencyKey?: string,
): Promise<unknown> {
  const verify = () => {
    signal.throwIfAborted();
    authorize();
    const current = this.resolveTool(botId, input, approved.groupId);
    if (connectorDigest(current) !== connectorDigest(approved))
      throw new ConnectorToolError("connector_catalog_changed");
  };
  verify();
  // A target exists only after a successful user-enabled lifecycle. Do not turn
  // arbitrary model calls into a new server-start authorization path.
  if (draft && !this.targets.has(input.connectorId))
    this.targets.set(input.connectorId, this.buildTarget(approved.connector));
  const target = this.targets.get(input.connectorId);
  if (!target) throw new ConnectorToolError("connector_unavailable");
  const started = performance.now();
  const report = (ok: boolean, errorCode: string | null, count: number | null, value?: unknown) =>
    this.deps.logCallResult?.({
      botId,
      connectorId: approved.connector.id,
      tool: approved.tool.tool,
      ok,
      errorCode,
      count,
      status: connectorNativeDiagnostics(value)?.status ?? null,
      containerCount: connectorNativeDiagnostics(value)?.containerCount ?? null,
      durationMs: Math.round(performance.now() - started),
    });
  let dispatched = false;
  let dispatchSignal: AbortSignal | undefined;
  try {
    const value = await this.deps.pool.run(
      target,
      async (connection, pooledSignal) => {
        verify();
        this.subscribeToolChanges(input.connectorId, connection);
        // Reconnects can change tools without a notification. Publish only after
        // revalidation, but reject this old permit even if the called tool stayed unchanged.
        const live = await this.discoverTools(input.connectorId, connection, pooledSignal);
        pooledSignal.throwIfAborted();
        verify();
        if (this.targets.get(input.connectorId) !== target)
          throw new ConnectorToolError("connector_catalog_changed");
        if (
          !this.deps.catalog.matches(input.connectorId, approved.connector.catalogVersion, live)
        ) {
          const published = this.deps.catalog.publish({
            connectorId: input.connectorId,
            expectedRevision: approved.connector.revision,
            tools: live,
            actorBotId: this.deps.actorBotId,
          });
          this.applyBuiltinDefaults(input.connectorId, live);
          this.emitConnectorChanged(input.connectorId);
          this.emitToolsChanged(this.deps.connectors.get(input.connectorId) ?? published);
          throw new ConnectorToolError("connector_catalog_changed");
        }
        dispatched = true;
        dispatchSignal = pooledSignal;
        const result = await connection.callTool({
          tool: input.tool,
          args: input.args,
          signal: pooledSignal,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        pooledSignal.throwIfAborted();
        // A successful acknowledgement remains a fact even if access or the catalog changed
        // during the remote call. Every subsequent operation obtains a fresh permit.
        return result;
      },
      signal,
    );
    report(true, null, connectorResultCount(value), value);
    return value;
  } catch (error) {
    report(
      false,
      error instanceof ConnectorCallError
        ? (error.reason ??
            (error.outcome === "unknown" ? "outcome_unknown" : "connector_tool_failed"))
        : error instanceof ConnectorToolError
          ? error.code
          : signal.aborted
            ? "cancelled"
            : "connector_call_failed",
      null,
      error,
    );
    if (dispatched && dispatchSignal?.aborted) throw new ConnectorCallError("unknown");
    if (error instanceof ConnectorCallError) throw error;
    if (error instanceof ConnectorAuthenticationError) {
      try {
        await this.markNeedsAuth(input.connectorId);
      } catch (transitionError) {
        if (dispatched) throw new ConnectorCallError("unknown");
        throw transitionError;
      }
      if (dispatched) throw new ConnectorCallError("unknown");
      throw new ConnectorToolError("connector_auth_required");
    }
    // Cancellation or loss of a response cannot prove that the remote write had no effect.
    if (dispatched) throw new ConnectorCallError("unknown");
    signal.throwIfAborted();
    if (
      error instanceof ConnectorToolError ||
      (error instanceof RpcError &&
        error.code <= RpcErrorCodes.draftUnavailable &&
        error.code >= RpcErrorCodes.draftExecutionFailed)
    )
      throw error;
    // Never forward arbitrary transport messages (which can contain URLs/credentials).
    throw new ConnectorToolError("connector_call_failed");
  }
}
