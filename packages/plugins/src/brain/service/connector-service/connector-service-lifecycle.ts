// Brain-side connector orchestration: the 13 registered RPCs, lifecycle
// operations, the connection pool and tool catalog publishing live here. The
// pool borrows connections; dispatch permissions are enforced per call and
// never inherited from a plugin manifest.

import { ConnectorToolError } from "@pibot/brain/kit";
import type { ConnectorOperation } from "@pibot/plugins-contract/full";
import {
  ConnectorAuthenticationError,
  ConnectorNativeError,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import type { ConnectorCatalogRepo } from "../../../store/index.ts";
import type { ConnectorPoolTarget } from "../../pool/pool.ts";
import { importSecretPrefix, USER_SECRET_SCOPE } from "../connector-import.ts";
import { ConnectorOpenError } from "../connector-runtime.ts";
import type { ConnectorServiceOperations } from "../connector-service.ts";
import { OUTSIDE_SANDBOX_ACK } from "./connector-service-sandbox.ts";
import { MAX_DISCOVERY_PAGES, remotePageSchema } from "./connector-service-shared.ts";

const cleanupRetryDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Open, discover and publish; failures land on the operation with a stable code. */
export async function runStartStep(
  this: ConnectorServiceOperations,
  operation: ConnectorOperation,
): Promise<void> {
  const connectorId = operation.connectorId;
  if (!connectorId) return;
  // Registered synchronously: a superseding stop aborts this generation before the open settles.
  const controller = new AbortController();
  this.lifecycles.set(connectorId, controller);
  let currentRevision = operation.revision;
  try {
    if (controller.signal.aborted)
      throw new RpcError(RpcErrorCodes.connectorStale, "Start superseded by a stop");
    const connector = this.deps.connectors.get(connectorId);
    if (!connector) throw new ConnectorOpenError("not_found", "Connector removed");
    const progressed = this.deps.operations.progress(
      operation.id,
      operation.revision,
      "connecting",
    );
    currentRevision = progressed.revision;
    // Any live generation is drained first: the request() revision bump and a
    // fresh generation below are what make the new open admissible. A failed
    // drain must stop the restart; the old generation still owns the pool.
    await this.deps.pool.stop(connectorId);
    const target = this.buildTarget(connector);
    this.targets.set(connectorId, target);
    await this.deps.pool.run(
      target,
      async (connection, signal) => {
        const tools = await this.discoverTools(connectorId, connection, signal);
        this.deps.catalog.publish({
          connectorId,
          expectedRevision: connector.revision,
          operation: { id: progressed.id, expectedRevision: progressed.revision },
          tools,
          actorBotId: this.deps.actorBotId,
        });
        this.applyBuiltinDefaults(connectorId, tools);
        this.subscribeToolChanges(connectorId, connection);
      },
      controller.signal,
    );
    this.emitConnectorChanged(connectorId);
    const fresh = this.deps.connectors.get(connectorId);
    if (fresh) this.emitToolsChanged(fresh);
  } catch (error) {
    this.recordStartFailure(operation, error, currentRevision);
  } finally {
    if (this.lifecycles.get(connectorId) === controller) this.lifecycles.delete(connectorId);
  }
}

export async function discoverToolsStep(
  this: ConnectorServiceOperations,
  connection: Awaited<ReturnType<ConnectorPoolTarget["open"]>>,
  signal: AbortSignal,
) {
  type PublishTool = Parameters<ConnectorCatalogRepo["publish"]>[0]["tools"][number];
  const tools: PublishTool[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let bytes = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    signal.throwIfAborted();
    const result = remotePageSchema.parse(await connection.listTools({ cursor, signal }));
    signal.throwIfAborted();
    for (const tool of result.tools) {
      const stack: { value: unknown; depth: number }[] = [{ value: tool.inputSchema, depth: 0 }];
      let schemaNodes = 0;
      while (stack.length) {
        const node = stack.pop();
        if (!node || ++schemaNodes > 2000 || node.depth > 24)
          throw new ConnectorToolError("connector_schema_unsupported");
        if (node.value && typeof node.value === "object")
          for (const value of Object.values(node.value))
            stack.push({ value, depth: node.depth + 1 });
      }
      bytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
      if (bytes > 8 * 1024 * 1024 || names.has(tool.name))
        throw new ConnectorToolError("connector_catalog_changed");
      names.add(tool.name);
      tools.push({
        tool: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description ?? "",
        schema: tool.inputSchema,
        suggestedReadOnly: tool.readOnlyHint === true,
        ...(tool.readOnlyHint === undefined ? {} : { readOnlyHint: tool.readOnlyHint }),
        ...(tool.idempotentHint === undefined ? {} : { idempotentHint: tool.idempotentHint }),
        ...(tool.destructiveHint === undefined ? {} : { destructiveHint: tool.destructiveHint }),
      });
    }
    if (!result.nextCursor) return tools;
    if (cursors.has(result.nextCursor)) throw new ConnectorToolError("connector_catalog_changed");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  // Never publish or authorize against an incomplete catalog.
  throw new ConnectorToolError("connector_catalog_changed");
}

export async function runStopStep(
  this: ConnectorServiceOperations,
  operation: ConnectorOperation,
): Promise<void> {
  const connectorId = operation.connectorId;
  if (!connectorId) return;
  let currentRevision = operation.revision;
  try {
    const progressed = this.deps.operations.progress(operation.id, operation.revision, "draining");
    currentRevision = progressed.revision;
    await this.apps.cancelAndDrain(connectorId);
    await this.deps.pool.stop(connectorId);
    const stoppingConnector = this.deps.connectors.get(connectorId);
    if (operation.kind === "disconnect" && stoppingConnector)
      this.apps.removeCredentials(stoppingConnector);
    this.deps.operations.finishStopped(progressed.id, progressed.revision, this.deps.actorBotId);
    this.targets.delete(connectorId);
    this.toolChangeUnsubs.get(connectorId)?.();
    this.toolChangeUnsubs.delete(connectorId);
    this.emitConnectorChanged(connectorId);
  } catch (error) {
    if (this.isSuperseded(error)) return;
    // A failed drain keeps pool ownership; report and leave it retryable.
    this.emitOperation(
      this.deps.operations.fail(
        operation.id,
        currentRevision,
        "connection_failed",
        this.deps.actorBotId,
      ),
    );
    this.emitConnectorChanged(connectorId);
  }
}

export async function runUninstallStep(
  this: ConnectorServiceOperations,
  installationId: string,
  initialOperation: ConnectorOperation,
): Promise<void> {
  let operation = initialOperation;
  let cleanupStarted = false;
  try {
    if (operation.failureCode === "cleanup_incomplete") {
      operation = this.deps.operations.resumeCleanup(
        operation.id,
        operation.revision,
        this.deps.actorBotId,
      );
      this.emitOperation(operation);
      for (const connector of this.deps.plugins.connections(installationId))
        this.emitConnectorChanged(connector.id, connector);
    }
    const connectors = this.deps.plugins.connections(installationId);
    for (const connector of connectors) this.apps.cancelConnector(connector.id);
    const results = await Promise.allSettled(
      connectors.map(async (connector) => {
        await this.apps.cancelAndDrain(connector.id);
        await this.deps.pool.stop(connector.id);
      }),
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      // Ownership stays with this operation: a retry must drain the same
      // resources, and uninstall is only claimed once every server is gone.
      this.emitOperation(
        this.deps.operations.fail(
          operation.id,
          operation.revision,
          "connection_failed",
          this.deps.actorBotId,
        ),
      );
      for (const connector of this.deps.plugins.connections(installationId))
        this.emitConnectorChanged(connector.id, connector);
      return;
    }
    this.deps.operations.current(operation.id, operation.revision);
    cleanupStarted = true;
    const installation = this.deps.plugins.get(installationId);
    const secretPrefix = importSecretPrefix(installationId);
    // Every step is idempotent and stays before finishStopped. A crash leaves this operation active,
    // so startup recovery repeats cleanup instead of accepting private residue as a completed uninstall.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.deps.operations.current(operation.id, operation.revision);
        if (installation?.sourceKind === "directory" && !this.deps.importHost)
          throw new RpcError(RpcErrorCodes.connectorUnavailable, "Import cleanup unavailable");
        for (const connector of connectors) {
          this.apps.removeCredentials(connector);
          // The run-as-me receipt is a setting, kept across disconnect, gone with the MCP.
          this.deps.secrets.remove(`connector:${connector.id}`, OUTSIDE_SANDBOX_ACK);
          this.startFailures.delete(connector.id);
        }
        this.deps.secrets.remove(`plugin-runtime:${installationId}`, "values");
        this.deps.secrets.removePrefix(USER_SECRET_SCOPE, secretPrefix);
        this.deps.plugins.removeImportSettings(installationId);
        await this.deps.importHost?.remove({ installationId });
        await this.deps.pluginSkills.remove(installationId);
        break;
      } catch (error) {
        if (this.isSuperseded(error) || attempt === 3) throw error;
        this.deps.onCleanupRetry?.(installationId, attempt);
        await cleanupRetryDelay(attempt === 1 ? 100 : 300);
      }
    }
    this.deps.operations.current(operation.id, operation.revision);
    this.deps.operations.finishStopped(operation.id, operation.revision, this.deps.actorBotId);
    for (const connector of connectors) {
      this.apps.cancelConnector(connector.id);
      this.targets.delete(connector.id);
      this.toolChangeUnsubs.get(connector.id)?.();
      this.toolChangeUnsubs.delete(connector.id);
    }
    this.emitPluginsChanged(installationId, "removed");
  } catch (error) {
    if (this.isSuperseded(error)) return;
    // Do not turn a partially cleaned uninstall into a finished error. Keeping the intent active
    // makes startup recovery repeat every idempotent private cleanup step before it may finish.
    if (cleanupStarted) {
      this.deps.onCleanupRetry?.(installationId, 3);
      const incomplete = this.deps.operations.cleanupIncomplete(
        operation.id,
        operation.revision,
        this.deps.actorBotId,
      );
      this.emitOperation(incomplete);
      for (const connector of this.deps.plugins.connections(installationId))
        this.emitConnectorChanged(connector.id, connector);
      return;
    }
    this.emitOperation(
      this.deps.operations.fail(
        operation.id,
        operation.revision,
        "connection_failed",
        this.deps.actorBotId,
      ),
    );
    for (const connector of this.deps.plugins.connections(installationId))
      this.emitConnectorChanged(connector.id, connector);
  }
}

