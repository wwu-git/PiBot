import { UnisolatedBadge } from "@pibot/external-agents/ui";
import { FolderPicker, hostPlatform } from "@pibot/renderer-kit";
import { ChangesLinkContext, ChangesPane } from "@pibot/workspaces/ui";
import { AutoCheckFolderMenu } from "../../autocheck/AutoCheckFolderMenu.tsx";
import { TasksPane } from "../../execution/TasksPane.tsx";
import { ExecutionContext } from "../../execution/workspace.tsx";
import { OfficePreviewContext } from "../../office/preview-context.tsx";
import { ContinuationPrompt } from "../../runtime/ContinuationPrompt.tsx";
import { ForceRelease } from "../../runtime/ForceRelease.tsx";
import { BrowserSlot } from "../../side-pane/BrowserSlot.tsx";
import { SidePane } from "../../side-pane/SidePane.tsx";
import { SidePaneActions } from "../../side-pane/SidePaneActions.tsx";
import sidePaneStyles from "../../side-pane/side-pane.module.css";
import { ProjectMemoryFolderMenu } from "../../workspace/memory/project/ProjectMemory.tsx";
import { BotProfile } from "../../workspace/profile/BotProfile.tsx";
import { ChatHeader } from "../ChatHeader.tsx";
import styles from "../chat.module.css";
import { AttachmentDropOverlay } from "../composer/Attachments.tsx";
import { userBubbleStyle } from "../messages/user-bubble.ts";
import { AgentAccountStatusBand } from "../status/AgentAccountStatusBand.tsx";
import { YoloControl } from "../status/YoloControl.tsx";
import { TopicMenu } from "../topics/TopicMenu.tsx";
import { importedTopicLabel } from "../topics/use-topic-title.ts";
import { renderChatComposer } from "./chat-composer-view.tsx";
import { renderChatHistory } from "./chat-history-view.tsx";
import type { ChatScreenModel } from "./chat-screen-model.ts";

