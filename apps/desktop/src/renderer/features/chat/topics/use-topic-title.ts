import { chatReadCache } from "@pibot/client-core";
import { ImportSourceSchema, type MethodResults } from "@pibot/protocol";
import { type Peer, useRpc, useT } from "@pibot/renderer-kit";
import { routineTopicTitle } from "@pibot/routines/ui";
import { useEffect, useState } from "react";

type Metadata = NonNullable<MethodResults["topics.metadata"]>;
const previewKey = (botId: string | undefined, topicId: string | undefined) =>
  JSON.stringify(["topic-title", botId, topicId]);

export function rememberTopicTitle(
  peer: Peer,
  botId: string,
  topic: MethodResults["topics.switch"],
) {
  const { title, routineId, readOnly, importSource } = topic;
  chatReadCache(peer).rememberPreview(previewKey(botId, topic.id), {
    title,
    routineId,
    readOnly: !!readOnly,
    importSource,
  } satisfies Metadata);
}

export function importedTopicLabel(t: ReturnType<typeof useT>, value: string | undefined) {
  const source = ImportSourceSchema.safeParse(value);
  return source.success && source.data !== "fixture"
    ? t("conversationImport.topicSource", { source: t(`conversationImport.source.${source.data}`) })
    : t("conversationImport.topicReadOnly");
}

export function useTopicTitle(
  botId: string | undefined,
  conversationId: string | undefined,
  draft: boolean,
) {
  const { peer } = useRpc();
  const t = useT();
  const key = JSON.stringify([botId, conversationId, draft]);
  const reads = peer ? chatReadCache(peer) : undefined;
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{
    peer: Peer;
    key: string;
    topic: MethodResults["topics.metadata"];
  }>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: revisions refresh the same peer and topic.
  useEffect(() => {
    if (!peer || !botId || draft || !conversationId) return;
    const controller = new AbortController();
    const off = peer.on("sidebar.changed", (event) => {
      if (event.conversationKey === `dm:${botId}`) setRevision((value) => value + 1);
    });
    const accept = (topic: MethodResults["topics.metadata"]) => {
      if (!controller.signal.aborted) setValue({ peer, key, topic });
    };
    void peer
      .call("topics.metadata", { botId, topicId: conversationId }, { signal: controller.signal })
      .then(accept, () => accept(null));
    return () => {
      controller.abort();
      off();
    };
  }, [peer, botId, conversationId, draft, key, revision]);
  const current = value?.peer === peer && value?.key === key ? value : undefined;
  const metadata = current?.topic ?? (value?.key === key && !current ? value.topic : undefined);
  const label = metadata ?? reads?.preview<Metadata>(previewKey(botId, conversationId));
  return {
    title: label
      ? label.routineId
        ? routineTopicTitle(t, label.title ?? "")
        : (label.title ?? "")
      : undefined,
    readOnly: !!label?.readOnly,
    importSource: label?.importSource,
    locked: !!conversationId && !draft && current?.topic?.readOnly !== false,
    error: current?.topic === null,
    retry: () => setRevision((value) => value + 1),
  };
}
