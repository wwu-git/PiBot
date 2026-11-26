import { ChatFontSizeSchema, type Settings } from "@pibot/protocol";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  TaskStatus,
  useRpc,
  useSettings,
  useTask,
} from "@pibot/renderer-kit";
import { Button, SegmentedControl, Switch, TextField } from "@pibot/ui";
import { useState } from "react";
import { useStartupDisplay } from "../../app/startup-display.tsx";
import { LoginStartRow } from "../background/LoginStartRow.tsx";
import { BackgroundLimit } from "./BackgroundLimit.tsx";
import { LiveIslandSettings } from "./LiveIslandSettings.tsx";
import { NetworkProxySettings } from "./network-proxy.tsx";
import { requirePeer, SetupError } from "./operations.ts";

// Same order as the language choices, so "follow system" always comes first.
const THEMES = ["system", "light", "dark"] as const;

export function GeneralSettings() {
  const { peer } = useRpc();
  const { t, settings, update } = useSettings();
  const task = useTask();
  const cleanupTask = useTask();
  const startupDisplay = useStartupDisplay();
  const clearDisplay = async () => {
    try {
      if (!startupDisplay) throw new Error("startup_cache_unavailable");
      await startupDisplay.clear();
    } catch {
      throw new SetupError("startup.clearFailed");
    }
  };
  const [cleanupDays, setCleanupDays] = useState("30");
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const parsedCleanupDays = Number(cleanupDays);
  const cleanupDaysValid =
    Number.isInteger(parsedCleanupDays) && parsedCleanupDays >= 1 && parsedCleanupDays <= 36_500;
  const disabled = task.busy || !peer;
  const change = (patch: Partial<Settings>) =>
    void task.run(async () => {
      requirePeer(peer);
      await update(patch);
    });
  return (
    <SettingsPage>
      <TaskStatus task={task} />
      <LiveIslandSettings disabled={disabled} change={change} />
      <SettingsSection title={t("settings.languageTheme")}>
        <SettingsRow icon="globe" tone="blue" label={t("language.label")} note={t("language.note")}>
          <SegmentedControl
            label={t("language.label")}
            disabled={disabled}
            value={settings?.language ?? "system"}
            options={(["system", "zh", "en"] as const).map((value) => ({
              value,
              label: t(`language.${value}`),
            }))}
            onValueChange={(language) => change({ language })}
          />
        </SettingsRow>
        <SettingsRow
          icon="moon"
          tone="violet"
          label={t("theme.label")}
          note={t("settings.themeNote")}
        >
          <SegmentedControl
            label={t("theme.label")}
            disabled={disabled}
            value={settings?.theme ?? "system"}
            options={THEMES.map((value) => ({ value, label: t(`theme.${value}`) }))}
            onValueChange={(theme) => change({ theme })}
          />
        </SettingsRow>
        <SettingsRow
          icon="message"
          tone="teal"
          label={t("chatFont.label")}
          note={t("settings.chatFontNote")}
        >
          <SegmentedControl
            label={t("chatFont.label")}
            disabled={disabled}
            value={settings?.chatFontSize ?? "medium"}
            options={ChatFontSizeSchema.options.map((value) => ({
              value,
              label: t(`chatFont.${value}`),
            }))}
            onValueChange={(chatFontSize) => change({ chatFontSize })}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings.startup")}>
        <LoginStartRow disabled={disabled} />
        <SettingsRow
          icon="pin"
          tone="teal"
          label={t("settings.showTrayIcon")}
          note={t("settings.showTrayIconNote")}
        >
          <Switch
            label={t("settings.showTrayIcon")}
            checked={settings?.showTrayIcon ?? false}
            disabled={disabled}
            onCheckedChange={(showTrayIcon) => change({ showTrayIcon })}
          />
        </SettingsRow>
      </SettingsSection>
      <NetworkProxySettings />
      <BackgroundLimit />
      <SettingsSection title={t("settings.data")}>
        <SettingsRow
          icon="trash"
          tone="pink"
          label={t("startup.clear")}
          note={t("startup.clearNote")}
        >
          <Button
            disabled={disabled}
            onClick={() =>
              void task.run(async () => {
                await clearDisplay();
              })
            }
          >
            {t("startup.clear")}
          </Button>
        </SettingsRow>
        <SettingsRow
          icon="clock"
          tone="amber"
          label={t("settings.runCleanup")}
          note={t("settings.runCleanupNote")}
        >
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <TextField
              label={t("settings.runCleanupDays")}
              type="number"
              min={1}
              max={36_500}
              step={1}
              value={cleanupDays}
              disabled={cleanupTask.busy}
              error={
                cleanupDays.length > 0 && !cleanupDaysValid
                  ? t("settings.runCleanupInvalid")
                  : undefined
              }
              style={{ width: 104 }}
              onChange={(event) => {
                setCleanupDays(event.currentTarget.value);
                setCleanupConfirmed(false);
              }}
            />
            <Button
              loading={cleanupTask.busy}
              disabled={!peer || !cleanupDaysValid}
              variant={cleanupConfirmed ? "primary" : "secondary"}
              onClick={() => {
                if (!peer || !cleanupDaysValid) return;
                if (!cleanupConfirmed) {
                  setCleanupConfirmed(true);
                  return;
                }
                void cleanupTask.run(async () => {
                  await clearDisplay();
                  const result = await peer
                    .call("runs.cleanup", {
                      olderThanDays: parsedCleanupDays,
                      confirmed: true,
                    })
                    .catch(() => {
                      throw new SetupError("settings.runCleanupError");
                    });
                  cleanupTask.setSuccess(
                    t("settings.runCleanupDone", {
                      runs: result.runs,
                      events: result.events,
                      executions: result.executions,
                      files: result.sessionFiles + result.resultFiles,
                    }),
                  );
                  setCleanupConfirmed(false);
                });
              }}
            >
              {t(
                cleanupTask.busy
                  ? "settings.runCleaning"
                  : cleanupConfirmed
                    ? "settings.runCleanupConfirm"
                    : "settings.runCleanupAction",
              )}
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>
      <TaskStatus task={cleanupTask} />
    </SettingsPage>
  );
}
