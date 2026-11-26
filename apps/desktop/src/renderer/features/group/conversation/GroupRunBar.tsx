import type { Bot, Group, MethodResults } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Icon } from "@pibot/ui";
import { useEffect, useState } from "react";
import type { PublicRun } from "../data.ts";
import styles from "../group.module.css";

type Current = MethodResults["groups.plan.current"];
type Progress = MethodResults["groups.plan.progress"];
const POLL_MS = 4_000;

/**
 * Maintainers 2026-11-20: above the input, a
 * running plan or automatic back-and-forth shows what is happening and a pause button; a paused
 * group shows what is held and a continue button. It is the same pause as the header switch and
 * the chat words 「暂停 / 继续」 (`toggle` is the header's own handler), and it renders nothing when
 * there is nothing to pause or continue.
 */
export function GroupRunBar({
  group,
  bots,
  runs,
  busy,
  toggle,
}: {
  group: Group;
  bots: readonly Bot[];
  runs: readonly PublicRun[];
  busy: boolean;
  toggle(): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [current, setCurrent] = useState<Current>(null);
  const [progress, setProgress] = useState<Progress>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!peer) return;
    const reload = (groupId: string) => {
      if (groupId === group.id) setRevision((value) => value + 1);
    };
    const off = [
      peer.on("groups.changed", (event) => reload(event.groupId)),
      peer.on("group.task", (event) => reload(event.task.groupId)),
    ];
    return () => {
      for (const stop of off) stop();
    };
  }, [peer, group.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` and pause state re-read the plan.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    const options = { signal: controller.signal, timeoutMs: 10_000 };
    void (async () => {
      try {
        const entry = await peer.call("groups.plan.current", { groupId: group.id }, options);
        if (controller.signal.aborted) return;
        setCurrent(entry);
        if (entry?.card.status !== "started") {
          setProgress(undefined);
          return;
        }
        const value = await peer.call(
          "groups.plan.progress",
          { groupId: group.id, workflowRunId: entry.card.id },
          options,
        );
        if (!controller.signal.aborted) setProgress(value);
      } catch {
        // The bar is a shortcut; the task panel and header switch still show and change the state.
        if (!controller.signal.aborted) setProgress(undefined);
      }
    })();
    return () => controller.abort();
  }, [peer, group.id, group.paused, group.conversationId, revision]);
  const planLive = progress?.status === "running" || progress?.status === "waiting";
  useEffect(() => {
    if (!planLive) return;
    const timer = setInterval(() => setRevision((value) => value + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [planLive]);

  const name = (botId: string | undefined) =>
    bots.find((bot) => bot.id === botId)?.name ?? t("group.member");
  const names = (ids: readonly (string | undefined)[]) => {
    const unique = [...new Set(ids.map(name))];
    const sep = t("group.bar.separator");
    return unique.length > 3
      ? t("group.bar.andMore", { names: unique.slice(0, 3).join(sep), count: unique.length })
      : unique.join(sep);
  };
  const steps = current?.card.plan.steps ?? [];
  const owner = (stepId: string) =>
    current?.card.owners.find((item) => item.stepId === stepId)?.botId;
  const indexOf = (stepId: string) => steps.findIndex((step) => step.id === stepId) + 1;
  const titleOf = (stepId: string) => steps.find((step) => step.id === stepId)?.title ?? stepId;
  const total = progress?.total ?? steps.length;

  let lead: string | undefined;
  let detail = "";
  if (group.paused) {
    const held = progress?.steps.filter((step) => step.paused) ?? [];
    const first = held[0];
    lead = t("group.bar.pausedLead");
    detail =
      held.length === 1 && first
        ? t("group.bar.pausedOne", {
            index: indexOf(first.stepId),
            title: titleOf(first.stepId),
          })
        : held.length > 1
          ? t("group.bar.pausedMany", {
              count: held.length,
              owners: names(held.map((step) => owner(step.stepId))),
            })
          : planLive
            ? t("group.bar.pausedPlan")
            : t("group.bar.pausedAuto");
  } else if (planLive && progress) {
    const running = progress.steps.filter((step) => step.status === "running");
    const first = running[0];
    // A plan waiting for the user's choice on its card is not running anything.
    lead = t(progress.choice ? "group.plan.choice.title" : "group.bar.runningLead");
    if (running.length === 1 && first)
      detail = t("group.bar.runningOne", {
        index: indexOf(first.stepId),
        total,
        owner: name(owner(first.stepId)),
        title: titleOf(first.stepId),
      });
    else if (running.length > 1) {
      const order = running.map((step) => indexOf(step.stepId)).sort((a, b) => a - b);
      detail = t("group.bar.runningMany", {
        from: order[0] ?? 1,
        to: order.at(-1) ?? 1,
        total,
        count: running.length,
        owners: names(running.map((step) => owner(step.stepId))),
      });
    } else detail = t("group.bar.runningIdle", { passed: progress.passed, total });
  } else {
    const automatic = runs.filter(
      (run) => run.automatic && (run.status === "running" || run.status === "queued"),
    );
    if (automatic.length) {
      const ids = [...new Set(automatic.map((run) => run.botId))];
      lead = t("group.bar.autoLead", { count: ids.length });
      detail = names(ids);
    }
  }
  if (!lead) return null;
  return (
    <div className={styles.runBar} data-paused={group.paused || undefined} role="status">
      {group.paused ? (
        <Icon name="pause" size={14} className={styles.runBarIcon} />
      ) : (
        <span className={styles.runBarDot} aria-hidden="true" />
      )}
      <span className={styles.runBarText}>
        <b>{lead}</b>
        {detail && ` · ${detail}`}
      </span>
      <button
        type="button"
        className={group.paused ? styles.runBarContinue : styles.runBarPause}
        disabled={busy}
        onClick={toggle}
      >
        <Icon name={group.paused ? "play" : "pause"} size={13} />
        {t(group.paused ? "group.bar.continue" : "group.bar.pause")}
      </button>
    </div>
  );
}
