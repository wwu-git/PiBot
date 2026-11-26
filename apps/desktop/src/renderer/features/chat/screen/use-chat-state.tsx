import { activeRun, chatController, currentImageModel, groupActivity } from "@pibot/client-core";
import { useAgentOptions } from "@pibot/external-agents/ui";
import type { AgentAccountStatus } from "@pibot/external-agents-contract";
import type { TranslationKey } from "@pibot/i18n";
import type { ExecutionMode, FolderSelection } from "@pibot/protocol";
import { folderLabel, useNavigation, useT } from "@pibot/renderer-kit";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRuntimeHealth } from "../../../app/runtime-health.ts";
import { useDisplayConversation } from "../../../app/startup-display.tsx";
import { useChatFolders } from "../../folders/use-chat-folders.ts";
import { useCatalog } from "../../workspace/profile/catalog.ts";
import { useAgentCommandMenu } from "../composer/AgentCommandMenu.tsx";
import { useComposerDraft, useRetryDraft } from "../composer/composer-drafts.tsx";
import { useSkillCommands } from "../composer/SkillCommands.tsx";
import { useAttachmentDrop } from "../composer/useAttachmentDrop.ts";
import { useAttachments } from "../composer/useAttachments.ts";
import { useInputHistory } from "../composer/useInputHistory.ts";
import { useTextareaHeight } from "../composer/useTextareaHeight.ts";
import { useMessageReply } from "../messages/MessageReply.tsx";
import { useTimelineDay } from "../messages/MessageTime.tsx";
import { usePlacedNotices } from "../status/ChatNotices.tsx";
import type { ActivityState } from "../tools/local-activity.ts";
import { useLocalActivity } from "../tools/local-activity.ts";
import { useTopicTitle } from "../topics/use-topic-title.ts";
import { useTopicWorkplace } from "../topics/useTopicWorkplace.ts";
import { useWorkplaces } from "../topics/useWorkplaces.ts";
import type { ConnectedChatProps } from "./chat-screen-model.ts";
import { useStarters } from "./use-starters.ts";

