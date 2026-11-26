import type { Connector, PluginSummary } from "@pibot/plugins-contract/full";
import { hostPlatform, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { Chip, Icon, IconTile } from "@pibot/ui";
import type { useConnectorOperations } from "../../shell/operations.ts";
import { useConnectorAction } from "../../shell/remote.ts";
import { ConnectorFeedback } from "../ConnectorFeedback.tsx";
import { ConnectorPanel } from "../ConnectorPanel.tsx";
import { ConnectorRecentUse } from "../ConnectorRecentUse.tsx";
import { runsOutsideSandbox } from "../connection-state.ts";
import { ImportedSkillAssignment } from "../ImportedSkillAssignment.tsx";
import { accessIsOn, toggleConnectionAccess } from "./access-grant.ts";
import styles from "./connections.module.css";
import { letterTone, monogram } from "./Faces.tsx";
import { localText } from "./local-text.ts";

import { WhoCanUse } from "./WhoCanUse.tsx";

export const toolName: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "pi",
  opencode: "OpenCode",
};

export const needsKey = (connector: Connector) =>
  connector.status === "needs_setup" || connector.status === "needs_auth";

/**
 * Design ③: who can use it (click a face), recent use, keys, tools and delete. Everything deeper
 * (confirmation mode, per-tool switches, re-authorizing) stays in the existing management panel,
 * opened from 「更多设置」.
 */
export function ConnectionPanel({
  summary,
  connectors,
  snapshot,
  operations,
  changed,
  manage,
  remove,
  close,
}: {
  summary: PluginSummary;
  connectors: Connector[];
  snapshot: number;
  operations: ReturnType<typeof useConnectorOperations>;
  changed(): void;
  manage(connectorId: string): void;
  remove(): void;
  close(): void;
}) {
  const { t, language } = useSettings();
  const workspace = useWorkspace();
  const action = useConnectorAction(changed);
  const bots = workspace.bots.filter((bot) => !bot.archivedAt);
  const groups = workspace.groups.filter((group) => !group.archivedAt);
  const first = connectors[0];
  const isOn = (kind: "bot" | "group", id: string) => accessIsOn(summary.access, { kind, id });
  const toggle = (kind: "bot" | "group", id: string) => {
    if (!first) return;
    void action.run((peer, signal) =>
      toggleConnectionAccess(peer, signal, {
        summary,
        connectors,
        botIds: bots.map((bot) => bot.id),
        target: { kind, id },
        started: operations.track,
      }),
    );
  };
  const missingKey = connectors.find(needsKey);
  const name = localText(summary.name[language], language);
  return (
    <ConnectorPanel title={name} close={close} busy={action.busy}>
      <div className={styles.panelHead}>
        <span className={styles.icon} data-tone={letterTone(name)} aria-hidden="true">
          {monogram(name)}
        </span>
        <div>
          <small>
            {[
              t(
                summary.sourceKind === "directory"
                  ? "connections.panel.kindPlugin"
                  : "connections.panel.kindMcp",
              ),
              localText(summary.description[language], language),
              summary.originTool &&
                t("connections.skill.from", {
                  tool: toolName[summary.originTool] ?? summary.originTool,
                }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
          {connectors.some((connector) => runsOutsideSandbox(connector, hostPlatform())) && (
            <div>
              <Chip tone="warn">{t("connectors.outsideSandbox.badge")}</Chip>
            </div>
          )}
        </div>
      </div>
      {first ? (
        <WhoCanUse
          bots={bots}
          groups={groups}
          isOn={isOn}
          toggle={toggle}
          disabled={action.disabled}
        >
          <ConnectorFeedback loading={false} error={action.error} retry={changed} />
        </WhoCanUse>
      ) : null}
      {summary.skillCount > 0 && (
        <section className={styles.section}>
          <p className={styles.note}>{t("connections.panel.skillsNote")}</p>
          <ImportedSkillAssignment installationId={summary.installationId} changed={changed} />
        </section>
      )}
      {first && <ConnectorRecentUse id={first.id} snapshot={snapshot} />}
      {first && (
        <>
          <section className={styles.block}>
            <h3 className={styles.blockTitle} data-mark="amber">
              <span>{t("connections.panel.keys")}</span>
            </h3>
            <div className={styles.softCard}>
              {missingKey ? (
                <button
                  type="button"
                  className={`${styles.tileRow} ${styles.tileAction}`}
                  onClick={() => manage(missingKey.id)}
                >
                  <IconTile icon="key" tone="amber" size="lg" />
                  <span className={styles.tileText}>
                    <b>{t("connections.panel.keysNeeded")}</b>
                  </span>
                  <Chip tone="warn">{t("connections.action.addKey")}</Chip>
                  <Icon name="chevronRight" size={16} className={styles.tileChevron} />
                </button>
              ) : (
                <div className={styles.tileRow}>
                  <IconTile icon="key" tone="violet" size="lg" />
                  <span className={styles.tileText}>
                    <b>{t("connections.panel.keys")}</b>
                  </span>
                  <Chip tone="ok">{t("connections.panel.keysOk")}</Chip>
                </div>
              )}
            </div>
          </section>
          <section className={styles.block}>
            <h3 className={styles.blockTitle} data-mark="teal">
              <span>{t("connections.panel.tools")}</span>
            </h3>
            <div className={styles.softCard}>
              <button
                type="button"
                className={`${styles.tileRow} ${styles.tileAction}`}
                onClick={() => manage(first.id)}
              >
                <IconTile icon="puzzle" tone="teal" size="lg" />
                <span className={styles.tileText}>
                  <b>{t("connections.panel.toolCount", { count: summary.toolCount })}</b>
                  <small>{t("connections.panel.more")}</small>
                </span>
                <Icon name="chevronRight" size={16} className={styles.tileChevron} />
              </button>
            </div>
          </section>
        </>
      )}
      <div className={styles.softCard}>
        <button
          type="button"
          className={`${styles.tileRow} ${styles.tileAction}`}
          data-danger=""
          onClick={remove}
        >
          <IconTile icon="trash" tone="red" size="lg" />
          <span className={styles.tileText}>
            <b>{t("connections.panel.delete")}</b>
          </span>
        </button>
      </div>
    </ConnectorPanel>
  );
}
