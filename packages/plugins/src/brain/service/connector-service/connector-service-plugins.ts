// Brain-side connector orchestration: the 13 registered RPCs, lifecycle
// operations, the connection pool and tool catalog publishing live here. The
// pool borrows connections; dispatch permissions are enforced per call and
// never inherited from a plugin manifest.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import type { PluginsRepo } from "../../../store/index.ts";
import {
  type ConnectorPreview,
  finalizeConnectorPreview,
  USER_SECRET_SCOPE,
} from "../connector-import.ts";
import type { ConnectorServiceOperations } from "../connector-service.ts";

export function pickImportStep(
  this: ConnectorServiceOperations,
  input: { kind: "file" | "directory" },
) {
  if (!this.deps.importHost)
    throw new RpcError(RpcErrorCodes.pluginImportInvalid, "Import picker unavailable");
  return this.deps.importHost.pick(input);
}

async function previewResult(
  service: ConnectorServiceOperations,
  preview: ConnectorPreview,
  signal: AbortSignal,
) {
  const warnings = new Set<"dangerous" | "unverified">();
  for (const server of preview.manifest.servers) {
    signal.throwIfAborted();
    if (server.transport !== "stdio") continue;
    // Quote argv as literals for the same shell analyzer used at command admission.
    const command = [server.command, ...server.args]
      .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
      .join(" ");
    const risk = service.deps.commandRisk
      ? await service.deps.commandRisk(command, signal)
      : "unverified";
    if (risk) warnings.add(risk);
  }
  signal.throwIfAborted();
  const visibleManifest = {
    ...preview.manifest,
    servers: preview.manifest.servers.map((server) => {
      if (server.transport === "http")
        return {
          ...server,
          url: server.url.replaceAll(/\$\{secret:[A-Z][A-Z0-9_]{0,63}\}/g, "REDACTED"),
        };
      if (server.transport === "stdio" && preview.plugin && service.deps.dataDir) {
        const root = preview.installationRoot as string;
        const data = join(service.deps.dataDir, "plugin-data", preview.installationId);
        const scrub = (value: string) =>
          value
            .replaceAll(data, `\${CLAUDE_PLUGIN_DATA}`)
            .replaceAll(root, `\${CLAUDE_PLUGIN_ROOT}`);
        return { ...server, command: scrub(server.command), args: server.args.map(scrub) };
      }
      return server;
    }),
  };
  return {
    previewId: preview.previewId,
    digest: preview.digest,
    manifest: visibleManifest,
    ...(preview.declaredVersion ? { declaredVersion: preview.declaredVersion } : {}),
    ...(preview.plugin
      ? {
          plugin: {
            components: preview.plugin.components,
            config: preview.plugin.config,
            skillCount: preview.plugin.skills.length,
            ...(preview.plugin.applicationCard
              ? { application: preview.plugin.applicationCard }
              : {}),
          },
        }
      : {}),
    expiresAt: preview.expiresAt,
    commandWarnings: [...warnings],
  };
}

/** A failed response must not strand a preview whose ID the client never received. */
async function checkedPreview(
  service: ConnectorServiceOperations,
  preview: ConnectorPreview,
  signal: AbortSignal,
) {
  try {
    return await previewResult(service, preview, signal);
  } catch (error) {
    service.previews.cancel(preview.previewId);
    const selection = service.selectionPreviews.get(preview.previewId);
    if (selection) {
      // Retain only cleanup ownership if the host cannot release it now; the next preview retries.
      selection.expiresAt = new Date(0).toISOString();
      try {
        await service.deps.importHost?.release({ selectionId: selection.selectionId });
      } catch {
        throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_preview_cleanup_failed");
      }
      service.selectionPreviews.delete(preview.previewId);
    }
    throw error;
  }
}

