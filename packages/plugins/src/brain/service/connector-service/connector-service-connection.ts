import { join } from "node:path";
import { connectorDigest } from "@pibot/brain/kit";
import type { Connector } from "@pibot/plugins-contract/full";
import { connectorAuditEvents, RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import type { ConnectorsRepo } from "../../../store/index.ts";
import type { ConnectorPoolTarget } from "../../pool/pool.ts";
import { USER_SECRET_SCOPE } from "../connector-import.ts";
import { ConnectorOpenError, openConnectorConnection } from "../connector-runtime.ts";
import { connectorSecretUses } from "../connector-secrets.ts";
import type { ConnectorServiceOperations } from "../connector-service.ts";
import { classifyStartFailure, startFailureLog } from "../connector-start-failure.ts";
import {
  outsideSandboxAvailability,
  outsideSandboxConfirmed,
} from "./connector-service-sandbox.ts";

/** Kept for the detail panel (memory only) and logged as codes. */
function recordStartFailure(
  ops: ConnectorServiceOperations,
  connectorId: string,
  failure: import("@pibot/plugins-contract/full").ConnectorStartFailure,
) {
  ops.startFailures.set(connectorId, failure);
  ops.deps.logStartFailure?.(startFailureLog(connectorId, failure));
}

export async function confirmWindowsServerStep(
  this: ConnectorServiceOperations,
  connector: Connector,
  server: NonNullable<ReturnType<ConnectorsRepo["configuration"]>>,
  restart: boolean,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  server = this.registry.effectiveServer(
    this.deps.plugins.get(connector.pluginInstallationId),
    server,
  );
  if ((this.deps.platform ?? process.platform) !== "win32" || server.transport !== "stdio") return;
  const scope = `connector:${connector.id}`;
  const configurationDigest = connectorDigest(server);
  if (!restart) {
    const saved = await this.deps.secrets.get(scope, "windows-ack");
    if (saved) {
      try {
        const accepted = JSON.parse(saved) as {
          connectorId?: string;
          installationId?: string;
          configurationDigest?: string;
        };
        if (
          accepted.connectorId === connector.id &&
          accepted.installationId === connector.pluginInstallationId &&
          accepted.configurationDigest === configurationDigest
        )
          return;
      } catch {
        /* A corrupt receipt cannot authorize a command. */
      }
    }
  }
  const receipt = await this.deps.confirmUnisolated?.(
    {
      connectorId: connector.id,
      installationId: connector.pluginInstallationId,
      revision: connector.revision,
      command: server.command,
      args: server.args,
      networkDomains: server.networkDomains,
    },
    signal,
  );
  signal?.throwIfAborted();
  if (!receipt)
    throw new RpcError(RpcErrorCodes.connectorUnavailable, "connector_confirmation_unavailable");
  if (!receipt.approved)
    throw new RpcError(RpcErrorCodes.connectorUnavailable, "connector_confirmation_cancelled");
  const commit = await this.deps.secrets.prepareSet(
    scope,
    "windows-ack",
    JSON.stringify({
      connectorId: connector.id,
      installationId: connector.pluginInstallationId,
      configurationDigest,
      approvedRevision: connector.revision,
      approvedAt: new Date().toISOString(),
    }),
  );
  signal?.throwIfAborted();
  if (this.deps.connectors.get(connector.id)?.revision !== connector.revision)
    throw new RpcError(RpcErrorCodes.connectorStale, "Connector changed during confirmation");
  this.deps.audit.append({
    botId: this.deps.actorBotId,
    kind: "connector.changed",
    summary: connectorAuditEvents.windows,
    detail: { connectorId: connector.id, revision: connector.revision },
  });
  commit();
}

export function buildTargetStep(
  this: ConnectorServiceOperations,
  connector: Connector,
): ConnectorPoolTarget {
  const generation = (this.generations.get(connector.id) ?? 0) + 1;
  this.generations.set(connector.id, generation);
  const installation = this.deps.plugins.get(connector.pluginInstallationId);
  if (this.deps.plugins.isApplication(connector.pluginInstallationId)) {
    const platforms = this.deps.plugins.applicationPlatforms(connector.pluginInstallationId);
    if (platforms.length > 0 && !platforms.includes(this.deps.platform ?? process.platform))
      throw new ConnectorOpenError(
        "unsupported_platform",
        "Pi Bot application is not supported on this platform",
      );
  }
  const mcp = this.registry.fromInstallation(installation)?.mcp;
  const storedServer = this.deps.connectors.configuration(connector.id);
  const openTimeoutMs = storedServer.startupTimeoutSec
    ? storedServer.startupTimeoutSec * 1000
    : mcp?.openTimeoutMs;
  return {
    connectorId: connector.id,
    generation,
    // A native extension owns its prompt budget; the pool must outlive that first OS grant.
    ...(openTimeoutMs ? { openTimeoutMs } : {}),
    open: async (signal) => {
      const row = this.deps.connectors.get(connector.id);
      if (!row) throw new ConnectorOpenError("not_found", "Connector removed");
      const storedServer = this.deps.connectors.configuration(connector.id);
      if (!storedServer) throw new ConnectorOpenError("not_found", "Connector config missing");
      const installation = this.deps.plugins.get(row.pluginInstallationId);
      const mcp = this.registry.fromInstallation(installation)?.mcp;
      const server = this.registry.effectiveServer(installation, storedServer);
      const importedRoots =
        installation?.sourceKind === "directory" && this.deps.dataDir
          ? {
              install: join(this.deps.dataDir, "plugins", installation.id),
              data: join(this.deps.dataDir, "plugin-data", installation.id),
            }
          : undefined;
      if ((this.deps.platform ?? process.platform) === "win32" && server.transport === "stdio") {
        const rawReceipt = await this.deps.secrets.get(`connector:${row.id}`, "windows-ack");
        let acknowledged = false;
        try {
          const accepted = rawReceipt ? JSON.parse(rawReceipt) : undefined;
          acknowledged =
            accepted?.connectorId === row.id &&
            accepted?.installationId === row.pluginInstallationId &&
            accepted?.configurationDigest === connectorDigest(server);
        } catch {
          /* Invalid acknowledgements never admit unisolated commands. */
        }
        if (!acknowledged)
          throw new ConnectorOpenError(
            "isolation_unavailable",
            "Windows command confirmation required",
          );
      }
      // Outside the sandbox only with a receipt for this exact configuration; a stale
      // one never falls back to either environment silently.
      const outsideSandbox =
        row.outsideSandbox &&
        outsideSandboxAvailability(this, row, server) === "available" &&
        server.transport === "stdio";
      if (outsideSandbox && !(await outsideSandboxConfirmed(this, row, server, signal))) {
        recordStartFailure(
          this,
          row.id,
          classifyStartFailure({
            phase: "start",
            timedOut: false,
            outsideSandbox: true,
            reconfirm: true,
            redact: (value) => value,
          }),
        );
        throw new ConnectorOpenError(
          "isolation_unavailable",
          "Outside-sandbox confirmation required",
        );
      }
      const bindings = connectorSecretUses(server, row.pluginInstallationId, this.deps.userSecrets);
      const allowedSecretNames = new Set(server.auth.secretNames);
      const connection = await openConnectorConnection(
        {
          connector: row,
          outsideSandbox,
          ...(this.deps.displayRedact ? { displayRedact: this.deps.displayRedact } : {}),
          reportStartFailure: (failure) => recordStartFailure(this, row.id, failure),
          logStderr: this.deps.logStderr,
          server,
          factory: this.deps.factory,
          pluginSecretRequest: this.pluginSecretHandlers(row.pluginInstallationId, () => {
            signal.throwIfAborted();
            if (
              !this.deps.connectors.get(row.id)?.enabled ||
              this.targets.get(row.id)?.generation !== generation
            )
              throw new Error("plugin_connection_changed");
          }),
          openExternal: this.deps.openExternal,
          enabledPluginTools: () => {
            const current = this.deps.connectors.get(row.id);
            return [
              "list_labels",
              "search_messages",
              "read_message",
              "read_thread",
              "create_draft",
              "send_message",
              "modify_labels",
            ].filter(
              (name) =>
                current && this.deps.connectors.tool(row.id, current.catalogVersion, name)?.enabled,
            );
          },
          resolveSecret: (name) => {
            if (!allowedSecretNames.has(name))
              throw new ConnectorOpenError(
                "secret_required",
                "Secret reference was not approved at installation",
              );
            return this.readConnectionSecret(name, signal);
          },
          commandEnv: this.deps.commandEnv,
          ...(this.deps.pathEntries ? { pathEntries: this.deps.pathEntries() } : {}),
          home: this.deps.home,
          dataDir: this.deps.dataDir,
          ...(importedRoots ? { importedRoots } : {}),
          tempDir: this.deps.tempDir,
          platform: (this.deps.platform ?? process.platform) as NodeJS.Platform,
          ...(mcp?.trustedStdio ? { trustedStdio: mcp.trustedStdio } : {}),
          ...(server.auth.kind === "oauth"
            ? {
                oauth: this.apps.oauthStorage(row.id, () => {
                  signal.throwIfAborted();
                  const latest = this.deps.connectors.get(row.id);
                  if (!latest?.enabled || this.targets.get(row.id)?.generation !== generation)
                    throw new ConnectorOpenError("revision_changed", "Authorization changed");
                }),
              }
            : {}),
        },
        signal,
      );
      try {
        const current = connectorSecretUses(
          server,
          row.pluginInstallationId,
          this.deps.userSecrets,
        );
        if (signal.aborted || connectorDigest(bindings) !== connectorDigest(current))
          throw new ConnectorOpenError("secret_required", "Secret changed while opening");
        this.secretBindings.set(row.id, bindings);
        this.startFailures.delete(row.id);
        return connection;
      } catch (error) {
        // Ownership has not transferred to the pool yet, including if revalidation throws.
        await connection.close();
        throw error;
      }
    },
  };
}

/** Installation credentials stay owned by connectors; user-assigned names belong to the port. */
export function readConnectionSecretStep(
  this: ConnectorServiceOperations,
  name: string,
  signal: AbortSignal,
) {
  if (name.startsWith("IMPORT_")) return this.deps.secrets.get(USER_SECRET_SCOPE, name);
  if (!this.deps.userSecrets)
    throw new ConnectorOpenError("secret_required", "User secret unavailable");
  return this.deps.userSecrets.read(name, signal);
}

/** Catalog changes reported by the server are re-discovered on the same generation. */
export function subscribeToolChangesStep(
  this: ConnectorServiceOperations,
  connectorId: string,
  connection: Awaited<ReturnType<ConnectorPoolTarget["open"]>>,
): void {
  this.toolChangeUnsubs.get(connectorId)?.();
  const unsubscribe = connection.onToolsChanged(() => {
    // On this connector's lane: snapshots of different connectors stay independent.
    this.spawn(async () => {
      const connector = this.deps.connectors.get(connectorId);
      if (!connector?.enabled) return;
      try {
        const tools = await this.deps.pool.run(
          this.targets.get(connectorId) ?? {
            connectorId,
            generation: this.generations.get(connectorId) ?? 1,
            open: () => Promise.reject(new Error("Connector target missing")),
          },
          (open, signal) => this.discoverTools(connectorId, open, signal),
          new AbortController().signal,
        );
        const published = this.deps.catalog.publish({
          connectorId,
          expectedRevision: connector.revision,
          tools,
          actorBotId: this.deps.actorBotId,
        });
        this.applyBuiltinDefaults(connectorId, tools);
        this.emitConnectorChanged(connectorId);
        this.emitToolsChanged(this.deps.connectors.get(connectorId) ?? published);
      } catch {
        // A late snapshot after disable must not resurrect the catalog; the
        // next explicit restart re-discovers.
      }
    }, connectorId);
  });
  this.toolChangeUnsubs.set(connectorId, unsubscribe);
}
