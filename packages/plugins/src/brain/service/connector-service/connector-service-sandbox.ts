// The per-MCP "run outside the sandbox (as you)" switch and the start diagnosis the
// detail panel reads. Turning it on needs the person's click in the native host dialog; nothing
// else (a Bot, YOLO, a remembered grant, the phone) reaches this path.
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectorDigest } from "@pibot/brain/kit";
import { aiConfigReadBoundary } from "@pibot/execution";
import type {
  Connector,
  ConnectorDiagnostics,
  ConnectorServer,
} from "@pibot/plugins-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import type { ConnectorServiceOperations } from "../connector-service.ts";

export const OUTSIDE_SANDBOX_ACK = "outside-sandbox-ack";

const platformOf = (ops: ConnectorServiceOperations) =>
  (ops.deps.platform ?? process.platform) as NodeJS.Platform;

/** Where the switch applies: user-imported stdio MCPs on macOS / Linux. */
export function outsideSandboxAvailability(
  ops: ConnectorServiceOperations,
  connector: Connector,
  server: ConnectorServer | undefined,
): ConnectorDiagnostics["outsideSandbox"] {
  if (server?.transport !== "stdio") return "unavailable";
  const platform = platformOf(ops);
  if (platform === "win32") return "windows";
  if (platform !== "darwin" && platform !== "linux") return "unavailable";
  // Built-in apps run fixed, trusted servers inside the sandbox with their own system grants.
  const installation = ops.deps.plugins.get(connector.pluginInstallationId);
  return installation && installation.sourceKind !== "builtin" ? "available" : "unavailable";
}

/** The receipt binds the confirmation to this connector, installation and exact configuration. */
export async function outsideSandboxConfirmed(
  ops: ConnectorServiceOperations,
  connector: Connector,
  server: ConnectorServer,
  signal?: AbortSignal,
): Promise<boolean> {
  const read = () => ops.deps.secrets.get(`connector:${connector.id}`, OUTSIDE_SANDBOX_ACK);
  const raw = await (signal ? retryReceiptStorage(read, signal) : read());
  if (!raw) return false;
  try {
    const accepted = JSON.parse(raw) as {
      connectorId?: unknown;
      installationId?: unknown;
      configurationDigest?: unknown;
    };
    return (
      accepted.connectorId === connector.id &&
      accepted.installationId === connector.pluginInstallationId &&
      accepted.configurationDigest === connectorDigest(server)
    );
  } catch {
    // A corrupt receipt cannot authorize running outside the sandbox.
    return false;
  }
}

/** The command or an argument lives in another AI tool's configuration folder. */
async function pointsIntoAiConfig(ops: ConnectorServiceOperations, server: ConnectorServer) {
  if (server.transport !== "stdio") return false;
  const home = ops.deps.home;
  // Roots hold each folder as written and canonical, so a path as the config wrote it matches.
  const { roots } = await aiConfigReadBoundary(platformOf(ops), [home], ops.deps.commandEnv);
  return [server.command, ...server.args].some((value) => {
    const path = value.startsWith("~/")
      ? join(home, value.slice(2))
      : isAbsolute(value)
        ? resolve(value)
        : undefined;
    if (!path) return false;
    return roots.some((root) => {
      const rest = relative(root, path);
      return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest));
    });
  });
}

export async function diagnosticsStep(
  this: ConnectorServiceOperations,
  { id }: { id: string },
): Promise<ConnectorDiagnostics> {
  const connector = this.deps.connectors.get(id);
  if (!connector) throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector not found");
  const stored = this.deps.connectors.configuration(id);
  const server = stored
    ? this.registry.effectiveServer(this.deps.plugins.get(connector.pluginInstallationId), stored)
    : undefined;
  const availability = outsideSandboxAvailability(this, connector, server);
  const lastFailure = this.startFailures.get(id) ?? null;
  let needsReconfirm = false;
  let receiptUnavailable = false;
  if (availability === "available" && connector.outsideSandbox && server) {
    try {
      needsReconfirm = !(await outsideSandboxConfirmed(this, connector, server));
    } catch (error) {
      if (!isReceiptStorageUnavailable(error)) throw error;
      receiptUnavailable = true;
    }
  }
  let suggestion: ConnectorDiagnostics["suggestion"] = null;
  if (availability === "available" && !connector.outsideSandbox && server) {
    if (await pointsIntoAiConfig(this, server).catch(() => false)) suggestion = "ai_config_path";
    else if (lastFailure && !lastFailure.outsideSandbox) suggestion = "sandbox_start_failed";
  }
  return {
    outsideSandbox: availability,
    needsReconfirm,
    ...(receiptUnavailable ? { receiptUnavailable: true as const } : {}),
    suggestion,
    lastFailure,
  };
}

