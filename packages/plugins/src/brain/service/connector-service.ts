import { finalizeConnectorPreview } from "./connector-import.ts";
import {
  buildTargetStep,
  confirmWindowsServerStep,
  readConnectionSecretStep,
  subscribeToolChangesStep,
} from "./connector-service/connector-service-connection.ts";
import {
  discoverToolsForBotStep,
  dispatchCheckedStep,
  dispatchDraftStep,
  dispatchStep,
  resolveToolStep,
} from "./connector-service/connector-service-dispatch.ts";
import {
  discoverToolsStep,
  markNeedsAuthStep,
  recordStartFailureStep,
  runStartStep,
  runStopStep,
  runUninstallStep,
} from "./connector-service/connector-service-lifecycle.ts";
import {
  cancelPreviewStep,
  importStep,
  pickImportStep,
  previewImportStep,
  uninstallStep,
} from "./connector-service/connector-service-plugins.ts";
import {
  diagnosticsStep,
  setOutsideSandboxStep,
} from "./connector-service/connector-service-sandbox.ts";
import type { ConnectorServiceDeps } from "./connector-service/connector-service-shared.ts";

export type { ConnectorServiceDeps } from "./connector-service/connector-service-shared.ts";
export { registerConnectorRpc } from "./connector-service/connector-service-shared.ts";
export type ConnectorServiceOperations = ReturnType<ConnectorService["operationContext"]>;

// Brain-side connector orchestration: the 13 registered RPCs, lifecycle
// operations, the connection pool and tool catalog publishing live here. The
// pool borrows connections; dispatch permissions are enforced per call and
// never inherited from a plugin manifest.

