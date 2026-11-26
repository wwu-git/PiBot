import { CONNECTOR_IMPORT_MAX_BYTES, type ConnectorAccess } from "@pibot/plugins-contract/full";
import { useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useId, useRef, useState } from "react";
import { ConnectorPanel } from "../page/ConnectorPanel.tsx";
import drawerStyles from "../page/connections/drawer.module.css";
import { localText } from "../page/connections/local-text.ts";
import styles from "../page/connectors.module.css";
import { connectorError } from "../shell/remote.ts";
import {
  fieldVisible,
  ImportPreview,
  type PreviewSummary,
  previewSummary,
} from "./ImportPreview.tsx";

// Previewing and importing a large package (13k files, minutes on a loaded
// machine) is a long operation, not a hung request. A short fixed timeout aborted it mid-way
// and left the user with a failure they could not retry; the bound only guards a real hang.
const LONG_OPERATION_TIMEOUT_MS = 30 * 60_000;
// Settings are re-checked once typing pauses, so each keystroke does not build a new preview.
const SETTINGS_CHECK_DELAY_MS = 600;

export function ImportPlugin({
  close,
  changed,
  initialText = "",
  initialSelectionId,
  presetTarget,
  connected,
}: {
  close(): void;
  changed(): void;
  initialText?: string;
  initialSelectionId?: string;
  presetTarget?: { kind: "bot" | "group"; id: string };
  /** Opens the new connection's details after 连接, instead of only closing. */
  connected?(connectorId: string): void;
}) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const inputId = useId();
  const [targets, setTargets] = useState<ConnectorAccess>(() => ({
    mode: "selected",
    bots: presetTarget?.kind === "bot" ? [presetTarget.id] : [],
    groups: presetTarget?.kind === "group" ? [presetTarget.id] : [],
  }));
  const [text, setText] = useState(initialText);
  const [preview, setPreview] = useState<PreviewSummary>();
  const [config, setConfig] = useState<Record<string, string | number | boolean>>({});
  const [configurationReviewed, setConfigurationReviewed] = useState(true);
  // Bumped by every settings change; a check that started from older values is not a review.
  const configVersion = useRef(0);
  const [checking, setChecking] = useState(false);
  const [settingsError, setSettingsError] = useState<ReturnType<typeof connectorError>>();
  const [busy, setBusy] = useState<"preview" | "import">();
  // A large import copies thousands of files; show real progress instead of a
  // spinner that looks hung for minutes.
  const [progress, setProgress] = useState<{ files: number; total: number }>();
  useRpcEvent("skills.importProgress", (value) => {
    if (value.phase === "copying") setProgress({ files: value.files, total: value.totalFiles });
    else setProgress(undefined);
  });
  const [error, setError] = useState<
    ReturnType<typeof connectorError> | "connectors.tooLarge" | "connectors.skillsPartial"
  >();
  const [partialInstallation, setPartialInstallation] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = useRef(true);
  const locked = useRef(false);
  const previewRef = useRef<{ peer: NonNullable<typeof peer>; id: string } | undefined>(undefined);
  const imported = useRef(false);
  const [cancelError, setCancelError] = useState(false);
  const cancelFailure = useRef(false);
  const retireRef = useRef<() => Promise<void>>(async () => {});
  const retire = async () => {
    const held = previewRef.current;
    previewRef.current = undefined;
    if (!held || imported.current) return;
    try {
      await held.peer.call("plugins.cancelPreview", { previewId: held.id }, { timeoutMs: 5_000 });
    } catch {
      // Expiry still bounds backend retention. Surface cleanup failure while the panel is alive.
      cancelFailure.current = true;
      if (active.current) setCancelError(true);
    }
  };
  retireRef.current = retire;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void retireRef.current();
    };
  }, []);
  // A backend restart invalidates its in-memory preview, even if the panel stays open.
  const originalPeer = useRef(peer);
  useEffect(() => {
    if (originalPeer.current === peer) return;
    originalPeer.current = peer;
    setText("");
    setPreview(undefined);
    setPartialInstallation(undefined);
    setConfigurationReviewed(true);
    setSettingsError(undefined);
    setChecking(false);
    setError("connectors.offline");
    setBusy(undefined);
    locked.current = false;
  }, [peer]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const expired = !!preview && now >= Date.parse(preview.expiresAt);
  const noSkillTarget = !targets.bots.length && !targets.groups.length;
  const targetRequired = !!preview?.plugin?.skillCount && !preview.servers.length && noSkillTarget;
  // With no servers and no skills there is nothing to import; a button that imports nothing
  // looked like a broken preview next to a 「0 个技能」 heading.
  const nothingToImport = !preview?.servers.length && (preview?.plugin?.skillCount ?? 0) === 0;
  const missingRequired =
    preview?.plugin?.config.some((field) => {
      if (!fieldVisible(field, preview.plugin?.config ?? [], config)) return false;
      if (!field.required) return false;
      const value = config[field.key];
      return (
        value === undefined ||
        (typeof value === "string" && value.trim() === "") ||
        (typeof value === "number" && !Number.isFinite(value))
      );
    }) ?? false;
  const currentPeer = useRef(peer);
  currentPeer.current = peer;
  const read = async (selectionId?: string) => {
    if (!peer || locked.current || (!selectionId && !text.trim())) return;
    if (!selectionId && new TextEncoder().encode(text).byteLength > CONNECTOR_IMPORT_MAX_BYTES) {
      setError("connectors.tooLarge");
      return;
    }
    const receiving = peer;
    locked.current = true;
    setBusy("preview");
    setError(undefined);
    try {
      const value = await receiving.call(
        "plugins.previewImport",
        { source: selectionId ? { kind: "selection", selectionId } : { kind: "json", text } },
        { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
      );
      if (!active.current || currentPeer.current !== receiving) {
        // Closing during parsing must also retire a late-created backend preview.
        try {
          await receiving.call(
            "plugins.cancelPreview",
            { previewId: value.previewId },
            { timeoutMs: 5_000 },
          );
        } catch {
          cancelFailure.current = true;
        }
        return;
      }
      setText("");
      imported.current = false;
      previewRef.current = { peer: receiving, id: value.previewId };
      setPreview(previewSummary(value));
      setSettingsError(undefined);
      setConfigurationReviewed((value.plugin?.config.length ?? 0) === 0);
      setConfig(
        Object.fromEntries(
          (value.plugin?.config ?? [])
            .filter((field) => field.default !== undefined)
            .map((field) => [field.key, field.default as string | number | boolean]),
        ),
      );
      setNow(Date.now());
    } catch (failure) {
      if (active.current && currentPeer.current === receiving) setError(connectorError(failure));
    } finally {
      if (active.current && currentPeer.current === receiving) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  const openedSelection = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is consumed once per mounted importer.
  useEffect(() => {
    if (!peer || !initialSelectionId || openedSelection.current) return;
    openedSelection.current = true;
    void read(initialSelectionId);
  }, [peer, initialSelectionId]);
  // The backend re-evaluates the package with the current settings (a changed service address
  // changes what it may reach). It runs by itself once typing pauses. Only one check runs at a
  // time because each replaces the preview it was given; a change made meanwhile checks again.
  const refreshConfiguration = async () => {
    if (!peer || !preview?.plugin || missingRequired || locked.current) return;
    const receiving = peer;
    const version = configVersion.current;
    locked.current = true;
    setChecking(true);
    setSettingsError(undefined);
    try {
      const value = await receiving.call(
        "plugins.previewImport",
        { source: { kind: "configured", previewId: preview.previewId, config } },
        { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
      );
      if (!active.current || currentPeer.current !== receiving) {
        try {
          await receiving.call(
            "plugins.cancelPreview",
            { previewId: value.previewId },
            { timeoutMs: 5_000 },
          );
        } catch {
          cancelFailure.current = true;
        }
        return;
      }
      imported.current = false;
      previewRef.current = { peer: receiving, id: value.previewId };
      setPreview(previewSummary(value));
      // Settings changed while this ran: the new preview id re-arms the check below.
      setConfigurationReviewed(configVersion.current === version);
      setNow(Date.now());
    } catch (failure) {
      if (active.current && currentPeer.current === receiving)
        setSettingsError(connectorError(failure));
    } finally {
      if (active.current && currentPeer.current === receiving) {
        locked.current = false;
        setChecking(false);
      }
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-armed by each settings change and each new preview; the check reads the latest values itself.
  useEffect(() => {
    if (
      !preview?.plugin ||
      configurationReviewed ||
      missingRequired ||
      uncertain ||
      busy ||
      settingsError
    )
      return;
    const timer = setTimeout(() => void refreshConfiguration(), SETTINGS_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [
    config,
    preview?.previewId,
    configurationReviewed,
    missingRequired,
    uncertain,
    busy,
    settingsError,
  ]);
  const setValue = (key: string, value: string | number | boolean) => {
    configVersion.current += 1;
    setConfigurationReviewed(false);
    setSettingsError(undefined);
    setConfig((current) => ({ ...current, [key]: value }));
  };
  const pick = async (kind: "file" | "directory") => {
    if (!peer || locked.current) return;
    locked.current = true;
    setBusy("preview");
    setError(undefined);
    try {
      // The method declares the picker's own long deadline; a shorter local one turned a
      // dialog still on screen into 「未能及时确认结果」. A cancel comes back as a result.
      const result = await peer.call("plugins.pickImport", { kind });
      locked.current = false;
      if (!active.current || result.canceled) return;
      if (result.selectionId) await read(result.selectionId);
    } catch (failure) {
      if (active.current) setError(connectorError(failure));
    } finally {
      if (active.current) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  const install = async (enable: boolean) => {
    if (
      !peer ||
      !preview ||
      (expired && !partialInstallation) ||
      missingRequired ||
      targetRequired ||
      (partialInstallation && noSkillTarget) ||
      !configurationReviewed ||
      locked.current ||
      uncertain
    )
      return;
    const receiving = peer;
    locked.current = true;
    setBusy("import");
    setError(undefined);
    try {
      const result = partialInstallation
        ? await (async () => {
            const status = await receiving.call("plugins.skillAssignments", {
              installationId: partialInstallation,
            });
            const assigned = await receiving.call(
              "plugins.assignSkills",
              {
                installationId: partialInstallation,
                expectedRevision: status.revision,
                targets: { bots: targets.bots, groups: targets.groups },
              },
              { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
            );
            return {
              installation: { id: partialInstallation },
              connectors: [],
              unassignedSkillCount: assigned.unassignedCount,
              pendingSkillTargetCount: assigned.pendingTargetCount,
            };
          })()
        : await receiving.call(
            "plugins.import",
            {
              previewId: preview.previewId,
              expectedDigest: preview.digest,
              enable,
              config,
              // Narrowing the sites a connection may reach is done in its 高级 tab, with
              // confirmation; the connect drawer shows them read-only.
              networkDomains: {},
              skillTargets: { bots: targets.bots, groups: targets.groups },
            },
            { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
          );
      imported.current = true;
      if (active.current && currentPeer.current === receiving) {
        changed();
        const first = result.connectors[0];
        if ((result.pendingSkillTargetCount || result.unassignedSkillCount) && !noSkillTarget) {
          setError("connectors.skillsPartial");
          setPartialInstallation(result.installation.id);
        } else if (enable && first && connected) connected(first.id);
        else close();
      }
    } catch (failure) {
      if (active.current && currentPeer.current === receiving) {
        const key = connectorError(failure);
        setError(key);
        // No blind retries after an ambiguous mutation ACK. Lists/events remain authoritative.
        if (["connectors.timeout", "connectors.offline", "connectors.failed"].includes(key))
          setUncertain(true);
        changed();
      }
    } finally {
      if (active.current && currentPeer.current === receiving) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  const canImport =
    !!peer &&
    !(expired && !partialInstallation) &&
    !missingRequired &&
    !targetRequired &&
    !nothingToImport &&
    configurationReviewed &&
    !checking &&
    !busy &&
    !uncertain;
  const name =
    preview &&
    (preview.plugin?.application?.name[language] || localText(preview.name[language], language));
  return (
    <ConnectorPanel
      title={name ? t("connections.drawer.connectTitle", { name }) : t("connectors.import")}
      close={close}
      busy={busy === "import"}
      footer={
        preview && (
          <>
            {preview.servers.length > 0 && !partialInstallation && (
              <Button
                variant="ghost"
                className={drawerStyles.footStart}
                disabled={!canImport}
                onClick={() => void install(false)}
              >
                {t("connections.drawer.importOnly")}
              </Button>
            )}
            <Button variant="secondary" disabled={busy === "import"} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={busy === "import"}
              disabled={
                partialInstallation ? !peer || noSkillTarget || !!busy || uncertain : !canImport
              }
              onClick={() => void install(true)}
            >
              {t(
                partialInstallation
                  ? "common.retry"
                  : preview.servers.length
                    ? "connections.drawer.connect"
                    : "connectors.importEnable",
              )}
            </Button>
          </>
        )
      }
    >
      {!peer && (
        <p role="alert" className={styles.error}>
          {t("connectors.offline")}
        </p>
      )}
      {!preview ? (
        <div className={styles.formCard}>
          <p className={styles.note}>{t("connectors.jsonNote")}</p>
          <div className={styles.row}>
            {(["file", "directory"] as const).map((kind) => (
              <Button
                key={kind}
                variant="secondary"
                disabled={!!busy || !peer}
                onClick={() => void pick(kind)}
              >
                {t(kind === "file" ? "connectors.chooseJson" : "connectors.chooseDirectory")}
              </Button>
            ))}
          </div>
          <label className={styles.field} htmlFor={inputId}>
            {t("connectors.json")}
            <textarea
              id={inputId}
              value={text}
              rows={12}
              spellCheck={false}
              autoComplete="off"
              disabled={!!busy || !peer}
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </label>
          <Button
            loading={busy === "preview"}
            disabled={!peer || !text.trim()}
            onClick={() => void read()}
          >
            {t(busy === "preview" ? "connectors.reading" : "connectors.preview")}
          </Button>
        </div>
      ) : (
        <ImportPreview
          preview={preview}
          config={config}
          setValue={setValue}
          disabled={busy === "import" || uncertain || !!partialInstallation}
          checking={checking || (!configurationReviewed && !missingRequired && !settingsError)}
          settingsError={settingsError && t(settingsError)}
          targets={targets}
          setTargets={setTargets}
        />
      )}
      {preview && nothingToImport && (
        <p className={styles.note}>{t("connectors.nothingToImport")}</p>
      )}
      {preview && expired && !partialInstallation && (
        <p role="alert" className={styles.error}>
          {t("connectors.expired")}
        </p>
      )}
      {busy === "import" && progress && (
        <p className={styles.note}>
          {t("connectors.importProgress", { files: progress.files, total: progress.total })}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      {cancelError && (
        <p role="alert" className={styles.error}>
          {t("connectors.failed")}
        </p>
      )}
      {uncertain && (
        <>
          <p role="alert">{t("connectors.importUncertain")}</p>
          <Button
            onClick={() => {
              changed();
              close();
            }}
          >
            {t("connectors.checkList")}
          </Button>
        </>
      )}
    </ConnectorPanel>
  );
}
