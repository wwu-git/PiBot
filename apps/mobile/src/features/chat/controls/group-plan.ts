import type { GroupPlanCard, GroupPlanProgress, GroupTask } from "@pibot/protocol";
import { visibleTaskText } from "@pibot/protocol-base";
import type { MobileKey } from "../../../i18n/messages.ts";
import type { Caller } from "./scope.ts";

// The group chat's task progress: the same durable plan card and live program facts the desktop
// task panel reads (`groups.plan.current` + `groups.plan.progress`), never the coordinator's prose.

export interface GroupPlanState {
  messageId: string;
  card: GroupPlanCard;
  /** Present once the plan started; before that every step is still waiting. */
  progress?: GroupPlanProgress;
  /** The group's pause switch (desktop header, input bar, chat words). */
  paused?: boolean;
}
export async function readGroupPlan(
  c: Caller,
  groupId: string,
  signal?: AbortSignal,
): Promise<GroupPlanState | null> {
  const [current, group] = await Promise.all([
    c.call("groups.plan.current", { groupId }, signal),
    c.call("groups.get", { groupId }, signal),
  ]);
  if (!current || current.card.groupId !== groupId) return null;
  const paused = group.paused === true;
  const progress =
    current.card.status === "started"
      ? await c.call(
          "groups.plan.progress",
          { groupId, workflowRunId: current.card.id },
          signal,
          15_000,
        )
      : undefined;
  return { messageId: current.messageId, card: current.card, progress, paused };
}
/** Maintainers 2026-11-20: the sheet's pause / continue is the desktop's group pause (only `paused`). */
export function setGroupPaused(c: Caller, groupId: string, paused: boolean, signal?: AbortSignal) {
  return c.call("groups.update", { groupId, paused }, signal, 30_000);
}
/** The desktop decision card's 「重试」 on a step that waits for the user. */
export function retryStep(
  c: Caller,
  groupId: string,
  workflowRunId: string,
  stepId: string,
  signal?: AbortSignal,
) {
  return c.call(
    "groups.workflow.resolve",
    { groupId, workflowRunId, stepId, action: "retry", confirmed: true },
    signal,
    30_000,
  );
}
/** The desktop card's 「核对启动结果」: continues a confirmed start that was cut off. */
export function continuePlan(c: Caller, groupId: string, messageId: string, signal?: AbortSignal) {
  return c.call("groups.plan.resolve", { groupId, messageId, decision: "check" }, signal, 35_000);
}
/**
 * The current topic's group tasks, newest first (the brain scopes `groups.tasks` to the group's
 * current conversation). Small pages: each task carries its instructions and result, and the
 * answer must fit one phone frame.
 */
export function readGroupTasks(
  c: Caller,
  groupId: string,
  section: "open" | undefined,
  signal?: AbortSignal,
) {
  return c.call("groups.tasks", { groupId, limit: 30, ...(section ? { section } : {}) }, signal);
}
/**
 * A step's group task: the workflow creates it with the step's title for the step's owner, and a
 * retry creates a new one, so the newest match is the current attempt. Progress facts carry no
 * task id, so this is the closest stable link the phone can read.
 */
export function stepTask(tasks: readonly GroupTask[], title: string, botId: string | undefined) {
  let found: GroupTask | undefined;
  for (const task of tasks)
    if (
      task.title === title &&
      (!botId || task.assigneeBotId === botId) &&
      (!found || task.createdAt > found.createdAt)
    )
      found = task;
  return found;
}