export async function previewImportStep(
  this: ConnectorServiceOperations,
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
  const now = Date.now();
  for (const [previewId, pending] of this.selectionPreviews) {
    if (Date.parse(pending.expiresAt) > now) continue;
    try {
      await this.deps.importHost?.release({ selectionId: pending.selectionId });
    } catch {
      throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_preview_cleanup_failed");
    }
    this.selectionPreviews.delete(previewId);
  }
  if (source.kind === "configured") {
    const selection = this.selectionPreviews.get(source.previewId);
    const preview = this.previews.configure(source.previewId, source.config);
    if (selection) {
      this.selectionPreviews.delete(source.previewId);
      this.selectionPreviews.set(preview.previewId, {
        ...selection,
        expiresAt: preview.expiresAt,
      });
    }
    return checkedPreview(this, preview, signal);
  }
  let text: string;
  const installationId =
    source.kind === "selection" && source.installationId
      ? (source.installationId as ReturnType<typeof randomUUID>)
      : randomUUID();
  let selection:
    | {
        selectionId: string;
        sourceDigest: string;
        sourceKind: "json" | "plugin";
        fileChanges?: import("@pibot/plugins-contract/full").ConnectorImportFileChanges;
      }
    | undefined;
  if (source.kind === "selection") {
    if (!this.deps.importHost)
      throw new RpcError(RpcErrorCodes.pluginImportInvalid, "Import picker unavailable");
    const read = await this.deps.importHost.read({
      selectionId: source.selectionId,
      installationId,
    });
    text = read.text;
    selection = {
      selectionId: source.selectionId,
      sourceDigest: read.sourceDigest,
      sourceKind: read.sourceKind,
      ...(read.fileChanges ? { fileChanges: read.fileChanges } : {}),
    };
  } else text = source.text;
  const installationRoot =
    selection?.sourceKind === "plugin" && this.deps.dataDir
      ? join(this.deps.dataDir, "plugins", installationId)
      : undefined;
  let preview: ReturnType<ConnectorServiceOperations["previews"]["create"]>;
  try {
    preview = this.previews.create(
      text,
      selection?.sourceKind ?? "json",
      Date.now(),
      installationId,
      installationRoot,
    );
  } catch (error) {
    if (selection)
      await this.deps.importHost
        ?.release({ selectionId: selection.selectionId })
        .catch(() => undefined);
    throw error;
  }
  if (selection)
    this.selectionPreviews.set(preview.previewId, { ...selection, expiresAt: preview.expiresAt });
  return checkedPreview(this, preview, signal);
}

export async function cancelPreviewStep(
  this: ConnectorServiceOperations,
  { previewId }: { previewId: string },
) {
  const selection = this.selectionPreviews.get(previewId);
  if (selection) await this.deps.importHost?.release({ selectionId: selection.selectionId });
  this.selectionPreviews.delete(previewId);
  this.previews.cancel(previewId);
  return { ok: true as const };
}

