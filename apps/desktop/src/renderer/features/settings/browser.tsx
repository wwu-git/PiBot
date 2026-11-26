// Lets users choose the browser route and check the extension connection.
import type { BrowserExtensionStatusSchema } from "@pibot/protocol";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  TaskStatus,
  useRpc,
  useRpcEvent,
  useT,
  useTask,
} from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useEffect, useState } from "react";
import type { z } from "zod";

type BrowserExtensionStatus = z.infer<typeof BrowserExtensionStatusSchema>;
type ExtensionState = BrowserExtensionStatus["extension"];

const STATUS_TONES = {
  connected: "ok",
  installed: "warn",
  not_installed: "warn",
  unsupported: "danger",
} as const;

export function BrowserSettings() {
  const { peer } = useRpc();
  const t = useT();
  const task = useTask();
  const [status, setStatus] = useState<BrowserExtensionStatus>();
  useEffect(() => {
    if (!peer) return;
    let pending: AbortController | undefined;
    const refresh = () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
      void peer
        .call("browserExtension.status", {}, { signal })
        .then((value) => {
          if (!request.signal.aborted) setStatus(value);
        })
        .catch(() => {
          // Leave the last status visible during a temporary failure.
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      pending?.abort();
    };
  }, [peer]);
  useRpcEvent("browserExtension.changed", setStatus);
  useRpcEvent("settings.changed", ({ browserExtensionPreference }) => {
    if (!browserExtensionPreference) return;
    setStatus((current) => current && { ...current, preference: browserExtensionPreference });
  });
  const disabled = !peer || task.busy || !status;
  const change = (preference: "user" | "bot", takeOver?: true) => {
    if (!peer) return;
    void task.run(async () => {
      setStatus(
        await peer.call("browserExtension.setPreference", {
          preference,
          ...(takeOver ? { takeOver } : {}),
        }),
      );
    });
  };
  const registration = status?.preference === "user" ? status.registration : undefined;
  const extension: ExtensionState = status?.extension ?? "unsupported";
  const extensionLabel = {
    connected: t("settings.browserExtensionStatus.connected"),
    installed: t("settings.browserExtensionStatus.installed"),
    not_installed: t("settings.browserExtensionStatus.not_installed"),
    unsupported: t("settings.browserExtensionStatus.unsupported"),
  }[extension];
  const browserName = status?.defaultBrowser?.name ?? t("settings.browserUnknown");
  return (
    <SettingsPage>
      <TaskStatus task={task} />
      <SettingsSection title={t("settings.browserSection")}>
        <SettingsRow
          icon="globe"
          tone="blue"
          label={t("settings.browserDefault")}
          note={browserName}
        />
        <SettingsRow
          icon="plug"
          tone="teal"
          label={t("settings.browserExtension")}
          note={
            status?.defaultBrowser?.id === "edge" && extension !== "connected"
              ? t("settings.browserExtensionStatus.edgeNotListed")
              : extensionLabel
          }
          dot={STATUS_TONES[extension]}
        />
        {registration && (
          <SettingsRow
            icon="plug"
            tone="amber"
            label={t(`settings.browserExtensionStatus.${registration}`)}
          >
            <Button variant="secondary" disabled={disabled} onClick={() => change("user", true)}>
              {t("settings.browserExtensionConnectHere")}
            </Button>
          </SettingsRow>
        )}
        <SettingsRow icon="shield" tone="violet" label={t("settings.browserPreference")}>
          <SegmentedControl
            label={t("settings.browserPreference")}
            disabled={disabled}
            value={status?.preference ?? "user"}
            options={[
              { value: "user", label: t("settings.browserPreferenceUser") },
              { value: "bot", label: t("settings.browserPreferenceBot") },
            ]}
            onValueChange={change}
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
