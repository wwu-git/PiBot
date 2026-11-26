import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask } from "@pibot/protocol";
import { visibleTaskText } from "@pibot/protocol-base";
import { BotAvatar, botAvatarLook, useNavigation, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { type CSSProperties, useEffect, useState } from "react";
import { RunApprovals } from "../../execution/RunApprovals.tsx";
import { TaskCheckpoint } from "../../execution/TaskCheckpoint.tsx";
import { GroupRunStop } from "../conversation/RunList.tsx";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";
import { ExecutionTaskTree } from "./ExecutionTaskTree.tsx";
import { GroupTaskHistory } from "./GroupTaskHistory.tsx";
import { TaskActions } from "./TaskActions.tsx";
import { TaskBriefCards, TaskBriefFlow } from "./TaskBrief.tsx";
import { TaskHandoff } from "./TaskHandoff.tsx";
import { TaskRecovery } from "./TaskRecovery.tsx";
import { TaskSource } from "./TaskSource.tsx";
import { TaskStatus } from "./TaskStatus.tsx";
import { TaskSummary } from "./TaskSummary.tsx";
import { TaskSupplement } from "./TaskSupplement.tsx";
import { useTaskBrief } from "./use-task-brief.ts";
import { useTaskExecution } from "./use-task-execution.ts";

type TaskTab = "description" | "children" | "history";

export function GroupTaskDetails({
  peer,
  data,
  task,
  refresh,
}: {
  peer: ChatPeer;
  data: GroupSnapshot;
  task: GroupTask;
  refresh(): Promise<void>;
}) {
  const t = useT();
  const { navigate } = useNavigation();
  const [tab, setTab] = useState<TaskTab>("description");
  const execution = useTaskExecution(peer, task);
  const brief = useTaskBrief(peer, task);
  const bot = data.bots.find((item) => item.id === task.assigneeBotId);
  const workspace = data.group?.memberWorkspaces?.find((item) => item.taskId === task.id);
  const runs = data.runs.filter(
    (run) => run.taskId === task.id && ["queued", "running"].includes(run.status),
  );
  const resultMessageId = execution.page?.resultMessageId;

  useEffect(() => {
    const saved = sessionStorage.getItem("pibot.group-task-tab");
    if (saved === "description" || saved === "children" || saved === "history") {
      setTab(saved);
    }
  }, []);

  const selectTab = (next: TaskTab) => {
    setTab(next);
    sessionStorage.setItem("pibot.group-task-tab", next);
  };

  return (
    <section className={styles.taskDetail} aria-label={task.title}>
      <div
        className={styles.taskDetailHead}
        style={{ "--bar": `var(--avatar-${botAvatarLook(bot, !bot).color})` } as CSSProperties}
      >
        <div className={styles.taskDetailTitleRow}>
          <h2 className={styles.taskDetailTitle}>{task.title}</h2>
          <TaskActions peer={peer} task={task} refresh={refresh} menu />
        </div>
        <div className={styles.taskDetailOwner}>
          <BotAvatar bot={bot} unknown label={bot?.name ?? task.assigneeBotId} size={24} />
          <span>{bot?.name ?? task.assigneeBotId}</span>
          <TaskStatus task={task} data={data} />
        </div>
        <div className={styles.taskDetailTags}>
          <span>
            {t(
              task.executionMode === "parallel" ? "group.taskModeParallel" : "group.taskModeSerial",
            )}
          </span>
          {workspace && (
            <span
              data-tone={
                workspace.state === "integrated"
                  ? "ok"
                  : workspace.state === "conflict"
                    ? "danger"
                    : undefined
              }
            >
              {t(`group.workspace.${workspace.state}`)}
            </span>
          )}
          {brief && (
            <span>{t("group.brief.stepOf", { index: brief.step.index, total: brief.total })}</span>
          )}
        </div>
        <TaskSource task={task} data={data} />
        {runs.map((run) => (
          <GroupRunStop
            key={run.id}
            peer={peer}
            run={run}
            task
            name={bot?.name ?? t("group.member")}
            bot={bot}
            refresh={refresh}
          />
        ))}
        <TaskRecovery peer={peer} task={task} bot={bot} refresh={refresh} />
        {task.status !== "open" && <TaskSummary task={task} />}
        {resultMessageId && (
          <Button
            variant="ghost"
            className={styles.taskResultButton}
            onClick={() =>
              navigate({
                name: "chat",
                groupId: task.groupId,
                focus: { messageId: resultMessageId },
              })
            }
          >
            {t("group.taskLocateResult")} <Icon name="chevronRight" size={12} />
          </Button>
        )}
      </div>
      {task.status === "open" && (
        <RunApprovals
          botId={task.assigneeBotId}
          conversationId={task.threadConversationId}
          context={{ botName: bot?.name ?? t("group.member"), groupName: data.group?.name ?? "" }}
        />
      )}
      {brief && <TaskBriefFlow brief={brief} bots={data.bots} />}
      {/* A plan step's checks and files are in its brief cards below. */}
      {!brief && <TaskHandoff task={task} />}
      {execution.page?.checkpoint && (
        <div className={styles.taskCheckpoint}>
          <TaskCheckpoint checkpoint={execution.page.checkpoint} />
        </div>
      )}
      <div className={styles.taskTabs} role="tablist">
        <Button
          variant="ghost"
          role="tab"
          aria-selected={tab === "description"}
          className={tab === "description" ? styles.taskTabActive : styles.taskTab}
          onClick={() => selectTab("description")}
        >
          {t("group.taskInstructions")}
        </Button>
        <Button
          variant="ghost"
          role="tab"
          aria-selected={tab === "children"}
          className={tab === "children" ? styles.taskTabActive : styles.taskTab}
          onClick={() => selectTab("children")}
        >
          {t("group.taskExecutionChildren")} {execution.page?.items.length ?? 0}
        </Button>
        <Button
          variant="ghost"
          role="tab"
          aria-selected={tab === "history"}
          className={tab === "history" ? styles.taskTabActive : styles.taskTab}
          onClick={() => selectTab("history")}
        >
          {t("group.taskInternalHistory")}
        </Button>
      </div>
      {tab === "description" && brief && (
        <>
          <TaskBriefCards peer={peer} brief={brief} bots={data.bots} task={task} />
          <details className={styles.briefRaw}>
            <summary>{t("group.brief.raw")}</summary>
            <p className={styles.taskInstructions}>{visibleTaskText(task.instructions)}</p>
          </details>
          {task.status === "open" && <TaskSupplement peer={peer} task={task} refresh={refresh} />}
        </>
      )}
      {tab === "description" && brief === undefined && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {tab === "description" && brief === null && (
        <div className={styles.taskPanelCard}>
          <p className={styles.taskInstructions}>{visibleTaskText(task.instructions)}</p>
          {task.status === "open" && <TaskSupplement peer={peer} task={task} refresh={refresh} />}
        </div>
      )}
      {tab === "children" && (
        <div className={styles.taskPanelCard}>
          {execution.page?.items.length ? (
            <ExecutionTaskTree tasks={execution.page.items} />
          ) : (
            !execution.busy && <p className={styles.note}>{t("execution.noTasks")}</p>
          )}
          {execution.busy && !execution.page && <p role="status">{t("common.loading")}</p>}
          {execution.error && (
            <p role="alert" className={styles.error}>
              {t("execution.loadError")}{" "}
              <Button variant="ghost" onClick={execution.retry}>
                {t("common.retry")}
              </Button>
            </p>
          )}
          {execution.page?.nextBefore && !execution.bounded && (
            <Button variant="ghost" onClick={execution.more} disabled={execution.busy}>
              {t("execution.older")}
            </Button>
          )}
          {execution.page?.nextBefore && execution.bounded && (
            <p className={styles.note}>{t("group.taskTreeBound")}</p>
          )}
        </div>
      )}
      {tab === "history" && <GroupTaskHistory peer={peer} task={task} />}
    </section>
  );
}
