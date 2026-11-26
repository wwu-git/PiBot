import {
  approvalCountdown,
  approvalExplanation,
  approvalFactText,
  approvalText,
} from "@pibot/client-core";
import type { Approval } from "@pibot/protocol";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLanguage, useLinkState, useSharedText, useText } from "../../runtime/context.tsx";
import { mono, radius, space, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { BotAvatar } from "../../ui/avatar.tsx";
import { Banner, Button, Switch } from "../../ui/controls.tsx";
import { useTimeText } from "../../ui/time.ts";
import { useToast } from "../../ui/toast.tsx";
import { useApprovals } from "./approvals-context.tsx";
import { approvalLead, approvalTarget, isPiManagerApproval, piRememberText } from "./card-facts.ts";
import { RiskTag } from "./RiskTag.tsx";
import { canRemember, desktopOnly } from "./use-approvals.ts";
import { useApprovalSource } from "./where.ts";

/** Seconds until the card is denied automatically; the inbox shows whole minutes. */
function useSecondsLeft(expiresAt: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return expiresAt ? Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000)) : undefined;
}
/**
 * Inbox card, as the desktop approval card: who wants what, the command, why it needs the
 * user, the countdown, then deny / allow at the bottom right. A dangerous allow goes through the
 * same native unlock as the detail page (inside `resolve`); the card opens the full detail.
 */
export function ApprovalCard({ approval, onOpen }: { approval: Approval; onOpen: () => void }) {
  const colors = useColors(),
    t = useText(),
    language = useLanguage(),
    shared = useSharedText(),
    time = useTimeText(),
    toast = useToast(),
    mobile = useLinkState(),
    approvals = useApprovals(),
    source = useApprovalSource()(approval);
  const left = useSecondsLeft(approval.expiresAt);
  const text = approvalText(approval, language);
  const target = approvalTarget(approval, language, shared);
  const why = approvalExplanation(approval, shared).summary;
  const desktop = desktopOnly(approval);
  const disabled = mobile.status !== "online" || desktop || approvals.action.busy || left === 0;
  const remembered = !!approvals.remember[approval.id];
  const pi = isPiManagerApproval(approval);
  const lead = approvalLead(approval, language);
  const rememberText = pi ? piRememberText(approval, shared) : t("remember");
  const decide = async (decision: "allow" | "deny") => {
    if ((await approvals.resolve(approval, decision)) === undefined) return;
    toast(t(decision === "allow" ? "allowedToast" : "deniedToast"));
  };
  const muted = [type.caption, { color: colors.text2 }];
  return (
    <View
      style={{
        marginHorizontal: space.page,
        borderRadius: radius.panel,
        backgroundColor: colors.card,
        boxShadow: colors["shadow-soft"],
        borderWidth: approval.risk === "danger" ? 1 : 0,
        borderColor: colors.danger,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text.title}
        onPress={onOpen}
        style={({ pressed }) => ({
          paddingTop: 12,
          paddingHorizontal: 14,
          paddingBottom: 4,
          gap: 8,
          borderTopLeftRadius: radius.panel,
          borderTopRightRadius: radius.panel,
          backgroundColor: pressed ? colors.hover : "transparent",
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {source.look && <BotAvatar bot={source.look} size={30} state="waiting" />}
          <Text numberOfLines={2} style={[type.rowTitle, { flex: 1, color: colors.text }]}>
            {text.title}
          </Text>
          <RiskTag approval={approval} />
        </View>
        {!!target && (
          <Text
            numberOfLines={2}
            style={[
              mono(12.5),
              {
                paddingVertical: 8,
                paddingHorizontal: 10,
                borderRadius: radius.code,
                backgroundColor: colors.tert,
                color: colors.text,
                overflow: "hidden",
              },
            ]}
          >
            {target}
          </Text>
        )}
        {pi && !!lead && (
          <Text numberOfLines={3} style={muted}>
            {lead}
          </Text>
        )}
        {pi &&
          text.facts.slice(0, 5).map((fact) => (
            <View
              key={`${fact.label ?? fact.kind}:${fact.value}`}
              style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}
            >
              <Text style={[type.caption, { width: 56, color: colors.text2 }]}>
                {fact.label ?? shared(`facts.${fact.kind}`)}
              </Text>
              <Text numberOfLines={3} style={[type.caption, { flex: 1, color: colors.text }]}>
                {approvalFactText(fact, shared)}
              </Text>
            </View>
          ))}
        {!!why && !pi && (
          <Text numberOfLines={3} style={muted}>
            {why}
          </Text>
        )}
        <Text numberOfLines={1} style={muted}>
          {[
            source.where,
            time.ago(approval.createdAt),
            left !== undefined ? t("autoDeny", { time: approvalCountdown(left) }) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </Pressable>
      {canRemember(approval) && !desktop && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 14,
            paddingTop: 6,
          }}
        >
          <Text style={[muted, { flex: 1 }]}>{rememberText}</Text>
          <Switch
            label={rememberText}
            value={remembered}
            disabled={disabled}
            onValueChange={(value) =>
              approvals.setRemember((rows) => ({ ...rows, [approval.id]: value }))
            }
          />
        </View>
      )}
      {approvals.unsent?.approval.id === approval.id && (
        <View style={{ paddingHorizontal: 14, paddingTop: 10 }}>
          <Banner
            tone="warn"
            icon="warning"
            text={t("approvalNotSent")}
            action={
              mobile.status === "online" && !approvals.action.busy
                ? { title: t("pendingRetry"), onPress: () => void approvals.retryUnsent() }
                : undefined
            }
          />
        </View>
      )}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          paddingHorizontal: 14,
          paddingTop: 10,
          paddingBottom: 12,
        }}
      >
        {desktop ? (
          <Button title={t("approvalOpen")} onPress={onOpen} />
        ) : (
          <>
            <Button title={t("deny")} disabled={disabled} onPress={() => void decide("deny")} />
            <Button
              variant="prim"
              icon={approval.risk === "danger" ? "face" : undefined}
              title={t(approval.risk === "danger" ? "approvalReview" : "allow")}
              disabled={disabled}
              onPress={() => void decide("allow")}
            />
          </>
        )}
      </View>
    </View>
  );
}
