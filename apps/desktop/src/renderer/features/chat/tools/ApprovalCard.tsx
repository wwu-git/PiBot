import {
  approvalCountdown,
  approvalExplanation,
  approvalFactText,
  approvalText,
  connectorToolLabel,
  isolationReasonText,
} from "@pibot/client-core";
import { ComputerApprovalCard, ComputerApprovalResult } from "@pibot/computer-use/ui";
import { LoginApprovalCard } from "@pibot/credentials/ui";
import type { Approval, ToolCallRecord } from "@pibot/protocol";
import {
  ApprovalExplanation,
  approvalStyles as styles,
  useNavigation,
  useRpc,
  useSettings,
  useT,
} from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { ConnectorApprovalScope } from "./ConnectorApprovalScope.tsx";
import { DraftCard } from "./DraftCard.tsx";
import lively from "./lively.module.css";
import { ManagerApprovalCard } from "./ManagerApprovalCard.tsx";
import { useApprovalFolder } from "./use-approval-folder.ts";

const paidImageModel = (scope: { provider: string; model: string }) =>
  `${scope.provider} / ${scope.model}`;

type Result = NonNullable<ToolCallRecord["approval"]>;
export function ApprovalResult({ result, botId }: { result: Result; botId?: string }) {
  const t = useT();
  const { openBotPermissions } = useNavigation();
  return (
    <div className={result.status === "allowed" ? styles.success : styles.result} role="status">
      {t(`approval.${result.status}`)}
      <ApprovalExplanation {...approvalExplanation(result, t)} />
      {/* Remembered grants are listed per Bot in its profile panel; without a Bot there is no list. */}
      {result.remembered && botId && (
        <Button variant="ghost" onClick={() => openBotPermissions(botId)}>
          {t("approval.revokeHint")}
        </Button>
      )}
    </div>
  );
}
export type ApprovalDecision = (
  id: string,
  decision: "allow" | "deny",
  remember: boolean,
  preauthorize?: boolean,
  rememberSecrets?: string[],
) => Promise<void>;
interface ApprovalCardProps {
  approval: Approval;
  conversationId?: string;
  refresh(): Promise<void>;
  decide: ApprovalDecision;
  inbox?: boolean;
  context?: { botName: string; groupName: string };
}
export function ApprovalCard(props: ApprovalCardProps) {
  if (props.approval.draft)
    return (
      <DraftCard
        conversationId={props.approval.conversationId ?? props.conversationId}
        approval={props.approval}
        refresh={props.refresh}
        inbox={props.inbox}
      />
    );
  const request = props.approval.computer;
  // Computer grants carry their own choices and resolve through `computer.grant.resolve`.
  if (request)
    return props.approval.status === "pending" ? (
      <ComputerApprovalCard
        approval={props.approval}
        request={request}
        refresh={props.refresh}
        inbox={props.inbox}
      />
    ) : (
      <ComputerApprovalResult approval={props.approval} request={request} />
    );
  // First automatic login: account choice + the approval buttons, via `credentials.login.resolve`.
  const login = props.approval.login;
  if (login && props.approval.status === "pending")
    return (
      <LoginApprovalCard
        approval={props.approval}
        request={login}
        refresh={props.refresh}
        inbox={props.inbox}
      />
    );
  // The default Pi's management and dispatch cards list each change and remember as a level.
  if (
    props.approval.status === "pending" &&
    (props.approval.category === "bot_management" || props.approval.category === "work_dispatch")
  )
    return (
      <ManagerApprovalCard
        approval={props.approval}
        refresh={props.refresh}
        decide={props.decide}
        inbox={props.inbox}
      />
    );
  return <StandardApprovalCard {...props} />;
}
function StandardApprovalCard({
  approval,
  refresh,
  decide,
  inbox = false,
  context,
  conversationId,
}: ApprovalCardProps) {
  const { t, language } = useSettings();
  const text = approvalText(approval, language);
  const { peer } = useRpc();
  const { openSettings } = useNavigation();
  const [resolving, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [secretChanged, setSecretChanged] = useState(false);
  const [connectorChoice, setConnectorChoice] = useState<"once" | "bot" | "all">("once");
  const choiceApproval = useRef(approval.id);
  if (choiceApproval.current !== approval.id) {
    choiceApproval.current = approval.id;
    setConnectorChoice("once");
  }
  const secretVersion = JSON.stringify(approval.secretUses ?? []);
  const secretKey = `${approval.id}:${secretVersion}`;
  const previousSecretKey = useRef(secretKey);
  if (previousSecretKey.current !== secretKey) {
    previousSecretKey.current = secretKey;
    setSecretChanged(false);
  }
  const [now, setNow] = useState(Date.now);
  const active = useRef(true);
  const locked = useRef(false);
  const folder = useApprovalFolder(
    peer,
    approval.id,
    approval.status === "pending",
    locked,
    refresh,
  );
  const busy = resolving || folder.picking;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const expires = Date.parse(approval.expiresAt);
  const remaining = Math.max(0, Math.ceil((expires - now) / 1000));
  const paused = remaining === 0 && !approval.routineRunId;
  const expired = remaining === 0 && !paused;
  const canRemember =
    !paused &&
    approval.category !== "read_ai_config" &&
    approval.canRemember &&
    approval.rememberOnly !== "secrets" &&
    approval.risk !== "danger";
  const secretNames = approval.secretUses?.map((secret) => secret.name) ?? [];
  const canRememberSecrets =
    !paused &&
    approval.canRememberSecrets === true &&
    approval.source !== "routine" &&
    !approval.routineRunId &&
    approval.risk !== "danger" &&
    secretNames.length > 0 &&
    secretNames.every((name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name));
  const canPreauthorize =
    approval.category !== "read_ai_config" &&
    approval.source === "routine" &&
    !!approval.canPreauthorize &&
    approval.risk !== "danger";
  useEffect(() => {
    if (approval.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approval.status]);
  useEffect(() => {
    if (remaining === 0 && approval.status === "pending")
      void refresh().catch(() => {
        if (active.current) setError(true);
      });
  }, [remaining, approval.status, refresh]);
  if (approval.status !== "pending")
    return <ApprovalResult result={approval} botId={approval.botId} />;
  // "Always" remembers only this card's scope, listed on the Bot's profile panel. A token
  // card's "always" remembers only its tokens, never the command (`rememberOnly: "secrets"`).
  const resolve = async (
    decision: "allow" | "deny",
    always = false,
    allowConversation = false,
    rememberSecrets = false,
  ) => {
    if (!peer || locked.current || expired || (decision === "allow" && secretChanged)) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      if (allowConversation && decision === "allow") {
        await peer.call("approvals.resolve", {
          id: approval.id,
          decision,
          remember: false,
          ...(approval.taskWebRead ? { allowTaskWeb: true } : { allowConversation: true }),
          ...(approval.conversationId ? { conversationId: approval.conversationId } : {}),
        });
      } else if (!paused && approval.connectorConsent && decision === "allow") {
        await peer.call("approvals.resolve", {
          id: approval.id,
          decision,
          remember: false,
          connectorConsent: connectorChoice,
          ...((approval.conversationId ?? conversationId)
            ? { conversationId: approval.conversationId ?? conversationId }
            : {}),
        });
      } else
        await decide(
          approval.id,
          decision,
          decision === "allow" && canRemember && always,
          decision === "allow" && canPreauthorize && always,
          decision === "allow" && canRememberSecrets && rememberSecrets ? secretNames : undefined,
        );
      if (decision === "deny" && approval.searchDisclosure && active.current)
        openSettings("models");
      await refresh();
    } catch (cause) {
      if (active.current) {
        setError(true);
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === -32602 &&
          "message" in cause &&
          typeof cause.message === "string" &&
          cause.message.includes("Secret consent changed")
        )
          setSecretChanged(true);
      }
      // A failed refresh cannot turn an unconfirmed decision into a successful one.
      try {
        await refresh();
      } catch {
        if (active.current) setError(true);
      }
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  };
  const connector = approval.connectorConsent;
  const outsideWrite = approval.facts.some(
    (fact) => fact.kind === "warning" && fact.value === "outside_workplace_write",
  );
  const tokenCard = secretNames.length > 0;
  const tokenCwd = tokenCard ? text.facts.find((fact) => fact.kind === "cwd")?.value : undefined;
  const facts = [
    ...new Map(text.facts.map((fact) => [JSON.stringify(fact), fact])).values(),
  ].filter(
    (fact) =>
      // A token card shows the command, tokens and folder as its own rows (brain adds the
      // token line for the phone and notifications).
      !(
        tokenCard &&
        (fact.kind === "program" ||
          fact.kind === "cwd" ||
          (fact.kind === "warning" &&
            /^(访问令牌（不会显示值）|Access tokens \(values hidden\)):/.test(fact.value)))
      ) &&
      (!connector?.display ||
        !(
          (fact.kind === "read" &&
            [connector.connectorId, connector.display.tool].includes(fact.value)) ||
          (fact.kind === "warning" &&
            /^(记住授权的实际范围|Actual scope of remembered permission):/.test(fact.value) &&
            fact.value.includes(connector.connectorId))
        )) &&
      // Acceptance 2026-11-20: "cannot remember this approval" next to a working "Always allow"
      // for a routine's script; the pinned approval is exactly that script's content.
      !(canPreauthorize && fact.kind === "warning" && fact.value === "incomplete_analysis") &&
      !(fact.kind === "program" && fact.value.startsWith("script-file:")),
  );
  const sandboxService = (approval.explanation ?? []).some(
    (step) => step.code === "local_service_once" || step.code === "system_service_once",
  );
  const serviceTarget = approval.facts.findLast((fact) => fact.kind === "network")?.value;
  const systemService = (approval.explanation ?? []).some(
    (step) => step.code === "system_service_once",
  );
  const serviceLabel = !systemService
    ? serviceTarget
    : /^com\.apple\.trustd(?:\.|$)/.test(serviceTarget ?? "")
      ? t("permissions.serviceTrust")
      : serviceTarget === "com.apple.system.opendirectoryd.libinfo"
        ? t("permissions.serviceDirectory")
        : serviceTarget === "com.apple.system.notification_center"
          ? t("permissions.serviceNotification")
          : t("permissions.serviceOther", { service: serviceTarget ?? "" });
  // The subtitle names the program (127.0.0.1:5037 · adb); "Why am I asked?" keeps the full path.
  const serviceProgram = approval.facts
    .filter((fact) => fact.kind === "program")
    .map((fact) => fact.value.split(/[/\\]/).pop() || fact.value)
    .join(", ");
  const connectorCall = approval.connectorCall;
  // Routine cards keep the brain's title, which leads with the routine's name.
  const title =
    connectorCall && !approval.routineRunId
      ? t("approval.connectorTitle", {
          bot: connectorCall.bot,
          name: connectorCall.name,
          tool: connectorToolLabel(connectorCall, language, t),
        })
      : text.title;
  // Command and write grants cover the workplace root, which cannot be inferred from cwd.
  const rememberText = sandboxService
    ? t("approval.sandboxRemember")
    : approval.category === "connector"
      ? t("approval.rememberConnector")
      : approval.grantScope?.kind === "submit"
        ? t("approval.rememberSubmit", { scope: approval.grantScope.domain })
        : approval.grantScope?.kind === "web_read"
          ? t("approval.rememberWebRead")
          : approval.grantScope?.kind === "paid_image"
            ? t("approval.rememberPaidImage", { model: paidImageModel(approval.grantScope) })
            : approval.category === "web"
              ? t("approval.rememberWeb", { scope: approval.domain ?? "" })
              : approval.category === "run_command"
                ? t("approval.rememberPrograms", {
                    // Same wording as the program rows: a script is named by its content.
                    programs: approval.facts
                      .filter(
                        (fact) => fact.kind === "program" && !fact.value.startsWith("script-file:"),
                      )
                      .map((fact) => approvalFactText(fact, t))
                      .join(", "),
                  })
                : approval.category === "write_file"
                  ? t("approval.rememberWrite")
                  : t("approval.rememberFolder");
  const scope = approval.grantScope;
  const scopeText =
    scope?.kind === "workplace" || scope?.kind === "programs"
      ? scope.root
      : scope?.kind === "folder"
        ? scope.path
        : scope?.kind === "domain"
          ? scope.domain
          : scope?.kind === "submit"
            ? t("permissions.submitScope", { site: scope.domain })
            : scope?.kind === "web_read"
              ? t("permissions.webReadScope")
              : scope?.kind === "paid_image"
                ? t("permissions.paidImageScope", { model: paidImageModel(scope) })
                : "";
  return (
    <section
      tabIndex={-1}
      id={`approval-${approval.id}`}
      className={`${styles.approval} ${inbox ? styles.inbox : lively.card} ${approval.risk === "danger" ? styles.danger : ""}`}
      data-tone={approval.risk === "danger" ? "red" : undefined}
      aria-label={t("approval.label")}
    >
      {context && (
        <p className={styles.context}>
          {t("group.approvalContext", { name: context.botName, group: context.groupName })}
        </p>
      )}
      {!approval.isolation.available && (
        <p className={styles.warning}>
          {t("isolation.warning")} {isolationReasonText(approval.isolation.reason, t)}
        </p>
      )}
      {!inbox && (
        <header>
          <span aria-hidden="true">
            {approval.category === "web" ? (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <ellipse cx="12" cy="12" rx="4" ry="9" />
                <path d="M3 12h18" />
              </svg>
            ) : approval.risk === "danger" ? (
              <Icon name="warning" />
            ) : tokenCard ? (
              <Icon name="key" />
            ) : (
              // A file request under a terminal icon read like a command approval.
              <Icon
                name={
                  ["write_file", "read_file", "list_dir"].includes(approval.category)
                    ? "file"
                    : approval.category === "connector"
                      ? "link"
                      : "terminal"
                }
              />
            )}
          </span>
          <strong>
            {approval.searchDisclosure
              ? t(
                  approval.searchDisclosure?.provider === "keyless"
                    ? "search.keylessDisclosure"
                    : approval.searchDisclosure?.provider === "bing"
                      ? "search.bingDisclosure"
                      : "search.chatDisclosure",
                )
              : title}
          </strong>
        </header>
      )}
      {approval.risk === "danger" && <p className={styles.risk}>{t("approval.danger")}</p>}
      {approval.searchDisclosure && (
        <p>
          {t(
            approval.searchDisclosure?.provider === "keyless"
              ? "search.keylessDisclosure"
              : approval.searchDisclosure?.provider === "bing"
                ? "search.bingDisclosure"
                : "search.chatDisclosure",
          )}
          <br />
          {t("search.querySummary", { query: approval.searchDisclosure.querySummary })}
        </p>
      )}
      {tokenCard ? (
        <>
          <dl className={styles.facts}>
            {approval.command && (
              <div>
                <dt>{t("approval.row.command")}</dt>
                <dd>
                  <code style={{ overflowWrap: "anywhere" }}>{approval.command}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>{t("approval.row.tokens")}</dt>
              <dd>
                {t("approval.tokensHidden", { names: secretNames.join(t("tool.group.separator")) })}
              </dd>
            </div>
            {tokenCwd && (
              <div>
                <dt>{t("approval.row.cwd")}</dt>
                <dd>{tokenCwd}</dd>
              </div>
            )}
          </dl>
          <p className={styles.note}>{t("approval.tokenInjection")}</p>
        </>
      ) : sandboxService ? (
        // The website card's target block: inset like the rest of the card, sentence in grey.
        <div className={styles.url}>
          {serviceLabel} · {serviceProgram}
          <small>
            {t(
              (approval.explanation ?? []).some((step) => step.code === "system_service_once")
                ? "facts.value.system_service"
                : "facts.value.local_service",
            )}
          </small>
        </div>
      ) : (
        approval.command && (
          <pre className={styles.command}>
            <code>{approval.command}</code>
          </pre>
        )
      )}
      {approval.url && (
        <div className={styles.url}>
          {approval.url}
          <small>{approval.domain}</small>
        </div>
      )}
      <ApprovalExplanation
        {...approvalExplanation(approval, t)}
        collapsedTitle={t("approval.whyAsk")}
      />
      <dl className={styles.facts}>
        {facts.map((fact) => (
          <div
            key={JSON.stringify(fact)}
            className={fact.risk === "danger" ? styles.risk : undefined}
          >
            <dt>{t(`facts.${fact.kind}`)}</dt>
            <dd style={fact.kind === "write" ? { whiteSpace: "pre-wrap" } : undefined}>
              {approvalFactText(fact, t)}
            </dd>
          </div>
        ))}
      </dl>
      {/* The lasting way is the topic's folder (like /add-dir), never this card. */}
      {outsideWrite && (
        <div className={styles.context}>
          <p>{t("approval.outsideWriteFolderHint")}</p>
          {!paused && approval.canAddWritableFolder && (
            <Button
              variant="secondary"
              disabled={!peer || busy || expired}
              loading={folder.picking}
              onClick={() => void folder.add()}
            >
              {t("approval.addWritableFolder")}
            </Button>
          )}
          {folder.picking && <p role="status">{t("folders.picking")}</p>}
          {folder.error && <p role="alert">{t(folder.error)}</p>}
        </div>
      )}
      {context &&
        canRemember &&
        approval.category === "write_file" &&
        approval.grantScope?.kind === "workplace" && (
          <p className={styles.context}>{t("approval.groupWriteHint")}</p>
        )}
      {!paused && approval.connectorConsent && (
        <ConnectorApprovalScope
          request={approval.connectorConsent}
          choice={connectorChoice}
          setChoice={setConnectorChoice}
          disabled={busy || expired}
        />
      )}

      {!paused && approval.taskWebRead && <p>{t("approval.taskWebsiteHint")}</p>}
      {!paused && approval.conversationWebDomain && (
        <p>{t("approval.conversationWebsiteHint", { domain: approval.conversationWebDomain })}</p>
      )}
      <footer>
        {!approval.connectorConsent && (canRemember || canPreauthorize) && (
          <small>
            {t("approval.alwaysHint", {
              scope: canPreauthorize
                ? [t("routines.allowFuture"), scopeText].filter(Boolean).join(" · ")
                : rememberText,
            })}
          </small>
        )}
        {!paused && (
          <small role="timer">
            {t(approval.routineRunId ? "approval.countdown" : "approval.chatCountdown", {
              time: approvalCountdown(remaining),
            })}
          </small>
        )}
        {remaining === 0 && (
          <p role="status">{t(paused ? "approval.paused" : "approval.awaitingExpiry")}</p>
        )}
        {error && (
          <p role="alert" className={styles.risk}>
            {t(secretChanged ? "approval.secretChanged" : "approval.error")}
          </p>
        )}
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={!peer || busy || expired}
            onClick={() => void resolve("deny")}
          >
            {t(approval.searchDisclosure ? "search.changeService" : "approval.deny")}
          </Button>
          <Button
            variant={
              (!approval.connectorConsent && (canRemember || canPreauthorize)) || canRememberSecrets
                ? "secondary"
                : undefined
            }
            loading={busy}
            disabled={!peer || expired || secretChanged}
            onClick={() => void resolve("allow")}
          >
            {t(
              approval.connectorConsent
                ? "approval.connectorAllow"
                : approval.searchDisclosure
                  ? "search.allow"
                  : "approval.allowOnce",
            )}
          </Button>
          {!approval.connectorConsent &&
            (canRemember || canPreauthorize) &&
            !approval.searchDisclosure && (
              <Button
                disabled={!peer || busy || expired}
                onClick={() => void resolve("allow", true)}
              >
                {t(
                  sandboxService
                    ? "approval.sandboxRemember"
                    : approval.category === "connector"
                      ? "approval.allowFuture"
                      : "approval.allowAlways",
                )}
              </Button>
            )}
          {canRememberSecrets && (
            <Button
              disabled={!peer || busy || expired || secretChanged}
              onClick={() => void resolve("allow", false, false, true)}
            >
              {t(
                secretNames.length === 1
                  ? "approval.allowTokenAlways"
                  : "approval.allowTokensAlways",
              )}
            </Button>
          )}
          {!paused && (approval.conversationWebDomain || approval.taskWebRead) && (
            <Button
              variant="secondary"
              disabled={!peer || busy || expired}
              onClick={() => void resolve("allow", false, true)}
            >
              {t(approval.taskWebRead ? "approval.allowTaskWeb" : "approval.allowConversation")}
            </Button>
          )}
          {(error || expired) && (
            <Button variant="ghost" onClick={() => void refresh()}>
              {t("common.retry")}
            </Button>
          )}
        </div>
      </footer>
    </section>
  );
}