export function useChatState({ peer, target, visible, disconnected }: ConnectedChatProps) {
  const t = useT();
  const {
    openSettings,
    settingsOverlay,
    openWorkspace,
    botPanel,
    openBotPanel,
    closeBotPanel,
    navigate,
    view,
    consumeChatFocus,
  } = useNavigation();
  const catalog = useCatalog();
  const { botId: targetBotId, topicId, draftId } = target;
  const previousController = useRef<ReturnType<typeof chatController> | undefined>(undefined);
  const controller = useMemo(() => {
    const controller = chatController(peer, { botId: targetBotId, topicId, draftId });
    const receipt = previousController.current?.pendingAddition();
    if (receipt && previousController.current !== controller) controller.restoreAddition(receipt);
    return controller;
  }, [peer, targetBotId, topicId, draftId]);
  previousController.current = controller;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useDisplayConversation({
    botId: state.bot?.id,
    topicId: state.conversationId,
    name: state.bot?.name ?? "Pi Bot",
    bot: state.bot,
    complete: !state.hasMore,
    messages: state.messages,
    ready: state.historyReady,
    failed: state.historyError,
    visible: visible && !disconnected,
  });
  useEffect(() => {
    if (
      visible &&
      state.needsFreshTopic &&
      state.bot &&
      !target.topicId &&
      !target.draftId &&
      !view.focus
    )
      navigate({ name: "chat", botId: state.bot.id, draftId: crypto.randomUUID() });
  }, [
    visible,
    state.needsFreshTopic,
    state.bot,
    target.topicId,
    target.draftId,
    view.focus,
    navigate,
  ]);
  const [text, setText] = useComposerDraft(
    peer,
    JSON.stringify([
      "dm",
      targetBotId ?? state.bot?.id,
      draftId ?? state.conversationId ?? topicId,
    ]),
    controller.pendingAddition()?.text,
  );
  const retryDraft = useRetryDraft(
    peer,
    state.bot?.category === "image" ? undefined : (targetBotId ?? state.bot?.id),
    state.conversationId ?? topicId,
  );
  const reply = useMessageReply();
  const [mediaError, setMediaError] = useState<TranslationKey>();
  const [draftModeSelection, setDraftModeSelection] = useState<{
    id?: string;
    mode: ExecutionMode;
  }>({ id: draftId, mode: "execute" });
  const draftMode = draftModeSelection.id === draftId ? draftModeSelection.mode : "execute";
  const timelineDay = useTimelineDay();
  const panelOpen = !!state.bot && botPanel?.botId === state.bot.id;
  const starters = useStarters(state.bot);
  const workplaces = useWorkplaces(peer, target.botId ?? state.bot?.id);
  const topicPlace = useTopicWorkplace(
    peer,
    target.botId ?? state.bot?.id,
    state.conversationId ?? topicId,
    workplaces.data,
    workplaces.changing,
  );
  const actualTopicId = state.conversationId ?? topicId;
  const feedbackTopic = useRef(state.conversationId);
  feedbackTopic.current = state.conversationId;
  // A new-topic draft keeps its folder choice in the controller until the first message.
  const isDraft = !!draftId && !state.conversationId;
  const topic = useTopicTitle(state.bot?.id ?? targetBotId, actualTopicId, isDraft);
  const setDraftWorkplace = useCallback(
    (selection: FolderSelection) => controller.setDraftWorkplace(selection),
    [controller],
  );
  const draftFolders = useMemo(
    () =>
      isDraft && draftId
        ? { key: draftId, selection: state.draftWorkplace, set: setDraftWorkplace }
        : undefined,
    [isDraft, draftId, state.draftWorkplace, setDraftWorkplace],
  );
  const activity = useLocalActivity(peer, state.bot?.id);
  const runtimeHealth = useRuntimeHealth();
  const drainFailed = !!state.bot && runtimeHealth.botIds.includes(state.bot.id);
  const groupedCache = useRef(new Map<string, ActivityState>());
  const grouped = useMemo(() => {
    groupedCache.current = groupActivity(activity.state, groupedCache.current);
    return groupedCache.current;
  }, [activity.state]);
  const conversationMessages = new Set(state.messages.map((message) => message.id));
  const waiting = activity.state.approvals.find(
    (approval) => approval.status === "pending" && conversationMessages.has(approval.messageId),
  );
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useTextareaHeight(textarea, text);
  const {
    edit: editText,
    onKeyDown: browseInputHistory,
    reset: resetInputHistory,
  } = useInputHistory(state.conversationId, state.messages, text, setText, textarea);
  const scroll = useRef<HTMLDivElement>(null);
  const messageContent = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ height: number; top: number } | undefined>(undefined);
  const name = state.bot?.name ?? "Pi";
  const notices = usePlacedNotices(
    disconnected ? null : peer,
    state.conversationId,
    state.messages,
    !state.hasMore,
  );
  const noticeBotName = useCallback(() => name, [name]);
  const runId = activeRun(state);
  const busy = state.pending || !!runId;
  // While this run waits for another Bot to release the folder (an independent review it
  // started), that Bot is the one working there; the changes pane names it, not this Bot.
  const folderHolder = runId
    ? activity.state.tools.find(
        (tool) => tool.runId === runId && tool.status === "running" && tool.waitingFor,
      )?.waitingFor
    : undefined;
  const folders = useChatFolders({
    peer: disconnected ? null : peer,
    botId: target.botId ?? state.bot?.id,
    topic: actualTopicId && !isDraft ? topicPlace.data : undefined,
    draft: draftFolders,
    registry: workplaces.data,
    running: busy || !!waiting,
    refreshTopic: topicPlace.refresh,
  });
  const [folderRequest, setFolderRequest] = useState(0);
  const folderModel = folders.model;
  const workplacePath = folderModel
    ? folderModel.primary.id === "home"
      ? workplaces.data?.home
      : folderModel.primary.path
    : undefined;
  const workplaceName = folderModel
    ? folderLabel(folderModel, t)
    : topicPlace.missing
      ? t("workplaces.folderMissing")
      : topicPlace.runnerOffline
        ? t("workplaces.runnerOffline")
        : topicPlace.error || workplaces.error
          ? t("workplaces.unavailable")
          : t("common.loading");
  const toolPaths = useMemo(
    () => ({ home: workplaces.data?.home, current: workplacePath }),
    [workplaces.data?.home, workplacePath],
  );
  const sendingBlocked =
    topic.locked ||
    !retryDraft.ready ||
    disconnected ||
    state.loading ||
    !state.historyReady ||
    state.historyError ||
    state.pending ||
    state.stopping ||
    state.metadataLoading ||
    state.metadataError ||
    !!state.appendUncertain;
  const draftLocked =
    topic.locked ||
    disconnected ||
    state.pending ||
    state.stopping ||
    !!state.appendUncertain ||
    state.loading ||
    !state.historyReady ||
    state.historyError ||
    state.metadataLoading ||
    state.metadataError;
  const model =
    state.bot?.category === "image"
      ? currentImageModel(state)
      : state.models.find(
          (item) => item.provider === state.bot?.modelProvider && item.id === state.bot?.modelId,
        );
  const attachments = useAttachments(
    state.bot?.category === "image" ||
      (model && "input" in model ? model.input.includes("image") : false),
    draftLocked,
    controller.pendingAddition()?.attachments,
  );
  const attachmentDrop = useAttachmentDrop(attachments.add, visible && !topic.locked);
  const agentBot = state.bot?.kind === "agent";
  const composerDisabled = disconnected || state.pending || state.loading || attachments.reading;
  const skillMenu = useSkillCommands({
    // Agent skills use the same selection text; the brain supplies the validated body.
    owners:
      state.bot && state.bot.category !== "image"
        ? [{ id: state.bot.id, name: state.bot.name }]
        : [],
    text,
    edit: editText,
    textarea,
    disabled: composerDisabled,
  });
  // A draft topic has no session yet: the Bot's last known commands stand in.
  const agentOptions = useAgentOptions(state.bot?.id ?? "", state.conversationId, agentBot);
  const agentMenu = useAgentCommandMenu({
    enabled: agentBot,
    agentName: state.bot?.name ?? "",
    commands: agentOptions.options?.commands,
    text,
    edit: editText,
    textarea,
    disabled: composerDisabled,
  });
  const nativeCommand = agentOptions.options?.commands.some(
    (command) => text === `/${command.name}`,
  );
  const skillCommands =
    agentBot && (nativeCommand || !skillMenu.open || !skillMenu.hasEntries) ? agentMenu : skillMenu;
  const modelsSettings = useCallback(() => {
    if (state.bot) openWorkspace({ name: "profile", botId: state.bot.id });
    else openSettings("models", "pi-model");
  }, [openSettings, openWorkspace, state.bot]);
  const credentialsSettings = useCallback(() => openSettings("models"), [openSettings]);
  // A folder problem is fixed where folders are chosen: the header's folder picker.
  const workplaceSettings = useCallback(() => setFolderRequest((value) => value + 1), []);
  // "Working in {folder}": the picker sits where the placeholder is, in either language.
  const draftLine = t("folders.draftLine", { folder: "\u0000" }).split("\u0000");
  const settingsWereOpen = useRef(false);
  useEffect(() => {
    // Also reconcile catalog edits when closing Settings; Bot saves already share their result.
    if (settingsWereOpen.current && !settingsOverlay) void controller.refreshMetadata();
    settingsWereOpen.current = !!settingsOverlay;
  }, [settingsOverlay, controller]);
  return {
    t,
    openBotPanel,
    closeBotPanel,
    navigate,
    view,
    consumeChatFocus,
    catalog,
    topicId,
    draftId,
    controller,
    state,
    text,
    setText,
    retryDraft,
    reply,
    mediaError,
    setMediaError,
    setDraftModeSelection,
    draftMode,
    timelineDay,
    panelOpen,
    starters,
    workplaces,
    topicPlace,
    actualTopicId,
    topic,
    feedbackTopic,
    isDraft,
    draftFolders,
    activity,
    drainFailed,
    grouped,
    folderHolder,
    conversationMessages,
    waiting,
    composing,
    textarea,
    editText,
    browseInputHistory,
    resetInputHistory,
    scroll,
    messageContent,
    atBottom,
    anchor,
    name,
    notices,
    noticeBotName,
    runId,
    busy,
    folders,
    folderRequest,
    folderModel,
    workplaceName,
    toolPaths,
    sendingBlocked,
    draftLocked,
    model,
    attachments,
    attachmentDrop,
    skillCommands,
    agentAccountStatus: agentOptions.accountStatus as AgentAccountStatus,
    checkAgentStatus: agentOptions.checkStatus,
    modelsSettings,
    credentialsSettings,
    workplaceSettings,
    draftLine,
  };
}