import { createHash, randomUUID } from "node:crypto";
import {
  type ConnectorCallInput,
  type ConnectorDiscoverInput,
  ConnectorToolError,
  connectorDigest,
  type PreparedConnector,
  type SecretUse,
} from "@pibot/brain/kit";
import type {
  CapabilityId,
  Connector,
  ConnectorManifest,
  ConnectorOperation,
  ConnectorStartFailure,
} from "@pibot/plugins-contract/full";
import { type ConnectorUpdateSchema, RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import type { z } from "zod";
import type { ConnectorsRepo } from "../../store/index.ts";
import { PluginRegistry } from "../apps/registry.ts";
import { mapConnectorCapabilities } from "../capability-mappings/index.ts";
import { sourceLayouts } from "../discovery/locations.ts";
import { broughtOverId, entryDescription, entryManifest } from "../discovery/mcp.ts";
import { readMcpFile } from "../discovery/scan.ts";
import type { ConnectorPoolTarget } from "../pool/pool.ts";
import { connectionAvailability } from "./connection-availability.ts";
import { ConnectorAppService } from "./connector-app-service.ts";
import { ConnectorPreviewStore } from "./connector-import.ts";
import { sourceUpdate } from "./connector-source-update.ts";
import { createPluginSecrets } from "./plugin-secrets.ts";

export class ConnectorService {
  readonly pluginSecretHandlers: ReturnType<typeof createPluginSecrets>;
  readonly apps: ConnectorAppService;
  readonly registry: PluginRegistry;
  private readonly secretBindings = new Map<string, SecretUse[]>();
  private readonly previews = new ConnectorPreviewStore();
  private readonly selectionPreviews = new Map<
    string,
    {
      selectionId: string;
      sourceDigest: string;
      sourceKind: "json" | "plugin";
      fileChanges?: import("@pibot/plugins-contract/full").ConnectorImportFileChanges;
      expiresAt: string;
    }
  >();
  /** Current pool targets; rebuilt on every enable/restart, kept across idle drains. */
  private readonly targets = new Map<string, ConnectorPoolTarget>();
  /** Monotonic per connector; every open attempt gets a fresh generation. */
  private readonly generations = new Map<string, number>();
  private readonly toolChangeUnsubs = new Map<string, () => void>();
  /** Start-kind operations serialize per connector; independent instances never block each other. */
  private readonly startChains = new Map<string, Promise<void>>();
  /** Every queued or running lifecycle job, chained or prompt; keeps `chain` and dispose truthful. */
  private readonly jobs = new Set<Promise<void>>();
  /** In-flight start generation per connector; a superseding stop aborts it promptly. */
  private readonly lifecycles = new Map<string, AbortController>();
  /** Last stdio start failure per connector, memory only (it holds a stderr tail). */
  private readonly startFailures = new Map<string, ConnectorStartFailure>();

  constructor(private readonly deps: ConnectorServiceDeps) {
    this.pluginSecretHandlers = createPluginSecrets(deps.secrets, deps.registerSecret);
    this.registry = new PluginRegistry(deps.pluginDefinitions);
    this.apps = new ConnectorAppService({
      ...deps,
      registry: this.registry,
      beforeEnable: async (connector) => {
        const server = this.deps.connectors.configuration(connector.id);
        if (server) await this.confirmWindowsServer(connector, server, false);
      },
      start: (operation) =>
        this.spawn(() => this.runStart(operation), operation.connectorId ?? undefined),
      changed: (id) => this.emitConnectorChanged(id),
      pluginChanged: (id) => this.emitPluginsChanged(id, "imported"),
      needsAuth: deps.onNeedsAuth,
      authorizeBuiltinOAuth: (connectorId, expectedRevision, signal) =>
        this.authorizeBuiltinOAuth(connectorId, expectedRevision, signal),
    });
  }

  availability(
    target: import("@pibot/plugins-contract/full").ConnectionTarget,
    connection: string,
    tool?: string,
  ) {
    return connectionAvailability(
      { ...this.deps, registry: this.registry, platform: this.deps.platform ?? process.platform },
      target,
      connection,
      tool,
    );
  }

  unavailable(target: import("@pibot/plugins-contract/full").ConnectionTarget) {
    return [
      ...this.registry
        .list((this.deps.platform ?? process.platform) as NodeJS.Platform)
        .map((app) => app.id),
      ...this.deps.connectors.list({ builtin: false, limit: 100 }).items.map((row) => row.id),
    ]
      .map((id) => this.availability(target, id))
      .filter((item) => item.reason !== "available");
  }

  // --- plugins.* -------------------------------------------------------------

  listPlugins(input: { cursor?: string; limit?: number; connectionsOnly?: boolean }) {
    return this.deps.plugins.list(input);
  }

  setPluginEnabled(input: { installationId: string; expectedRevision: number; enabled: boolean }) {
    const installation = this.deps.plugins.setEnabled({
      ...input,
      actorBotId: this.deps.actorBotId,
    });
    this.emitPluginsChanged(input.installationId, input.enabled ? "enabled" : "disabled");
    return installation;
  }

  pickImport(input: { kind: "file" | "directory" }) {
    return pickImportStep.call(this.operationContext(), input);
  }

  previewImport(
    source:
      | { kind: "json"; text: string }
      | { kind: "selection"; selectionId: string; installationId?: string }
      | {
          kind: "configured";
          previewId: string;
          config: Record<string, string | number | boolean>;
        },
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ) {
    return previewImportStep.call(this.operationContext(), source, signal);
  }

  private buildingPlugin = false;

  async installBuiltPlugin(
    path: string,
    config: Record<string, string | number | boolean>,
    botId: string,
    signal: AbortSignal,
  ) {
    if (this.buildingPlugin) throw new RpcError(-32602, "plugin_install_busy");
    this.buildingPlugin = true;
    const work = this.installBuiltPluginStep(path, config, botId, signal);
    // The caller receives errors; shutdown only needs a settlement barrier.
    const drained = work.then(
      () => undefined,
      () => undefined,
    );
    this.jobs.add(drained);
    try {
      return await work;
    } finally {
      this.jobs.delete(drained);
      this.buildingPlugin = false;
    }
  }

  private async installBuiltPluginStep(
    path: string,
    config: Record<string, string | number | boolean>,
    botId: string,
    signal: AbortSignal,
  ) {
    const host = this.deps.importHost;
    if (!host?.adopt) throw new RpcError(-32602, "plugin_import_host_unavailable");
    const selection = await host.adopt({ path });
    let previewId: string | undefined;
    try {
      let preview = await this.previewImport(
        { kind: "selection", selectionId: selection.selectionId },
        signal,
      );
      previewId = preview.previewId;
      let raw = this.previews.peek(previewId);
      if (!raw.plugin || raw.secrets.length) throw new RpcError(-32602, "plugin_package_required");
      if (
        !raw.plugin.application ||
        !raw.plugin.applicationCard ||
        !raw.manifest.servers.length ||
        raw.plugin.skills.length
      )
        throw new RpcError(-32602, "pibot_application_package_required");
      if (
        !(raw.plugin.applicationCard.platforms as readonly string[]).includes(
          this.deps.platform ?? process.platform,
        )
      )
        throw new RpcError(-32602, "pibot_application_unsupported_platform");
      const previous = this.deps.plugins.findBuiltPlugin(
        raw.manifest.name.en,
        raw.plugin.applicationId,
      );
      if (previous) {
        this.previews.cancel(previewId);
        this.selectionPreviews.delete(previewId);
        preview = await this.previewImport(
          { kind: "selection", selectionId: selection.selectionId, installationId: previous.id },
          signal,
        );
        previewId = preview.previewId;
        raw = this.previews.peek(previewId);
        if (!raw.plugin) throw new RpcError(-32602, "plugin_package_required");
      }
      for (const field of raw.plugin.config)
        if (field.sensitive && Object.hasOwn(config, field.key))
          throw new RpcError(-32602, "plugin_sensitive_config_forbidden");
      const validated = finalizeConnectorPreview(raw, config, {}, true);
      if (validated.secrets.length) throw new RpcError(-32602, "plugin_sensitive_config_forbidden");
      const pending = raw.plugin.config.some((field) => field.sensitive && field.required);
      // Windows keeps a newly generated application disabled until the normal native
      // confirmation flow is completed from Connections. The import RPC still succeeds so
      // the package and its card are durable, but it must not silently start a stdio process.
      const windowsConfirmationRequired = (this.deps.platform ?? process.platform) === "win32";
      if (previous) {
        for (const connector of this.deps.plugins.connections(previous.id)) {
          signal.throwIfAborted();
          const operation = this.deps.operations.request(
            { id: connector.id, expectedRevision: connector.revision, kind: "disable" },
            botId,
          );
          await this.runStop(operation);
        }
      }
      const receipt = await this.import(
        {
          previewId,
          expectedDigest: preview.digest,
          config,
          enable: !pending && !windowsConfirmationRequired,
          botInstall: true,
          skillTargets: { bots: [botId], groups: [] },
        },
        signal,
      );
      if (pending) this.deps.plugins.pendingBuiltSettings(receipt.installation.id);
      this.deps.audit.append({
        botId,
        kind: "plugin.changed",
        summary: "plugin_install",
        detail: {
          installationId: receipt.installation.id,
          pluginInstall: {
            name: this.deps.displayRedact?.(raw.plugin.name) ?? raw.plugin.name,
            version: raw.plugin.version,
            components: raw.plugin.components.length,
            domains: [
              ...new Set(raw.manifest.servers.flatMap((server) => server.networkDomains)),
            ].slice(0, 100),
          },
        },
      });
      return {
        text: JSON.stringify({
          installationId: receipt.installation.id,
          name: raw.plugin.name,
          version: raw.plugin.version,
          state: pending ? "needs_setup" : "installed",
          next: pending
            ? "请在连接中填写插件设置 / Fill this plugin's settings in Connections"
            : windowsConfirmationRequired
              ? "Windows 上已安装但未启动；请在连接中确认后启用 / Installed but not started on Windows; confirm it in Connections before enabling"
              : undefined,
        }),
      };
    } finally {
      try {
        if (previewId) await this.cancelPreview({ previewId });
      } finally {
        await host.release(selection);
      }
    }
  }

  cancelPreview({ previewId }: { previewId: string }) {
    return cancelPreviewStep.call(this.operationContext(), { previewId });
  }

  import(
    input: {
      skillTargets?: { bots: string[]; groups: string[] };
      previewId: string;
      enable: boolean;
      botInstall?: boolean;
      expectedDigest: string;
      config: Record<string, string | number | boolean>;
      networkDomains?: Record<string, string[]>;
      broughtOver?: { tool: string; key: string; name?: string };
      sourcePath?: string;
    },
    signal?: AbortSignal,
  ) {
    return importStep.call(this.operationContext(), input, signal);
  }

  uninstall(input: { installationId: string; expectedRevision: number }) {
    return uninstallStep.call(this.operationContext(), input);
  }

  // --- connectors.* ----------------------------------------------------------

  listConnectors(input: {
    cursor?: string;
    limit?: number;
    installationId?: string;
    builtin?: boolean;
  }) {
    const page = this.deps.connectors.list(input);
    return { ...page, items: page.items.map((connector) => this.withAppId(connector)) };
  }

  private withAppId(connector: Connector): Connector {
    const installation = this.deps.plugins.get(connector.pluginInstallationId);
    const appId = this.registry.appId(connector, installation);
    return appId ? { ...connector, appId } : connector;
  }

  /**
   * Some knowledge sources live in a remote MCP app, so the brain creates that one connection
   * itself from a manifest it owns (never user-supplied JSON). It is installed disabled and for
   * nobody (`selected` with no targets); the knowledge source's assignments are the only way to
   * lend it out. The UI's next step is `connectors.authorize`, and enabling it with the OAuth
   * grant is exactly that call.
   */
  createManagedConnection(manifest: ConnectorManifest): Connector {
    const receipt = this.deps.plugins.install({
      id: randomUUID(),
      manifest,
      digest: connectorDigest(manifest),
      sourceKind: "json",
      actorBotId: this.deps.actorBotId,
      accessMode: "selected",
      managedBy: "knowledge_source",
    });
    const connector = receipt.connectors[0];
    // A manifest with one server always yields one connector; reaching here is a bug in the
    // manifest above, not something the person can fix, so it surfaces as an internal error.
    if (!connector) throw new Error("Managed connector manifest installed without a connector");
    this.emitPluginsChanged(receipt.installation.id, "imported");
    return this.withAppId(connector);
  }

  getConnector({ id }: { id: string }) {
    const connector = this.deps.connectors.get(id);
    if (!connector) throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector not found");
    const access = this.deps.connectors.access(id);
    const server = this.deps.connectors.configuration(id);
    const installation = this.deps.plugins.get(connector.pluginInstallationId);
    return {
      connector: this.withAppId(connector),
      access,
      auth: server?.auth.kind ?? ("none" as const),
      canReplaceCredential: this.apps.canReplaceCredential(id),
      networkDomains: server.networkDomains,
      canEditNetworkDomains:
        this.deps.plugins.get(connector.pluginInstallationId)?.sourceKind !== "builtin",
      bundledNode:
        installation?.sourceKind === "directory" &&
        server?.transport === "stdio" &&
        (server.command === "node" || server.command === "node.exe"),
    };
  }

  updateConnector(input: z.output<typeof ConnectorUpdateSchema>) {
    const connector = this.deps.connectors.get(input.id);
    const installation = connector && this.deps.plugins.get(connector.pluginInstallationId);
    if (
      installation?.sourceKind === "builtin" &&
      input.tools?.some(
        (tool) =>
          tool.readOnly && !this.registry.toolPolicy(installation.pluginId, tool.tool).readOnly,
      )
    )
      throw new RpcError(
        RpcErrorCodes.invalidParams,
        "Builtin write tools cannot be classified as read-only",
      );
    const updated = this.deps.connectors.update(input, this.deps.actorBotId);
    if (input.networkDomains !== undefined) {
      // A saved restriction must not leave an old process serving calls with its previous rules.
      this.targets.delete(updated.id);
      this.lifecycles.get(updated.id)?.abort();
      if (updated.enabled) {
        const operation = this.deps.operations.request(
          { id: updated.id, expectedRevision: updated.revision, kind: "restart" },
          this.deps.actorBotId,
        );
        this.emitOperation(operation);
        this.spawn(() => this.runStart(operation), updated.id);
      }
    }
    if (input.access) this.emitPluginsChanged(updated.pluginInstallationId, "access");
    this.emitConnectorChanged(updated.id);
    this.emitToolsChanged(updated);
    return updated;
  }

  async updateFromSource(input: {
    id: string;
    expectedRevision: number;
    confirmed: boolean;
    expectedDigest?: string;
  }) {
    const connector = this.deps.connectors.get(input.id);
    if (!connector) throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector not found");
    // The details page holds the connector's revision; the installation has its own counter.
    if (connector.revision !== input.expectedRevision)
      throw new RpcError(RpcErrorCodes.connectorStale, "Connector revision changed");
    const notFound = () => ({
      state: "source_not_found" as const,
      installationId: connector.pluginInstallationId,
      expectedRevision: input.expectedRevision,
      changes: { commands: 0, arguments: 0, envNames: 0, websites: 0, files: 0 },
    });
    const origin = this.deps.plugins.origin(connector.pluginInstallationId);
    const importHost = this.deps.importHost;
    if (!origin || !importHost) return notFound();
    let selection: { selectionId: string } | undefined;
    let sourcePreviewId: string | undefined;
    let configurationDigest: string | undefined;
    try {
      let preview: Awaited<ReturnType<ConnectorService["previewImport"]>>;
      if (origin.path.includes("#")) {
        const [file, encoded] = origin.path.split("#", 2);
        if (!file) return notFound();
        const name = decodeURIComponent(encoded ?? "");
        const source = sourceLayouts(this.deps.home, this.deps.commandEnv).find(
          (item) => item.id === origin.tool,
        );
        const format = source?.mcpFiles.find((item) => item.path === file);
        if (!source || !format) return notFound();
        const entry = (
          await readMcpFile(source.id, file, format.format, AbortSignal.timeout(30_000))
        )?.find((item) => item.name === name)?.entry;
        if (!entry) return notFound();
        const text = JSON.stringify(
          entryManifest(entry, {
            id: broughtOverId(source.id, name),
            name,
            description: { zh: entryDescription(entry), en: entryDescription(entry) },
          }),
        );
        configurationDigest = createHash("sha256").update(text).digest("hex");
        preview = await this.previewImport({ kind: "json", text }, AbortSignal.timeout(60_000));
      } else {
        if (!importHost.adopt) return notFound();
        selection = await importHost.adopt({ path: origin.path });
        preview = await this.previewImport(
          {
            kind: "selection",
            selectionId: selection.selectionId,
            installationId: connector.pluginInstallationId,
          },
          AbortSignal.timeout(60_000),
        );
      }
      sourcePreviewId = preview.previewId;
      const current = this.deps.plugins.get(connector.pluginInstallationId);
      if (!current)
        throw new RpcError(RpcErrorCodes.connectorUnavailable, "Installation unavailable");
      const rawPreview = this.previews.peek(preview.previewId);
      const oldManifest = this.deps.plugins.manifest(connector.pluginInstallationId);
      if (!oldManifest)
        throw new RpcError(RpcErrorCodes.connectorUnavailable, "Manifest unavailable");
      const selectionPreview = this.selectionPreviews.get(preview.previewId);
      const sourceDigest =
        selectionPreview?.sourceDigest ?? configurationDigest ?? rawPreview.digest;
      if (input.confirmed && input.expectedDigest && input.expectedDigest !== sourceDigest)
        throw new RpcError(RpcErrorCodes.connectorStale, "Source changed during confirmation");
      const { manifest, changes, details } = sourceUpdate(
        oldManifest,
        rawPreview.manifest,
        rawPreview.plugin?.components.length ?? 0,
        this.deps.displayRedact,
        selectionPreview?.fileChanges,
        rawPreview.secrets.map((secret) => secret.value),
      );
      if (!input.confirmed)
        return {
          state: "preview" as const,
          installationId: connector.pluginInstallationId,
          expectedRevision: input.expectedRevision,
          changes,
          details,
          sourceDigest,
        };
      if (selection && rawPreview.plugin && importHost.replaceMaterialize)
        await importHost.replaceMaterialize({
          selectionId: selection.selectionId,
          installationId: connector.pluginInstallationId,
          expectedDigest: selectionPreview?.sourceDigest ?? rawPreview.digest,
        });
      const updated = this.deps.plugins.updateImported({
        installationId: connector.pluginInstallationId,
        expectedRevision: current.revision,
        manifest,
        digest: rawPreview.digest,
        actorBotId: this.deps.actorBotId,
        changed: changes,
      });
      this.previews.cancel(preview.previewId);
      this.selectionPreviews.delete(preview.previewId);
      this.emitConnectorChanged(connector.id);
      const refreshed = this.deps.connectors.get(connector.id);
      if (connector.enabled && refreshed)
        await this.restart({ id: connector.id, expectedRevision: refreshed.revision });
      return {
        state: "updated" as const,
        installationId: updated.id,
        expectedRevision: updated.revision,
        changes,
        details,
        sourceDigest,
        connector: refreshed,
      };
    } finally {
      if (sourcePreviewId) {
        this.previews.cancel(sourcePreviewId);
        this.selectionPreviews.delete(sourcePreviewId);
      }
      if (selection)
        await importHost.release({ selectionId: selection.selectionId }).catch(() => undefined);
    }
  }

  getOperation({ operationId }: { operationId: string }) {
    const operation = this.deps.operations.get(operationId);
    if (!operation) throw new RpcError(RpcErrorCodes.connectorUnavailable, "Operation not found");
    return operation;
  }

  listTools({ id, ...page }: { id: string; cursor?: string; limit?: number }) {
    const connector = this.deps.connectors.get(id);
    const installation = connector && this.deps.plugins.get(connector.pluginInstallationId);
    const result = this.deps.connectors.tools(id, page);
    if (installation?.sourceKind !== "builtin") return result;
    const descriptions = this.registry.fromInstallation(installation)?.mcp?.toolDescriptions;
    return {
      ...result,
      items: result.items.map((tool) => {
        const trustedRead = this.registry.toolPolicy(installation.pluginId, tool.tool).readOnly;
        return {
          ...tool,
          readOnly: tool.readOnly && trustedRead,
          readOnlyLocked: !trustedRead,
          ...(descriptions?.[tool.tool] ? { displayDescription: descriptions[tool.tool] } : {}),
        };
      }),
    };
  }

  capabilitySuggestions(connectorId: string) {
    return this.deps.connectors.capabilitySuggestions(connectorId);
  }

  capabilityConnectors(capabilityId: CapabilityId) {
    return this.deps.connectors.capabilityConnectors(capabilityId);
  }

  /** Metadata only: the same Bot visibility and current-catalog checks as ordinary discovery. */
  capabilityTools(
    botId: string,
    connectorId: string,
    capabilityId: CapabilityId,
    groupId?: string,
  ) {
    const items = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = this.discoverToolsForBot(
        botId,
        { connectorId, cursor, limit: 50 },
        false,
        groupId,
      );
      items.push(...page.items.filter((tool) => tool.capabilityId === capabilityId));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && items.length < 100 && pages < 20);
    return items.slice(0, 100);
  }

  async setEnabled(
    input: { id: string; expectedRevision: number; enabled: boolean },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (input.enabled) {
      const connector = this.deps.connectors.get(input.id);
      const server = connector && this.deps.connectors.configuration(input.id);
      if (connector && server) await this.confirmWindowsServer(connector, server, false, signal);
    }
    signal?.throwIfAborted();
    const operation = this.deps.operations.request(
      {
        id: input.id,
        expectedRevision: input.expectedRevision,
        kind: input.enabled ? "enable" : "disable",
      },
      this.deps.actorBotId,
    );
    this.emitOperation(operation);
    if (input.enabled) this.spawn(() => this.runStart(operation), input.id);
    else {
      this.apps.cancelConnector(input.id);
      // Notify the in-flight start generation now, not after it settles.
      this.lifecycles.get(input.id)?.abort();
      this.spawnPrompt(() => this.runStop(operation));
    }
    return { operationId: operation.id };
  }

  disconnect(input: { id: string; expectedRevision: number }) {
    this.apps.cancelConnector(input.id);
    const operation = this.deps.operations.request(
      { id: input.id, expectedRevision: input.expectedRevision, kind: "disconnect" },
      this.deps.actorBotId,
    );
    this.emitOperation(operation);
    this.lifecycles.get(input.id)?.abort();
    this.spawnPrompt(() => this.runStop(operation));
    return { operationId: operation.id };
  }

  async restart(input: { id: string; expectedRevision: number }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const connector = this.deps.connectors.get(input.id);
    const server = connector && this.deps.connectors.configuration(input.id);
    if (connector && server) await this.confirmWindowsServer(connector, server, true, signal);
    signal?.throwIfAborted();
    const operation = this.deps.operations.request(
      { id: input.id, expectedRevision: input.expectedRevision, kind: "restart" },
      this.deps.actorBotId,
    );
    this.emitOperation(operation);
    this.spawn(() => this.runStart(operation), input.id);
    return { operationId: operation.id };
  }

  /** Desktop-only view of the sandbox switch and the last start failure. */
  diagnostics(input: { id: string }) {
    return diagnosticsStep.call(this.operationContext(), input);
  }

  /** Turning it on waits for the person's click in the native host dialog. */
  setOutsideSandbox(
    input: { id: string; expectedRevision: number; enabled: boolean },
    signal?: AbortSignal,
  ) {
    return setOutsideSandboxStep.call(this.operationContext(), input, signal);
  }

  private confirmWindowsServer(
    connector: Connector,
    server: NonNullable<ReturnType<ConnectorsRepo["configuration"]>>,
    restart: boolean,
    signal?: AbortSignal,
  ) {
    return confirmWindowsServerStep.call(
      this.operationContext(),
      connector,
      server,
      restart,
      signal,
    );
  }

  /** Recovery at brain start: intents survive a crash; processes never restart from the store. */
  recoverPending(): void {
    this.spawnPrompt(async () => {
      for (let cursor: string | undefined; ; ) {
        const page = this.deps.operations.reconcileFailedUninstalls(this.deps.actorBotId, cursor);
        for (const connector of page.items) this.emitConnectorChanged(connector.id, connector);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const running: Promise<void>[] = [];
      const recovered = new Set<string>();
      for (let cursor = ""; ; ) {
        const page = this.deps.operations.pending(cursor || undefined);
        for (const operation of page.items) {
          if (operation.connectorId) recovered.add(operation.connectorId);
          const runner =
            operation.kind === "uninstall"
              ? () => this.runUninstall(operation.installationId, operation)
              : operation.kind === "enable" || operation.kind === "restart"
                ? () => this.runStart(operation)
                : () => this.runStop(operation);
          // Recovery honours the same lanes as user-triggered operations.
          if (
            operation.connectorId &&
            (operation.kind === "enable" || operation.kind === "restart")
          )
            running.push(this.spawn(runner, operation.connectorId));
          else running.push(this.spawnPrompt(runner));
        }
        await Promise.all(running);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      // A completed enable intent survives a process restart too; sessions never own these wires.
      for (let cursor: string | undefined; ; ) {
        const page = this.deps.connectors.list({ cursor, limit: 100 });
        for (const connector of page.items) {
          const awaitingKeyring =
            connector.kind === "mcp_stdio" &&
            connector.outsideSandbox &&
            connector.status === "error" &&
            connector.statusDetailCode === "secure_storage_unavailable";
          if (
            recovered.has(connector.id) ||
            !connector.enabled ||
            (!["ready", "idle"].includes(connector.status) && !awaitingKeyring)
          )
            continue;
          const operation = this.deps.operations.request(
            { id: connector.id, expectedRevision: connector.revision, kind: "restart" },
            this.deps.actorBotId,
          );
          running.push(this.spawn(() => this.runStart(operation), connector.id));
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      await Promise.all(running);
    });
  }

  /** True drain on shutdown; the brain must not exit with live servers. */
  async dispose(): Promise<void> {
    for (const lifecycle of this.lifecycles.values()) lifecycle.abort();
    await this.apps.dispose();
    for (const unsubscribe of this.toolChangeUnsubs.values()) unsubscribe();
    this.toolChangeUnsubs.clear();
    this.targets.clear();
    // Late snapshot jobs may spawn while draining; loop until the set is empty.
    while (this.jobs.size > 0) await Promise.all([...this.jobs]).catch(() => undefined);
    await this.deps.pool.dispose();
  }

  /** Metadata only: never opens a transport or imports plugin code. */
  discoverToolsForBot(
    botId: string,
    input: ConnectorDiscoverInput,
    readOnly = false,
    groupId?: string,
  ) {
    return discoverToolsForBotStep.call(this.operationContext(), botId, input, readOnly, groupId);
  }

  /** Trusted target resolution precedes policy. A plugin hint is never a read grant. */
  resolveTool(botId: string, input: ConnectorCallInput, groupId?: string): PreparedConnector {
    return resolveToolStep.call(this.operationContext(), botId, input, groupId);
  }

  dispatchDraft(
    approvalId: string,
    botId: string,
    input: ConnectorCallInput,
    approved: PreparedConnector,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<unknown> {
    return dispatchDraftStep.call(
      this.operationContext(),
      approvalId,
      botId,
      input,
      approved,
      signal,
      authorize,
    );
  }

  dispatchCapability(
    botId: string,
    input: ConnectorCallInput,
    approved: PreparedConnector,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<unknown> {
    if (!approved.tool.capabilityId || approved.tool.capabilityReadOnly !== true)
      throw new ConnectorToolError("connector_tool_denied");
    return this.dispatchChecked(botId, input, approved, signal, authorize, false);
  }

  dispatch(
    botId: string,
    input: ConnectorCallInput,
    approved: PreparedConnector,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<unknown> {
    return dispatchStep.call(this.operationContext(), botId, input, approved, signal, authorize);
  }

  private dispatchChecked(
    botId: string,
    input: ConnectorCallInput,
    approved: PreparedConnector,
    signal: AbortSignal,
    authorize: () => void,
    draft: boolean,
    idempotencyKey?: string,
  ): Promise<unknown> {
    return dispatchCheckedStep.call(
      this.operationContext(),
      botId,
      input,
      approved,
      signal,
      authorize,
      draft,
      idempotencyKey,
    );
  }

  // --- internals -------------------------------------------------------------

  /**
   * Start-kind work queues per connector (plan T3: serialized per instance,
   * never head-of-line across connectors). Stop-kind work never queues behind
   * a start: pool drain plus repo supersession make prompt execution safe, so
   * a disable cancels a hung start instead of waiting for it.
   */
  private spawn(job: () => Promise<void>, connectorId?: string): Promise<void> {
    const guarded = async () => {
      try {
        await job();
      } catch {
        // Runners record their own failures; a rejected job must not poison later ones.
      }
    };
    const previous =
      connectorId === undefined
        ? Promise.resolve()
        : (this.startChains.get(connectorId) ?? Promise.resolve());
    const promise = previous.then(guarded);
    if (connectorId !== undefined) {
      this.startChains.set(connectorId, promise);
      void promise.finally(() => {
        // Drop settled tails so removed connectors do not accumulate entries.
        if (this.startChains.get(connectorId) === promise) this.startChains.delete(connectorId);
      });
    }
    this.jobs.add(promise);
    void promise.catch(() => undefined).finally(() => this.jobs.delete(promise));
    return promise;
  }

  private spawnPrompt(job: () => Promise<void>): Promise<void> {
    return this.spawn(job);
  }

  /** Test/dispose seam: resolve once every lifecycle job settled so far. */
  get chain(): Promise<void> {
    return Promise.all([...this.jobs]).then(() => undefined);
  }

  private emitPluginsChanged(
    installationId: string,
    reason: "imported" | "enabled" | "disabled" | "removed" | "access",
  ): void {
    const installation = this.deps.plugins.get(installationId);
    if (!installation) return;
    this.deps.emit("plugins.changed", {
      installationId,
      revision: installation.revision,
      reason,
    });
  }

  private emitConnectorChanged(connectorId: string, cleanupSnapshot?: Connector): void {
    const connector = this.deps.connectors.get(connectorId) ?? cleanupSnapshot;
    if (!connector) return;
    this.deps.emit("connectors.changed", {
      connectorId,
      revision: connector.revision,
      catalogVersion: connector.catalogVersion,
      status: connector.status,
    });
  }

  private emitToolsChanged(connector: Pick<Connector, "id" | "revision" | "catalogVersion">): void {
    this.deps.emit("connectors.toolsChanged", {
      connectorId: connector.id,
      revision: connector.revision,
      catalogVersion: connector.catalogVersion,
    });
  }

  private emitOperation(operation: ConnectorOperation): void {
    this.deps.emit("connectors.operationChanged", operation);
  }

  /**
   * A user-initiated OAuth setup is the one non-model call allowed to invoke a connector tool
   * without a Bot scope. The registry supplies the exact tool name; no renderer-provided name or
   * arguments can enter this path.
   */
  private async authorizeBuiltinOAuth(
    connectorId: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<void> {
    const connector = this.deps.connectors.get(connectorId);
    const installation = connector && this.deps.plugins.get(connector.pluginInstallationId);
    const definition = installation && this.registry.fromInstallation(installation);
    const tool = definition?.mcp?.oauthStartTool;
    if (!connector || connector.revision !== expectedRevision || !tool)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "Built-in OAuth is unavailable");
    let target = this.targets.get(connectorId);
    for (let attempt = 0; !target && attempt < 120; attempt += 1) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      target = this.targets.get(connectorId);
    }
    if (!target)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "Built-in OAuth startup timed out");
    const current = this.deps.connectors.get(connectorId);
    if (!current || current.revision !== expectedRevision || !current.enabled)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "Built-in OAuth connection changed");
    const catalogTool = this.deps.connectors.tool(connectorId, current.catalogVersion, tool);
    if (!catalogTool?.enabled)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "Built-in OAuth tool unavailable");
    try {
      await this.deps.pool.run(
        target,
        (connection, pooledSignal) =>
          connection.callTool({ tool, args: {}, signal: pooledSignal }).then(() => undefined),
        signal,
      );
    } catch (error) {
      await this.deps.pool.stop(connectorId).catch(() => undefined);
      throw error;
    }
  }

  /** Open, discover and publish; failures land on the operation with a stable code. */
  private runStart(operation: ConnectorOperation): Promise<void> {
    return runStartStep.call(this.operationContext(), operation);
  }

  private async discoverTools(
    connectorId: string,
    connection: Awaited<ReturnType<ConnectorPoolTarget["open"]>>,
    signal: AbortSignal,
  ) {
    const tools = await discoverToolsStep.call(this.operationContext(), connection, signal);
    const connector = this.deps.connectors.get(connectorId);
    const plugin = connector && this.deps.plugins.get(connector.pluginInstallationId);
    if (!connector || !plugin) throw new ConnectorToolError("connector_unavailable");
    return mapConnectorCapabilities({ registry: this.registry, connector, plugin, tools });
  }

  private buildTarget(connector: Connector): ConnectorPoolTarget {
    return buildTargetStep.call(this.operationContext(), connector);
  }

  /** Installation credentials stay owned by connectors; user-assigned names belong to the port. */
  private readConnectionSecret(name: string, signal: AbortSignal) {
    return readConnectionSecretStep.call(this.operationContext(), name, signal);
  }

  private runStop(operation: ConnectorOperation): Promise<void> {
    return runStopStep.call(this.operationContext(), operation);
  }

  private runUninstall(installationId: string, operation: ConnectorOperation): Promise<void> {
    return runUninstallStep.call(this.operationContext(), installationId, operation);
  }

  private recordStartFailure(
    operation: ConnectorOperation,
    error: unknown,
    currentRevision: number,
  ): void {
    recordStartFailureStep.call(this.operationContext(), operation, error, currentRevision);
  }

  private markNeedsAuth(connectorId: string) {
    return markNeedsAuthStep.call(this.operationContext(), connectorId);
  }

  private applyBuiltinDefaults(
    connectorId: string,
    tools: { tool: string; description: string; schema: unknown }[],
  ) {
    const connector = this.deps.connectors.get(connectorId);
    const installation = connector && this.deps.plugins.get(connector.pluginInstallationId);
    // Only built-in apps have a fixed tool table. For any other connection the catalog already set
    // the defaults; resetting them here to
    // "everything writes" undid that right after publishing (owner's GitHub, 2026-11-01).
    if (!connector || installation?.sourceKind !== "builtin") return;
    const states = this.deps.connectors.toolPolicyStates(connectorId);
    const changes = tools.flatMap(({ tool }) => {
      const stored = states.get(tool);
      if (!stored || stored.overridden) return [];
      const defaults = this.registry.toolPolicy(
        installation.sourceKind === "builtin" ? installation.pluginId : "",
        tool,
      );
      if (stored.enabled === defaults.enabled && stored.readOnly === defaults.readOnly) return [];
      return [{ tool, enabled: defaults.enabled, readOnly: defaults.readOnly }];
    });
    let current = connector;
    for (let offset = 0; offset < changes.length; offset += 100) {
      current = this.deps.connectors.update(
        {
          id: connectorId,
          expectedRevision: current.revision,
          tools: changes.slice(offset, offset + 100),
        },
        this.deps.actorBotId,
        { recordToolOverrides: false },
      );
    }
  }

  /** A superseded operation was cancelled by a newer request; not a failure. */
  private isSuperseded(error: unknown): boolean {
    return error instanceof RpcError && error.code === RpcErrorCodes.connectorStale;
  }

  /** Catalog changes reported by the server are re-discovered on the same generation. */
  private subscribeToolChanges(
    connectorId: string,
    connection: Awaited<ReturnType<ConnectorPoolTarget["open"]>>,
  ): void {
    subscribeToolChangesStep.call(this.operationContext(), connectorId, connection);
  }

  // Keep live access to private state: an awaited step must observe later cancellation and scope changes.
  private operationContext() {
    const owner = this;
    return {
      owner,
      applyBuiltinDefaults: owner.applyBuiltinDefaults.bind(owner),
      get apps() {
        return owner.apps;
      },
      buildTarget: owner.buildTarget.bind(owner),
      confirmWindowsServer: owner.confirmWindowsServer.bind(owner),
      get deps() {
        return owner.deps;
      },
      discoverTools: owner.discoverTools.bind(owner),
      dispatchChecked: owner.dispatchChecked.bind(owner),
      emitConnectorChanged: owner.emitConnectorChanged.bind(owner),
      emitOperation: owner.emitOperation.bind(owner),
      emitPluginsChanged: owner.emitPluginsChanged.bind(owner),
      emitToolsChanged: owner.emitToolsChanged.bind(owner),
      get generations() {
        return owner.generations;
      },
      isSuperseded: owner.isSuperseded.bind(owner),
      get lifecycles() {
        return owner.lifecycles;
      },
      markNeedsAuth: owner.markNeedsAuth.bind(owner),
      get previews() {
        return owner.previews;
      },
      readConnectionSecret: owner.readConnectionSecret.bind(owner),
      get registry() {
        return owner.registry;
      },
      recordStartFailure: owner.recordStartFailure.bind(owner),
      resolveTool: owner.resolveTool.bind(owner),
      runStart: owner.runStart.bind(owner),
      runUninstall: owner.runUninstall.bind(owner),
      get secretBindings() {
        return owner.secretBindings;
      },
      pluginSecretHandlers: owner.pluginSecretHandlers,
      get selectionPreviews() {
        return owner.selectionPreviews;
      },
      spawn: owner.spawn.bind(owner),
      spawnPrompt: owner.spawnPrompt.bind(owner),
      get startFailures() {
        return owner.startFailures;
      },
      subscribeToolChanges: owner.subscribeToolChanges.bind(owner),
      get targets() {
        return owner.targets;
      },
      get toolChangeUnsubs() {
        return owner.toolChangeUnsubs;
      },
    };
  }
}
