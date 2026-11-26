import type { MethodParams, GroupPlanProgress as Progress } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./group-plan.module.css";

type Choice = MethodParams["groups.plan.choose"]["choice"];

/**
 * The plan waits for the user (no replans left, or a skipped repair left a FAIL verdict): the
 * program's options as buttons. The brain checks the choice against the plan's current state.
 */
export function GroupPlanChoice({
  groupId,
  progress,
  titles,
  changed,
}: {
  groupId: string;
  progress: Progress & { choice: NonNullable<Progress["choice"]> };
  titles: ReadonlyMap<string, string>;
  changed(value: Progress, choice: Choice): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [busy, setBusy] = useState<Choice>();
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = undefined;
    },
    [],
  );
  const choose = async (choice: Choice) => {
    // The ref is set synchronously, so a double click sends one request.
    if (!peer || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(choice);
    setFailed(false);
    try {
      const value = await peer.call(
        "groups.plan.choose",
        { groupId, workflowRunId: progress.workflowRunId, choice, confirmed: true },
        { signal: controller.signal, timeoutMs: 15_000 },
      );
      if (!controller.signal.aborted) changed(value, choice);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(undefined);
      }
    }
  };
  const steps = progress.choice.stepIds.map((id) => titles.get(id) ?? id).join(" · ");
  const options: { choice: Choice; label: string; primary?: boolean }[] =
    progress.choice.kind === "replan_limit"
      ? [
          { choice: "continue", label: t("group.plan.choice.continue"), primary: true },
          { choice: "new_plan", label: t("group.plan.choice.newPlan") },
        ]
      : [
          { choice: "accept", label: t("group.plan.choice.accept"), primary: true },
          { choice: "stop", label: t("group.plan.stop") },
        ];
  return (
    <section className={styles.modify} aria-label={t("group.plan.choice.title")}>
      <p>
        {progress.choice.kind === "replan_limit"
          ? t("group.plan.choice.replanLimit")
          : t("group.plan.choice.fixSkipped", { steps })}
      </p>
      {progress.choice.kind === "replan_limit" && !!progress.choice.stepIds.length && (
        <p className={styles.note}>{t("group.plan.choice.replanLimitVerdicts", { steps })}</p>
      )}
      <div className={`${styles.actions} ${styles.choiceActions}`}>
        {options.map((option) => (
          <Button
            key={option.choice}
            variant={option.primary ? "primary" : "secondary"}
            disabled={!peer || (!!busy && busy !== option.choice)}
            loading={busy === option.choice}
            onClick={() => void choose(option.choice)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {failed && (
        <p role="alert" className={styles.note}>
          {t("group.plan.choice.failed")}
        </p>
      )}
    </section>
  );
}
