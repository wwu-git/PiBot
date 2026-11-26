import { useEffect, useRef, useState } from "react";
import { useLinkState, useRuntime } from "../../../runtime/context.tsx";
import { useAction } from "../../../runtime/use-action.ts";
import { StoredTopicsSchema, storeKeys } from "../../../storage/phone-store.ts";
import { createTopic, listTopics, switchTopic, type TopicRow } from "./calls.ts";
import type { ChatScope } from "./scope.ts";

/**
 * Topic list and current topic of a Bot or group; switching/creating go through the computer.
 * `opened` (a record's own topic) is shown instead of the current one without
 * switching the computer, until the person switches or creates a topic here.
 */
export function useTopics(
  kind: ChatScope["kind"],
  id: string,
  groupTopicId?: string,
  opened?: string,
) {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const store = runtime.storage.store;
  const cacheKey = mobile.selectedId ? storeKeys.topics(mobile.selectedId, kind, id) : undefined;
  // Proposal 10: a list this process already holds is there in the first frame, so the chat
  // page knows its topic (and so its stored messages) before any read.
  const first = () => (cacheKey ? store.peek(cacheKey, StoredTopicsSchema) : undefined);
  const [topics, setTopics] = useState<TopicRow[]>(() => first()?.topics ?? []);
  const [current, setCurrent] = useState<string | undefined>(() => {
    const copy = first();
    return copy && opened && copy.topics.some((row) => row.id === opened) ? opened : copy?.current;
  });
  const scope = `${mobile.selectedId}:${kind}:${id}`;
  const shownFor = useRef(topics.length ? scope : undefined);
  const action = useAction(scope, mobile.peer);
  const write = useAction(scope, mobile.peer);
  const viewing = useRef(opened);
  const shown = (rows: TopicRow[], value: string | undefined) =>
    viewing.current && rows.some((row) => row.id === viewing.current) ? viewing.current : value;
  const remember = async (rows: TopicRow[], value: string | undefined) => {
    setTopics(rows);
    setCurrent(shown(rows, value));
    // The copy keeps the computer's current topic, so an offline open still lands there.
    if (cacheKey)
      await store.write(cacheKey, StoredTopicsSchema.parse({ current: value, topics: rows }));
  };
  const load = () =>
    action.read(async (signal) => {
      if (!mobile.selectedId || !cacheKey) return;
      if (mobile.status !== "online") {
        const cached = await store.read(cacheKey, StoredTopicsSchema);
        signal.throwIfAborted();
        if (cached) {
          setTopics(cached.topics);
          setCurrent(shown(cached.topics, cached.current));
        }
        return;
      }
      // The chat page needs the current topic before it can show any message: use the last copy
      // at once, then the computer's list.
      if (!topics.length && current === undefined) {
        const cached = await store.read(cacheKey, StoredTopicsSchema);
        signal.throwIfAborted();
        if (cached) {
          setTopics(cached.topics);
          setCurrent(shown(cached.topics, cached.current));
        }
      }
      const rows = await listTopics(runtime, kind, id, signal);
      signal.throwIfAborted();
      const value = rows.find((row) => row.isCurrent)?.id ?? groupTopicId ?? rows[0]?.id;
      await remember(rows, value);
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the device, peer and conversation own the topic list.
  useEffect(() => {
    // A reconnect keeps the topic (and so the thread) on screen; another chat starts from its copy.
    if (shownFor.current !== scope) {
      shownFor.current = scope;
      const copy = first();
      setTopics(copy?.topics ?? []);
      setCurrent(copy ? shown(copy.topics, copy.current) : undefined);
    }
    void load();
    if (kind !== "bot") return;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const off = mobile.peer?.on("sidebar.changed", (event) => {
      if (event.conversationKey !== `dm:${id}`) return;
      clearTimeout(refresh);
      refresh = setTimeout(() => void load(), 150);
    });
    return () => {
      clearTimeout(refresh);
      off?.();
    };
  }, [mobile.selectedId, mobile.peer, kind, id, mobile.refreshVersion]);
  const title = topics.find((topic) => topic.id === current)?.title;
  return {
    topics,
    current,
    title,
    action,
    write,
    load,
    switchTo: (topicId: string) =>
      write.run(async (signal) => {
        viewing.current = undefined;
        const value = await switchTopic(runtime, kind, id, topicId, signal);
        signal.throwIfAborted();
        await remember(
          topics.map((topic) => ({ ...topic, isCurrent: topic.id === value })),
          value,
        );
        return value;
      }),
    create: () =>
      write.run(async (signal) => {
        viewing.current = undefined;
        const value = await createTopic(runtime, kind, id, signal);
        signal.throwIfAborted();
        const rows = await listTopics(runtime, kind, id, signal);
        signal.throwIfAborted();
        await remember(rows, value);
        return value;
      }),
  };
}
