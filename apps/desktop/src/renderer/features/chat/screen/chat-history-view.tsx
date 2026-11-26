import { emptyActivity, replyReceiptPositions } from "@pibot/client-core";
import { BotAvatar } from "@pibot/renderer-kit";
import { Button, Card } from "@pibot/ui";
import { type ComponentProps, Fragment } from "react";
import { MessageExecutionCards } from "../../execution/MessageExecutionCards.tsx";
import { MessageMemoryNotices } from "../../workspace/memory/MemoryNotices.tsx";
import styles from "../chat.module.css";
import { AdditionContext } from "../composer/SendOptions.tsx";
import { ChatMessage } from "../messages/ChatMessage.tsx";
import { JumpLatest } from "../messages/JumpLatest.tsx";
import { MessageTime } from "../messages/MessageTime.tsx";
import { userBubbleStyle } from "../messages/user-bubble.ts";
import { ChatNoticeLines } from "../status/ChatNotices.tsx";
import { SandboxNoticesProvider } from "../status/SandboxNotices.tsx";
import { AgentStepsContext, agentStepDetails } from "../tools/agent-steps.ts";
import type { ChatScreenModel } from "./chat-screen-model.ts";
import { StarterCards } from "./StarterCards.tsx";

const suggestions = [
  "suggestion.plan",
  "suggestion.write",
  "suggestion.learn",
  "suggestion.brainstorm",
] as const;
type HistoryMessage = ChatScreenModel["state"]["messages"][number];
type TurnPosition = NonNullable<ComponentProps<typeof ChatMessage>["turn"]>;
/**
 * A run's split replies — which continue the one before, which ends the turn, and every
 * tool the turn ran (the last reply's changed-files card covers the whole turn). One pass.
 */
function turnPositions(list: readonly HistoryMessage[]) {
  const result = new Map<string, TurnPosition>();
  const receipts = replyReceiptPositions(list);
  const sameRun = (a?: HistoryMessage, b?: HistoryMessage) =>
    !!a &&
    !!b &&
    a.role === "assistant" &&
    b.role === "assistant" &&
    !!a.runId &&
    a.runId === b.runId;
  const tools = new Map<string, NonNullable<HistoryMessage["tools"]>>();
  // Maintainers 2026-11-13: a Bot reply retries from the user message that started its run.
  const origins = new Map<string, HistoryMessage>();
  for (const message of list) {
    if (message.role === "user" && message.runId && !origins.has(message.runId))
      origins.set(message.runId, message);
    if (message.role === "assistant" && message.runId && message.tools?.length)
      tools.set(message.runId, [...(tools.get(message.runId) ?? []), ...message.tools]);
  }
  // Maintainers 2026-11-13 (layout A): files delivered by one unbroken stretch of replies sit in the
  // end card of that stretch (a stretch, not the run: a message in between starts a new card).
  let files: NonNullable<TurnPosition["attachments"]> = [];
  list.forEach((message, index) => {
    if (message.role !== "assistant" || !message.runId) return;
    if (!sameRun(list[index - 1], message)) files = [];
    if (message.attachments?.length)
      files.push({ messageId: message.id, attachments: message.attachments });
    const last = !sameRun(message, list[index + 1]);
    result.set(message.id, {
      continued: sameRun(list[index - 1], message),
      last,
      origin: origins.get(message.runId),
      receipt: receipts.get(message.id),
      ...(last
        ? {
            tools: tools.get(message.runId) ?? message.tools,
            ...(files.length ? { attachments: files } : {}),
          }
        : {}),
    });
  });
  return result;
}

