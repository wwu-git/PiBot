import {
  type LiveRunActivity,
  type ReplyReceiptPosition,
  replyReceiptPositions,
} from "@pibot/client-core";
import {
  type Approval,
  answeredOnPhone,
  attachmentContinuationOf,
  type Message,
} from "@pibot/protocol";
import { useRouter } from "expo-router";
import {
  memo,
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { useMobileSelector, useRuntime, useText } from "../../runtime/context.tsx";
import { cardShadow } from "../../theme/scale.ts";
import { avatarColor, onFill, useColors } from "../../theme/use-theme.ts";
import type { AvatarLook } from "../../ui/avatar.tsx";
import { Banner, Button } from "../../ui/controls.tsx";
import { OfflineBanner } from "../../ui/headers.tsx";
import { useTimeText } from "../../ui/time.ts";
import { useToast } from "../../ui/toast.tsx";
import { PendingSend } from "../compose/PendingSend.tsx";
import { OfflineDivider } from "../offline/OfflineHistory.tsx";
import { changesTarget } from "./controls/scope.ts";
import { messageQuestion } from "./controls/use-question.ts";
import { ApprovalInlineCard, QuestionCard } from "./messages/cards.tsx";
import { DispatchReceiptCards, handedOut } from "./messages/DispatchReceiptCard.tsx";
import { MessageItem } from "./messages/MessageItem.tsx";
import { RunChangesCard, wroteFiles } from "./messages/RunChangesCard.tsx";
import {
  GroupExecutionMessageFact,
  RunReceiptCard,
  settledRun,
} from "./messages/RunReceiptCard.tsx";
import { retrySource } from "./sheets/message-sheets.tsx";
import type { ChatPage } from "./use-chat-page.ts";

export interface ThreadHandle {
  /** Back to the newest message (after a send). */
  toLatest(): void;
}
interface RowActions {
  open(message: Message): void;
  retry(message: Message): void;
  answer(message: Message, optionId: string, label: string): void;
}
interface RowProps {
  message: Message;
  group: boolean;
  look?: AvatarLook;
  userColor: string;
  stats?: string;
  activity?: LiveRunActivity;
  answered?: string;
  questionDisabled: boolean;
  canRetry: boolean;
  changes?: ReturnType<typeof changesTarget>;
  /** Follows a reply of the same run (no repeated avatar, closer). */
  continued: boolean;
  /** Ends its run's stretch of replies, so it carries the run's receipt and changes. */
  last: boolean;
  /** Some reply of the run wrote files (the changes card sits on the last one). */
  turnWrote: boolean;
  receipt?: ReplyReceiptPosition;
  /** The line above this message: the phone's own replies start, or the computer's resume. */
  divider?: "phone" | "back";
  actions: RefObject<RowActions>;
}
const sameLook = (a?: AvatarLook, b?: AvatarLook) =>
  a === b ||
  (!!a &&
    !!b &&
    a.name === b.name &&
    a.shape === b.shape &&
    a.color === b.color &&
    a.eyes === b.eyes);
/**
 * The history reloads after every tool, message and done event and brings new objects for
 * messages that did not change; equal ones keep their row as it is.
 */
function sameMessage(a: Message, b: Message) {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.updatedAt !== b.updatedAt ||
    a.status !== b.status ||
    a.content !== b.content
  )
    return false;
  const keys = Object.keys(a) as (keyof Message)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const left = a[key],
      right = b[key];
    return (
      Object.is(left, right) ||
      (typeof left === "object" &&
        typeof right === "object" &&
        JSON.stringify(left) === JSON.stringify(right))
    );
  });
}
/**
 * One message with its cards. Memoized on what it shows, so a streaming reply, a keystroke in the
 * composer or a link event re-renders only the row that changed, not the whole thread.
 */
