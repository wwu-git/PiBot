import {
  interruptedMessage,
  type LiveRunActivity,
  messageBubbleText,
  providerFailureText,
  replyCitationText,
  routineNoticeText,
  silentWake,
} from "@pibot/client-core";
import { type TranslationKey, zh } from "@pibot/i18n";
import { chatAddition, type Message, messageDispatch, messageForward } from "@pibot/protocol";
import { type ComponentProps, memo, type ReactNode, useCallback, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { radius, type } from "../../../theme/scale.ts";
import { avatarColor, useColors, userBubble } from "../../../theme/use-theme.ts";
import { type AvatarLook, type AvatarState, BotAvatar } from "../../../ui/avatar.tsx";
import { Button } from "../../../ui/controls.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { latinQuotes, MessageMarkdown } from "../../../ui/markdown.tsx";
import { Attachments } from "../../files/Attachments.tsx";
import { ForwardCard } from "./ForwardCard.tsx";
import { BubbleGradient, RunActivityPill, TypingPill } from "./live.tsx";
import { ToolSteps } from "./ToolSteps.tsx";

const failureKeys = {
  provider_overloaded: "failProviderOverloaded",
  provider_rejected: "failProviderRejected",
  provider_error: "failProviderError",
  rate_limited: "failRateLimited",
  network: "failNetwork",
  auth_failed: "failAuth",
  quota_exhausted: "failQuota",
  billing: "failQuota",
  context_overflow: "failContext",
  context_too_large: "failContext",
  budget_exhausted: "failBudget",
  repeated_operation: "failRepeatedOperation",
  image_timeout: "failImageTimeout",
} as const;
/**
 * A failed reply says why, in the words the desktop uses for the same code. Codes without a phone
 * wording use the desktop's own text: a runner or folder failure showed a bare "Something went
 * wrong" with the reason only in the receipt (v0.0.2).
 */
function failureText(
  code: Message["errorCode"],
  t: ReturnType<typeof useText>,
  shared: ReturnType<typeof useSharedText>,
) {
  if (code && Object.hasOwn(failureKeys, code))
    return t(failureKeys[code as keyof typeof failureKeys]);
  const key = `errors.${code}`;
  return code && Object.hasOwn(zh, key) ? shared(key as TranslationKey) : t("previewFailed");
}

// Desktop bubbles: 18 radius with the 6pt corner at the bottom on the sender's side.
const botBubble = {
  borderRadius: radius.bubble,
  borderBottomLeftRadius: radius.tail,
  paddingVertical: 10,
  paddingHorizontal: 14,
} as const;
/** Note under a user bubble: still in the phone outbox, or delivered as a steer. */
export function UserBubble({
  text,
  note,
  color,
  onPress,
}: {
  text: string;
  note?: "queued" | "steer";
  /** The Bot's avatar colour in a private chat; groups use violet. */
  color: string;
  onPress?: () => void;
}) {
  const colors = useColors(),
    t = useText();
  const tone = userBubble(colors, color);
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "80%", alignItems: "flex-end", gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        disabled={!onPress}
        onPress={onPress}
        style={{
          backgroundColor: tone.bg,
          borderRadius: radius.bubble,
          borderBottomRightRadius: radius.tail,
          paddingVertical: 10,
          paddingHorizontal: 14,
          overflow: "hidden",
        }}
      >
        <BubbleGradient wash={avatarColor(colors, color)} />
        <Text style={[type.body, { color: tone.fg }]}>{latinQuotes(text)}</Text>
      </Pressable>
      {note && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name={note === "queued" ? "clock" : "check"} color={colors.text2} size={12} />
          <Text style={[type.small, { color: colors.text2 }]}>
            {t(note === "queued" ? "queuedNote" : "steerNote")}
          </Text>
        </View>
      )}
    </View>
  );
}
/** A Bot's turn: 28pt avatar, the reply column beside it; in groups the name sits above. */
export function BotRow({
  look,
  who,
  state,
  continued,
  children,
}: {
  look?: AvatarLook;
  who?: string;
  state?: AvatarState;
  /** A later reply of the same run keeps the column but not the repeated avatar. */
  continued?: boolean;
  children: ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 6 }}>
      {!!who && (
        <Text style={{ marginLeft: 38, fontSize: 12, fontWeight: "600", color: colors.text2 }}>
          {who}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
        {look && !continued ? (
          <BotAvatar bot={look} size={28} state={state} />
        ) : (
          <View style={{ width: 28 }} />
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 8, alignItems: "flex-start" }}>{children}</View>
      </View>
    </View>
  );
}
function MessageBody({
  message,
  look,
  who,
  stats,
  activity,
  extra,
  userColor,
  onPress,
  onRetry,
  continued,
}: {
  message: Message;
  look?: AvatarLook;
  /** Follows a reply of the same run. */
  continued?: boolean;
  who?: string;
  stats?: string;
  activity?: LiveRunActivity;
  extra?: ReactNode;
  userColor: string;
  onPress: () => void;
  onRetry?: () => void;
}) {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText();
  if (silentWake(message)) return null;
  if (message.role === "user") {
    const notice = routineNoticeText(message, shared, (iso) => new Date(iso).toLocaleString());
    if (notice)
      return (
        <Text
          accessibilityRole="text"
          style={[type.small, { color: colors.text2, alignSelf: "center", textAlign: "center" }]}
        >
          {notice}
        </Text>
      );
    const addition = chatAddition(message);
    const steering =
      addition?.mode === "steer" && (addition.state === "queued" || addition.state === "received");
    // FORWARD-DISPLAY: a forward shows the user's note (or a neutral count) and a collapsed card.
    const forward = messageForward(message);
    const text = messageBubbleText(message, shared);
    const bubble = (
      <UserBubble
        text={text}
        color={userColor}
        note={steering ? "steer" : undefined}
        onPress={onPress}
      />
    );
    // A message the default Pi sent here on the person's request: a quiet label above it.
    const dispatch = messageDispatch(message);
    const from = dispatch && (
      <Text style={[type.small, { color: colors.text2, alignSelf: "flex-end" }]}>
        {shared("chat.fromPi", { name: dispatch.from })}
      </Text>
    );
    if (!message.attachments?.length && !forward && !from) return bubble;
    return (
      <View style={{ gap: 6 }}>
        {from}
        {(!!text || steering) && bubble}
        {forward && <ForwardCard forward={forward} />}
        {!!message.attachments?.length && (
          <Attachments messageId={message.id} items={message.attachments} align="flex-end" />
        )}
      </View>
    );
  }
  const failed = message.role === "error" || message.status === "error";
  const streaming = message.status === "streaming";
  const providerFailure = failed && providerFailureText(message, shared);
  return (
    <BotRow
      look={look}
      who={who}
      continued={continued}
      state={failed ? "blocked" : streaming ? "working" : "idle"}
    >
      {!!message.tools?.length && <ToolSteps tools={message.tools} />}
      {failed ? (
        <>
          {/* What the Bot wrote before failing stays a normal reply; the reason goes under it. */}
          {!!message.content && (
            <View style={{ ...botBubble, maxWidth: "100%", backgroundColor: colors.bubble }}>
              <MessageMarkdown text={message.content} color={colors.text} cacheKey={message.id} />
            </View>
          )}
          <View style={{ ...botBubble, backgroundColor: colors.dangerBg }}>
            <Text style={[type.body, { color: colors.danger }]}>
              {failureText(message.errorCode, t, shared)}
            </Text>
            {providerFailure && (
              <Text selectable style={[type.small, { color: colors.danger }]}>
                {providerFailure}
              </Text>
            )}
          </View>
          {onRetry && <Button icon="refresh" title={t("retryFrom")} onPress={onRetry} />}
        </>
      ) : streaming && !message.content ? (
        !activity && <TypingPill />
      ) : message.content ? (
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          style={{ ...botBubble, maxWidth: "100%", backgroundColor: colors.bubble }}
        >
          <MessageMarkdown
            text={streaming ? `${message.content} ▍` : message.content}
            cacheKey={message.id}
            color={colors.text}
          />
        </Pressable>
      ) : null}
      {replyCitationText(message, shared).map((note) => (
        <Text key={note} style={[type.small, { color: colors.text2 }]}>
          {note}
        </Text>
      ))}
      {!!message.attachments?.length && (
        <Attachments messageId={message.id} items={message.attachments} />
      )}
      {interruptedMessage(message) && (
        <Text style={[type.small, { color: colors.warn }]}>{t("interrupted")}</Text>
      )}
      {extra}
      {streaming && activity && <RunActivityPill activity={activity} />}
      {!!stats && (
        <Text style={[type.small, { color: colors.text2, fontVariant: ["tabular-nums"] }]}>
          {stats}
        </Text>
      )}
    </BotRow>
  );
}

const MemoMessageBody = memo(
  MessageBody,
  (a, b) =>
    a.message === b.message &&
    a.stats === b.stats &&
    a.activity === b.activity &&
    a.extra === b.extra &&
    a.userColor === b.userColor &&
    a.who === b.who &&
    a.continued === b.continued &&
    a.look?.name === b.look?.name &&
    a.look?.shape === b.look?.shape &&
    a.look?.color === b.look?.color &&
    a.look?.eyes === b.look?.eyes &&
    a.onPress === b.onPress &&
    a.onRetry === b.onRetry,
);

export function MessageItem(props: ComponentProps<typeof MessageBody>) {
  const handlers = useRef(props);
  handlers.current = props;
  const onPress = useCallback(() => handlers.current.onPress(), []);
  const onRetry = useCallback(() => handlers.current.onRetry?.(), []);
  return (
    <MemoMessageBody {...props} onPress={onPress} onRetry={props.onRetry ? onRetry : undefined} />
  );
}