export type StepMark = "done" | "running" | "waiting" | "attention" | "failed" | "skipped";
export interface PlanStepView {
  id: string;
  title: string;
  task?: string;
  botId?: string;
  mark: StepMark;
  label: MobileKey;
  attempt: number;
}
type StepState = GroupPlanProgress["steps"][number];
function stepLook(
  state: StepState | undefined,
  terminalStopped: boolean,
): { mark: StepMark; label: MobileKey } {
  if (!state) return { mark: "waiting", label: "gpStepWaiting" };
  // Same order as the desktop progress dots: a resolved verdict wins over the raw state.
  if (state.verdictResolution?.kind === "repaired") return { mark: "done", label: "gpStepDone" };
  if (state.verdictResolution?.kind === "skipped" || state.status === "skipped")
    return { mark: "skipped", label: "gpStepSkipped" };
  if (state.status === "passed") return { mark: "done", label: "gpStepDone" };
  // The user's stop marks the interrupted step blocked; on a stopped plan it is stopped too.
  if (terminalStopped && ["running", "blocked", "ready", "waiting"].includes(state.status))
    return { mark: "waiting", label: "gpStepStopped" };
  // Stopped by the group's pause: not a failure, and it runs again when the group continues.
  if (state.paused)
    return {
      mark: "waiting",
      label: terminalStopped ? "gpStepStopped" : "gpStepPaused",
    };
  if (state.status === "blocked") return { mark: "attention", label: "gpStepNeedsYou" };
  if (state.status === "failed") return { mark: "failed", label: "gpStepFailed" };
  if (state.status === "running")
    return state.verdict?.verdict === "fail" || state.attempt > 0
      ? { mark: "running", label: "gpStepChecking" }
      : { mark: "running", label: "gpStepRunning" };
  return { mark: "waiting", label: "gpStepWaiting" };
}
const live = (progress?: GroupPlanProgress) =>
  !!progress && (progress.status === "running" || progress.status === "waiting");

/** Steps in plan order with owner and state, the counts, the header line and the actions offered. */
export function planView(state: GroupPlanState) {
  const { card, progress } = state;
  const defined = new Map(card.plan.steps.map((step) => [step.id, step]));
  const owners = new Map(card.owners.map((owner) => [owner.stepId, owner.botId]));
  const facts = new Map(progress?.steps.map((step) => [step.stepId, step]) ?? []);
  // A replanned plan reports the live replacement's steps; their order and ids lead then.
  const ids = progress?.steps.length
    ? progress.steps.map((step) => step.stepId)
    : card.plan.steps.map((step) => step.id);
  const terminalStopped =
    progress?.status === "cancelled" ||
    (progress?.status === "failed" && progress.stoppedReason === "user_stopped");
  const steps = ids.map((id): PlanStepView => {
    const step = defined.get(id);
    const fact = facts.get(id);
    return {
      id,
      title: step?.title ?? id,
      task: step?.task === undefined ? undefined : visibleTaskText(step.task),
      botId: owners.get(id),
      ...stepLook(fact, terminalStopped),
      attempt: fact?.attempt ?? 0,
    };
  });
  const done = progress ? progress.passed : 0;
  const total = progress ? progress.total : steps.length;
  const blocked = live(progress) ? steps.filter((step) => step.mark === "attention") : [];
  return {
    steps,
    done,
    total,
    status: statusKey(state),
    live: live(progress),
    /** Steps the phone may retry: blocked while the plan still runs, as the decision card. */
    retryable: new Set(blocked.map((step) => step.id)),
    /** A start the user confirmed that did not finish; the desktop offers to check it. */
    continuable: !progress && card.status === "starting",
    /** The group is paused; the sheet offers continue. A live plan offers pause. */
    paused: state.paused === true,
  };
}
function statusKey({ card, progress }: GroupPlanState): MobileKey {
  if (!progress)
    return card.status === "pending"
      ? "gpPlanPending"
      : card.status === "ready"
        ? "gpPlanReady"
        : card.status === "starting"
          ? "gpPlanStarting"
          : card.status === "modify"
            ? "gpPlanModify"
            : "gpPlanRunning";
  switch (progress.status) {
    case "running":
      return "gpPlanRunning";
    case "waiting":
      return "gpPlanWaiting";
    case "passed":
      return "gpPlanPassed";
    case "cancelled":
      return "gpPlanReplaced";
    default:
      return progress.stoppedReason === "cost" || progress.stoppedReason === "budget_exhausted"
        ? "gpPlanStoppedBudget"
        : progress.stoppedReason === "user_stopped" || !progress.stoppedReason
          ? "gpPlanStopped"
          : "gpPlanStoppedLimit";
  }
}
