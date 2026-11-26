import type { GroupTask } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";

export function TaskStatus({ task, data }: { task: GroupTask; data: GroupSnapshot }) {
  const t = useT();
  // Maintainers 2026-11-20: a paused group runs nothing; an unfinished task reads 已暂停, not 进行中.
  const status =
    task.status !== "open"
      ? task.status
      : data.group?.paused && !task.activity?.waitingForUser
        ? "paused"
        : (task.activity?.state ?? "open");
  const finishing = task.status === "done" && task.activity?.state === "running";
  const name =
    task.status === "open" && task.activity?.waitingForBotId
      ? data.bots.find((bot) => bot.id === task.activity?.waitingForBotId)?.name
      : undefined;
  return (
    <span className={styles.taskStatus} data-status={status}>
      {task.handoff?.state === "unmet"
        ? t("group.handoff.state.unmet")
        : task.status === "open" && task.activity?.stop?.code === "context_full"
          ? t("group.taskState.contextFull")
          : finishing
            ? t("group.taskFinishing")
            : status === "paused"
              ? t("group.taskState.paused")
              : task.status === "open" && task.activity?.waitingForUser
                ? t("group.taskWaitingUser")
                : task.status === "open" && task.activity?.waitingForTasks
                  ? t("group.taskWaitingAssignments")
                  : task.status === "open" && task.activity?.waitingForChildren
                    ? t("group.taskWaitingChildren")
                    : name
                      ? t("group.taskWaitingFor", { name })
                      : t(`group.taskState.${status}`)}
    </span>
  );
}
