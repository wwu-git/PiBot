import { SettingsRow, SettingsSection, useT } from "@pibot/renderer-kit";
import { Switch } from "@pibot/ui";
import type { ComponentProps, ReactNode } from "react";
import styles from "./drawer.module.css";
import { FacePicker } from "./Faces.tsx";

/**
 * 谁能用: an optional 「所有 Bot」 switch, then the faces to tap. Turning the switch off keeps the
 * faces that were on, as the old 「指定的 Bot 与群」 button did.
 */
export function WhoCanUse({
  children,
  all,
  ...picker
}: ComponentProps<typeof FacePicker> & {
  children?: ReactNode;
  all?: { on: boolean; disabled: boolean; toggle(on: boolean): void };
}) {
  const t = useT();
  return (
    <SettingsSection
      title={t("connections.panel.who")}
      action={<small className={styles.fieldNote}>{t("connections.drawer.whoNote")}</small>}
    >
      {all && (
        <SettingsRow
          icon="user"
          tone="violet"
          label={t("connections.drawer.allBots")}
          note={t("connections.drawer.allBotsNote")}
        >
          <Switch
            checked={all.on}
            label={t("connections.drawer.allBots")}
            disabled={all.disabled}
            onCheckedChange={all.toggle}
          />
        </SettingsRow>
      )}
      <div className={styles.pickerRow}>
        <FacePicker {...picker} />
      </div>
      {children}
    </SettingsSection>
  );
}
