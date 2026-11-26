import { DomainSchema } from "@pibot/plugins-contract/full";
import { SettingsLine, SettingsRow, SettingsSection, useSettings } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { useState } from "react";
import styles from "./connections/drawer.module.css";
import connectorStyles from "./connectors.module.css";

/**
 * 能连的网站, read as chips; editing is a deliberate step with a confirmation, because the list
 * is what the connection may reach. The parent keys drafts by revision so a stale edit never
 * silently replaces a newer list.
 */
export function ConnectorNetworkEditor({
  domains,
  disabled,
  editable,
  save,
}: {
  domains: readonly string[];
  disabled: boolean;
  editable: boolean;
  save(domains: string[]): void;
}) {
  const { t } = useSettings();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState(domains.join("\n"));
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = entries.map((entry) => DomainSchema.safeParse(entry));
  const valid = entries.length <= 64 && parsed.every((entry) => entry.success);
  const normalized = [...new Set(parsed.flatMap((entry) => (entry.success ? [entry.data] : [])))];
  const changed = JSON.stringify(normalized) !== JSON.stringify(domains);
  return (
    <SettingsSection title={t("connections.drawer.sites")}>
      <SettingsRow
        icon="globe"
        tone="blue"
        label={t(domains.length ? "connections.drawer.sitesNote" : "connections.drawer.sitesNone")}
      >
        {!editing && editable && (
          <Button variant="secondary" disabled={disabled} onClick={() => setEditing(true)}>
            {t("connections.drawer.sitesEdit")}
          </Button>
        )}
      </SettingsRow>
      {!editing && domains.length > 0 && (
        <div className={styles.stackedControl}>
          <span className={`${styles.siteChips} ${styles.start}`}>
            {domains.map((domain) => (
              <Chip key={domain} className={styles.mono}>
                {domain}
              </Chip>
            ))}
          </span>
        </div>
      )}
      {editing && (
        <div className={styles.stackedControl}>
          <label className={connectorStyles.field}>
            <span className={styles.fieldNote}>{t("connectors.network.note")}</span>
            <textarea
              aria-label={t("connectors.network.title")}
              value={text}
              disabled={disabled || confirming}
              maxLength={16384}
              rows={4}
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </label>
          {!valid && (
            <span role="alert" className={styles.fieldError}>
              {t("connectors.network.invalid")}
            </span>
          )}
          {confirming && (
            <SettingsLine dot="warn" role="alert">
              {t("connections.drawer.sitesConfirm")}
            </SettingsLine>
          )}
          <div className={styles.inlineActions}>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => {
                if (confirming) setConfirming(false);
                else {
                  setEditing(false);
                  setText(domains.join("\n"));
                }
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={disabled || !valid || !changed}
              onClick={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                setConfirming(false);
                setEditing(false);
                save(normalized);
              }}
            >
              {t(confirming ? "connections.drawer.save" : "connectors.network.save")}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
