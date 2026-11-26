import { budgetAmount } from "@pibot/client-core";
import type { GroupPlanCard, GroupPlanProgress as Progress } from "@pibot/protocol";
import { BotAvatar, useRpc, useT } from "@pibot/renderer-kit";
import { Button, type DotState, StatusDot } from "@pibot/ui";
import { useChangesLink } from "@pibot/workspaces/ui";
import { useEffect, useRef, useState } from "react";
import { BudgetRaise } from "../../receipt/RunReceipt.tsx";
import { useRunReceipt } from "../../receipt/receipt-store.ts";
import type { GroupSnapshot } from "../data.ts";
import { GroupPlanChoice } from "./GroupPlanChoice.tsx";
import styles from "./group-plan.module.css";

/** Step events are not all broadcast; a slow poll covers them only while the plan is live. */
const POLL_MS = 4_000;
const live = (progress?: Progress) =>
  !progress || progress.status === "running" || progress.status === "waiting";
/** Step states as the shared status dots (the text label stays beside each). */
const dots: Record<Progress["steps"][number]["status"], DotState> = {
  passed: "done",
  running: "running",
  ready: "queued",
  waiting: "queued",
  blocked: "waiting",
  failed: "failed",
  skipped: "stopped",
};

/**
 * Live program facts of a started plan on its card (step states, attempts, ledger cost)
 * and the user's 「停止计划」 with an inline confirmation.
 */