export function recordStartFailureStep(
  this: ConnectorServiceOperations,
  operation: ConnectorOperation,
  error: unknown,
  currentRevision: number,
): void {
  if (this.isSuperseded(error)) return;
  if (error instanceof ConnectorNativeError && error.nativeDiagnostics && operation.connectorId)
    this.deps.logNativeState?.({
      connectorId: operation.connectorId,
      errorCode: error.failureCode,
      ...error.nativeDiagnostics,
    });
  const failureCode: ConnectorOperation["failureCode"] =
    error instanceof ConnectorAuthenticationError
      ? "auth_required"
      : error instanceof ConnectorNativeError
        ? error.failureCode === "permission_required"
          ? "auth_required"
          : error.failureCode
        : error instanceof ConnectorOpenError && error.failureCode !== "not_found"
          ? error.failureCode
          : error instanceof Error &&
              (error.message === "unsupported_platform" || error.message === "dependency_missing")
            ? error.message
            : error instanceof DOMException && error.name === "TimeoutError"
              ? "timeout"
              : "connection_failed";
  this.emitOperation(
    this.deps.operations.fail(operation.id, currentRevision, failureCode, this.deps.actorBotId),
  );
  if (operation.connectorId) this.emitConnectorChanged(operation.connectorId);
  if (failureCode === "auth_required" && operation.connectorId)
    this.deps.onNeedsAuth?.(operation.connectorId);
}

export async function markNeedsAuthStep(this: ConnectorServiceOperations, connectorId: string) {
  const connector = this.deps.connectors.get(connectorId);
  if (!connector?.enabled) return;
  const operation = this.deps.operations.request(
    { id: connectorId, expectedRevision: connector.revision, kind: "restart" },
    this.deps.actorBotId,
  );
  this.targets.delete(connectorId);
  await this.deps.pool.stop(connectorId);
  this.emitOperation(
    this.deps.operations.fail(
      operation.id,
      operation.revision,
      "auth_required",
      this.deps.actorBotId,
    ),
  );
  this.emitConnectorChanged(connectorId);
  this.deps.onNeedsAuth?.(connectorId);
}
