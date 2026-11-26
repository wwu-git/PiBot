import { type Message, Methods, PI_DISPATCH_TOOLS, type PiDispatch } from "@pibot/protocol";
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { useRuntime, useSharedText } from "../../../runtime/context.tsx";
import { useCachedValue } from "../../../runtime/use-cached-value.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { Button, ListCard } from "../../../ui/controls.tsx";
import { Icon, type IconName } from "../../../ui/icons.tsx";

const ListSchema = Methods["teams.dispatches"].result;
const ICONS: Record<PiDispatch["status"], IconName> = {
  working: "clock",
  waiting: "warning",
  done: "check",
  failed: "warning",
  stopped: "close",
};

/** Whether this reply handed work out (only then is there a receipt to read). */
export function handedOut(message: Message) {
  return (
    message.role === "assistant" &&
    !!message.tools?.some((tool) => (PI_DISPATCH_TOOLS as readonly string[]).includes(tool.tool))
  );
}

/**
 * The default Pi's hand-off receipts under its reply, as on the desktop: who did the task, how it
 * ended, a short excerpt and the outputs, and a way into that topic. Live while it is working.
 */
export function DispatchReceiptCards({ messageId }: { messageId: string }) {
  const runtime = useRuntime();
  const list = useCachedValue(
    `dispatches:${messageId}`,
    ListSchema,
    (signal) => runtime.call("teams.dispatches", { messageId }, signal),
    ["teams.dispatch.changed"],
  );
  if (!list.value?.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {list.value.map((item) => (
        <DispatchReceipt key={item.id} item={item} />
      ))}
    </View>
  );
}

function DispatchReceipt({ item }: { item: PiDispatch }) {
  const colors = useColors(),
    t = useSharedText(),
    router = useRouter();
  const finished = item.finishedAt ? Date.parse(item.finishedAt) : undefined;
  const seconds = finished
    ? Math.max(1, Math.round((finished - Date.parse(item.createdAt)) / 1000))
    : 0;
  const status = t(`dispatch.status.${item.status}`);
  const result = finished
    ? t("dispatch.duration", {
        status,
        time:
          seconds >= 60
            ? t("dispatch.minutes", { count: Math.round(seconds / 60) })
            : t("dispatch.seconds", { count: seconds }),
      })
    : status;
  const rows: [string, string][] = [
    [t("dispatch.row.result"), result],
    ...(item.summary ? [[t("dispatch.row.summary"), item.summary] as [string, string]] : []),
    ...(item.outputs.length
      ? [
          [t("dispatch.row.outputs"), item.outputs.join(t("tool.group.separator"))] as [
            string,
            string,
          ],
        ]
      : []),
  ];
  const tone =
    item.status === "failed" ? colors.danger : item.status === "done" ? colors.ok : colors.text2;
  return (
    <ListCard flush>
      <View
        accessibilityLabel={t("dispatch.label")}
        style={{ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 12, gap: 8 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={ICONS[item.status]} color={tone} size={16} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.text }}>
            {t(`dispatch.title.${item.status}`, { target: item.targetName, pi: "Pi" })}
          </Text>
        </View>
        {rows.map(([label, value]) => (
          <View key={label} style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}>
            <Text style={{ width: 52, fontSize: 13, lineHeight: 19, color: colors.text2 }}>
              {label}
            </Text>
            <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: colors.text }}>
              {value}
            </Text>
          </View>
        ))}
        {!!item.targetConversationId && (
          <View style={{ flexDirection: "row" }}>
            <Button
              title={t("dispatch.open", { target: item.targetName })}
              onPress={() => router.push(`/conversation/${item.targetKind}/${item.targetId}`)}
            />
          </View>
        )}
      </View>
    </ListCard>
  );
}
