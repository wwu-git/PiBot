// Shows Bot memory behavior and recent background extraction in the profile.
import type { Bot } from "@pibot/protocol";
import { botPanelStyles as styles, useSettings } from "@pibot/renderer-kit";
import { IconTile, SegmentedControl, Switch } from "@pibot/ui";
import { useState } from "react";
import type { BotUpdate } from "../profile/use-bot-editor.ts";
import { MemoryMaintenanceNotice } from "./MemoryMaintenanceNotice.tsx";
import { MemorySummary } from "./MemorySummary.tsx";

import { useMemoryMaintenance } from "./use-memory-maintenance.ts";

export function MemoryPanel({
  bot,
  save,
  busy,
}: {
  bot: Bot;
  save(patch: BotUpdate): Promise<boolean>;
  busy: boolean;
}) {
  const { t, language } = useSettings();
  const [failed, setFailed] = useState(false);
  const extraction = bot.memoryExtraction ?? true;
  const maintenance = useMemoryMaintenance(bot.id, extraction);
  return (
    <section className={styles.section} data-memory-panel="bot">
      <h2>{t("skills.memoryTitle")}</h2>
      <SegmentedControl
        label={t("workspace.memoryMode")}
        value={bot.memoryMode ?? "auto"}
        disabled={busy}
        options={[
          { value: "auto", label: t("workspace.memoryAuto") },
          { value: "ask", label: t("workspace.memoryAsk") },
        ]}
        onValueChange={(value) => void save({ memoryMode: value === "ask" ? "ask" : "auto" })}
      />
      <div className={styles.card}>
        <div className={styles.cardRow}>
          <IconTile icon="star" tone="violet" size="lg" />
          <span className={styles.rowText}>
            <strong>{t("workspace.memoryExtraction")}</strong>
            <small>
              {t("workspace.memoryExtractionNote")}
              {maintenance?.lastExtractionAt &&
                ` ${t("memorySettings.maintenance.lastExtraction", {
                  time: new Date(maintenance.lastExtractionAt).toLocaleString(language),
                })}`}
            </small>
          </span>
          <Switch
            label={t("workspace.memoryExtraction")}
            checked={extraction}
            disabled={busy}
            onCheckedChange={(enabled) => {
              setFailed(false);
              void save({ memoryExtraction: enabled }).then((ok) => setFailed(!ok));
            }}
          />
        </div>
      </div>
      {failed && (
        <p role="alert" className={styles.error}>
          {t("workspace.memoryExtractionFailed")}
        </p>
      )}
      {maintenance?.issue && <MemoryMaintenanceNotice issue={maintenance.issue} />}
      <MemorySummary key={bot.id} owner={{ scope: "bot", ownerId: bot.id }} />
    </section>
  );
}
