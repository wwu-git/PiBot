import { FolderPicker } from "@pibot/renderer-kit";
import { Button, Card, IconButton } from "@pibot/ui";
import { ExecutionPanel } from "../../execution/ExecutionPanel.tsx";
import { MemoryNoticesStatus } from "../../workspace/memory/MemoryNotices.tsx";
import styles from "../chat.module.css";
import {
  AttachmentButton,
  AttachmentDrafts,
  AttachmentIssues,
  RetryAttachmentDrafts,
} from "../composer/Attachments.tsx";
import { shouldSend } from "../composer/input.ts";
import { ModeSwitch } from "../composer/ModeSwitch.tsx";
import { NextReplyField } from "../composer/NextReplySuggestion.tsx";
import { SendOptions } from "../composer/SendOptions.tsx";
import { ReplyDraft } from "../messages/MessageReply.tsx";
import { CompactionActions } from "../status/CompactionActions.tsx";
import { ContextHintNotice } from "../status/ContextHintNotice.tsx";
import { RunStatusNotice } from "../status/RunStatusNotice.tsx";
import { SubscriptionAuthNotice } from "../status/SubscriptionAuthNotice.tsx";
import type { ChatScreenModel } from "./chat-screen-model.ts";

// The compaction row appears by itself only after an automatic compaction or context overflow
// failed; offering it on every healthy conversation was noise. Otherwise it opens from the
// composer's + menu (「整理上下文」) for someone who wants to shorten a long topic.
const compactionFailures = new Set(["compaction_failed", "compaction_timeout", "context_overflow"]);

function compactionFailure(messages: ChatScreenModel["state"]["messages"]): string | undefined {
  const last = messages.findLast((message) => message.role === "assistant");
  return last?.errorCode && compactionFailures.has(last.errorCode) ? last.id : undefined;
}