export function isReceiptStorageUnavailable(error: unknown): error is RpcError {
  return error instanceof RpcError && error.code === RpcErrorCodes.secretsUnavailable;
}

async function retryReceiptStorage<T>(operation: () => Promise<T>, signal?: AbortSignal) {
  const waits = [600, 1200, 2400];
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const wait = waits[attempt];
      if (
        wait === undefined ||
        !isReceiptStorageUnavailable(error) ||
        (error.message !== "secure_storage_busy" && error.message !== "secure_storage_timeout")
      )
        throw error;
      await delay(wait, undefined, { signal });
    }
  }
}

export async function setOutsideSandboxStep(
  this: ConnectorServiceOperations,
  input: { id: string; expectedRevision: number; enabled: boolean },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const connector = this.deps.connectors.get(input.id);
  if (!connector) throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector not found");
  if (connector.revision !== input.expectedRevision)
    throw new RpcError(RpcErrorCodes.connectorStale, "Connector revision changed");
  const stored = this.deps.connectors.configuration(input.id);
  const server = stored
    ? this.registry.effectiveServer(this.deps.plugins.get(connector.pluginInstallationId), stored)
    : undefined;
  if (!server || outsideSandboxAvailability(this, connector, server) !== "available")
    throw new RpcError(RpcErrorCodes.unsupported, "outside_sandbox_unavailable");
  const scope = `connector:${connector.id}`;
  let updated: Connector;
  if (input.enabled) {
    if (server.transport !== "stdio") throw new RpcError(RpcErrorCodes.unsupported, "stdio_only");
    const receipt = await this.deps.confirmUnisolated?.(
      {
        connectorId: connector.id,
        installationId: connector.pluginInstallationId,
        revision: connector.revision,
        command: server.command,
        args: server.args,
        networkDomains: server.networkDomains,
        mode: "outside_sandbox",
      },
      signal,
    );
    signal?.throwIfAborted();
    if (!receipt)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "connector_confirmation_unavailable");
    if (!receipt.approved)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "outside_sandbox_cancelled");
    const acknowledgement = JSON.stringify({
      connectorId: connector.id,
      installationId: connector.pluginInstallationId,
      configurationDigest: connectorDigest(server),
      approvedRevision: connector.revision,
      approvedAt: new Date().toISOString(),
    });
    const commit = await retryReceiptStorage(
      () => this.deps.secrets.prepareSet(scope, OUTSIDE_SANDBOX_ACK, acknowledgement),
      signal,
    );
    signal?.throwIfAborted();
    // Revision CAS inside the same transaction: a change during the dialog voids the answer.
    updated = this.deps.connectors.setOutsideSandbox(
      { ...input, enabled: true },
      this.deps.actorBotId,
      commit,
    );
  } else {
    updated = this.deps.connectors.setOutsideSandbox(
      { ...input, enabled: false },
      this.deps.actorBotId,
      () => this.deps.secrets.remove(scope, OUTSIDE_SANDBOX_ACK),
    );
  }
  // The last failure described the other environment.
  this.startFailures.delete(connector.id);
  this.emitConnectorChanged(connector.id);
  if (!updated.enabled) return { connector: updated, operationId: null };
  // A running connection keeps its old process until restarted; restart so the choice applies now.
  const operation = this.deps.operations.request(
    { id: updated.id, expectedRevision: updated.revision, kind: "restart" },
    this.deps.actorBotId,
  );
  this.emitOperation(operation);
  this.spawn(() => this.runStart(operation), updated.id);
  return {
    connector: this.deps.connectors.get(updated.id) ?? updated,
    operationId: operation.id,
  };
}