const ThreadRow = memo(
  function ThreadRow({
    message,
    group,
    look,
    userColor,
    stats,
    activity,
    answered,
    questionDisabled,
    canRetry,
    changes,
    continued,
    last,
    turnWrote,
    receipt,
    divider,
    actions,
  }: RowProps) {
    const t = useText();
    const question = messageQuestion(message);
    const receiptMessageId = receipt ? receipt.messageId : message.id;
    const settled =
      last && !!receiptMessageId && settledRun(message) && settledRun(receipt?.message ?? message);
    return (
      <View style={{ gap: 16, marginTop: continued ? -8 : 0 }}>
        {divider && (
          <OfflineDivider
            text={t(divider === "phone" ? "offlineHistoryDivider" : "offlineHistoryBack")}
          />
        )}
        <MessageItem
          message={message}
          look={look}
          continued={continued}
          who={group && !continued ? look?.name : undefined}
          userColor={userColor}
          stats={stats}
          activity={activity}
          onPress={() => actions.current.open(message)}
          onRetry={canRetry ? () => actions.current.retry(message) : undefined}
          extra={
            question && (
              <QuestionCard
                pause={question}
                answered={answered}
                disabled={questionDisabled}
                onAnswer={(optionId, label) => actions.current.answer(message, optionId, label)}
              />
            )
          }
        />
        {handedOut(message) && <DispatchReceiptCards messageId={message.id} />}
        {changes && settled && turnWrote ? (
          <RunChangesCard
            runId={message.runId}
            target={changes}
            footer={
              <RunReceiptCard
                runId={message.runId}
                messageId={receiptMessageId ?? undefined}
                embedded
              />
            }
            fallback={
              <RunReceiptCard runId={message.runId} messageId={receiptMessageId ?? undefined} />
            }
          />
        ) : (
          settled && (
            <RunReceiptCard runId={message.runId} messageId={receiptMessageId ?? undefined} />
          )
        )}
        {group && <GroupExecutionMessageFact message={message} />}
      </View>
    );
  },
  (a, b) =>
    sameMessage(a.message, b.message) &&
    a.group === b.group &&
    sameLook(a.look, b.look) &&
    a.userColor === b.userColor &&
    a.stats === b.stats &&
    a.activity === b.activity &&
    a.answered === b.answered &&
    a.questionDisabled === b.questionDisabled &&
    a.canRetry === b.canRetry &&
    a.changes === b.changes &&
    a.continued === b.continued &&
    a.last === b.last &&
    a.turnWrote === b.turnWrote &&
    a.receipt?.messageId === b.receipt?.messageId &&
    (a.receipt?.message === b.receipt?.message ||
      (a.receipt?.message === a.message && b.receipt?.message === b.message) ||
      (!!a.receipt?.message &&
        !!b.receipt?.message &&
        sameMessage(a.receipt.message, b.receipt.message))) &&
    a.divider === b.divider &&
    a.actions === b.actions,
);
const keyOf = (message: Message) => message.id;
const sameRun = (a?: Message, b?: Message) =>
  !!a &&
  !!b &&
  a.role === "assistant" &&
  b.role === "assistant" &&
  !!a.runId &&
  a.runId === b.runId;
/**
 * As in the desktop history, a run's split replies read as one stretch. Only the first shows
 * the avatar, and only the last carries the run's receipt and changed-files card (each split
 * reply is a settled message, so every one drew its own receipt before). One pass.
 */
function turnPositions(messages: readonly Message[]) {
  const wrote = new Set<string>();
  for (const message of messages) if (wroteFiles(message)) wrote.add(message.runId);
  const result = new Map<string, { continued: boolean; last: boolean; wrote: boolean }>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.runId) return;
    result.set(message.id, {
      continued: sameRun(messages[index - 1], message),
      last: !sameRun(message, messages[index + 1]),
      wrote: wrote.has(message.runId),
    });
  });
  return result;
}
/**
 * The phone's offline turns, once synced into the topic, keep the line the offline chat drew
 * above them. The import marks each reply in `usage.source` (answeredOnPhone); the user messages
 * just before a marked reply went to the phone's model too. A second line says where the
 * computer answers again, so the first one does not seem to cover everything below. One pass.
 */
function phoneStretches(messages: readonly Message[]) {
  const phone = new Array<boolean>(messages.length).fill(false);
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !answeredOnPhone(message.usage)) return;
    phone[index] = true;
    for (let back = index - 1; back >= 0 && !phone[back]; back--) {
      if (messages[back]?.role !== "user") break;
      phone[back] = true;
    }
  });
  const result = new Map<string, "phone" | "back">();
  messages.forEach((message, index) => {
    const before = index > 0 && phone[index - 1];
    if (phone[index] && !before) result.set(message.id, "phone");
    else if (!phone[index] && before) result.set(message.id, "back");
  });
  return result;
}
// A record's jump to an old message: tries before the thread is shown wherever it is.
const FOCUS_ATTEMPTS = 6;