export function renderChatHistory(screen: ChatScreenModel) {
  const {
    t,
    controller,
    state,
    topic,
    timelineDay,
    starters,
    workplaces,
    topicPlace,
    activity,
    grouped,
    textarea,
    editText,
    scroll,
    messageContent,
    name,
    notices,
    noticeBotName,
    busy,
    toolPaths,
    sendingBlocked,
    modelsSettings,
    credentialsSettings,
    workplaceSettings,
    retries,
    userFooter,
    messageFocus,
    messageScroll,
    send,
    executionReplies,
    captureScroll,
    loadMore,
    memoryNotices,
  } = screen;
  const turns = turnPositions(state.messages);
  const agentName = state.bot?.kind === "agent" ? state.bot.name : undefined;
  const agentSteps = agentName
    ? { agentName, details: agentStepDetails(state.messages) }
    : undefined;
  const history = (
    <div className={styles.scrollViewport}>
      <JumpLatest {...messageScroll} />
      <div
        data-sandbox-scope
        ref={scroll}
        className={styles.scroll}
        onScroll={(event) => {
          const container = event.currentTarget;
          if (!messageScroll.onScroll(event)) return;
          if (container.scrollTop <= 24 && !state.historyError) void loadMore();
        }}
      >
        <div
          ref={messageContent}
          className={styles.messages}
          style={userBubbleStyle(state.bot?.avatarColor)}
        >
          {(state.loading || state.metadataRetrying) && (
            <p className={styles.notice} role="status">
              {t(state.metadataRetrying ? "chat.metadataWaiting" : "chat.loadingHistory")}
            </p>
          )}
          {(state.historyError || state.metadataError || workplaces.error || topicPlace.error) && (
            <Card className={styles.loadError} role="alert">
              <p>
                {t(
                  state.metadataError
                    ? "chat.metadataError"
                    : state.historyError
                      ? "chat.historyError"
                      : topicPlace.missing
                        ? "workplaces.folderMissingHint"
                        : "workplaces.unavailable",
                )}
              </p>
              <Button
                variant="secondary"
                disabled={state.loading || state.loadingMore}
                onClick={() => {
                  captureScroll();
                  if (state.historyError || state.metadataError) void controller.retryHistory();
                  if (workplaces.error) void workplaces.refresh();
                  if (topicPlace.error) topicPlace.refresh();
                }}
              >
                {t("common.retry")}
              </Button>
            </Card>
          )}
          {!state.loading && state.hasMore && (
            <Button
              variant="ghost"
              className={styles.earlier}
              loading={state.loadingMore}
              onClick={() => void loadMore()}
            >
              {t("chat.loadEarlier")}
            </Button>
          )}
          {!state.loading && !state.hasMore && state.messages.length > 0 && (
            <p className={styles.notice}>{t("chat.noMoreHistory")}</p>
          )}
          {!state.loading && !state.historyError && state.messages.length === 0 && (
            <section className={styles.empty}>
              <BotAvatar bot={state.bot} size={88} label={name} />
              {topic.readOnly ? (
                <p>{t("conversationImport.emptyTopic")}</p>
              ) : !topic.locked ? (
                <>
                  <h1>{t("chat.hello", { name })}</h1>
                  <p>{t("chat.empty")}</p>
                  <StarterCards
                    items={starters.length ? starters : suggestions.map((key) => t(key))}
                    disabled={busy}
                    onPick={(text) => {
                      editText(text);
                      textarea.current?.focus();
                    }}
                  />
                </>
              ) : null}
            </section>
          )}
          {state.messages.map((message, index) => (
            <Fragment key={message.id}>
              <ChatNoticeLines notices={notices.before.get(message.id)} botName={noticeBotName} />
              <MessageTime
                at={message.createdAt}
                previousAt={state.messages[index - 1]?.createdAt}
                firstTopicMessage={index === 0 && !state.hasMore}
                today={timelineDay}
              />
              <ChatMessage
                message={message}
                preview={!state.historyReady || topic.locked}
                highlighted={messageFocus.highlighted?.messageId === message.id}
                focusToolCallId={
                  messageFocus.highlighted?.messageId === message.id
                    ? messageFocus.highlighted.toolCallId
                    : undefined
                }
                turn={turns.get(message.id)}
                name={name}
                generatingLabel={
                  message.runId && notices.waitingRuns.has(message.runId)
                    ? t("computerHandoff.runWaiting")
                    : undefined
                }
                busy={busy || sendingBlocked}
                retry={retries.get(message.id)?.text}
                retryAttachments={retries.get(message.id)?.ids}
                onRetry={send}
                userFooter={topic.locked ? undefined : userFooter(message)}
                footer={
                  <MessageExecutionCards
                    message={message}
                    cards={executionReplies.get(message.id)}
                  />
                }
                onModelsSettings={modelsSettings}
                onCredentialsSettings={credentialsSettings}
                onWorkplaceSettings={workplaceSettings}
                botId={state.bot?.id}
                bot={state.bot}
                activity={grouped.get(message.id) ?? emptyActivity}
                toolPaths={toolPaths}
                refreshApprovals={activity.refresh}
                decideApproval={activity.decide}
              />
              <MessageMemoryNotices notices={memoryNotices} messageId={message.id} />
            </Fragment>
          ))}
          {/* A role Bot's starters stay offered until the user has written once. */}
          {!topic.locked &&
            !state.loading &&
            starters.length > 0 &&
            state.messages.length > 0 &&
            !state.hasMore &&
            !state.messages.some((message) => message.role === "user") && (
              <div className={styles.suggestions}>
                <StarterCards
                  items={starters}
                  disabled={busy}
                  onPick={(text) => {
                    editText(text);
                    textarea.current?.focus();
                  }}
                />
              </div>
            )}
          <ChatNoticeLines notices={notices.tail} botName={noticeBotName} />
        </div>
      </div>
    </div>
  );
  const additions = {
    ...(activity.state.runActivity ? { activity: activity.state.runActivity } : {}),
    // An addition the run never took goes back to this chat's message box, attachments included.
    restore: (message: HistoryMessage) => {
      screen.setText((current) => (current ? `${current}\n${message.content}` : message.content));
      if (message.attachments?.length) screen.retryDraft.add(message.attachments);
    },
  };
  return (
    <SandboxNoticesProvider notices={notices.all} approvals={activity.state.approvals}>
      <AdditionContext.Provider value={additions}>
        {agentSteps ? (
          <AgentStepsContext.Provider value={agentSteps}>{history}</AgentStepsContext.Provider>
        ) : (
          history
        )}
      </AdditionContext.Provider>
    </SandboxNoticesProvider>
  );
}