export function GroupPlanProgressView({
  card,
  titles,
  bots,
}: {
  card: GroupPlanCard;
  titles: ReadonlyMap<string, string>;
  bots?: ReadonlyMap<string, GroupSnapshot["bots"][number]>;
}) {
  const t = useT();
  const { peer } = useRpc();
  const changes = useChangesLink();
  const [progress, setProgress] = useState<Progress>();
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [newPlan, setNewPlan] = useState(false);
  const [revision, setRevision] = useState(0);
  const stopRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    if (!peer) return;
    const reload = (groupId: string) => {
      if (groupId === card.groupId) setRevision((value) => value + 1);
    };
    const off = [
      peer.on("groups.changed", (event) => reload(event.groupId)),
      peer.on("group.task", (event) => reload(event.task.groupId)),
    ];
    return () => {
      for (const stop of off) stop();
    };
  }, [peer, card.groupId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` re-reads after a change event.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    void peer
      .call(
        "groups.plan.progress",
        { groupId: card.groupId, workflowRunId: card.id },
        { signal: controller.signal, timeoutMs: 10_000 },
      )
      .then(
        (value) => {
          if (controller.signal.aborted) return;
          setProgress(value);
          setFailed(false);
        },
        () => {
          if (!controller.signal.aborted) setFailed(true);
        },
      );
    return () => controller.abort();
  }, [peer, card.groupId, card.id, revision]);
  const polling = live(progress);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => setRevision((value) => value + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);
  useEffect(
    () => () => {
      stopRequest.current?.abort();
      stopRequest.current = undefined;
    },
    [],
  );
  const stop = async () => {
    // The ref is set synchronously: a double click sends one request (the brain is idempotent too).
    if (!peer || !progress || stopRequest.current) return;
    const controller = new AbortController();
    stopRequest.current = controller;
    setStopping(true);
    setFailed(false);
    try {
      const value = await peer.call(
        "groups.plan.stop",
        { groupId: card.groupId, workflowRunId: progress.workflowRunId, confirmed: true },
        { signal: controller.signal, timeoutMs: 15_000 },
      );
      if (controller.signal.aborted) return;
      setProgress(value);
      setConfirming(false);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (stopRequest.current === controller) {
        stopRequest.current = undefined;
        setStopping(false);
      }
    }
  };
  if (!progress)
    return failed ? (
      <p role="alert" className={styles.note}>
        {t("group.plan.progressFailed")}
      </p>
    ) : null;
  const cost =
    progress.costUsd === null
      ? t("group.plan.costUnknown")
      : progress.budgetUsd === null
        ? t("group.plan.spent", { cost: budgetAmount(progress.costUsd) })
        : t("group.plan.spentOf", {
            cost: budgetAmount(progress.costUsd),
            budget: budgetAmount(progress.budgetUsd),
          });
  const state =
    progress.status === "failed"
      ? progress.stoppedReason === "user_stopped"
        ? t("group.plan.run.stopped")
        : t("group.plan.run.ended", { reason: t(stopReasonKey(progress.stoppedReason)) })
      : progress.choice
        ? t("group.plan.choice.title")
        : t(`group.plan.run.${progress.status}`);
  const choice = progress.choice && live(progress) ? progress.choice : undefined;
  const ownerIds = new Map(card.owners.map((entry) => [entry.stepId, entry.botId]));
  const owner = (stepId: string) => bots?.get(ownerIds.get(stepId) ?? "");
  const share = progress.total ? Math.round((progress.passed / progress.total) * 100) : 0;
  const terminalStopped =
    progress.status === "cancelled" ||
    (progress.status === "failed" && progress.stoppedReason === "user_stopped");
  // The user's stop marks the step it interrupted as blocked; on a stopped plan that step, like
  // every other unfinished one, reads 「已停止」 rather than asking the user to act.
  const stoppedHere = (step: Progress["steps"][number]) =>
    terminalStopped &&
    (step.paused || ["running", "blocked", "ready", "waiting"].includes(step.status));
  return (
    <div className={styles.modify} aria-live="polite">
      <div className={styles.head}>
        <b>{state}</b>
        <span>
          {t("group.plan.progress", { done: progress.passed, total: progress.total })} · {cost}
          {!!progress.pendingCostRequests &&
            ` · ${t("group.plan.costPending", { count: progress.pendingCostRequests })}`}
        </span>
      </div>
      <div className={styles.bar} aria-hidden="true">
        <i style={{ width: `${share}%` }} />
      </div>
      <ul className={styles.progress}>
        {progress.steps.map((step) => (
          <li key={step.stepId} data-status={step.status}>
            <StatusDot
              state={
                step.verdictResolution?.kind === "repaired"
                  ? dots.passed
                  : // A FAIL kept as it is reads like a skip: settled by the user, not passed.
                    step.verdictResolution?.kind === "skipped" ||
                      step.verdictResolution?.kind === "accepted"
                    ? dots.skipped
                    : step.verdict?.verdict === "fail"
                      ? "failed"
                      : stoppedHere(step)
                        ? "stopped"
                        : step.paused
                          ? "waiting"
                          : dots[step.status]
              }
              className={styles.dot}
            />
            {bots && (
              <BotAvatar
                bot={owner(step.stepId)}
                unknown={!owner(step.stepId)}
                label={owner(step.stepId)?.name ?? t("group.member")}
                size={20}
              />
            )}
            <span className={styles.stepLine}>
              {titles.get(step.stepId) ?? step.stepId} ·{" "}
              {step.verdictResolution
                ? t(`group.plan.verdict.${step.verdictResolution.kind}`, {
                    step:
                      titles.get(step.verdictResolution.stepId) ?? step.verdictResolution.stepId,
                  })
                : step.verdict
                  ? t(`group.plan.verdict.${step.verdict.verdict}`, {
                      count: step.verdict.failures.length,
                    })
                  : stoppedHere(step)
                    ? t("group.plan.step.stopped")
                    : step.paused
                      ? t("group.plan.step.paused")
                      : t(`group.plan.step.${step.status}`)}
              {step.status === "running" && step.attempt > 0
                ? ` · ${t("group.plan.attempt", { n: step.attempt + 1 })}`
                : ""}
              {step.workspace && (
                <span className={styles.workspace} data-state={step.workspace}>
                  {t(`group.plan.workspace.${step.workspace}`)}
                  {!!step.conflictFiles?.length &&
                    ` · ${t("group.plan.workspace.files", { files: step.conflictFiles.slice(0, 5).join(", ") })}`}
                  {changes && step.executionRunId && step.workspace !== "shared" && (
                    <button
                      type="button"
                      onClick={() =>
                        changes.open({ scope: "turn", runId: step.executionRunId as string })
                      }
                    >
                      {t("group.plan.workspace.changes")}
                    </button>
                  )}
                </span>
              )}
              {progress.stoppedReason === "cost" && step.executionRunId && (
                <PlanBudgetRecovery
                  runId={step.executionRunId}
                  changed={() => setRevision((n) => n + 1)}
                />
              )}
            </span>
          </li>
        ))}
      </ul>
      {choice && (
        <GroupPlanChoice
          groupId={card.groupId}
          progress={{ ...progress, choice }}
          titles={titles}
          changed={(value, chosen) => {
            setProgress(value);
            if (chosen === "new_plan") setNewPlan(true);
          }}
        />
      )}
      {newPlan && !live(progress) && (
        <p className={styles.note}>{t("group.plan.choice.newPlanDone")}</p>
      )}
      {live(progress) &&
        !choice &&
        (confirming ? (
          <div className={styles.modify}>
            <p>{t("group.plan.stopConfirm")}</p>
            <div className={styles.actions}>
              <Button variant="secondary" disabled={stopping} onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" loading={stopping} onClick={() => void stop()}>
                {t("group.plan.stopAction")}
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.actions}>
            <Button variant="secondary" disabled={!peer} onClick={() => setConfirming(true)}>
              {t("group.plan.stop")}
            </Button>
          </div>
        ))}
      {failed && (
        <p role="alert" className={styles.note}>
          {t("group.plan.progressFailed")}
        </p>
      )}
    </div>
  );
}

function PlanBudgetRecovery({ runId, changed }: { runId: string; changed(): void }) {
  const { peer } = useRpc();
  const receipt = useRunReceipt(peer, runId);
  return receipt.data?.budgetRaise ? (
    <BudgetRaise
      receipt={receipt.data}
      reload={() => {
        receipt.retry();
        changed();
      }}
    />
  ) : null;
}
function stopReasonKey(reason: string | null) {
  switch (reason) {
    case "cost":
      return "group.plan.stop.cost";
    case "budget_exhausted":
      return "errors.budget_exhausted";
    case "model_requests":
      return "group.plan.stop.requests";
    case "active_seconds":
      return "group.plan.stop.time";
    case "round_limit":
      return "group.plan.stop.rounds";
    case "no_progress":
      return "group.plan.stop.progress";
    case "replan_limit":
      return "group.plan.stop.replans";
    default:
      return "group.plan.stop.other";
  }
}
