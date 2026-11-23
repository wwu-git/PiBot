import {
  type BuiltinApp,
  CAPABILITIES,
  type CapabilityId,
  type Connector,
  type ConnectorAccess,
  ConnectorFailureCodeSchema,
  type ConnectorSourceDetails,
  type ConnectorTool,
  supportsDirectConnectionWrites,
} from "@pibot/plugins-contract/full";
import { connectorsZh } from "@pibot/plugins-contract/i18n";
import { hostPlatform, type Peer, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, Chip, IconTile, SegmentedControl, Switch } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import { operationPending, type useConnectorOperations } from "../shell/operations.ts";
import { useConnectorAction, useConnectorPage, useConnectorRead } from "../shell/remote.ts";
import { ConnectionAccessProposal } from "./ConnectionAccessProposal.tsx";
import { ConnectorAccessEditor } from "./ConnectorAccessEditor.tsx";
import { ConnectorDataDestinations } from "./ConnectorDataDestinations.tsx";
import { ConnectorFeedback, ConnectorPagination, OperationStatus } from "./ConnectorFeedback.tsx";
import { ConnectorNetworkEditor } from "./ConnectorNetworkEditor.tsx";
import { ConnectorPanel } from "./ConnectorPanel.tsx";
import { ConnectorRecentUse } from "./ConnectorRecentUse.tsx";
import { ConnectorSandboxSection, ConnectorStartFailureView } from "./ConnectorSandbox.tsx";
import { ConnectorSourceDiff } from "./ConnectorSourceDiff.tsx";
import {
  connectionFailureCode,
  connectorSwitchChecked,
  runsOutsideSandbox,
} from "./connection-state.ts";
import styles from "./connectors.module.css";
import { DirectToolGrants } from "./DirectToolGrants.tsx";
import { ImportedSkillAssignment } from "./ImportedSkillAssignment.tsx";
import { connectorName } from "./presentation.ts";

