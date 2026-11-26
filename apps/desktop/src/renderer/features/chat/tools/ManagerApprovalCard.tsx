import { approvalCountdown, approvalFactText, approvalText } from "@pibot/client-core";
import type { Approval } from "@pibot/protocol";
import { approvalStyles as styles, useSettings } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import lively from "./lively.module.css";
import own from "./manager-card.module.css";

type Decide = (
  id: string,
  decision: "allow" | "deny",
  remember: boolean,
  preauthorize?: boolean,
  rememberSecrets?: string[],
) => Promise<void>;

/**
 * The default Pi's management and dispatch cards (owner-approved look 2026-11-24): what changes,
 * row by row, and one "don't ask again" box that sets Pi's own level for that kind to always.
 */
export function ManagerApprovalCard({
  approval,
  refresh,
  decide,
  inbox = false,
}: {
  approval: Approval;
  refresh(): Promise<void>;
  decide: Decide;
  inbox?: boolean;
}) {
  const { t, language } = useSettings();
  const text = approvalText(approval, language);
  const lead = "lead" in text ? text.lead : undefined;
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const remaining = Math.max(0, Math.ceil((Date.parse(approval.expiresAt) - now) / 1000));
  useEffect(() => {
    if (approval.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approval.status]);
  const dispatch = approval.category === "work_dispatch";
  const canRemember = approval.canRemember && remaining > 0;
  const resolve = async (decision: "allow" | "deny") => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await decide(approval.id, decision, decision === "allow" && canRemember && always);
      await refresh();
    } catch {
      if (active.current) setError(true);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      tabIndex={-1}
      id={`approval-${approval.id}`}
      className={`${styles.approval} ${inbox ? styles.inbox : lively.card}`}
      aria-label={t("approval.label")}
    >
      {!inbox && (
        <header>
          <span aria-hidden="true">
            <Icon name={dispatch ? "arrow" : "users"} />
          </span>
          <strong>{text.title}</strong>
        </header>
      )}
      {inbox && <strong>{text.title}</strong>}
      {lead && <p className={`${styles.context} ${own.lead}`}>{lead}</p>}
      <dl className={styles.facts}>
        {text.facts.map((fact) => (
          <div key={JSON.stringify(fact)}>
            <dt>{fact.label ?? t(`facts.${fact.kind}`)}</dt>
            <dd>{approvalFactText(fact, t)}</dd>
          </div>
        ))}
      </dl>
      <footer className={own.choices}>
        {canRemember && (
          <label className={`${styles.check} ${own.check}`}>
            <input
              type="checkbox"
              checked={always}
              disabled={busy}
              onChange={(event) => setAlways(event.currentTarget.checked)}
            />
            {t(
              dispatch ? "approval.piRemember.work_dispatch" : "approval.piRemember.bot_management",
            )}
          </label>
        )}
        {error && (
          <p role="alert" className={styles.risk}>
            {t("approval.error")}
          </p>
        )}
        <div className={styles.actions}>
          <Button variant="secondary" disabled={busy} onClick={() => void resolve("deny")}>
            {t("approval.deny")}
          </Button>
          <Button loading={busy} onClick={() => void resolve("allow")}>
            {t("approval.allow")}
          </Button>
        </div>
        {remaining > 0 ? (
          <small role="timer">
            {t("approval.chatCountdown", { time: approvalCountdown(remaining) })}
          </small>
        ) : (
          <p role="status">{t("approval.awaitingExpiry")}</p>
        )}
      </footer>
    </section>
  );
}
