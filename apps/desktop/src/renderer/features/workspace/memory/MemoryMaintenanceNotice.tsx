// Gives the existing memory surfaces the same warning and model-settings action.
import type { MemoryMaintenanceStatus } from "@pibot/protocol";
import { useNavigation, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import styles from "./memory-maintenance.module.css";

export function MemoryMaintenanceNotice({
  issue,
}: {
  issue: NonNullable<MemoryMaintenanceStatus["issue"]>;
}) {
  const t = useT();
  const { dialog, closeDialog, openSettings } = useNavigation();
  const budget = issue.reason === "budget_exhausted";
  return (
    <div className={styles.bannerWarn} role="status">
      <Icon name="warning" size={14} />
      <span>
        {budget
          ? t("memorySettings.maintenance.budget_exhausted")
          : t(`memorySettings.maintenance.${issue.task}`, {
              count: issue.count,
              reason: t(`memorySettings.maintenance.${issue.reason}`),
            })}
      </span>
      {budget ? (
        <small>{t("memorySettings.maintenance.budgetNext")}</small>
      ) : (
        <Button
          variant="pill"
          onClick={() => {
            if (dialog) closeDialog(dialog.key);
            openSettings("models");
          }}
        >
          {t("workspace.backgroundTaskModels")}
        </Button>
      )}
    </div>
  );
}
