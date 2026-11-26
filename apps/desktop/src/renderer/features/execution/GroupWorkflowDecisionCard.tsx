import {
  type GroupWorkflowDecision,
  GroupWorkflowDecisionSchema,
  type Message,
} from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import cardStyles from "./chat-cards.module.css";
import styles from "./execution.module.css";

const reasonHelp = {
  permission_denied: "errors.permission_denied",
  execution_interrupted: "group.workflow.interruptedHelp",
  restart_interrupted: "group.workflow.interruptedHelp",
  acceptance_failed: "group.workflow.decisionHelp",
  cycle_replaced: "group.workflow.cycleReplacedHelp",
  task_not_completed: "group.workflow.taskIncompleteHelp",
  owner_unavailable: "group.workflow.ownerUnavailableHelp",
  model_price_unknown: "group.workflow.priceUnknownHelp",
  dependency_context_too_large: "group.workflow.inputTooLargeHelp",
  step_input_too_large: "group.workflow.inputTooLargeHelp",
  skill_unavailable: "group.workflow.methodUnavailableHelp",
  precheck_failed: "group.workflow.precheckFailedHelp",
  queue_capacity: "group.workflow.queueFullHelp",
  scheduler_error: "group.workflow.schedulerErrorHelp",
  budget_exhausted: "errors.budget_exhausted",
  repeated_operation: "errors.repeated_operation",
  agent_auth_failed: "errors.agent_auth_failed",
  agent_quota: "errors.agent_quota",
  agent_rate_limited: "errors.agent_rate_limited",
  agent_model_unavailable: "errors.agent_model_unavailable",
  coordinator_handed_over: "group.workflow.handedOverHelp",
  dispositions_exhausted: "group.workflow.handedOverHelp",
} as const;

