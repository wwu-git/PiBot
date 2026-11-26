import { SecretsPage } from "@pibot/credentials/ui";
import { ConnectorsPage } from "@pibot/plugins/ui";
import { useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { RoutinesPage } from "@pibot/routines/ui";
import { SkillCopyEditor, SkillDetailExtras, SkillWriter, TeachPage } from "@pibot/skills/ui";
import { useRef } from "react";
import { AuditLog } from "../audit/index.tsx";
import { GroupChat } from "../group/index.tsx";
import { Sidebar } from "../sidebar/index.tsx";
import { Inbox } from "../workspace/inbox/Inbox.tsx";
import workspaceStyles from "../workspace/workspace.module.css";
import styles from "./chat.module.css";
import { MessageReplyProvider } from "./messages/MessageReply.tsx";
import { type ConnectedChatProps, useChatScreenModel } from "./screen/chat-screen-model.ts";
import { renderConnectedChat } from "./screen/connected-chat-view.tsx";

export function ChatScreen() {
  const { peer, state } = useRpc();
  const { view, closeWorkspace } = useNavigation();
  const groupScope = useRef({ peer, revision: 0 });
  if (groupScope.current.peer !== peer)
    groupScope.current = { peer, revision: groupScope.current.revision + 1 };
  const { t, settings } = useSettings();
  const retainedDm = view.name === "chat" && !view.groupId;
  const retainedPeer = useRef(peer);
  if (peer) retainedPeer.current = peer;
  const target = { botId: view.botId, topicId: view.topicId, draftId: view.draftId };
  return (
    <div className={styles.shell} data-chat-font={settings?.chatFontSize ?? "medium"}>
      <Sidebar />
      {retainedPeer.current && retainedDm && (
        <div className={styles.chatViewport} hidden={view.name !== "chat"}>
          <MessageReplyProvider key={JSON.stringify(target)}>
            <ConnectedChat
              key={JSON.stringify(target)}
              peer={retainedPeer.current}
              disconnected={!peer}
              brainStarting={state === "starting" || state === "restarting"}
              target={target}
              visible={view.name === "chat"}
            />
          </MessageReplyProvider>
        </div>
      )}
      {view.name === "connectors" ? (
        <ConnectorsPage
          secrets={(controls) => <SecretsPage {...controls} />}
          skillWriter={(controls) => <SkillWriter {...controls} />}
          skillEditor={(controls) => <SkillCopyEditor {...controls} />}
          skillExtras={(controls) => <SkillDetailExtras {...controls} />}
        />
      ) : view.name === "routines" ? (
        <RoutinesPage />
      ) : !peer && (!retainedDm || !retainedPeer.current) ? (
        <main className={workspaceStyles.placeholder}>
          <p role="status">{t("workspace.brainUnavailable")}</p>
        </main>
      ) : view.name === "inbox" ? (
        <Inbox close={closeWorkspace} />
      ) : view.name === "teach" && view.botId && peer ? (
        <TeachPage key={view.botId} botId={view.botId} peer={peer} />
      ) : view.name === "audit" ? (
        <AuditLog
          key={`${view.auditGroupId ?? "all"}:${view.auditBotId ?? "all"}`}
          initialBotId={view.auditBotId}
          groupId={view.auditGroupId}
        />
      ) : view.groupId && peer ? (
        <GroupChat
          key={`${groupScope.current.revision}:${view.groupId}`}
          peer={peer}
          groupId={view.groupId}
          threadId={view.threadId}
        />
      ) : null}
    </div>
  );
}
function ConnectedChat(props: ConnectedChatProps) {
  const model = useChatScreenModel(props);
  return renderConnectedChat(model);
}