export function renderChatComposer(screen: ChatScreenModel) {
  const {
    peer,
    disconnected,
    t,
    draftId,
    controller,
    state,
    text,
    setText,
    retryDraft,
    mediaError,
    setDraftModeSelection,
    draftMode,
    isDraft,
    activity,
    memoryNotices,
    waiting,
    composing,
    textarea,
    editText,
    browseInputHistory,
    resetInputHistory,
    name,
    runId,
    busy,
    folders,
    folderModel,
    sendingBlocked,
    draftLocked,
    model,
    attachments,
    skillCommands,
    modelsSettings,
    draftLine,
    send,
    nextReply,
    requestKey,
    compactRequested,
    requestCompact,
    compactDismissed,
    dismissCompaction,
  } = screen;
  const failedCompaction = compactionFailure(state.messages);
  const needsCompaction = !!failedCompaction && failedCompaction !== compactDismissed;
  const canOrganize =
    state.bot?.category !== "image" &&
    !!state.bot &&
    !!state.conversationId &&
    state.messages.some((message) => message.role === "assistant");
  return (
    <div className={styles.composerArea}>
      {disconnected && (
        <p className={styles.band} data-tone="warn" role="status">
          {t("workspace.brainUnavailable")}
        </p>
      )}
      <SubscriptionAuthNotice
        bot={state.bot}
        providers={screen.catalog.providers}
        openSettings={screen.credentialsSettings}
      />
      <RunStatusNotice peer={peer} messages={state.messages} />
      {state.contextHint &&
        canOrganize &&
        state.bot &&
        state.conversationId &&
        !needsCompaction &&
        compactRequested !== state.conversationId && (
          <ContextHintNotice
            key={`${state.bot.id}:${state.conversationId}`}
            disabled={busy || sendingBlocked}
            organize={() => {
              requestCompact(state.conversationId ?? undefined);
              void controller.dismissContextHint();
            }}
            dismiss={() => void controller.dismissContextHint()}
          />
        )}
      {canOrganize &&
        state.bot &&
        state.conversationId &&
        (needsCompaction || compactRequested === state.conversationId) && (
          <CompactionActions
            key={`${state.bot.id}:${state.conversationId}`}
            peer={peer}
            botId={state.bot.id}
            conversationId={state.conversationId}
            disabled={busy || sendingBlocked}
            dismiss={() => {
              requestCompact((requested) =>
                requested === state.conversationId ? undefined : requested,
              );
              dismissCompaction(failedCompaction);
            }}
          />
        )}
      {/* An external agent has its own model; Pi Bot's model settings do not apply. */}
      {!state.loading &&
        !state.metadataLoading &&
        !model &&
        !state.metadataError &&
        state.bot?.kind !== "agent" && (
          <div className={styles.noModel} role="status">
            <span>{t("chat.noModel")}</span>
            <Button variant="ghost" onClick={modelsSettings}>
              {t("chat.goToSettings")}
            </Button>
          </div>
        )}
      {requestKey && (
        <Card className={styles.error} role="alert">
          <p>{t(requestKey, { name })}</p>
          <div className={styles.actions}>
            {state.retryText !== undefined &&
              !state.appendUncertain &&
              !state.requestError?.startsWith("append_") && (
                <Button
                  variant="secondary"
                  disabled={
                    busy ||
                    state.retryText === undefined ||
                    (state.requestError === "uncertain" && state.historyError)
                  }
                  onClick={() => state.retryText !== undefined && void send(state.retryText)}
                >
                  {t(
                    state.requestError === "quota_exhausted"
                      ? "chat.retryAfterQuota"
                      : "common.retry",
                  )}
                </Button>
              )}
            {(state.requestError === "no_model" ||
              state.requestError === "quota_exhausted" ||
              state.requestError === "image_unsupported" ||
              state.requestError === "scanned_pdf_unsupported") && (
              <Button variant="ghost" onClick={modelsSettings}>
                {t(
                  state.requestError === "quota_exhausted"
                    ? "chat.changeModel"
                    : "chat.goToSettings",
                )}
              </Button>
            )}
          </div>
        </Card>
      )}
      {state.stopError && (
        <p role="alert" className={styles.band} data-tone="danger">
          {t("chat.stopError")}
        </p>
      )}
      {activity.state.error && (
        <p role="alert" className={styles.band} data-tone="danger">
          {t("approval.loadError")}{" "}
          <Button variant="ghost" onClick={() => void activity.refresh()}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      <MemoryNoticesStatus notices={memoryNotices} />
      {state.bot?.category === "image" && (
        <p className={styles.band} data-tone="info">
          {t("media.autoMode")} · {t("media.defaults")}
          {runId && <> · {t("media.steerUnsupported")}</>}
        </p>
      )}
      {mediaError && (
        <p role="alert" className={styles.band} data-tone="danger">
          {t(mediaError)}
        </p>
      )}
      <ReplyDraft textarea={textarea} disabled={state.pending} />
      <AttachmentIssues
        issues={attachments.issues}
        dismiss={attachments.dismissIssue}
        openModels={modelsSettings}
      />
      {attachments.reading && (
        <p role="status" className={styles.band} data-tone="info">
          {t("attachments.reading")}
        </p>
      )}
      {retryDraft.failed && (
        <p role="alert" className={styles.band} data-tone="danger">
          {t("messages.retryDraftFailed")}{" "}
          <Button variant="ghost" onClick={retryDraft.reload}>
            {t("messages.retryDraftLoad")}
          </Button>
        </p>
      )}
      <RetryAttachmentDrafts
        attachments={retryDraft.attachments}
        remove={retryDraft.remove}
        disabled={draftLocked || attachments.reading}
      />
      <AttachmentDrafts
        drafts={attachments.drafts}
        remove={attachments.remove}
        disabled={draftLocked || attachments.reading}
      />
      {isDraft && draftMode === "plan" && (
        <p className={styles.planModeHint}>
          {t("agentWork.planHint")}{" "}
          <Button
            variant="ghost"
            onClick={() => setDraftModeSelection({ id: draftId, mode: "execute" })}
          >
            {t("agentWork.executeInstead")}
          </Button>
        </p>
      )}
      {!isDraft && <ExecutionPanel />}
      {skillCommands.popup}
      {waiting && (
        <p className={styles.band} data-tone="info" role="status">
          {t("chat.additionWaiting")}
        </p>
      )}
      {/* Maintainers 2026-11-13: the mode switch and a draft's folder line share one row above the
          composer; stacked they took two rows of height. They wrap only on a narrow window. */}
      <div className={styles.composerControls}>
        {state.bot?.category !== "image" && (
          <ModeSwitch
            botId={state.bot?.id}
            draftMode={isDraft ? draftMode : undefined}
            onDraftMode={
              isDraft ? (mode) => setDraftModeSelection({ id: draftId, mode }) : undefined
            }
          />
        )}
        {isDraft && folderModel && (
          <div className={styles.draftFolders}>
            {draftLine[0]}
            <FolderPicker
              model={folderModel}
              variant="draft"
              inherit={folders.inherit}
              placement="above"
            />
            {draftLine[1]}
            <span className={styles.draftFoldersNote}>· {t("folders.draftNote")}</span>
          </div>
        )}
      </div>
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          if (!sendingBlocked) void send(text);
        }}
      >
        <AttachmentButton
          disabled={draftLocked || attachments.reading}
          add={attachments.add}
          organize={
            canOrganize ? () => requestCompact(state.conversationId ?? undefined) : undefined
          }
        />
        <NextReplyField suggestion={nextReply}>
          <textarea
            ref={textarea}
            className={styles.input}
            rows={1}
            aria-label={t("chat.placeholder", { name })}
            aria-describedby={["chat-input-hint", nextReply.id].filter(Boolean).join(" ")}
            placeholder={nextReply.text ? "" : t("chat.placeholder", { name })}
            value={text}
            disabled={disconnected || state.pending || state.loading}
            // Disabling a focused textarea drops its focus, so after a pasted image finished
            // reading Enter went nowhere; read-only keeps focus while send() still waits for it.
            readOnly={attachments.reading}
            aria-busy={attachments.reading}
            aria-autocomplete="list"
            aria-controls={skillCommands.open ? skillCommands.id : undefined}
            aria-activedescendant={skillCommands.open ? skillCommands.activeId : undefined}
            onChange={(event) => {
              nextReply.dismiss();
              editText(event.currentTarget.value);
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                void attachments.add(files);
              }
            }}
            onCompositionStart={() => {
              composing.current = true;
              nextReply.composition(true);
            }}
            onCompositionEnd={() => {
              composing.current = false;
              nextReply.composition(false);
            }}
            onKeyDown={(event) => {
              if (skillCommands.onKeyDown(event, composing.current)) return;
              if (nextReply.onKeyDown(event, composing.current)) return;
              if (browseInputHistory(event, composing.current)) return;
              if (shouldSend(event.nativeEvent, composing.current)) {
                event.preventDefault();
                if (!sendingBlocked) void send(text);
              }
            }}
          />
        </NextReplyField>
        <SendOptions
          botId={state.bot?.id}
          image={state.bot?.category === "image"}
          agent={state.bot?.kind === "agent"}
          busy={!!runId}
          disabled={
            disconnected || state.loading || state.pending || !state.bot || state.metadataError
          }
          draftMode={isDraft ? draftMode : undefined}
          onDraftMode={isDraft ? (mode) => setDraftModeSelection({ id: draftId, mode }) : undefined}
          send={
            (!text.trim() && !attachments.drafts.length && !retryDraft.attachments.length) ||
            sendingBlocked
              ? undefined
              : (mode) => void send(text, undefined, mode)
          }
        />
        {state.appendUncertain ? (
          <IconButton
            className={styles.composerButton}
            type="button"
            label={t("chat.appendConfirm")}
            disabled={disconnected || state.pending}
            onClick={(event) => {
              // A fast receipt can turn this reused button into Send before its default action.
              event.preventDefault();
              void controller.confirmAppend().then((confirmedText) => {
                if (confirmedText === undefined) return;
                resetInputHistory();
                attachments.clear();
                setText((current) => (current === confirmedText ? "" : current));
              });
            }}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="m5 12 4 4L19 6" />
            </svg>
          </IconButton>
        ) : (
          <IconButton
            className={styles.composerButton}
            type="submit"
            variant="primary"
            label={t("chat.send")}
            title={
              runId && !waiting
                ? t(
                    state.bot?.category === "image"
                      ? "media.steerUnsupported"
                      : "chat.additionHint.steer",
                  )
                : t("chat.send")
            }
            disabled={
              state.loading ||
              sendingBlocked ||
              attachments.reading ||
              (!text.trim() && !attachments.drafts.length && !retryDraft.attachments.length) ||
              !state.bot ||
              state.metadataError ||
              (state.requestError === "uncertain" && state.historyError)
            }
          >
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
              <path d="M12 19V5m-6 6 6-6 6 6" />
            </svg>
          </IconButton>
        )}
        {runId && (
          <IconButton
            className={styles.composerButton}
            type="button"
            label={t("chat.stop")}
            disabled={disconnected || state.stopping}
            onClick={() => void controller.abort()}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="10" height="10" rx="2" />
            </svg>
          </IconButton>
        )}
      </form>
      <div className={styles.hint} id="chat-input-hint">
        {t("chat.inputHint")}
      </div>
    </div>
  );
}