export function GroupWorkflowDecisionCard({
  message,
  embedded = false,
}: {
  message: Message;
  /**
   * Inside another card (the inbox): no frame, shadow or decision edge of its own; the content
   * lines up with the host card's text column and the actions sit left in one wrapping row.
   */
  embedded?: boolean;
}) {
  const usage = message.usage;
  const parsed = GroupWorkflowDecisionSchema.safeParse(
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? usage.groupWorkflowDecision
      : undefined,
  );
  const { peer } = useRpc();
  const t = useT();
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const [resolved, setResolved] = useState<{
    action: GroupWorkflowDecision["resolution"];
    owner?: string;
  }>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const decision = parsed.success ? parsed.data : undefined;
  const decisionGroupId = decision?.groupId;
  const decisionState = decision?.state;
  const decisionOwnerBotId = decision?.ownerBotId;
  const finalReview = !!decision?.reviewSteps;
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setOwner("");
    setMembers([]);
    if (!peer || !decisionGroupId || decisionState === "resolved" || finalReview)
      return () => abort.abort();
    setMembersError(false);
    void Promise.all([
      peer.call(
        "groups.get",
        { groupId: decisionGroupId },
        { signal: abort.signal, timeoutMs: 10_000 },
      ),
      peer.call("bots.list", { limit: 200 }, { signal: abort.signal, timeoutMs: 10_000 }),
    ])
      .then(([group, bots]) => {
        if (abort.signal.aborted) return;
        const ids = new Set(group.members.map((member) => member.botId));
        const next = bots
          .filter((bot) => ids.has(bot.id) && bot.id !== decisionOwnerBotId)
          .map((bot) => ({ id: bot.id, name: bot.name }));
        setMembers(next);
      })
      .catch(() => {
        if (!abort.signal.aborted) setMembersError(true);
      });
    return () => abort.abort();
  }, [peer, decisionGroupId, decisionState, decisionOwnerBotId, finalReview]);
  const labels = useMemo(
    () => new Map(members.map((member) => [member.id, member.name])),
    [members],
  );
  if (!decision) return null;
  if (decision.state === "resolved" || resolved) {
    const action = decision.resolution ?? resolved?.action;
    const summary = action
      ? t(`group.workflow.resolved.${action}`, {
          title: decision.title,
          name: decision.reassignedTo ?? resolved?.owner ?? t("group.member"),
        })
      : t("group.workflow.decisionResolved", { title: decision.title });
    const note = decision.note ?? (action === "accept" ? t("group.workflow.accept") : undefined);
    return (
      <section
        className={
          embedded
            ? `${styles.embeddedDecision} ${styles.embeddedResolved}`
            : `${styles.inlineCard} ${styles.cardHead} ${cardStyles.card}`
        }
        role="status"
      >
        {/* The host card already shows the item's mark. */}
        {!embedded && <IconTile icon="check" tone="green" size="sm" />}
        <span className={styles.planStep} title={summary}>
          <span className={styles.planCount}>{summary}</span>
        </span>
        {note && (
          <small className={`${styles.planStep} ${styles.hint}`} title={note}>
            <span className={styles.planCount}>{note}</span>
          </small>
        )}
      </section>
    );
  }
  // A run that stopped with a full context would only stop again on a plain retry.
  const contextFull = decision.reasonCode === "context_full" && !decision.confirmationRequired;
  const submit = async (action: "retry" | "skip" | "reassign" | "accept") => {
    const signal = lifetime.current?.signal;
    if (!peer || !signal || signal.aborted || busy || (action === "reassign" && !owner)) return;
    setBusy(true);
    setError(false);
    try {
      await peer.call(
        "groups.workflow.resolve",
        {
          groupId: decision.groupId,
          workflowRunId: decision.workflowRunId,
          stepId: decision.stepId,
          action,
          ...(action === "reassign" ? { ownerBotId: owner } : {}),
          confirmed: true,
        },
        { signal, timeoutMs: 30_000 },
      );
      if (!signal.aborted) setResolved({ action, owner: labels.get(owner) });
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <section
      className={
        embedded
          ? styles.embeddedDecision
          : `${styles.inlineCard} ${styles.planCard} ${cardStyles.card} ${cardStyles.decision}`
      }
      aria-label={t("group.workflow.decisionTitle")}
    >
      <div className={styles.cardHead}>
        {!embedded && <IconTile icon="warning" tone="amber" size="sm" />}
        <b>{decision.title}</b>
        {!decision.reviewSteps && (
          <small>{t("group.workflow.attempt", { count: decision.attempt + 1 })}</small>
        )}
      </div>
      <p className={embedded ? styles.embeddedText : undefined}>
        {contextFull
          ? t("group.workflow.contextFullHelp", {
              files: decision.reading || t("group.workflow.contextFullFiles"),
            })
          : t(
              decision.reviewSteps
                ? "group.workflow.finalReviewHelp"
                : decision.confirmationRequired
                  ? "group.workflow.confirmationHelp"
                  : (reasonHelp[decision.reasonCode as keyof typeof reasonHelp] ??
                    "group.workflow.blockedHelp"),
            )}
      </p>
      {decision.note && (
        <small className={`${styles.planStep} ${styles.hint}`} title={decision.note}>
          <span className={styles.planCount}>{decision.note}</span>
        </small>
      )}
      {decision.reviewSteps && (
        <ul>
          {decision.reviewSteps.map((step) => (
            <li key={step.stepId}>
              <b>{step.title}</b>
              {[...new Set(step.checks)].map((check) => (
                <p key={check}>{check}</p>
              ))}
            </li>
          ))}
        </ul>
      )}
      <div
        className={embedded ? styles.embeddedActions : `${styles.cardHead} ${cardStyles.actions}`}
      >
        {decision.confirmationRequired && (
          <Button variant="secondary" disabled={busy} onClick={() => void submit("accept")}>
            {t("group.workflow.accept")}
          </Button>
        )}
        {!decision.reviewSteps && (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => void submit("retry")}>
              {t(contextFull ? "group.workflow.retryNarrower" : "group.workflow.retry")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void submit("skip")}>
              {t("group.workflow.skip")}
            </Button>
            <select
              aria-label={t("group.workflow.chooseOwner")}
              value={owner}
              disabled={busy}
              onChange={(event) => setOwner(event.currentTarget.value)}
            >
              <option value="">{t("group.workflow.chooseOwner")}</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {labels.get(member.id)}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              disabled={busy || !owner}
              onClick={() => void submit("reassign")}
            >
              {t("group.workflow.reassign")}
            </Button>
          </>
        )}
      </div>
      {error && <p role="alert">{t("group.workflow.decisionError")}</p>}
      {membersError && <p role="alert">{t("group.workflow.membersError")}</p>}
    </section>
  );
}
