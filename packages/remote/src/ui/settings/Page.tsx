import { OFFICIAL_RELAY_URL, type RemoteSettings } from "@pibot/remote-contract";
import {
  layoutStyles,
  SettingsBack,
  SettingsEmpty,
  SettingsFold,
  SettingsHero,
  SettingsLine,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  useT,
} from "@pibot/renderer-kit";
import { Button, Chip, IconTile, SegmentedControl, Switch, TextField } from "@pibot/ui";
import { useEffect, useState } from "react";
import { DeviceRow } from "../devices/DeviceRow.tsx";
import { EndpointCapabilities } from "../devices/EndpointCapabilities.tsx";
import { OfflineModels } from "../devices/OfflineModels.tsx";
import { RunnerControl } from "../devices/RunnerControl.tsx";
import { Pairing } from "../pairing/Pairing.tsx";
import { DirectSettings } from "./DirectSettings.tsx";
import styles from "./remote.module.css";
import { StunPrivacy } from "./StunPrivacy.tsx";
import { useRemoteSettings } from "./use-remote.ts";

export function RemoteSettingsPage() {
  const t = useT();
  const remote = useRemoteSettings();
  const [draft, setDraft] = useState<RemoteSettings>();
  const [selectedId, setSelectedId] = useState<string>();
  const [addMenu, setAddMenu] = useState(false);
  const [runnerInput, setRunnerInput] = useState(false);
  // Only a self-hosted relay is named; the official relay adds nothing to the code or the note.
  const runnerRelayHost =
    remote.pair?.kind === "runner" ? remote.pair.payload?.split("@")[1] : undefined;
  const runnerStatus =
    remote.pair?.kind !== "runner"
      ? undefined
      : remote.pair.status === "paired"
        ? t("remote.runner.addedNamed", {
            name: remote.devices.find((device) => device.id === remote.pair?.deviceId)?.name ?? "",
          })
        : remote.pair.status === "waiting"
          ? remote.pair.relayProblem === "unreachable"
            ? t("remote.runner.relayUnreachable")
            : remote.pair.relayProblem === "tls"
              ? t("remote.runner.relayTls")
              : remote.pair.relayProblem === "certificate"
                ? t("remote.runner.relayCertificate")
                : t("remote.runner.waiting")
          : remote.pair.status === "expired"
            ? t("remote.runner.expired")
            : remote.pair.status === "failed"
              ? t("remote.error.pairFailed")
              : undefined;
  const [runnerCode, setRunnerCode] = useState("");
  const [runnerDialog, setRunnerDialog] = useState(false);
  useEffect(() => {
    if (!runnerDialog || remote.pair?.status !== "paired") return;
    const timer = setTimeout(() => {
      setRunnerDialog(false);
    }, 1800);
    return () => clearTimeout(timer);
  }, [runnerDialog, remote.pair?.status]);
  const [tab, setTab] = useState<"capabilities" | "offline" | "control">("capabilities");
  useEffect(() => {
    setDraft(remote.settings);
  }, [remote.settings]);
  const edit = (patch: Partial<RemoteSettings>) =>
    setDraft((old) => (old ? { ...old, ...patch } : old));
  /**
   * Maintainers 2026-11-12/13: every setting takes effect as it is changed, with no save or confirm
   * step (a confirmation banner far from the row made changes look lost). A change that sends
   * data somewhere new (validateSettingsChange: turning remote on, another relay, a new STUN
   * server) is consented by the user's own choice on a row whose note says what goes where.
   */
  const commit = (patch: Partial<Omit<RemoteSettings, "version">>) => {
    edit(patch);
    const saved = remote.settings;
    if (!saved) return;
    const { version: _, ...base } = saved;
    const next = { ...base, ...patch };
    const sendsSomewhereNew =
      (next.enabled &&
        (!saved.enabled || next.relay !== saved.relay || next.relayUrl !== saved.relayUrl)) ||
      (next.direct.mode === "stun" &&
        (saved.direct.mode !== "stun" || saved.direct.stunUrl !== next.direct.stunUrl));
    void remote.save(next, sendsSomewhereNew);
  };
  if (remote.loading || !draft)
    return (
      <SettingsPage>
        <SettingsLine
          role={remote.error ? "alert" : "status"}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void remote.reload();
              }}
            >
              {t("remote.retry")}
            </Button>
          }
        >
          {t(remote.error ? "remote.failed" : "remote.loading")}
        </SettingsLine>
      </SettingsPage>
    );
  const selected = remote.devices.find((device) => device.id === selectedId);
  const pathLabel = (device: (typeof remote.devices)[number]) => {
    const connection = device.kind === "runner" ? device.runnerConnection : undefined;
    const path = typeof connection === "object" ? connection.path : device.path;
    return t(
      path === "lan"
        ? "remote.runner.path.lan"
        : path === "punched"
          ? "remote.runner.path.punched"
          : path === "address"
            ? "remote.runner.path.address"
            : path === "relay"
              ? "remote.runner.path.relay"
              : "remote.path.direct",
    );
  };
  type Device = (typeof remote.devices)[number];
  const deviceRow = (device: Device) => (
    <button
      className={styles.deviceSummary}
      key={device.id}
      type="button"
      onClick={() => {
        setTab("capabilities");
        setSelectedId(device.id);
      }}
    >
      <IconTile
        icon={device.kind === "phone" ? "phone" : "laptop"}
        tone={device.kind === "phone" ? "teal" : "blue"}
        size="lg"
      />
      <span className={styles.deviceSummaryText}>
        <strong>{device.name}</strong>
        <span>
          <i className={device.online ? styles.onlineDot : styles.offlineDot} />
          {device.online ? t("remote.online") : t("remote.offline")} · {pathLabel(device)}
        </span>
      </span>
      {device.kind === "runner" && device.isolation && !device.isolation.available && (
        <Chip tone="warn">{t("remote.runner.commandApproval")}</Chip>
      )}
      <span className={styles.deviceChevron} aria-hidden="true">
        ›
      </span>
    </button>
  );
  const phones = remote.devices.filter((device) => device.kind === "phone");
  const runners = remote.devices.filter((device) => device.kind === "runner");
  const errorLine = remote.error && (
    <SettingsLine
      role="alert"
      tone="danger"
      action={
        <Button
          variant="secondary"
          onClick={() => {
            void remote.reload();
          }}
        >
          {t("remote.retry")}
        </Button>
      }
    >
      {t(
        remote.error === "stale"
          ? "remote.stale"
          : remote.error === "failed"
            ? "remote.failed"
            : `remote.error.${remote.error}`,
      )}
    </SettingsLine>
  );
  if (selected) {
    // The device card, then its details one tab at a time.
    const tabs =
      selected.kind === "phone"
        ? (["capabilities", "offline", "control"] as const)
        : (["capabilities", "control"] as const);
    const current = (tabs as readonly string[]).includes(tab) ? tab : "capabilities";
    return (
      <SettingsPage>
        {errorLine}
        <SettingsBack label={t("remote.devices")} onClick={() => setSelectedId(undefined)} />
        <div className={layoutStyles.card}>
          <DeviceRow
            device={selected}
            busy={remote.busy}
            rename={(id, name) => void remote.rename(id, name)}
            revoke={remote.revoke}
          />
          {selected.kind === "runner" &&
            !selected.online &&
            selected.isolation &&
            !selected.isolation.available && (
              <SettingsLine tone="warn">{t("remote.runner.commandApproval")}</SettingsLine>
            )}
        </div>
        <SegmentedControl
          label={selected.name}
          value={current}
          options={tabs.map((value) => ({
            value,
            label: t(
              value === "capabilities"
                ? "remote.tab.capabilities"
                : value === "offline"
                  ? "remote.tab.offline"
                  : selected.kind === "phone"
                    ? "remote.tab.runners"
                    : "remote.tab.phones",
            ),
          }))}
          onValueChange={setTab}
        />
        {current === "capabilities" && (
          <EndpointCapabilities paired={remote.devices} endpointId={selected.id} />
        )}
        {current === "offline" && selected.kind === "phone" && (
          <OfflineModels deviceId={selected.id} disabled={remote.busy} />
        )}
        {current === "control" &&
          (selected.kind === "phone" ? (
            <RunnerControl phoneId={selected.id} disabled={remote.busy} />
          ) : (
            <RunnerControl runnerDeviceId={selected.id} disabled={remote.busy} />
          ))}
      </SettingsPage>
    );
  }
  return (
    <SettingsPage>
      <div className={styles.leadRow}>
        <p className={layoutStyles.lead}>{t("remote.lead")}</p>
        <div className={styles.addDeviceWrap}>
          <Button
            disabled={remote.busy || !remote.status?.pairingAvailable}
            aria-expanded={addMenu}
            onClick={() => setAddMenu((value) => !value)}
          >
            {t("remote.addDevice")}
          </Button>
          {addMenu && (
            <div className={styles.addDeviceMenu}>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setAddMenu(false);
                  void remote.add();
                }}
              >
                <IconTile icon="phone" tone="teal" size="sm" />
                {t("remote.addPhone")}
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setAddMenu(false);
                  setRunnerDialog(true);
                  setRunnerInput(false);
                  void remote.add("runner");
                }}
              >
                <IconTile icon="laptop" tone="violet" size="sm" />
                {t("remote.addRunner")}
              </button>
            </div>
          )}
        </div>
      </div>
      {errorLine}
      <SettingsHero
        icon="laptop"
        title={draft.desktopName}
        note={
          remote.status ? (
            <>
              <i className={draft.enabled ? styles.onlineDot : styles.offlineDot} />
              {t(`remote.status.${remote.status.reason}`)}
            </>
          ) : (
            t("remote.enabled")
          )
        }
      >
        <Switch
          label={t("remote.enabled")}
          checked={draft.enabled}
          disabled={remote.busy}
          onCheckedChange={(enabled) => commit({ enabled })}
        />
      </SettingsHero>
      <p className={layoutStyles.note}>{t("remote.disclosure")}</p>
      {!draft.enabled && <SettingsLine>{t("remote.enableBeforePair")}</SettingsLine>}
      {runnerDialog && (
        <div className={layoutStyles.card}>
          <SettingsRow
            icon="laptop"
            tone="violet"
            label={t(runnerInput ? "remote.runner.code" : "remote.runner.addTitle")}
            stacked
          >
            {runnerInput ? (
              <div className={styles.actions}>
                <TextField
                  label={t("remote.runner.code")}
                  value={runnerCode}
                  maxLength={1152}
                  onChange={(event) => setRunnerCode(event.target.value)}
                />
                <Button
                  disabled={remote.busy || runnerCode.length < 25}
                  onClick={() => {
                    const code = runnerCode;
                    void remote.addRunner(code).then((added) => {
                      if (added) {
                        setRunnerCode("");
                        setRunnerDialog(false);
                      }
                    });
                  }}
                >
                  {t("remote.runner.add")}
                </Button>
              </div>
            ) : (
              <div className={styles.runnerCode}>
                <p className={styles.runnerNote}>{t("remote.runner.howTo")}</p>
                <TextField
                  label={t("remote.runner.code")}
                  value={remote.pair?.payload ?? ""}
                  readOnly
                />
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    disabled={!remote.pair?.payload}
                    onClick={() => void navigator.clipboard.writeText(remote.pair?.payload ?? "")}
                  >
                    {t("remote.runner.copyCode")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={remote.busy}
                    onClick={() => void remote.add("runner")}
                  >
                    {t("remote.runner.newCode")}
                  </Button>
                </div>
                <p className={styles.runnerNote}>
                  {t("remote.runner.generatedNote")}
                  {runnerRelayHost ? t("remote.runner.viaRelay", { host: runnerRelayHost }) : ""}
                </p>
                {runnerStatus && (
                  <p
                    className={styles.runnerNote}
                    role={remote.pair?.relayProblem ? "alert" : undefined}
                  >
                    {runnerStatus}
                  </p>
                )}
              </div>
            )}
            <div className={styles.actions}>
              <Button
                variant="ghost"
                disabled={remote.busy}
                onClick={() => {
                  if (!runnerInput) void remote.cancel();
                  else void remote.add("runner");
                  setRunnerInput(!runnerInput);
                }}
              >
                {t(runnerInput ? "remote.runner.useGenerated" : "remote.runner.useLegacy")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void remote.cancel();
                  setRunnerDialog(false);
                }}
              >
                {t("remote.runner.closeCode")}
              </Button>
            </div>
          </SettingsRow>
        </div>
      )}
      {!runnerDialog && remote.pair && remote.pair.kind !== "runner" && (
        <div className={layoutStyles.card}>
          <Pairing pair={remote.pair} busy={remote.busy} cancel={() => void remote.cancel()} />
        </div>
      )}
      <SettingsSection title={`${t("remote.phones")} · ${phones.length}`}>
        {phones.map(deviceRow)}
        {!phones.length && <SettingsEmpty icon="phone" title={t("remote.empty")} />}
      </SettingsSection>
      <SettingsSection title={`${t("remote.runners")} · ${runners.length}`}>
        {runners.map(deviceRow)}
        {!runners.length && <SettingsEmpty icon="laptop" title={t("remote.empty")} />}
      </SettingsSection>
      {remote.hasMore && (
        <Button variant="secondary" disabled={remote.busy} onClick={() => void remote.more()}>
          {t("remote.more")}
        </Button>
      )}
      <SettingsFold
        icon="network"
        tone="teal"
        title={t("remote.advanced")}
        summary={t("remote.advancedSummary")}
      >
        <SettingsRow
          icon="server"
          tone="teal"
          label={t("remote.relay")}
          note={
            // Maintainers 2026-11-12: name the official relay so users see where data goes.
            draft.relay === "official"
              ? t("remote.officialAddress", { url: OFFICIAL_RELAY_URL })
              : undefined
          }
        >
          <SegmentedControl
            label={t("remote.relay")}
            value={draft.relay}
            disabled={remote.busy}
            options={[
              { value: "official", label: t("remote.official") },
              { value: "custom", label: t("remote.custom") },
            ]}
            onValueChange={(relay) =>
              // A custom relay is saved once its address is entered (on leaving the field).
              relay === "custom" && !draft.relayUrl ? edit({ relay }) : commit({ relay })
            }
          />
        </SettingsRow>
        {draft.relay === "custom" && (
          <SettingsRow icon="server" tone="teal" label={t("remote.address")} stacked>
            <TextField
              label={t("remote.address")}
              hideLabel
              value={draft.relayUrl ?? ""}
              maxLength={2048}
              disabled={remote.busy}
              onChange={(e) => edit({ relayUrl: e.target.value || null })}
              onBlur={() => {
                if (draft.relayUrl && draft.relayUrl !== remote.settings?.relayUrl)
                  commit({ relay: "custom", relayUrl: draft.relayUrl });
              }}
            />
          </SettingsRow>
        )}
        <SettingsRow icon="edit" tone="blue" label={t("remote.desktopName")} stacked>
          <TextField
            label={t("remote.desktopName")}
            hideLabel
            value={draft.desktopName}
            maxLength={80}
            disabled={remote.busy}
            onChange={(e) => edit({ desktopName: e.target.value })}
            onBlur={() => {
              const name = draft.desktopName.trim();
              if (name && name !== remote.settings?.desktopName) commit({ desktopName: name });
            }}
          />
        </SettingsRow>
        <DirectSettings
          value={draft.direct}
          busy={remote.busy}
          edit={(direct) => edit({ direct })}
          commit={(direct) => commit({ direct })}
        />
        <SettingsRow
          icon="moon"
          tone="violet"
          label={t("remote.keepAwake")}
          note={
            remote.status
              ? `${t("remote.keepAwakeNote")} · ${t(
                  remote.status.keepAwake === "requested"
                    ? "remote.keepAwakeRequested"
                    : remote.status.keepAwake === "unsupported"
                      ? "remote.keepAwakeUnsupported"
                      : "remote.keepAwakeOff",
                )}`
              : t("remote.keepAwakeNote")
          }
        >
          <Switch
            label={t("remote.keepAwake")}
            checked={draft.keepAwake}
            disabled={remote.busy}
            onCheckedChange={(keepAwake) => commit({ keepAwake })}
          />
        </SettingsRow>
        <SettingsRow
          icon="globe"
          tone="blue"
          label={t("remote.lanDiscovery")}
          note={t("remote.lanDiscoveryNote")}
        >
          <Switch
            label={t("remote.lanDiscovery")}
            checked={draft.lanDiscovery}
            disabled={remote.busy}
            onCheckedChange={(lanDiscovery) => commit({ lanDiscovery })}
          />
        </SettingsRow>
        {remote.settings && <StunPrivacy settings={remote.settings} />}
      </SettingsFold>
    </SettingsPage>
  );
}
