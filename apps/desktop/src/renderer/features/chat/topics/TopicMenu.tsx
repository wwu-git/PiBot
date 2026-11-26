import { useT } from "@pibot/renderer-kit";
import { Topics } from "../../workspace/topics/Topics.tsx";
import { TopicPopover } from "./TopicPopover.tsx";
import type { useTopicTitle } from "./use-topic-title.ts";
export function TopicMenu({
  botId,
  conversationId,
  draft,
  topic,
}: {
  botId: string;
  conversationId?: string;
  draft: boolean;
  topic: ReturnType<typeof useTopicTitle>;
}) {
  const t = useT();
  const title =
    draft || !conversationId
      ? t("workspace.newTopic")
      : topic.title === undefined
        ? t(topic.error ? "workspace.untitled" : "common.loading")
        : topic.title || t("workspace.untitled");
  return (
    <TopicPopover title={title} error={topic.error} retry={topic.retry}>
      <Topics botId={botId} conversationId={conversationId} draft={draft} />
    </TopicPopover>
  );
}