export async function importStep(
  this: ConnectorServiceOperations,
  input: {
    previewId: string;
    skillTargets?: { bots: string[]; groups: string[] };
    enable: boolean;
    botInstall?: boolean;
    expectedDigest: string;
    config: Record<string, string | number | boolean>;
    networkDomains?: Record<string, string[]>;
    /**
     * Internal only (bring-over; RPC params are strict and cannot carry it): where it came
     * from, and the name to save it under when an installed one already has its own.
     */
    broughtOver?: { tool: string; key: string; name?: string };
    sourcePath?: string;
  },
  signal?: AbortSignal,
) {
  const committed = this.previews.committed(input.previewId, input);
  if (committed) {
    if (committed.digest !== input.expectedDigest)
      throw new RpcError(RpcErrorCodes.pluginImportInvalid, "Preview changed; re-run the import");
    const installation = this.deps.plugins.get(committed.installationId);
    if (!installation)
      throw new RpcError(RpcErrorCodes.pluginImportCommitted, "Imported plugin is unavailable");
    if (input.enable && !installation.enabled)
      throw new RpcError(
        RpcErrorCodes.pluginImportCommitted,
        "Already imported and currently disabled; enable it from the connector list",
      );
    if (
      this.deps.plugins.importSkillCount(installation.id) > 0 &&
      (input.skillTargets?.bots.length || input.skillTargets?.groups.length)
    )
      await this.deps.skillCopies?.run(installation.id, signal);
    return {
      installation,
      connectors: this.deps.plugins.connections(committed.installationId),
      unassignedSkillCount: this.deps.skillCopies?.status(installation.id).unassignedCount,
      pendingSkillTargetCount: this.deps.skillCopies?.status(installation.id).pendingTargetCount,
    };
  }
  let preview: ReturnType<ConnectorServiceOperations["previews"]["take"]>;
  try {
    preview = this.previews.take(input.previewId);
  } catch (error) {
    const expiredSelection = this.selectionPreviews.get(input.previewId);
    this.selectionPreviews.delete(input.previewId);
    if (expiredSelection)
      await this.deps.importHost
        ?.release({ selectionId: expiredSelection.selectionId })
        .catch(() => undefined);
    throw error;
  }
  if (preview.digest !== input.expectedDigest)
    throw new RpcError(RpcErrorCodes.pluginImportInvalid, "Preview changed; re-run the import");
  const appPlatforms = preview.plugin?.applicationCard?.platforms;
  if (
    preview.plugin?.application &&
    (!preview.plugin.applicationId ||
      !preview.plugin.applicationCard ||
      preview.plugin.skills.length)
  )
    throw new RpcError(-32602, "pibot_application_package_required");
  if (
    preview.plugin?.application &&
    appPlatforms &&
    !appPlatforms.includes((this.deps.platform ?? process.platform) as "darwin" | "linux" | "win32")
  )
    throw new RpcError(-32602, "pibot_application_unsupported_platform");
  const finalized = finalizeConnectorPreview(
    preview,
    input.config,
    input.networkDomains,
    input.botInstall,
  );
  if (input.botInstall && finalized.secrets.length)
    throw new RpcError(-32602, "plugin_sensitive_config_forbidden");
  signal?.throwIfAborted();
  const targets = input.skillTargets ?? { bots: [], groups: [] };
  this.deps.skillCopies?.validate(targets);
  // Bringing a plugin over gives it to nobody yet; its skills wait in 「给 Bot 用」.
  if (
    !input.broughtOver &&
    !preview.manifest.servers.length &&
    !targets.bots.length &&
    !targets.groups.length
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "skill_target_required");

  const requiresWindowsConsent =
    input.enable &&
    !input.botInstall &&
    (this.deps.platform ?? process.platform) === "win32" &&
    finalized.manifest.servers.some((server) => server.transport === "stdio");
  // Plaintext credentials are migrated before anything is persisted; a name
  // conflict is a hard stop, never a silent overwrite.
  for (const secret of finalized.secrets) {
    const existing = await this.deps.secrets.get(USER_SECRET_SCOPE, secret.name);
    if (existing !== undefined && existing !== secret.value)
      throw new RpcError(
        RpcErrorCodes.pluginImportInvalid,
        `Secret ${secret.name} already exists with a different value`,
      );
  }
  const commits: Array<() => void> = [];
  for (const secret of finalized.secrets) {
    const existed = this.deps.secrets.has(USER_SECRET_SCOPE, secret.name);
    const commit = await this.deps.secrets.prepareSet(USER_SECRET_SCOPE, secret.name, secret.value);
    commits.push(() => {
      if (!existed && this.deps.secrets.has(USER_SECRET_SCOPE, secret.name))
        throw new RpcError(RpcErrorCodes.pluginImportInvalid, "Import secret conflict");
      if (!existed) commit();
    });
  }
  const selection = this.selectionPreviews.get(preview.previewId);
  const alreadyInstalled = this.deps.plugins.get(preview.installationId);
  if (selection?.sourceKind === "plugin" && !alreadyInstalled)
    await this.deps.importHost?.materialize({
      selectionId: selection.selectionId,
      installationId: preview.installationId,
      expectedDigest: selection.sourceDigest,
    });
  if (input.botInstall && alreadyInstalled) {
    if (!selection || !this.deps.importHost?.replaceMaterialize)
      throw new RpcError(-32602, "plugin_update_unavailable");
    await this.deps.importHost.replaceMaterialize({
      selectionId: selection.selectionId,
      installationId: preview.installationId,
      expectedDigest: selection.sourceDigest,
    });
    const installation = this.deps.plugins.updateImported({
      installationId: preview.installationId,
      expectedRevision: alreadyInstalled.revision,
      manifest: finalized.manifest,
      digest: finalized.digest,
      actorBotId: this.deps.actorBotId,
      reconcileServers: true,
      changed: { commands: 1, arguments: 1, envNames: 1, websites: 1, files: 1 },
    });
    this.deps.plugins.setImportSettings(
      installation.id,
      finalized.settings,
      preview.plugin?.skills.length ?? 0,
      preview.plugin?.application === true,
      preview.plugin?.applicationCard?.platforms ?? [],
      preview.plugin?.applicationId,
    );
    if (preview.plugin?.skills.length) {
      this.deps.skillCopies?.enqueue(installation.id, targets);
      await this.deps.skillCopies?.run(installation.id, signal);
    }
    this.emitPluginsChanged(installation.id, "imported");
    const connections = this.deps.plugins.connections(installation.id);
    if (input.enable)
      for (const connector of connections) {
        const operation = this.deps.operations.request(
          {
            id: connector.id,
            expectedRevision: connector.revision,
            kind: connector.enabled ? "restart" : "enable",
          },
          this.deps.actorBotId,
        );
        this.emitOperation(operation);
        this.spawn(() => this.runStart(operation), connector.id);
      }
    return { installation, connectors: connections };
  }
  let receipt: ReturnType<PluginsRepo["install"]>;
  try {
    receipt = this.deps.plugins.install({
      id: preview.installationId,
      commitSecrets: () => {
        for (const commit of commits) commit();
        if (preview.plugin?.skills.length)
          this.deps.skillCopies?.enqueue(preview.installationId, targets);
        this.deps.plugins.setImportSettings(
          preview.installationId,
          finalized.settings,
          preview.plugin?.skills.length ?? 0,
          preview.plugin?.application === true,
          preview.plugin?.applicationCard?.platforms ?? [],
          preview.plugin?.applicationId,
        );
      },
      manifest: input.broughtOver?.name
        ? {
            ...finalized.manifest,
            name: { zh: input.broughtOver.name, en: input.broughtOver.name },
          }
        : finalized.manifest,
      ...(input.broughtOver
        ? { origin: { tool: input.broughtOver.tool, key: input.broughtOver.key } }
        : {}),
      ...(input.broughtOver && input.sourcePath ? { originPath: input.sourcePath } : {}),
      digest: finalized.digest,
      sourceKind: selection?.sourceKind === "plugin" ? "directory" : "json",
      actorBotId: this.deps.actorBotId,
      enableWithoutConnectors:
        input.enable && finalized.manifest.servers.length === 0 && !!preview.plugin?.skills.length,
      ...(input.enable &&
        !requiresWindowsConsent && {
          // Enable intents ride the install transaction: committing the receipt
          // without them would let a later retry silently rewrite an interrupted
          // "import and enable" into an import-only one.
          requestEnable: (connectorId: string, expectedRevision: number) =>
            this.deps.operations.request(
              { id: connectorId, expectedRevision, kind: "enable" },
              this.deps.actorBotId,
            ),
        }),
    });
  } catch (error) {
    if (selection?.sourceKind === "plugin" && !alreadyInstalled)
      await this.deps.importHost?.remove({ installationId: preview.installationId });
    throw error;
  }
  // The durable install now owns every secret. Replace the plaintext-bearing preview immediately
  // with a minimal retry receipt before any host cleanup or optional start work can await/fail.
  this.previews.commit(preview, input);

  // Installation committed, so the source capability is no longer needed. Cleanup failures
  // must not hide the durable receipt or retain the in-memory preview indefinitely.
  this.selectionPreviews.delete(preview.previewId);
  if (selection)
    await this.deps.importHost
      ?.release({ selectionId: selection.selectionId })
      .catch(() => undefined);
  if (requiresWindowsConsent && receipt.created) {
    for (const connector of receipt.connectors) {
      const server = this.deps.connectors.configuration(connector.id);
      if (server) await this.confirmWindowsServer(connector, server, false);
    }
    for (const connector of receipt.connectors)
      receipt.enableOperations.push(
        this.deps.operations.request(
          { id: connector.id, expectedRevision: connector.revision, kind: "enable" },
          this.deps.actorBotId,
        ),
      );
  }
  if (!receipt.created) {
    // The import intent already committed on the first attempt: a retry must
    // not replay lifecycle operations for the same receipt. A retry with
    // enable while nothing is enabled is ambiguous — the intent either
    // belonged to a commit the user later disabled, or predates the atomic
    // transaction — so refuse instead of overriding the user's choice.
    if (input.enable && !receipt.installation.enabled)
      throw new RpcError(
        RpcErrorCodes.pluginImportCommitted,
        "Already imported and currently disabled; enable it from the connector list",
      );
    // Later starts are the user's explicit enable/restart decision in the connectors UI.
    // The durable job survives a cancelled UI request; subsequent explicit retries reconcile it.
    if (preview.plugin?.skills.length && (targets.bots.length || targets.groups.length))
      await this.deps.skillCopies?.run(preview.installationId, signal);
    return {
      installation: receipt.installation,
      connectors: receipt.connectors,
      unassignedSkillCount: this.deps.skillCopies?.status(receipt.installation.id).unassignedCount,
      pendingSkillTargetCount: this.deps.skillCopies?.status(receipt.installation.id)
        .pendingTargetCount,
    };
  }
  this.emitPluginsChanged(receipt.installation.id, "imported");
  for (const operation of receipt.enableOperations) {
    this.emitOperation(operation);
    // Enable requests are per-connector, so the id is part of the operation by construction.
    const connectorId = operation.connectorId;
    if (!connectorId)
      throw new RpcError(RpcErrorCodes.internal, "Enable operation without connector id");
    this.spawn(() => this.runStart(operation), connectorId);
  }
  // The durable job survives a cancelled UI request; subsequent explicit retries reconcile it.
  if (preview.plugin?.skills.length && (targets.bots.length || targets.groups.length))
    await this.deps.skillCopies?.run(preview.installationId, signal);
  return {
    installation: receipt.installation,
    unassignedSkillCount: this.deps.skillCopies?.status(receipt.installation.id).unassignedCount,
    pendingSkillTargetCount: this.deps.skillCopies?.status(receipt.installation.id)
      .pendingTargetCount,
    connectors: receipt.connectors.map(
      (connector) => this.deps.connectors.get(connector.id) ?? connector,
    ),
  };
}

export function uninstallStep(
  this: ConnectorServiceOperations,
  input: { installationId: string; expectedRevision: number },
) {
  const operation = this.deps.operations.uninstall(
    input.installationId,
    input.expectedRevision,
    this.deps.actorBotId,
  );
  this.emitOperation(operation);
  // Promptly cancel every in-flight start generation of this installation.
  for (const connector of this.deps.plugins.connections(input.installationId)) {
    this.apps.cancelConnector(connector.id);
    this.lifecycles.get(connector.id)?.abort();
  }
  this.spawnPrompt(() => this.runUninstall(input.installationId, operation));
  return { operationId: operation.id };
}
