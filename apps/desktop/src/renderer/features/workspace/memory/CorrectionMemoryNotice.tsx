// Reuses the desktop undo card when a group reply has a durable correction receipt.
import type { ChatPeer } from "@pibot/client-core";
import type { Message } from "@pibot/protocol";
import { MessageMemoryNotices, useMemoryNotices } from "./MemoryNotices.tsx";

export function CorrectionMemoryNotice({
  peer,
  botId,
  message,
}: {
  peer: ChatPeer;
  botId: string;
  message: Message;
}) {
  const notices = useMemoryNotices(peer, botId, message.conversationId);
  return <MessageMemoryNotices notices={notices} messageId={message.id} />;
}
