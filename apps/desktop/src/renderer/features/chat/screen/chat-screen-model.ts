import type { ChatTarget } from "@pibot/client-core";
import type { useRpc } from "@pibot/renderer-kit";
import { useState } from "react";
import { useMemoryNotices } from "../../workspace/memory/MemoryNotices.tsx";
import { useChatMessages } from "./use-chat-messages.tsx";
import { useChatState } from "./use-chat-state.tsx";
import { useChatWorkspace } from "./use-chat-workspace.tsx";
export type ConnectedChatProps = {
  peer: NonNullable<ReturnType<typeof useRpc>["peer"]>;
  target: ChatTarget;
  visible: boolean;
  disconnected: boolean;
};
export function useChatScreenModel(props: ConnectedChatProps) {
  const state = useChatState(props);
  const messages = useChatMessages({ ...props, ...state });
  const workspace = useChatWorkspace({ ...props, ...state, ...messages });
  // Memory notices render under the reply that produced them and report errors by the composer.
  // Keyed by the routed topic: the session learns its conversation id only after history, and
  // keying on that rebuilt the controller (a second profile read) on every open.
  const memoryNotices = useMemoryNotices(props.peer, state.state.bot?.id, state.actualTopicId);
  // Keyed by conversation so a request made in one topic never opens the row in another.
  const [compactRequested, requestCompact] = useState<string>();
  const [compactDismissed, dismissCompaction] = useState<string>();
  return {
    ...props,
    ...state,
    ...messages,
    ...workspace,
    memoryNotices,
    compactRequested,
    requestCompact,
    compactDismissed,
    dismissCompaction,
  };
}
export type ChatScreenModel = ReturnType<typeof useChatScreenModel>;