export function renderConnectedChat(screen: ChatScreenModel) {
  const {
    peer,
    visible,
    disconnected,
    t,
    openBotPanel,
    closeBotPanel,
    navigate,
    catalog,
    topicId,
    draftId,
    state,
    setText,
    panelOpen,
    workplaces,
    topicPlace,
    actualTopicId,
    topic,
    feedbackTopic,
    isDraft,
    drainFailed,
    waiting,
    name,
    notices,
    busy,
    agentAccountStatus,
    checkAgentStatus,
    folderHolder,
    folderRequest,
    folderModel,
    workplaceName,
    sendingBlocked,
    attachmentDrop,
    messageFocus,
    sidePane,
    officePreview,
    selectedExecutionTask,
    setSelectedExecutionTask,
    execution,
    changes,
    browserActive,
    sendFromPane,
  } = screen;

  // Reply cards read the sidebar link from context; `body` keeps the chat markup unindented.
  const body = (
    <main
      ref={attachmentDrop.root}
      className={styles.main}
      style={userBubbleStyle(state.bot?.avatarColor)}
      {...attachmentDrop.handlers}
    >
      <ChatHeader
        name={name}
        bot={state.bot}
        onProfile={() => {
          if (state.bot) {
            if (panelOpen) closeBotPanel();
            else openBotPanel(state.bot.id, "details", true);
          }
        }}
        state={waiting || notices.waitingRuns.size ? "waiting" : busy ? "working" : "idle"}
        topics={
          state.bot && (
            <TopicMenu
              key={`${state.bot.id}:${actualTopicId ?? draftId ?? "current"}`}
              botId={state.bot.id}
              conversationId={actualTopicId}
              draft={isDraft}
              topic={topic}
            />
          )
        }
        agentBadge={
          // Only where it applies: an empty slot would leave a stray separator (X2).
          state.bot?.kind === "agent" && hostPlatform() === "win32" ? (
            <UnisolatedBadge />
          ) : undefined
        }
        folders={
          topic.readOnly ? (
            <span className={styles.subtitleText}>{importedTopicLabel(t, topic.importSource)}</span>
          ) : topic.locked ? (
            <span className={styles.subtitleText}>
              {t(topic.error ? "chat.topicUnavailable" : "common.loading")}
            </span>
          ) : folderModel ? (
            <FolderPicker
              model={folderModel}
              disabled={!state.bot || !workplaces.confirmed || (!isDraft && !topicPlace.confirmed)}
              openRequest={folderRequest}
              footer={
                state.bot && !isDraft ? (
                  <>
                    <ProjectMemoryFolderMenu model={folderModel} />
                    <AutoCheckFolderMenu
                      botIds={[state.bot.id]}
                      conversationId={actualTopicId}
                      nameOf={() => name}
                    />
                  </>
                ) : undefined
              }
            />
          ) : (
            <span className={styles.subtitleText}>{workplaceName}</span>
          )
        }
        panelOpen={panelOpen}
        newTopicDisabled={!topic.readOnly && sendingBlocked}
        changes={
          !topic.locked && (
            <div className={sidePaneStyles.pills}>
              <SidePaneActions
                pane={sidePane}
                changes={changes.state}
                previewCount={officePreview.count}
                hasDirectory={!!folderModel}
                browserActive={browserActive}
                disabled={!state.bot}
                openTasks={execution.open}
                openChanges={changes.togglePill}
              />
            </div>
          )
        }
        yolo={
          !topic.locked && (
            <YoloControl
              key={`${state.bot?.id}:${state.conversationId ?? draftId ?? "draft"}`}
              peer={peer}
              conversationId={state.conversationId}
              topicBotId={state.bot?.id}
            />
          )
        }
        onNewTopic={() => {
          if (state.bot)
            navigate({ name: "chat", botId: state.bot.id, draftId: crypto.randomUUID() });
        }}
      />
      {messageFocus.notice && (
        <p className={styles.focusNotice} role="status">
          {t(`chat.focus.${messageFocus.notice}`)}
        </p>
      )}
      <div
        className={`${styles.body} ${sidePane.open ? (sidePane.full ? sidePaneStyles.fullBody : sidePane.wide ? sidePaneStyles.wideBody : "") : ""}`}
      >
        <div className={styles.chatColumn}>
          {drainFailed && (
            <div role="alert" className={styles.health}>
              <span>{t("runtime.drainFailedBot")}</span>
              <ForceRelease botId={state.bot?.id} />
            </div>
          )}
          <ContinuationPrompt conversationId={state.conversationId} />
          {state.bot?.kind === "agent" && !isDraft && (
            <AgentAccountStatusBand
              name={name}
              status={agentAccountStatus}
              command={agentAccountStatus.command ?? ""}
              onCheck={() => void checkAgentStatus()}
              onProfile={() => state.bot && openBotPanel(state.bot.id, "agent", true)}
            />
          )}
          {renderChatHistory(screen)}
          {!topic.locked && renderChatComposer(screen)}
        </div>
        {state.bot && (
          <SidePane
            pane={sidePane}
            slots={[
              officePreview.slot,
              {
                id: "tasks",
                content: state.conversationId ? (
                  <TasksPane
                    selected={selectedExecutionTask}
                    back={() => setSelectedExecutionTask(undefined)}
                  />
                ) : null,
              },
              {
                id: "changes",
                content: changes.target ? (
                  <ChangesPane
                    key={JSON.stringify(changes.target)}
                    peer={peer}
                    conversationKey={changes.target.conversationKey}
                    topicId={changes.target.topicId}
                    ownerBotId={state.bot.id}
                    botName={name}
                    running={busy}
                    {...(folderHolder ? { runningName: folderHolder } : {})}
                    wide={sidePane.wide}
                    active={visible}
                    request={changes.request}
                    send={sendFromPane}
                  />
                ) : null,
              },
              {
                id: "browser",
                content: browserActive ? (
                  <BrowserSlot
                    botId={state.bot.id}
                    botName={name}
                    peer={disconnected ? null : peer}
                    pane={sidePane}
                    running={busy}
                    conversationId={state.conversationId}
                    onFeedback={(conversationId, feedback) => {
                      if (feedbackTopic.current === conversationId)
                        setText((current) => (current ? `${current}\n\n${feedback}` : feedback));
                    }}
                  />
                ) : null,
              },
            ]}
          />
        )}
        {panelOpen && state.bot && (
          <BotProfile
            key={state.bot.id}
            send={sendFromPane}
            botId={state.bot.id}
            conversationId={state.conversationId ?? topicId}
            draft={!!draftId && !state.conversationId}
            catalog={catalog}
          />
        )}
      </div>
      <AttachmentDropOverlay active={attachmentDrop.dragging} />
    </main>
  );
  return (
    <OfficePreviewContext.Provider value={officePreview.open}>
      <ExecutionContext.Provider value={execution}>
        <ChangesLinkContext.Provider value={changes.link}>{body}</ChangesLinkContext.Provider>
      </ExecutionContext.Provider>
    </OfficePreviewContext.Provider>
  );
}
