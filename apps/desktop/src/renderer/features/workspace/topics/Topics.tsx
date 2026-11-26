import type { MethodResults } from "@pibot/protocol";
import { useAction, useNavigation, useRpc, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { RoutineTopicLabel, routineTopicTitle } from "@pibot/routines/ui";
import { useEffect, useRef, useState } from "react";
import { useTimelineDay } from "../../chat/messages/MessageTime.tsx";
import { useTopicRestore } from "../../chat/topics/use-topic-archive.ts";
import { importedTopicLabel, rememberTopicTitle } from "../../chat/topics/use-topic-title.ts";
import { TopicListView } from "./TopicListView.tsx";

export function Topics({
  botId,
  conversationId,
  draft = false,
}: {
  botId: string;
  conversationId?: string;
  draft?: boolean;
}) {
  const { t } = useSettings();
  useTimelineDay();
  const { peer } = useRpc();
  const { navigate } = useNavigation();
  const workspace = useWorkspace();
  const statuses = new Map<string, "queued" | "running">();
  for (const status of Object.values(workspace.statuses))
    if (status.botId === botId && !status.groupId && status.state !== "idle") {
      const prior = statuses.get(status.conversationId);
      if (prior !== "running") statuses.set(status.conversationId, status.state);
    }
  const waitingTopics = new Set(
    workspace.inbox.flatMap((item) =>
      (item.kind === "approval" || item.kind === "routine_approval") &&
      item.approval.botId === botId &&
      item.approval.status === "pending"
        ? [item.conversationId]
        : [],
    ),
  );
  const folderName = (topic: MethodResults["topics.list"][number]) => {
    if (topic.readOnly) return importedTopicLabel(t, topic.importSource);
    const id = topic.workplaceFolderId;
    if (!id || id === "home") return t("agentWork.ownFolder");
    return topic.workplaceFolderName ?? t("agentWork.folderUnavailable");
  };
  const task = useAction();
  const restoring = useTopicRestore(peer, botId);
  const [topics, setTopics] = useState<MethodResults["topics.list"]>([]);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [namesUnavailable, setNamesUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [namesRevision, setNamesRevision] = useState(0);
  const namesEpoch = useRef(0);
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState("");
  const epoch = useRef(0);
  const renameLock = useRef(false);
  const topicsRef = useRef(topics);
  topicsRef.current = topics;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((v) => v + 1), 250);
    };
    const off = [
      peer?.on("sidebar.changed", refresh),
      peer?.on("chat.status", (event) => {
        if (event.botId === botId) refresh();
      }),
      peer?.on("chat.done", (event) => {
        if (event.botId === botId) refresh();
      }),
      peer?.on("chat.error", (event) => {
        if (event.botId === botId) refresh();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const unsubscribe of off) unsubscribe?.();
    };
  }, [peer, botId]);
  useEffect(() => {
    setNamesUnavailable(false);
    let controller: AbortController | undefined;
    const refreshNames = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const version = epoch.current;
      const loaded = topicsRef.current.filter(
        (topic) => topic.botId === botId && !!topic.archivedAt === archived,
      );
      if (!peer || loaded.length === 0) return;
      // Stay below the shared GUI queue budget even after many pages have been loaded.
      const pageCount = Math.ceil(loaded.length / 50);
      const refreshPages = async () => {
        const results: MethodResults["topics.list"][] = [];
        let nextPage = 0;
        let failed = false;
        await Promise.all(
          Array.from({ length: Math.min(4, pageCount) }, async () => {
            while (!failed) {
              request.signal.throwIfAborted();
              const page = nextPage++;
              if (page >= pageCount) return;
              try {
                results[page] = await peer.call(
                  "topics.list",
                  { botId, limit: 50, query, archived, before: loaded[page * 50 - 1]?.id },
                  { signal: request.signal, timeoutMs: 10000 },
                );
              } catch (error) {
                failed = true;
                throw error;
              }
            }
          }),
        );
        return results;
      };
      void refreshPages().then(
        (results) => {
          if (request.signal.aborted || version !== epoch.current) return;
          setNamesUnavailable(false);
          const names = new Map(
            results.flatMap((page) =>
              page
                .filter((topic) => topic.botId === botId && !!topic.archivedAt === archived)
                .map((topic) => [topic.id, topic.workplaceFolderName] as const),
            ),
          );
          setTopics((current) =>
            current.map((topic) =>
              names.has(topic.id) ? { ...topic, workplaceFolderName: names.get(topic.id) } : topic,
            ),
          );
        },
        () => {
          if (!request.signal.aborted && version === epoch.current) setNamesUnavailable(true);
        },
      );
    };
    const changed = () => {
      namesEpoch.current++;
      refreshNames();
    };
    if (namesRevision > 0) refreshNames();
    const off = [
      peer?.on("bots.changed", (event) => {
        if (event.botId === botId) changed();
      }),
      peer?.on("permissions.changed", changed),
    ];
    return () => {
      controller?.abort();
      for (const unsubscribe of off) unsubscribe?.();
    };
  }, [peer, botId, query, archived, namesRevision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection and draft changes refresh the current marker and accepted first message.
  useEffect(() => {
    const version = ++epoch.current;
    const folderVersion = namesEpoch.current;
    setUnavailable(false);
    setLoading(true);
    setMore(false);
    const timer = setTimeout(
      () => {
        if (!peer) {
          setUnavailable(true);
          setLoading(false);
          return;
        }
        void peer
          .call("topics.list", { botId, limit: 50, query, archived })
          .then((result) => {
            if (
              result.some(
                (topic) =>
                  topic.botId !== botId || topic.kind !== "dm" || !!topic.archivedAt !== archived,
              )
            )
              throw new Error("Topic target mismatch");
            if (version === epoch.current) {
              setTopics(result);
              setMore(result.length === 50);
              if (folderVersion !== namesEpoch.current) setNamesRevision((value) => value + 1);
            }
          })
          .catch(() => {
            if (version === epoch.current) setUnavailable(true);
          })
          .finally(() => {
            if (version === epoch.current) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      epoch.current++;
    };
  }, [peer, botId, conversationId, draft, query, archived, revision]);
  const rename = async (topicId: string) => {
    if (!peer || renameLock.current) return;
    if (!title.trim()) {
      task.setError("workspace.invalid");
      return;
    }
    const topic = topics.find((topic) => topic.id === topicId);
    if (!topic || title.trim() === topic.title) {
      setEditing(undefined);
      return;
    }
    renameLock.current = true;
    const version = epoch.current;
    const result = await task.run(() =>
      peer.call("topics.rename", { botId, topicId, title: title.trim() }),
    );
    renameLock.current = false;
    if (result && version === epoch.current) {
      setEditing(undefined);
      setRevision((v) => v + 1);
    }
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const groups = new Map<"today" | "week" | "earlier", MethodResults["topics.list"]>([
    ["today", []],
    ["week", []],
    ["earlier", []],
  ]);
  const currentId =
    conversationId ?? (!draft ? topics.find((topic) => topic.isCurrent)?.id : undefined);
  for (const topic of topics) {
    // An old Bot page may still be visible while its replacement read is pending.
    if (topic.botId !== botId || topic.kind !== "dm" || !!topic.archivedAt !== archived) continue;
    // Scheduled-task topics are listed like any other (maintainers 2026-10-21): an earlier layout hid them behind
    // their task row, but the chat header's topic list has no such row, so they were unreachable.
    const date = new Date(topic.updatedAt);
    groups.get(date >= today ? "today" : date >= week ? "week" : "earlier")?.push(topic);
  }
  return (
    <TopicListView
      topics={[...groups.values()].flat()}
      currentId={currentId}
      archived={archived}
      setArchived={setArchived}
      query={query}
      setQuery={setQuery}
      loading={loading}
      error={
        task.error ??
        restoring.error ??
        (unavailable || namesUnavailable ? "workspace.unavailable" : undefined)
      }
      retry={() => setRevision((value) => value + 1)}
      editing={editing}
      title={title}
      setTitle={setTitle}
      rename={(id) => void rename(id)}
      startRename={(topic) => {
        setTitle(topic.title ?? "");
        setEditing(topic.id);
      }}
      cancelRename={() => setEditing(undefined)}
      busy={task.busy}
      restoring={restoring.busy}
      available={!!peer}
      folderName={folderName}
      status={(topic) => (waitingTopics.has(topic.id) ? "waiting" : statuses.get(topic.id))}
      displayTitle={(topic) =>
        topic.routineId
          ? routineTopicTitle(t, topic.title ?? "")
          : topic.title || t("workspace.untitled")
      }
      canRename={(topic) => !topic.routineId}
      extra={(topic) =>
        topic.routineId ? <RoutineTopicLabel id={topic.routineId} botId={botId} /> : null
      }
      open={(topic) => {
        if (peer)
          void task
            .run(() => peer.call("topics.switch", { botId, topicId: topic.id }))
            .then((result) => {
              if (result) {
                rememberTopicTitle(peer, botId, result);
                navigate({ name: "chat", botId, topicId: result.id });
                void workspace.refresh();
              }
            });
      }}
      restore={(id) => void restoring.run(id)}
      more={more}
      loadMore={() => {
        const folderVersion = namesEpoch.current;
        if (!peer) return;
        const version = epoch.current;
        void task
          .run(() =>
            peer.call("topics.list", {
              botId,
              before: topics.at(-1)?.id,
              limit: 50,
              query,
              archived,
            }),
          )
          .then((next) => {
            if (
              next &&
              version === epoch.current &&
              next.every(
                (topic) =>
                  topic.botId === botId && topic.kind === "dm" && !!topic.archivedAt === archived,
              )
            ) {
              setTopics((previous) => {
                const ids = new Set(previous.map((topic) => topic.id));
                return [...previous, ...next.filter((topic) => !ids.has(topic.id))];
              });
              setMore(next.length === 50);
              // A folder event may have refreshed the old pages while this page was in flight.
              if (folderVersion !== namesEpoch.current) setNamesRevision((value) => value + 1);
            }
          });
      }}
    />
  );
}
