import { type Category, type Level, PI_MANAGER_CATEGORIES } from "@pibot/protocol";
import { PermissionRow, botPanelStyles as styles, useNavigation, useT } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import type { ReactNode } from "react";
import { CATEGORY_LOOK } from "../../settings/permissions/permission-operations.tsx";
import type { usePermissions } from "../../settings/permissions/use-permissions.ts";
import { ProfileNetwork } from "./ProfileNetwork.tsx";

type PermissionState = ReturnType<typeof usePermissions>;
const levels: Level[] = ["never", "ask", "always"];
const operations: Category[] = ["run_command", "read_file", "list_dir", "write_file"];

export function PermissionCategoryRow({
  state,
  category,
  soon = false,
  options = levels,
  note,
}: {
  state: PermissionState;
  category: Category;
  soon?: boolean;
  options?: readonly Level[];
  note?: string;
}) {
  const t = useT();
  const override = state.data?.overrides?.[category];
  return (
    <PermissionRow<Level>
      icon={{ name: CATEGORY_LOOK[category][0], tone: CATEGORY_LOOK[category][1] }}
      label={t(`permissions.category.${category}`)}
      value={
        state.data?.effective?.levels[category] ??
        override ??
        state.global?.levels[category] ??
        "never"
      }
      overridden={override !== undefined}
      disabled={state.busy || state.refreshing || !state.connected || state.error || soon}
      note={soon ? t("common.comingSoon") : note}
      options={options.map((value) => ({ value, label: t(`permissions.level.${value}`) }))}
      change={(value) => void state.save({ levels: { [category]: value } })}
      restore={() => void state.save({ levels: { [category]: null } })}
    />
  );
}

/** Shared presentation; the caller owns the Bot or group scope and every persistence action. */
export function PermissionsContent({
  state,
  description,
  imageOnly = false,
  computer,
  grants,
  browser,
  activity,
  piManager = false,
}: {
  state: PermissionState;
  description: ReactNode;
  imageOnly?: boolean;
  /** The default Pi's own page: its management and dispatch levels lead the list. */
  piManager?: boolean;
  computer?: ReactNode;
  grants?: ReactNode;
  browser?: ReactNode;
  activity?: ReactNode;
}) {
  const t = useT();
  const disabled = state.busy || state.refreshing || !state.connected || state.error;
  return (
    <div className={styles.stack}>
      <p className={styles.note}>{description}</p>
      {state.error && (
        <p role="alert" className={styles.error}>
          {t("workspace.failed")}{" "}
          <Button variant="pill" onClick={() => void state.refresh()}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!state.data && !state.error && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {state.data &&
        state.global &&
        (imageOnly ? (
          <section className={styles.section}>
            <h2>{t("panel.chatHistory")}</h2>
            <div className={styles.card}>
              <PermissionCategoryRow state={state} category="read_messages" />
            </div>
          </section>
        ) : (
          <>
            {piManager && (
              <section className={styles.section}>
                <h2>{t("permissions.piSection")}</h2>
                <div className={styles.card}>
                  {PI_MANAGER_CATEGORIES.map((category) => (
                    <PermissionCategoryRow
                      key={category}
                      state={state}
                      category={category}
                      note={t(`permissions.note.${category}`)}
                    />
                  ))}
                </div>
                <p className={styles.note}>{t("permissions.piNote")}</p>
              </section>
            )}
            <section className={styles.section}>
              <h2>{t("permissions.operations")}</h2>
              <div className={styles.card}>
                {operations.map((category) => (
                  <PermissionCategoryRow key={category} state={state} category={category} />
                ))}
              </div>
            </section>
            <section className={styles.section}>
              <h2>{t("permissions.network")}</h2>
              <div className={styles.card}>
                <PermissionCategoryRow state={state} category="web" />
                <ProfileNetwork
                  network={state.data.effective?.network ?? state.data.network}
                  inherited={!state.data.overrides?.network}
                  disabled={disabled}
                  save={state.save}
                />
              </div>
            </section>
            {computer}
            <section className={styles.section}>
              <h2>{t("permissions.connectionsAndSending")}</h2>
              <div className={styles.card}>
                {(
                  [
                    "connector",
                    "send_out",
                    "read_ai_config",
                    "read_messages",
                    "agent_delegation",
                  ] as const
                ).map((category) => (
                  <PermissionCategoryRow
                    key={category}
                    state={state}
                    category={category}
                    options={
                      category === "send_out" || category === "read_ai_config"
                        ? ["never", "ask"]
                        : levels
                    }
                  />
                ))}
              </div>
              {/* Read-only by owner decision 2026-11-24: the mark comes with the role. */}
              {state.data.overrides?.confirmEverySend && (
                <p className={styles.note}>{t("permissions.confirmEverySend")}</p>
              )}
            </section>
          </>
        ))}
      {grants}
      {!imageOnly && browser}
      {activity}
    </div>
  );
}

export function PermissionActivity({ botId, groupId }: { botId?: string; groupId?: string }) {
  const t = useT(),
    { openAudit } = useNavigation();
  return (
    <div className={styles.card}>
      <button
        type="button"
        className={`${styles.cardRow} ${styles.rowButton}`}
        onClick={() => openAudit(botId, groupId)}
      >
        <IconTile icon="audit" tone="teal" size="lg" />
        <span className={styles.rowText}>
          <strong>{t("panel.activity")}</strong>
        </span>
        <Icon name="chevronRight" size={16} />
      </button>
    </div>
  );
}
