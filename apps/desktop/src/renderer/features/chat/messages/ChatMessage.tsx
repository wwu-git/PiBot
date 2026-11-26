import {
  interruptedMessage,
  messageBubbleText,
  providerFailureText,
  silentWake,
  type ToolPaths,
} from "@pibot/client-core";
import { AgentReplyFacts } from "@pibot/external-agents/ui";
import { agentTurnFacts } from "@pibot/external-agents-contract";
import {
  AGENT_SETUP_ERROR_CODES,
  answeredOnPhone,
  type Bot,
  backgroundRestartUsage,
  isBackgroundRestart,
  type Message,
  messageDispatch,
  messageFailureCode,
  PI_DISPATCH_TOOLS,
} from "@pibot/protocol";
import { BotAvatar, botAvatarLook, useSettings, useT } from "@pibot/renderer-kit";
import { MessageRoutineProposals } from "@pibot/routines/ui";
import { MessageSkillProposals, TeachTrialReturn } from "@pibot/skills/ui";
import { Button, Card, Icon } from "@pibot/ui";
import { GitInstallCard, TurnCard } from "@pibot/workspaces/ui";
import { type CSSProperties, memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { RunReceipt } from "../../receipt/RunReceipt.tsx";
import styles from "../chat.module.css";
import { BackgroundFinished } from "../status/BackgroundFinished.tsx";
import { BackgroundCommandLine } from "../status/BackgroundLine.tsx";
import { InterruptedRecovery } from "../status/InterruptedRecovery.tsx";
import { ModelRecovery } from "../status/ModelRecovery.tsx";
import { RunActivityLine } from "../status/RunActivityLine.tsx";
import { useBackgroundRun } from "../status/use-background-run.ts";
import type { ApprovalDecision } from "../tools/ApprovalCard.tsx";
import { DispatchReceipts } from "../tools/DispatchReceipts.tsx";
import type { ActivityState } from "../tools/local-activity.ts";
import { ToolActivity } from "../tools/ToolActivity.tsx";
import { MessageSelectionToggle, MessageTranslation } from "./MessageActionParts.tsx";
import { useMessageActions } from "./MessageActionsContext.tsx";
import { MessageAttachmentOverflow } from "./MessageAttachmentOverflow.tsx";
import { MessageAttachments } from "./MessageAttachments.tsx";
import { MessageForwardCard } from "./MessageForwardCard.tsx";
import { MessageImageDelivery } from "./MessageImageDelivery.tsx";
import { QuotedMessage, useMessageReplyMenu } from "./MessageReply.tsx";
import { mentionText } from "./markdown-mentions.tsx";
import { ReplyContent } from "./ReplyContent.tsx";

interface ChatMessageProps {
  message: Message;
  preview?: boolean;
  imageActor?: { botId: string; conversationId: string; groupId?: string };
  name: string;
  busy: boolean;
  retry?: string;
  retryAttachments?: string[];
  onRetry(text: string, attachmentIds?: string[]): void;
  onModelsSettings(): void;
  onCredentialsSettings?(): void;
  /** Opens where the run's working folders are associated (Bot panel or group settings). */
  onWorkplaceSettings?(): void;
  botId?: string;
  bot?: Bot;
  activity?: ActivityState;
  approvalContext?: { botName: string; groupName: string };
  toolPaths?: ToolPaths;
  refreshApprovals?: () => Promise<void>;
  decideApproval?: ApprovalDecision;
  heading?: ReactNode;
  footer?: ReactNode;
  userFooter?: ReactNode;
  generatingLabel?: string;
  unknownAvatar?: boolean;
  queued?: boolean;
  showProgress?: boolean;
  mentionNames?: readonly string[];
  highlighted?: boolean;
  focusToolCallId?: string;
  /**
   * Where this message sits in its run's split replies. `continued`
   * hides the repeated avatar; only the `last` one carries the turn's changed-files card, built
   * from every tool of the turn (`tools`).
   */
  turn?: {
    continued: boolean;
    last: boolean;
    tools?: Message["tools"];
    /** Maintainers 2026-11-13 (layout A): every file the turn delivered, by the reply that sent it. */
    attachments?: { messageId: string; attachments: Message["attachments"] }[];
    /** The user message that started this run (从这里重来 on a Bot reply retries from it). */
    origin?: Message;
    receipt?: { messageId: string | null; message?: Message };
  };
}

// Deltas preserve all other message references, so completed Markdown need not be parsed again.
export const ChatMessage = memo(function ChatMessage({
  message,
  preview = false,
  imageActor,
  name,
  busy,
  retry,
  retryAttachments,
  onRetry,
  onModelsSettings,
  onCredentialsSettings,
  onWorkplaceSettings,
  botId,
  bot,
  activity,
  approvalContext,
  toolPaths,
  refreshApprovals,
  decideApproval,
  heading,
  footer,
  userFooter,
  generatingLabel,
  unknownAvatar,
  queued,
  showProgress = true,
  mentionNames,
  highlighted,
  focusToolCallId,
  turn,
}: ChatMessageProps) {
  const t = useT();
  const replyMenu = useMessageReplyMenu(message, name, preview, turn?.origin);
  const messageActions = useMessageActions();
  const [stoppedReceiptMessage, setStoppedReceiptMessage] = useState<string | null>(null);
  const onReceiptStoppedChange = useCallback(
    (stopped: boolean) => setStoppedReceiptMessage(stopped ? message.id : null),
    [message.id],
  );
  // An external agent that never started did no work; no receipt for that send.
  const runId =
    message.role === "assistant" &&
    message.status !== "streaming" &&
    !(message.errorCode && AGENT_SETUP_ERROR_CODES.has(message.errorCode))
      ? message.runId
      : null;
  // Maintainers 2026-11-13 (layout A): a direct chat ends each turn with one card — delivered files,
  // changed files and the receipt together.
  const turnFiles = !preview && !!turn && !heading && !imageActor?.groupId;
  const endCard = turnFiles && !!turn?.last;
  const receiptMessageId = turn?.receipt ? turn.receipt.messageId : message.id;
  const receiptMessage = turn?.receipt?.message ?? message;
  const background = useBackgroundRun(message.botId ?? botId, runId);
  // An agent turn's own figures; parsed once so the memoised receipt keeps its props stable.
  const agentFacts = useMemo(() => agentTurnFacts(receiptMessage.usage), [receiptMessage.usage]);
  // The run's work receipt, merged into the turn's changed-files card when there is one.
  const receipt = useCallback(
    (embedded: boolean) =>
      runId && receiptMessageId ? (
        <RunReceipt
          runId={runId}
          messageId={receiptMessageId}
          embedded={embedded || endCard}
          files={!embedded}
          agent={agentFacts}
          onStoppedChange={onReceiptStoppedChange}
        />
      ) : null,
    [runId, receiptMessageId, agentFacts, onReceiptStoppedChange, endCard],
  );
  if (silentWake(message)) return null;
  // The restart notice is one model-facing message whose content also lists command ids;
  // the interface shows the event in the current language instead of repeating that raw text.
  if (isBackgroundRestart(message.usage)) {
    const restart = backgroundRestartUsage(message.usage);
    return (
      <article className={styles.notice} aria-label={t("background.systemEvent")}>
        {!restart
          ? t("background.restartNoticePlain")
          : restart.unverified
            ? t("background.restartNoticeUnverified", {
                count: restart.stopped,
                unverified: restart.unverified,
              })
            : t("background.restartNotice", { count: restart.stopped })}
      </article>
    );
  }
  // An accepted routine queues fixed bilingual text for the model; people see a system line.
  const routineNotice = routineNoticeOf(message);
  if (routineNotice) return <RoutineNoticeLine notice={routineNotice} />;
  if (
    message.role === "user" &&
    message.usage &&
    typeof message.usage === "object" &&
    !Array.isArray(message.usage) &&
    message.usage.systemEvent === true
  )
    return (
      <article className={styles.notice} aria-label={t("background.systemEvent")}>
        {message.usage.trigger === "background_finished" ? (
          <BackgroundFinished
            key={message.id}
            message={message}
            botId={message.botId ?? botId ?? imageActor?.botId}
            groupId={imageActor?.groupId}
            preview={preview}
          />
        ) : (
          <>
            <span aria-hidden="true">·</span> {message.content}
          </>
        )}
      </article>
    );
  if (message.role === "user") {
    // FORWARD-DISPLAY: a forward shows the user's note; its material lives in the card below.
    const text = messageBubbleText(message, t);
    const dispatch = messageDispatch(message);
    return (
      <>
        {dispatch && (
          <div className={styles.fromPi}>
            <Icon name="arrow" size={12} />
            {t("chat.fromPi", { name: dispatch.from })}
          </div>
        )}
        <article
          {...replyMenu}
          className={`${styles.user} ${highlighted ? styles.messageFocus : ""}`}
          data-message-id={message.id}
          data-selecting={(!preview && messageActions?.selecting) || undefined}
          data-selected={messageActions?.selected.has(message.id) || undefined}
          aria-label={t("chat.you")}
        >
          {!preview && <MessageSelectionToggle message={message} name={name} />}
          <QuotedMessage message={message} />
          {mentionNames ? mentionText(text, mentionNames, styles.mentionText ?? "") : text}
          <MessageForwardCard message={message} />
          <MessageAttachments
            attachments={message.attachments}
            messageId={message.id}
            readOnly={preview}
          />
          {userFooter}
          {!preview && <MessageTranslation message={message} />}
        </article>
      </>
    );
  }
  const paidImage =
    !!message.usage &&
    typeof message.usage === "object" &&
    !Array.isArray(message.usage) &&
    message.usage.imageGeneration === true;
  const failureCode = messageFailureCode(message);
  const providerFailure = failureCode && providerFailureText(message, t);
  const failed = !!failureCode;
  const interrupted = interruptedMessage(message);
  const waiting = activity?.approvals.some(
    (approval) => approval.messageId === message.id && approval.status === "pending",
  );
  const streaming = message.status === "streaming" && showProgress;
  // Every private chat used to say "Pi is replying", whichever Bot was answering.
  const generating = generatingLabel ?? t("chat.generating", { name: bot?.name ?? name ?? "Pi" });
  // Maintainers 2026-11-13: a direct chat's split replies read "what I'm about to do", then the steps
  // it ran (the brain keeps steps run before any words in their own message). Groups keep the
  // steps above the reply, which there is one message per turn.
  const stepsAfterText = !heading && !imageActor?.groupId;
  const steps = !preview &&
    botId &&
    message.runId &&
    activity &&
    refreshApprovals &&
    decideApproval && (
      <ToolActivity
        conversationId={message.conversationId}
        messageId={message.id}
        runId={message.runId}
        botId={botId}
        messageStatus={message.status}
        paths={toolPaths}
        records={message.tools}
        live={activity.tools}
        approvals={activity.approvals}
        approvalContext={approvalContext}
        refresh={refreshApprovals}
        decide={decideApproval}
        focusToolCallId={focusToolCallId}
        slim={stepsAfterText}
      />
    );
  return (
    <article
      {...replyMenu}
      className={`${styles.assistant} ${heading ? styles.withSender : ""} ${highlighted ? styles.messageFocus : ""}`}
      data-message-id={message.id}
      data-continued={turn?.continued || undefined}
      data-selecting={(!preview && messageActions?.selecting) || undefined}
      data-selected={messageActions?.selected.has(message.id) || undefined}
      aria-label={name}
    >
      {!preview && <MessageSelectionToggle message={message} name={name} />}
      {heading && (
        // A group names each speaker in its own Bot colour.
        <div
          className={styles.sender}
          style={
            bot
              ? ({ "--sender": `var(--ink-${botAvatarLook(bot).color})` } as CSSProperties)
              : undefined
          }
        >
          {heading}
        </div>
      )}
      <span className={styles.avatar}>
        <BotAvatar
          bot={bot}
          unknown={unknownAvatar}
          size={28}
          label={name}
          state={
            streaming
              ? queued
                ? "idle"
                : waiting
                  ? "waiting"
                  : "working"
              : failed
                ? "blocked"
                : "idle"
          }
        />
      </span>
      <div className={styles.reply}>
        {!stepsAfterText && steps}
        {message.content.trim() && (
          <ReplyContent
            message={message}
            mentionNames={mentionNames}
            botId={botId}
            streaming={streaming}
            // A run paused on a card is not typing: no caret on its own line under the text.
            paused={!!waiting}
            generating={generating}
          />
        )}
        {stepsAfterText && steps}
        {!message.content.trim() && streaming && (
          // Before the first words arrive, the speaker shows a typing pill in its colour.
          <span
            className={styles.typing}
            data-waiting={waiting || undefined}
            style={
              bot
                ? ({
                    "--chat-c": `var(--avatar-${botAvatarLook(bot).color})`,
                    "--chat-ink": `var(--ink-${botAvatarLook(bot).color})`,
                  } as CSSProperties)
                : undefined
            }
            role="status"
            aria-label={waiting ? t("approval.pending") : generating}
          >
            <span className={styles.typingDots} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {waiting ? t("approval.pending") : generating}
          </span>
        )}
        {!preview &&
          (message.botId ?? botId) &&
          (message.tools?.some((tool) => tool.tool === "routine_propose") ||
            activity?.tools.some(
              (tool) => tool.messageId === message.id && tool.tool === "routine_propose",
            )) && (
            <MessageRoutineProposals
              botId={(message.botId ?? botId) as string}
              messageId={message.id}
            />
          )}
        {!preview &&
          (message.botId ?? botId) &&
          (message.tools?.some((tool) => tool.tool === "skill_propose") ||
            activity?.tools.some(
              (tool) => tool.messageId === message.id && tool.tool === "skill_propose",
            )) && (
            <MessageSkillProposals
              botId={(message.botId ?? botId) as string}
              botName={bot?.name ?? name ?? ""}
              messageId={message.id}
            />
          )}
        {!preview &&
          (message.tools?.some((tool) =>
            (PI_DISPATCH_TOOLS as readonly string[]).includes(tool.tool),
          ) ||
            activity?.tools.some(
              (tool) =>
                tool.messageId === message.id &&
                (PI_DISPATCH_TOOLS as readonly string[]).includes(tool.tool),
            )) && <DispatchReceipts messageId={message.id} />}
        {!preview && runId && (message.botId ?? botId) && (
          <TeachTrialReturn botId={(message.botId ?? botId) as string} runId={runId} />
        )}
        {!turnFiles && (
          <MessageAttachments
            attachments={message.attachments}
            messageId={message.id}
            readOnly={preview}
          />
        )}
        {message.role === "assistant" && (
          <MessageAttachmentOverflow message={message} readOnly={preview} />
        )}
        {!preview && (imageActor || botId) && (
          <MessageImageDelivery
            message={message}
            actor={imageActor ?? { botId: botId as string, conversationId: message.conversationId }}
            busy={imageActor ? false : busy}
          />
        )}
        {!preview && message.role === "assistant" && message.status !== "streaming" && (
          <AgentReplyFacts usage={message.usage} />
        )}
        {!preview && gitSetupCard(message.usage) && <GitInstallCard context="parallel" />}
        {!preview &&
          (turn && !turn.last ? (
            receipt(false)
          ) : endCard ? (
            <div className={styles.turnEnd}>
              {turn?.attachments?.map((part) => (
                <MessageAttachments
                  key={part.messageId}
                  attachments={part.attachments}
                  messageId={part.messageId}
                  readOnly={false}
                />
              ))}
              <TurnCard
                bare
                message={turn?.tools ? { ...receiptMessage, tools: turn.tools } : receiptMessage}
                activity={activity}
                receipt={runId ? receipt : undefined}
              />
            </div>
          ) : (
            <TurnCard
              message={turn?.tools ? { ...receiptMessage, tools: turn.tools } : receiptMessage}
              activity={activity}
              receipt={runId ? receipt : undefined}
            />
          ))}
        {!preview && streaming && activity?.runActivity && (
          <RunActivityLine activity={activity.runActivity} />
        )}
        {answeredOnPhone(message.usage) && (
          <p className={styles.notice}>{t("chat.answeredOnPhone")}</p>
        )}
        {!preview && <MessageTranslation message={message} />}
        {background.pending && (
          <p className={styles.notice} role="status">
            {t(background.waiting ? "background.taskWaiting" : "background.continued")}
          </p>
        )}
        {failed && !background.pending && (
          <Card className={styles.error} role="alert">
            <p>
              {t(
                // "permission_denied" also names an image-provider refusal; for an external
                // agent it is Pi Bot's launch policy (the Bot may not run commands or edit files).
                agentFacts && failureCode === "permission_denied"
                  ? "externalAgents.errors.launchDenied"
                  : `errors.${failureCode ?? "internal"}`,
              )}
            </p>
            {providerFailure && <p className={styles.notice}>{providerFailure}</p>}
            {agentFacts?.errorDetail && (
              <p className={styles.notice}>
                {t("externalAgents.errors.agentSaid", {
                  name: agentFacts.name,
                  detail: agentFacts.errorDetail,
                })}
              </p>
            )}
            {background.commands
              .filter((row) => row.status === "running")
              .map((row) => (
                <BackgroundCommandLine key={row.id} row={row} />
              ))}
            <div className={styles.actions}>
              {!preview && (
                <ModelRecovery message={{ ...message, errorCode: failureCode ?? null }} bot={bot} />
              )}
              {(paidImage || bot?.category === "image") &&
                message.errorCode === "quota_exhausted" && (
                  <Button variant="secondary" onClick={onModelsSettings}>
                    {t("chat.changeModel")}
                  </Button>
                )}
              {!paidImage && failureCode !== "output_limit" && (
                <Button
                  variant="secondary"
                  disabled={busy || (retry === undefined && !retryAttachments?.length)}
                  onClick={() => onRetry(retry ?? "", retryAttachments)}
                >
                  {t(
                    message.errorCode === "quota_exhausted"
                      ? "chat.retryAfterQuota"
                      : "common.retry",
                  )}
                </Button>
              )}
              {(message.errorCode === "auth_failed" ||
                message.errorCode === "claude_subscription_unsupported" ||
                message.errorCode === "subscription_unsupported") && (
                <Button variant="ghost" onClick={onCredentialsSettings ?? onModelsSettings}>
                  {t("chat.checkKey")}
                </Button>
              )}
              {message.errorCode === "no_model" && (
                <Button variant="ghost" onClick={onModelsSettings}>
                  {t("chat.goToSettings")}
                </Button>
              )}
              {message.errorCode === "workplace_unavailable" && onWorkplaceSettings && (
                <Button variant="ghost" onClick={onWorkplaceSettings}>
                  {t("chat.openWorkplace")}
                </Button>
              )}
            </div>
            {failureCode !== "output_limit" && retry === undefined && !retryAttachments?.length && (
              <span className={styles.notice}>{t("chat.retryNeedsHistory")}</span>
            )}
          </Card>
        )}
        {message.status === "aborted" &&
          !background.pending &&
          (interrupted ? (
            !preview && <InterruptedRecovery message={message} botId={message.botId ?? botId} />
          ) : (
            // A reply the user stopped reads as a band carrying its model action.
            <div className={`${styles.band} ${styles.stoppedBand}`} data-tone="warn">
              <span className={styles.notice}>
                {t(
                  // Only say text was kept when there is some (a stop before any words keeps none).
                  !message.content.trim()
                    ? "chat.stoppedEmpty"
                    : !preview && stoppedReceiptMessage === message.id
                      ? "chat.stoppedPreserved"
                      : "chat.stopped",
                )}
              </span>
              {!preview && <ModelRecovery message={message} bot={bot} />}
            </div>
          ))}
        {footer}
      </div>
    </article>
  );
});

/**
 * A trusted routine confirmation carries display facts, never renderer-chosen ones; anything
 * malformed falls back to the ordinary bubble so the content cannot silently disappear.
 */
function routineNoticeOf(message: Message) {
  const usage = message.usage;
  if (message.role !== "user" || !usage || typeof usage !== "object" || Array.isArray(usage))
    return undefined;
  const notice = usage.routineNotice;
  if (!notice || typeof notice !== "object" || Array.isArray(notice)) return undefined;
  return {
    kind: notice.kind === "updated" ? ("updated" as const) : ("created" as const),
    name: typeof notice.name === "string" ? notice.name : undefined,
    at: typeof notice.at === "string" ? notice.at : undefined,
  };
}

/** Same quiet line as other chat system records, in the interface language and local time. */
const RoutineNoticeLine = memo(function RoutineNoticeLine({
  notice,
}: {
  notice: ReturnType<typeof routineNoticeOf> & object;
}) {
  const t = useT();
  const { language } = useSettings();
  const label = t(
    notice.kind === "updated" ? "routines.notice.updated" : "routines.notice.created",
    { name: notice.name ?? t("routineProposal.untitled") },
  );
  const at = notice.at ? new Date(notice.at) : undefined;
  const time = at && !Number.isNaN(at.getTime()) ? at.toLocaleString(language) : undefined;
  return (
    <p className={styles.systemLine} role="note">
      {time ? `${label} · ${t("routines.next")} ${time}` : label}
    </p>
  );
});

/** A plan's turns notice that also offers to install Git (written by the program, once per plan). */
function gitSetupCard(usage: Message["usage"]) {
  return (
    !!usage && typeof usage === "object" && !Array.isArray(usage) && usage.gitSetup === "parallel"
  );
}