/**
 * Messages, local pending sends, inline approval/changes cards and notices of one topic, on an
 * inverted virtualized list: it opens at the newest message without measuring the whole history,
 * keeps only the rows near the screen mounted, and stays pinned to the newest message while a
 * reply streams. Reading older messages keeps them in place when new ones arrive.
 */
export function ChatThread({
  page,
  focus,
  onMessage,
  onRetry,
  ref,
}: {
  page: ChatPage;
  /** A record opens its topic at this message; consumed by the first positioning. */
  focus?: string;
  onMessage: (message: Message) => void;
  onRetry: (source: Message) => void;
  ref?: Ref<ThreadHandle>;
}) {
  const colors = useColors(),
    t = useText(),
    time = useTimeText(),
    toast = useToast(),
    router = useRouter(),
    runtime = useRuntime(),
    // Upload ticks re-render the thread's footer only, never the message rows.
    outbox = useMobileSelector((s) => ({
      uploads: s.uploads,
      failed: s.failed,
      status: s.status,
      reconnecting: !!s.reconnecting,
    }));
  const list = useRef<FlatList<Message>>(null);
  const [jump, setJump] = useState({ away: false, count: 0 });
  const { chat, runInfo } = page;
  const seenIds = useRef(chat.messages.map((message) => message.id));
  const stored = new Set(chat.messages.map((message) => message.id));
  const outboxRows = page.composer.outbox.filter(
    (pending) => !pending.userMessageId || !stored.has(pending.userMessageId),
  );
  // v0.0.2: a reply streamed above the user's own just-delivered bubble, which waits in the
  // footer until history carries the stored message. Rows of the runs that send started are
  // drawn after it meanwhile (receipt run IDs; phone and computer clocks may differ).
  const lateRuns = new Set(outboxRows.flatMap((pending) => pending.runIds ?? []));
  const lateKey = [...lateRuns].join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: lateKey stands for lateRuns.
  const [data, late] = useMemo(() => {
    const ordered = [...chat.messages].reverse();
    if (!lateRuns.size) return [ordered, [] as Message[]];
    const after = (message: Message) => !!message.runId && lateRuns.has(message.runId);
    return [ordered.filter((message) => !after(message)), chat.messages.filter(after)];
  }, [chat.messages, lateKey]);
  const changes = useMemo(() => page.scope && changesTarget(page.scope), [page.scope]);
  const turns = useMemo(() => turnPositions(chat.messages), [chat.messages]);
  const receipts = useMemo(() => replyReceiptPositions(chat.messages), [chat.messages]);
  const stretches = useMemo(() => phoneStretches(chat.messages), [chat.messages]);
  const actions = useRef<RowActions>({ open: () => {}, retry: () => {}, answer: () => {} });
  actions.current = {
    open: onMessage,
    retry: (message) => {
      const source = retrySource(chat.messages, message);
      if (source) onRetry(source);
    },
    answer: (message, optionId, label) =>
      void page.question.answer(message, optionId, label).then((ok) => ok && toast(t("answered"))),
  };
  useImperativeHandle(ref, () => ({
    toLatest: () => list.current?.scrollToOffset({ offset: 0, animated: true }),
  }));
  // A different topic opens at its newest message.
  const topicId = page.scope?.topicId;
  const shownTopic = useRef(topicId);
  useEffect(() => {
    if (shownTopic.current === topicId) return;
    shownTopic.current = topicId;
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, [topicId]);
  useEffect(() => {
    const ids = chat.messages.map((message) => message.id);
    const previous = seenIds.current;
    const appended =
      ids.length > previous.length && previous.every((id, index) => ids[index] === id);
    if (jump.away && appended) {
      const added = ids.length - previous.length;
      if (added) setJump((value) => ({ ...value, count: value.count + added }));
    }
    seenIds.current = ids;
  }, [chat.messages, jump.away]);
  // Only a record's jump hides the thread until it sits at the message it points to.
  const focusId = useRef(focus);
  const [positioned, setPositioned] = useState(!focus);
  const attempts = useRef(0);
  const retrying = useRef(false);
  const position = () => {
    const target = focusId.current;
    if (!target || !data.length) return;
    const index = data.findIndex((message) => message.id === target);
    if (index < 0) {
      // Not in the loaded page (older than it, or gone): the topic's end instead.
      focusId.current = undefined;
      setPositioned(true);
      return;
    }
    focusId.current = undefined;
    retrying.current = false;
    // Inverted: viewPosition 1 puts the message's top at the top of the screen. An unmeasured
    // row fails synchronously into onScrollToIndexFailed, which schedules the next try.
    list.current?.scrollToIndex({ index, viewPosition: 1, viewOffset: -12, animated: false });
    if (!retrying.current) requestAnimationFrame(() => setPositioned(true));
  };
  const budget = runInfo.budget;
  const stats = budget
    ? t(budget.unknownCostRequests ? "statsLineNoCost" : "statsLine", {
        requests: budget.requests,
        time: time.duration(budget.activeMillis),
        cost: budget.knownCostUsd.toFixed(2),
      })
    : undefined;
  const allow = async (approval: Approval) => {
    if ((await page.approvals.resolve(approval, "allow")) !== undefined) toast(t("allowedToast"));
  };
  // A private chat's own bubbles take the Bot's colour; a group's are violet, as on the desktop.
  const userColor = page.kind === "bot" ? (page.entry?.looks[0]?.color ?? "violet") : "violet";
  const jumpColor = avatarColor(colors, userColor);
  const first = chat.messages[0];
  const questionBusy = !page.online || page.question.action.busy;
  const renderRow = (message: Message) => {
    const turn = turns.get(message.id);
    const failed = message.role === "error" || message.status === "error";
    const look = page.lookFor(message.botId);
    return (
      <ThreadRow
        message={message}
        group={page.kind === "group"}
        look={look}
        userColor={userColor}
        stats={message.id === runInfo.messageId ? stats : undefined}
        activity={chat.activities[message.id]}
        answered={page.question.answers[message.id]}
        questionDisabled={questionBusy || message.status !== "done"}
        canRetry={
          failed && page.retry.enabled && page.online && !!retrySource(chat.messages, message)
        }
        changes={changes}
        continued={!!turn?.continued}
        last={turn?.last ?? true}
        turnWrote={!!turn?.wrote}
        receipt={receipts.get(message.id)}
        divider={stretches.get(message.id)}
        actions={actions}
      />
    );
  };
  // Between 已送达 and the reply's first words (seconds with a slow model) nothing showed
  // that the Bot had started. While the run is on and the newest message is still the user's,
  // the Bot's typing bubble stands in; the streaming reply takes its place.
  const latest = chat.messages.findLast((message) => !attachmentContinuationOf(message));
  const typing =
    page.kind === "bot" &&
    page.online &&
    chat.status.state !== "idle" &&
    latest?.role === "user" &&
    !chat.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.status === "streaming" &&
        message.runId === chat.status.runId,
    );
  // Inverted: the list header is drawn at the bottom of the screen, the footer at the top.
  const bottom =
    outboxRows.length || typing || page.stopNotice || page.pending.length ? (
      <View style={{ gap: 16 }}>
        {outboxRows.map((pending) => (
          <PendingSend
            key={pending.clientId}
            pending={pending}
            color={userColor}
            online={page.online}
            reconnecting={outbox.status === "connecting" && outbox.reconnecting}
            progress={outbox.uploads[pending.clientId]}
            failed={outbox.failed === pending.clientId}
            onRetry={() => void runtime.retry()}
            onDiscard={() =>
              void runtime.discard(pending.clientId).then(
                () => toast(t("pendingDiscarded")),
                () => toast(t("busy")),
              )
            }
          />
        ))}
        {late.map((message) => (
          <View key={message.id}>{renderRow(message)}</View>
        ))}
        {typing && latest && (
          <MessageItem
            message={{
              id: `typing:${latest.id}`,
              conversationId: latest.conversationId,
              botId: page.scope?.id ?? null,
              runId: chat.status.runId,
              role: "assistant",
              content: "",
              status: "streaming",
              errorCode: null,
              usage: null,
              createdAt: latest.createdAt,
              updatedAt: latest.createdAt,
            }}
            look={page.entry?.looks[0]}
            userColor={userColor}
            onPress={() => undefined}
          />
        )}
        {page.stopNotice && <Banner tone="warn" icon="warning" text={t("stopNotice")} />}
        {page.pending.map((approval) => (
          <View key={approval.id} style={{ gap: 8 }}>
            <ApprovalInlineCard
              approval={approval}
              disabled={!page.online || page.approvals.action.busy}
              onView={() => router.push(`/approval/${approval.id}`)}
              onAllow={() => void allow(approval)}
            />
            {page.approvals.unsent?.approval.id === approval.id && (
              <Banner
                tone="warn"
                icon="warning"
                text={t("approvalNotSent")}
                action={
                  page.online && !page.approvals.action.busy
                    ? { title: t("pendingRetry"), onPress: () => void page.approvals.retryUnsent() }
                    : undefined
                }
              />
            )}
          </View>
        ))}
      </View>
    ) : undefined;
  const top =
    page.connecting || chat.hasMore || first ? (
      <View style={{ gap: 16 }}>
        {page.connecting && <OfflineBanner text={t("chatOffline")} />}
        {chat.hasMore && (
          <Button
            title={t("loadEarlier")}
            style={{ alignSelf: "center" }}
            onPress={() => void chat.load(true)}
          />
        )}
        {first && (
          <Text style={{ alignSelf: "center", fontSize: 12, lineHeight: 18, color: colors.text2 }}>
            {time.stamp(first.createdAt)}
          </Text>
        )}
      </View>
    ) : undefined;
  // A topic the phone never read stayed blank for seconds while the computer answered.
  const empty = page.composer.outbox.length ? undefined : chat.action.busy ? (
    <View style={{ alignSelf: "center", paddingVertical: 40 }}>
      <ActivityIndicator size="small" color={colors.text2} accessibilityLabel={t("loading")} />
    </View>
  ) : (
    <Text style={{ alignSelf: "center", fontSize: 13.5, color: colors.text2, paddingVertical: 40 }}>
      {t("emptyChat")}
    </Text>
  );
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        inverted
        data={data}
        keyExtractor={keyOf}
        renderItem={({ item: message }) => renderRow(message)}
        ListHeaderComponent={bottom}
        ListFooterComponent={top}
        ListEmptyComponent={empty}
        // Short threads sit under the header as before; inverted, flex-end is the screen's top.
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "flex-end",
          paddingTop: 12,
          paddingBottom: 16,
          paddingHorizontal: 16,
          gap: 16,
        }}
        style={{ flex: 1, opacity: positioned || !data.length ? 1 : 0 }}
        keyboardShouldPersistTaps="handled"
        // Reading older messages: rows arriving at the newest end do not move the ones on screen;
        // within 80 pt of the newest message the thread follows them (as the old pinned bottom).
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
        // Replies are tall and uneven: a small first batch opens the chat fast; the window keeps
        // about four screens either way mounted.
        initialNumToRender={10}
        maxToRenderPerBatch={6}
        windowSize={9}
        onContentSizeChange={() => {
          // Android may report the content size before the list's own layout; settle first.
          if (!positioned && focusId.current) requestAnimationFrame(position);
        }}
        onScrollToIndexFailed={(info) => {
          // The target is beyond the rows measured so far: jump near it, then aim again.
          list.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          if (++attempts.current < FOCUS_ATTEMPTS) {
            retrying.current = true;
            focusId.current = data[info.index]?.id;
            setTimeout(position, 60);
          } else setPositioned(true);
        }}
        onScroll={(event) => {
          const away =
            event.nativeEvent.contentOffset.y > event.nativeEvent.layoutMeasurement.height;
          setJump((value) => ({ away, count: away ? value.count : 0 }));
        }}
      />
      {jump.away && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            jump.count
              ? `${t("jumpLatest")} · ${t("newMessages", { count: jump.count })}`
              : t("jumpLatest")
          }
          onPress={() => {
            list.current?.scrollToOffset({ offset: 0, animated: true });
            setJump({ away: false, count: 0 });
          }}
          style={{
            position: "absolute",
            right: 18,
            bottom: 12,
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.b2,
            alignItems: "center",
            justifyContent: "center",
            ...cardShadow(colors),
          }}
        >
          <Text style={{ color: colors.text, fontSize: 20 }}>↓</Text>
          {jump.count > 0 && (
            <Text
              style={{
                position: "absolute",
                right: -5,
                top: -7,
                minWidth: 17,
                height: 17,
                borderRadius: 9,
                backgroundColor: jumpColor,
                color: onFill(colors),
                textAlign: "center",
                fontSize: 11,
              }}
            >
              {jump.count}
            </Text>
          )}
        </Pressable>
      )}
    </View>
  );
}