type Operations = ReturnType<typeof useConnectorOperations>;
export function ConnectorDetails({
  id,
  initialSection,
  requestedTarget,
  apps,
  snapshot,
  operations,
  suggestedCapabilities = [],
  changed,
  close,
}: {
  id: string;
  initialSection?: "access" | "advanced";
  requestedTarget?: { kind: "bot" | "group"; id: string };
  apps?: BuiltinApp[];
  snapshot: number;
  operations: Operations;
  /** Confirmed catalog mappings; only overlaps with a built-in tool are worth telling the user. */
  suggestedCapabilities?: readonly CapabilityId[];
  changed(): void;
  close(): void;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const load = useCallback(
    (peer: Peer, signal: AbortSignal) => peer.call("connectors.get", { id }, { signal }),
    [id],
  );
  const detail = useConnectorRead(load);
  const catalog = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        apps ? Promise.resolve({ items: apps }) : peer.call("apps.list", {}, { signal }),
      [apps],
    ),
  );
  const loadTools = useCallback(
    (peer: Peer, signal: AbortSignal, cursor?: string) =>
      peer.call("connectors.tools", { id, cursor, limit: 50 }, { signal }),
    [id],
  );
  const tools = useConnectorPage(loadTools, snapshot);
  // The sandbox switch and the last start failure (desktop-only RPC).
  const diagnostics = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal) => peer.call("connectors.diagnostics", { id }, { signal }),
      [id],
    ),
  );
  const refreshDetail = detail.refresh;
  const refreshDiagnostics = diagnostics.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: All connector events retire the selected detail snapshot.
  useEffect(() => {
    refreshDetail();
    refreshDiagnostics();
  }, [snapshot, refreshDetail, refreshDiagnostics]);
  const refresh = () => {
    detail.refresh();
    diagnostics.refresh();
    tools.refresh();
    changed();
  };
  const action = useConnectorAction(refresh);
  const connector = detail.value?.connector;
  const localApp =
    catalog.value?.items.find((app) => app.id === connector?.appId)?.category === "local";
  const connectionFailed =
    connector && ["needs_setup", "needs_auth", "error"].includes(connector.status);
  const failure = ConnectorFailureCodeSchema.safeParse(
    connectionFailureCode(connector?.statusDetailCode, detail.value?.auth === "system"),
  );
  const latest = operations.rows
    .filter(
      (row) =>
        row.connectorId === id ||
        (row.connectorId === null && row.installationId === connector?.pluginInstallationId),
    )
    .at(-1);
  const pendingRows = operations.rows.filter(
    (row) =>
      (row.connectorId === id ||
        (row.connectorId === null && row.installationId === connector?.pluginInstallationId)) &&
      operationPending(row),
  );
  const pending = pendingRows.length > 0;
  const blocked = action.disabled || detail.loading || !!detail.error || !connector;
  const disabled = blocked || pending;
  // Capabilities are not a user-facing concept (maintainers 2026-10-24): GitHub / Notion / Figma are
  // just connections, and where a connection overlaps a built-in tool the built-in one is used.
  const overlapNames = suggestedCapabilities.flatMap((capabilityId) => {
    const definition = CAPABILITIES.find(({ id }) => id === capabilityId);
    return definition?.hasBuiltin ? [definition.name[language]] : [];
  });
  // Restart keeps the connector "stopping" until discovery completes. The
  // operation, rather than that snapshot status, identifies a cancellable start.
  const stopAvailable =
    pending &&
    pendingRows.every(({ operation }) =>
      operation
        ? (operation.kind === "enable" || operation.kind === "restart") &&
          (operation.state === "pending" || operation.state === "running") &&
          operation.phase !== "draining"
        : connector?.status === "starting",
    );
  const stopDisabled = blocked || (pending && !stopAvailable);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const targetKey = requestedTarget ? `${requestedTarget.kind}:${requestedTarget.id}` : "";
  const [confirmedTarget, setConfirmedTarget] = useState<string>();
  const targetConfirmed = confirmedTarget === targetKey;
  const [authorization, setAuthorization] = useState<{
    authorizationId: string;
    expiresAt: string;
  }>();
  const [token, setToken] = useState("");
  const [sourceUpdate, setSourceUpdate] = useState<{
    state: "preview" | "source_not_found" | "updated";
    details?: ConnectorSourceDetails;
    sourceDigest?: string;
    changes: {
      commands: number;
      arguments: number;
      envNames: number;
      websites: number;
      files: number;
    };
  }>();
  const updateFromSource = async (confirmed: boolean) => {
    if (!connector || disabled) return;
    const result = await action.run(
      (peer, signal) =>
        peer.call(
          "connectors.updateFromSource",
          {
            id,
            expectedRevision: connector.revision,
            confirmed,
            ...(confirmed && sourceUpdate?.sourceDigest
              ? { expectedDigest: sourceUpdate.sourceDigest }
              : {}),
          },
          { signal },
        ),
      330_000,
    );
    if (!result) {
      setSourceUpdate(undefined);
      return;
    }
    if (result.state === "preview") setSourceUpdate(result);
    else if (result.state === "source_not_found") setSourceUpdate(result);
    else if (result.state === "updated") {
      setSourceUpdate(result);
      refresh();
    }
  };
  useEffect(() => {
    if (connector?.status === "ready" || connector?.status === "idle") setAuthorization(undefined);
  }, [connector?.status]);
  const authorize = async () => {
    if (!connector || action.disabled) return;
    const submitted = token;
    setToken("");
    const result = await action.run((peer, signal) =>
      peer.call(
        "connectors.authorize",
        {
          id,
          expectedRevision: connector.revision,
          ...(submitted ? { token: submitted } : {}),
        },
        { signal },
      ),
    );
    if (result && detail.value?.auth === "oauth") setAuthorization(result);
  };
  const [waitingNative, setWaitingNative] = useState(false);
  const lifecycle = async (kind: "enable" | "disable" | "restart" | "disconnect") => {
    const gate = kind === "enable" || kind === "restart" ? disabled : stopDisabled;
    if (!connector || gate) return;
    const mayConfirm =
      (kind === "enable" || kind === "restart") &&
      (hostPlatform() === "win32" || connector.outsideSandbox);
    setWaitingNative(mayConfirm);
    const value = await action.run(
      (peer, signal) => {
        const params = { id, expectedRevision: connector.revision };
        if (kind === "enable" || kind === "disable")
          return peer.call(
            "connectors.setEnabled",
            { ...params, enabled: kind === "enable" },
            { signal },
          );
        return peer.call(
          kind === "restart" ? "connectors.restart" : "connectors.disconnect",
          params,
          { signal },
        );
      },
      mayConfirm ? 330_000 : 30_000,
    );
    setWaitingNative(false);
    if (value) {
      operations.track(value.operationId, connector.pluginInstallationId, id);
      setConfirmDisconnect(false);
    }
  };
  const setOutsideSandbox = async (enabled: boolean) => {
    if (!connector || disabled) return;
    setWaitingNative(enabled);
    const value = await action.run(
      (peer, signal) =>
        peer.call(
          "connectors.setOutsideSandbox",
          { id, expectedRevision: connector.revision, enabled },
          { signal },
        ),
      enabled ? 330_000 : 30_000,
    );
    setWaitingNative(false);
    if (value?.operationId) operations.track(value.operationId, connector.pluginInstallationId, id);
  };
  const update = (
    patch: {
      networkDomains?: string[];
      access?: ConnectorAccess;
      confirmationMode?: Connector["confirmationMode"];
      tools?: { tool: string; enabled: boolean; readOnly: boolean }[];
    },
    resolveAccess?: (peer: Peer, signal: AbortSignal) => Promise<ConnectorAccess>,
  ) => {
    if (!connector || disabled) return Promise.resolve(undefined);
    return action.run(async (peer, signal) =>
      peer.call(
        "connectors.update",
        {
          id,
          expectedRevision: connector.revision,
          ...patch,
          ...(resolveAccess ? { access: await resolveAccess(peer, signal) } : {}),
        },
        { signal },
      ),
    );
  };
  return (
    <ConnectorPanel
      title={
        connector
          ? connectorName(connector, catalog.value?.items ?? [], language)
          : t("connectors.title")
      }
      close={close}
      busy={action.busy}
    >
      {waitingNative && (
        <p role="status" className={styles.note}>
          {t("connectors.nativeConfirmationWaiting")}
        </p>
      )}
      <ConnectorFeedback
        loading={detail.loading}
        error={detail.error ?? action.error}
        retry={refresh}
      />
      {connector && (
        <>
          <div className={styles.statusCard}>
            <IconTile icon="plug" tone="blue" size="lg" />
            <Chip
              tone={
                connector.status === "ready" || connector.status === "idle"
                  ? "ok"
                  : connectionFailed
                    ? "warn"
                    : "neutral"
              }
            >
              {t(`connectors.status.${connector.status}`)}
            </Chip>
            {runsOutsideSandbox(connector, hostPlatform()) && (
              <Chip tone="warn">{t("connectors.outsideSandbox.badge")}</Chip>
            )}
            <span className={`${styles.note} ${styles.grow}`}>
              {t(
                localApp
                  ? "connectors.category.local"
                  : connector.identity === "user"
                    ? "connectors.userIdentity"
                    : "connectors.botIdentity",
              )}
            </span>
            <Switch
              checked={connectorSwitchChecked(connector)}
              label={t(connector.enabled ? "connectors.disable" : "connectors.enable")}
              disabled={connectionFailed || (connector.enabled ? stopDisabled : disabled)}
              onCheckedChange={(enabled) => void lifecycle(enabled ? "enable" : "disable")}
            />
          </div>
          {overlapNames.length > 0 && (
            <p className={styles.note}>
              {t("capabilities.builtinOverlap", {
                capabilities: overlapNames.join(language === "zh" ? "、" : ", "),
              })}
            </p>
          )}
          {detail.value?.bundledNode && (
            <p className={styles.note}>{t("connectors.bundledNode")}</p>
          )}
          {(["needs_setup", "needs_auth", "error"] as Connector["status"][]).includes(
            connector.status,
          ) &&
            (diagnostics.value?.lastFailure ? (
              <ConnectorStartFailureView failure={diagnostics.value.lastFailure} />
            ) : (
              <p className={styles.warn}>
                {failure.success
                  ? t(`connectors.failure.${failure.data}`)
                  : t("connectors.setupNote")}
                {connector.kind === "mcp_stdio" && connector.status === "error" && (
                  <> {t("connectors.startFailure.restartToSee")}</>
                )}
              </p>
            ))}
          {hostPlatform() === "win32" && connector.kind === "mcp_stdio" && (
            <p className={styles.warn}>{t("connectors.windowsWarning")}</p>
          )}
          {diagnostics.value && (
            <ConnectorSandboxSection
              connector={connector}
              diagnostics={diagnostics.value}
              disabled={disabled}
              toggle={(enabled) => void setOutsideSandbox(enabled)}
            />
          )}
          {detail.value?.canEditNetworkDomains && (
            <ConnectorNetworkEditor
              key={`${id}:${connector.revision}`}
              domains={detail.value.networkDomains ?? []}
              disabled={disabled}
              save={(networkDomains) => void update({ networkDomains })}
            />
          )}
          {(connector.status === "needs_auth" ||
            connector.status === "needs_setup" ||
            connector.status === "disabled") &&
            ((detail.value?.auth === "bearer" && detail.value.canReplaceCredential !== false) ||
              detail.value?.auth === "oauth") && (
              <section className={styles.stack}>
                {detail.value?.auth === "bearer" && (
                  <label className={styles.field}>
                    {t("connectors.appToken")}
                    <input
                      type="password"
                      value={token}
                      autoComplete="new-password"
                      disabled={action.disabled}
                      maxLength={16384}
                      onChange={(event) => setToken(event.currentTarget.value)}
                    />
                  </label>
                )}
                {authorization ? (
                  <>
                    <p role="status">{t("connectors.authorizing")}</p>
                    <Button
                      variant="secondary"
                      disabled={action.disabled}
                      onClick={() =>
                        void action.run(async (peer, signal) => {
                          await peer.call(
                            "connectors.cancelAuthorization",
                            { authorizationId: authorization.authorizationId },
                            { signal },
                          );
                          setAuthorization(undefined);
                        })
                      }
                    >
                      {t("connectors.cancelAuth")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={action.disabled || (detail.value?.auth === "bearer" && !token.trim())}
                    onClick={() => void authorize()}
                  >
                    {t("connectors.reauthorize")}
                  </Button>
                )}
              </section>
            )}
          {detail.value?.auth === "bearer" && detail.value.canReplaceCredential === false && (
            <p className={styles.note}>{t("connectors.sharedCredentialNote")}</p>
          )}
          <OperationStatus
            row={latest}
            check={operations.check}
            systemAuth={detail.value?.auth === "system"}
          />
          {!localApp && (
            <div className={styles.row}>
              <Button
                variant="secondary"
                disabled={stopDisabled}
                onClick={() => setConfirmDisconnect(true)}
              >
                {t("connectors.disconnect")}
              </Button>
            </div>
          )}
          {confirmDisconnect && (
            <section className={styles.warn}>
              <p>{t("connectors.disconnectConfirm")}</p>
              <div className={styles.row}>
                <Button
                  variant="secondary"
                  disabled={action.busy}
                  onClick={() => setConfirmDisconnect(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  className={styles.dangerButton}
                  disabled={stopDisabled}
                  onClick={() => void lifecycle("disconnect")}
                >
                  {t("connectors.disconnect")}
                </Button>
              </div>
            </section>
          )}
          {!connector.appId && (
            <ImportedSkillAssignment
              installationId={connector.pluginInstallationId}
              changed={changed}
            />
          )}
          {detail.value &&
            (requestedTarget &&
            !targetConfirmed &&
            initialSection === "access" &&
            detail.value.access.mode !== "all" ? (
              <ConnectionAccessProposal
                key={`${targetKey}:${connector.revision}`}
                access={detail.value.access}
                target={requestedTarget}
                disabled={disabled}
                confirm={(access) => {
                  void update({ access }).then((saved) => {
                    if (saved) setConfirmedTarget(targetKey);
                  });
                }}
              />
            ) : (
              <ConnectorAccessEditor
                access={detail.value.access}
                disabled={disabled}
                resolveAndSave={(resolve) => void update({}, resolve)}
                save={(access) => {
                  void update({ access });
                }}
              />
            ))}
          <section className={styles.stack}>
            <h3>{t("connectors.confirmation")}</h3>
            <fieldset className={styles.optCards} disabled={disabled}>
              <legend className={styles.visuallyHidden}>{t("connectors.confirmation")}</legend>
              {(
                [
                  "read_write",
                  "always_ask",
                  "read_only",
                  ...(supportsDirectConnectionWrites(connector.kind)
                    ? (["direct_read_write"] as const)
                    : []),
                ] as const
              ).map((mode) => (
                <label className={styles.optCard} key={mode}>
                  <input
                    type="radio"
                    name={`confirmation-${id}`}
                    value={mode}
                    checked={connector.confirmationMode === mode}
                    onChange={() => update({ confirmationMode: mode })}
                  />
                  <span>
                    {t(`connectors.confirmation.${mode}`)}
                    {mode === "direct_read_write" && (
                      <span className={styles.note} style={{ display: "block" }}>
                        {t("connectors.directReadWriteNote")}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
            <p className={styles.note}>{t("connectors.confirmationNote")}</p>
          </section>
          <DirectToolGrants id={id} />
          <ConnectorRecentUse id={id} snapshot={snapshot} />
          <ConnectorDataDestinations id={id} snapshot={snapshot} />
          <details className={styles.stack} open={initialSection === "advanced" || undefined}>
            <summary>{t("connectors.advanced")}</summary>
            <div className={styles.stack}>
              <section className={styles.stack}>
                <h3>{t("connectors.updateSource")}</h3>
                {!sourceUpdate || sourceUpdate.state === "preview" ? (
                  <p className={styles.note}>{t("connectors.updateSourceConfirm")}</p>
                ) : sourceUpdate.state === "source_not_found" ? (
                  <p className={styles.note}>{t("connectors.updateSourceNotFound")}</p>
                ) : (
                  <p className={styles.note}>{t("connectors.updateSourceDone")}</p>
                )}
                {sourceUpdate && sourceUpdate.state === "preview" && (
                  <>
                    <p className={styles.note}>
                      {t("connectors.updateSourceDiff", sourceUpdate.changes)}
                    </p>
                    {sourceUpdate.details && <ConnectorSourceDiff details={sourceUpdate.details} />}
                  </>
                )}
                <Button
                  variant="secondary"
                  disabled={disabled || (sourceUpdate?.state !== "preview" && !!sourceUpdate)}
                  onClick={() => void updateFromSource(!!sourceUpdate)}
                >
                  {t("connectors.updateSource")}
                </Button>
              </section>
              <div className={styles.row}>
                <Button
                  variant="secondary"
                  disabled={disabled || connector.status === "starting"}
                  onClick={() => void lifecycle("restart")}
                >
                  {t("connectors.restart")}
                </Button>
              </div>
              <section className={styles.stack}>
                <h3>{t("connectors.tools")}</h3>
                <p className={styles.note}>{t("connectors.toolsNote")}</p>
                {tools.value?.items.map((tool) => (
                  <ToolRow
                    key={`${tool.catalogVersion}:${tool.tool}`}
                    tool={tool}
                    disabled={disabled || tools.loading || !!tools.error}
                    save={(patch) => update({ tools: [patch] })}
                  />
                ))}
                {!tools.loading && !tools.error && !tools.value?.items.length && (
                  <p>{t("connectors.noTools")}</p>
                )}
                <ConnectorFeedback
                  loading={tools.loading}
                  error={tools.error}
                  retry={tools.refresh}
                />
                <ConnectorPagination
                  previous={tools.previous}
                  next={tools.next}
                  disabled={tools.loading || disabled}
                />
              </section>
            </div>
          </details>
        </>
      )}
      {!peer && <p role="status">{t("connectors.offline")}</p>}
    </ConnectorPanel>
  );
}

function ToolRow({
  tool,
  disabled,
  save,
}: {
  tool: ConnectorTool;
  disabled: boolean;
  save(patch: { tool: string; enabled: boolean; readOnly: boolean }): void;
}) {
  const { t } = useSettings();
  const key = `connectors.tool.${tool.tool}`;
  const label = Object.hasOwn(connectorsZh, key)
    ? t(key as keyof typeof connectorsZh)
    : tool.tool
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .slice(0, 100)
        .replace(/^./u, (char) => char.toUpperCase());
  const mode = !tool.enabled ? "disabled" : tool.readOnly ? "read_only" : "confirm_write";
  return (
    <div className={styles.toolRow}>
      <IconTile
        icon={mode === "disabled" ? "pause" : tool.readOnly ? "search" : "edit"}
        tone={mode === "disabled" ? "neutral" : tool.readOnly ? "teal" : "orange"}
        size="lg"
      />
      <div className={styles.toolText}>
        <strong>{label}</strong>
        <small>
          {t(tool.readOnly ? "connectors.readToolSummary" : "connectors.writeToolSummary")}
        </small>
        {tool.suggestedReadOnly && <small>{t("connectors.suggested")}</small>}
        {tool.readOnlyLocked && <small>{t("connectors.toolMode.readOnlyLocked")}</small>}
      </div>
      <SegmentedControl
        label={t("connectors.toolModeFor", { name: label })}
        disabled={disabled}
        value={mode}
        options={[
          {
            value: "read_only",
            label: t("connectors.toolMode.readOnly"),
            disabled: tool.readOnlyLocked,
          },
          { value: "confirm_write", label: t("connectors.toolMode.confirmWrite") },
          { value: "disabled", label: t("connectors.toolMode.disabled") },
        ]}
        onValueChange={(next) =>
          save({
            tool: tool.tool,
            enabled: next !== "disabled",
            readOnly: next === "read_only",
          })
        }
      />
    </div>
  );
}
