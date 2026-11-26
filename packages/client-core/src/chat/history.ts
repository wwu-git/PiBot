// Keep history windows contiguous so the chat can render complete reply segments.
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { readCurrentTopic } from "./current-topic.ts";
import { completeLeadingReplies, HISTORY_PAGE_SIZE, historyPage } from "./history-page.ts";
import { sameMessage } from "./selectors.ts";
import type { ChatSession } from "./session.ts";

export async function reload(this: ChatSession, replaceWindow = true) {
  const discoverTopic = !this.target.topicId && !this.target.draftId && !this.state.conversationId;
  this.historyRouteReady = false;
  // Leaving and coming back must not flash the previous answer: the notice is re-asked below.
  this.patch({
    loading: true,
    historyReady: false,
    historyError: false,
    needsFreshTopic: false,
    contextHint: false,
  });
  const metadata = this.refreshMetadata();
  const history = async () => {
    try {
      const botId = this.target.botId ?? (await this.identityRead)?.id;
      if (!botId || this.disposed) throw new Error("Bot unavailable");
      const probe = (async () => {
        try {
          if (discoverTopic) {
            const topicId = await readCurrentTopic(
              this.peer,
              this.reads,
              botId,
              this.lifetime.signal,
            );
            this.lifetime.signal.throwIfAborted();
            if (!topicId) {
              this.patch({ needsFreshTopic: true });
              return;
            }
            this.patch({ conversationId: topicId });
          } else {
            await this.reads.read(
              `topics:${botId}`,
              (signal) => this.peer.call("topics.list", { botId, limit: 1 }, { signal }),
              this.lifetime.signal,
            );
          }
          this.topicRouting = true;
        } catch (error) {
          if (!(error instanceof RpcError) || error.code !== RpcErrorCodes.methodNotFound)
            throw error;
        }
        this.historyRouteReady = true;
      })();
      // Unknown default routes must resolve identity before history, including an empty page.
      // Known routes stay parallel; wait for both so a late history cannot hide a probe failure.
      if (discoverTopic) {
        await probe;
        if (this.state.needsFreshTopic) return;
        await this.refreshHistory(true, false, replaceWindow);
      } else {
        const results = await Promise.allSettled([
          probe,
          this.refreshHistory(true, false, replaceWindow),
        ]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
      if (
        this.topicRouting &&
        this.state.conversationId &&
        this.state.messages.some((message) => message.conversationId !== this.state.conversationId)
      )
        throw new Error("History target changed during discovery");
      if (!this.state.historyError) this.patch({ historyReady: true });
      // A hint the user has not refused yet survives a reload; the brain decides.
      if (!this.state.historyError) void this.checkContextHint();
    } catch {
      if (!this.lifetime.signal.aborted) {
        this.patch({
          historyError: true,
          historyReady: false,
          ...(discoverTopic && !this.historyRouteReady ? { conversationId: undefined } : {}),
        });
      }
    } finally {
      this.patch({ loading: false });
      void this.flushHistoryRefresh(this.state.historyError);
    }
  };
  await Promise.all([metadata, history()]);
}

export async function flushHistoryRefresh(this: ChatSession, initial = false) {
  if (
    this.state.needsFreshTopic ||
    this.state.loading ||
    this.state.pending ||
    !this.historyRefreshPending
  )
    return;
  this.historyRefreshPending = false;
  await this.refreshHistory(initial);
}

export async function refreshHistory(
  this: ChatSession,
  initial = false,
  recoverSend = false,
  replaceWindow = initial,
): Promise<void> {
  if (this.pageRead) {
    await this.pageRead;
    return this.refreshHistory(initial, recoverSend, replaceWindow);
  }
  if (this.historyRead) {
    this.historyRefreshPending = true;
    return this.historyRead;
  }
  this.historyRead = this.readHistory(initial, recoverSend, replaceWindow);
  try {
    await this.historyRead;
  } finally {
    this.historyRead = undefined;
    void this.flushHistoryRefresh();
  }
}

export async function readHistory(
  this: ChatSession,
  initial = false,
  recoverSend = false,
  replaceWindow = initial,
) {
  if (this.disposed || (this.target.draftId && !this.state.conversationId)) return;
  // Establish pagination first, and replay accepted deltas before reading checkpoints.
  // A failed send instead recovers history and discards deltas with no sequence cutoff.
  if ((!initial && this.state.loading) || (this.state.pending && !recoverSend)) {
    this.historyRefreshPending = true;
    return;
  }
  const botId = this.state.bot?.id ?? this.target.botId;
  if (!botId) return;
  const version = ++this.historyVersion;
  try {
    const route = this.route();
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
    const page = await historyPage(this, route, signal);
    if (this.disposed || version !== this.historyVersion) return;
    const expected =
      this.target.topicId ?? (this.topicRouting ? this.state.conversationId : undefined);
    if (expected && page.some((message) => message.conversationId !== expected))
      throw new Error("History target mismatch");
    // A replacement window has no retained prefix to cover a cut reply segment.
    const { messages, hasMore } = await completeLeadingReplies(
      this,
      route,
      page,
      signal,
      !replaceWindow,
    );
    if (this.disposed || this.lifetime.signal.aborted || version !== this.historyVersion) return;
    // Terminal events refresh canonical text (including redaction) from the brain.
    const ids = new Set(messages.map((message) => message.id));
    const liveById = new Map(this.state.messages.map((message) => [message.id, message]));
    const snapshot = messages.map((message) => {
      const live = liveById.get(message.id);
      // Persisted text can lag deltas; tools must survive eviction from the live cache.
      if (message.status === "streaming" && live?.status === "streaming")
        return { ...live, tools: message.tools ?? live.tools };
      // Every tool end refreshes the page; keeping unchanged rows' objects lets memoized rows
      // skip re-rendering (and re-parsing Markdown), which made a 5-minute browser run janky.
      return live && sameMessage(live, message) ? live : message;
    });
    const first = this.state.messages.findIndex((message) => ids.has(message.id));
    const last = this.state.messages.findLastIndex((message) => ids.has(message.id));
    const merged =
      first < 0
        ? [...this.state.messages, ...snapshot]
        : [
            ...this.state.messages.slice(0, first),
            ...snapshot,
            ...this.state.messages.slice(last + 1),
          ];
    // A full disjoint page leaves an unknown gap; restart pagination instead of splicing around it.
    const resetWindow = replaceWindow || (first < 0 && page.length === HISTORY_PAGE_SIZE);
    this.patch({
      messages: resetWindow ? snapshot : merged,
      conversationId:
        this.target.topicId ?? messages[0]?.conversationId ?? this.state.conversationId,
      historyError: !this.state.loading && !this.historyRouteReady,
      historyReady: !this.state.loading && this.historyRouteReady,
      ...(resetWindow || (first === 0 && snapshot[0]?.id !== this.state.messages[0]?.id)
        ? { hasMore }
        : {}),
    });
  } catch (error) {
    if (!this.lifetime.signal.aborted && version === this.historyVersion) {
      this.failedPage = false;
      const missing =
        error instanceof RpcError &&
        error.code === RpcErrorCodes.invalidParams &&
        error.message === "Unknown topic";
      this.patch({
        historyError: true,
        historyReady: false,
        ...(missing ? { messages: [], hasMore: false } : {}),
      });
    }
  }
}

export function retryHistory(this: ChatSession) {
  if (this.target.draftId && !this.state.conversationId && this.state.requestError === "uncertain")
    return Promise.resolve();
  return this.failedPage && !this.state.metadataError ? this.loadMore() : this.reload();
}

export async function loadMore(this: ChatSession, signal?: AbortSignal) {
  if (this.historyRead || this.pageRead) return;
  this.pageRead = this.readOlder(signal);
  try {
    await this.pageRead;
  } finally {
    this.pageRead = undefined;
    void this.flushHistoryRefresh();
  }
}

export async function readOlder(this: ChatSession, signal?: AbortSignal) {
  const { bot, loadingMore, hasMore, messages } = this.state;
  if (!bot || loadingMore || !hasMore || this.state.loading || signal?.aborted) return;
  const before = messages[0]?.id;
  if (!before) return;
  this.patch({ loadingMore: true, historyError: false });
  try {
    const version = this.historyVersion;
    const route = this.route();
    const readSignal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    const page = await historyPage(this, route, readSignal, before);
    if (route.topicId && page.some((message) => message.conversationId !== route.topicId))
      throw new Error("History target mismatch");
    const { messages: older, hasMore: earlier } = await completeLeadingReplies(
      this,
      route,
      page,
      readSignal,
    );
    if (
      this.disposed ||
      this.lifetime.signal.aborted ||
      signal?.aborted ||
      version !== this.historyVersion
    )
      return;
    const ids = new Set(this.state.messages.map((message) => message.id));
    this.patch({
      messages: [...older.filter((message) => !ids.has(message.id)), ...this.state.messages],
      hasMore: earlier,
    });
  } catch {
    // A cancelled focus must not prepend a late page or turn ordinary browsing into a load error.
    if (!this.lifetime.signal.aborted && !signal?.aborted) {
      this.failedPage = true;
      this.patch({ historyError: true });
    }
  } finally {
    this.patch({ loadingMore: false });
  }
}
