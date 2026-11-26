import {
  approvalCountdown,
  approvalExplanation,
  approvalFactText,
  approvalText,
} from "@pibot/client-core";
import type { Approval } from "@pibot/protocol";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage, useLinkState, useSharedText, useText } from "../../runtime/context.tsx";
import { BlurTarget, Glass, GlassScope, useGlassTarget } from "../../theme/glass.tsx";
import { PageTint } from "../../theme/page-tint.tsx";
import { radius, type } from "../../theme/scale.ts";
import { monoFont, useColors } from "../../theme/use-theme.ts";
import { BotAvatar } from "../../ui/avatar.tsx";
import { Banner, Button, CheckMark, EmptyState, ErrorLine, ListCard } from "../../ui/controls.tsx";
import { NavBar, OfflineBanner } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { Sheet, SheetIcon, SheetText, SheetTitle } from "../../ui/sheet.tsx";
import { useTimeText } from "../../ui/time.ts";
import { useToast } from "../../ui/toast.tsx";
import { ApprovalHeader, CodeBlock } from "../chat/messages/cards.tsx";
import { useApprovals } from "./approvals-context.tsx";
import { approvalLead, approvalTarget, isPiManagerApproval, piRememberText } from "./card-facts.ts";
import { RiskTag } from "./RiskTag.tsx";
import { canRemember, desktopOnly } from "./use-approvals.ts";
import { useApprovalSource } from "./where.ts";

const mono = new Set(["program", "read", "write", "cwd"]);
function useSecondsLeft(expiresAt: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return expiresAt ? Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000)) : 0;
}
export function ApprovalDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const approvals = useApprovals(),
    router = useRouter(),
    t = useText();
  const approval = approvals.items.find((item) => item.id === id);
  if (!approval)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title={t("approvalBar")} onBack={() => router.back()} />
        <EmptyState icon="inbox" title={t("approvalGone")} />
      </View>
    );
  return <Detail approval={approval} />;
}
/** The card's facts as a two-column list, keys muted (desktop `dl`). */
function Facts({ approval }: { approval: Approval }) {
  const colors = useColors(),
    language = useLanguage(),
    shared = useSharedText();
  const facts = approvalText(approval, language).facts;
  if (!facts.length) return null;
  return (
    <View style={{ marginHorizontal: 16, marginBottom: 12, gap: 6 }}>
      {facts.map((fact) => (
        <View
          key={`${fact.label ?? fact.kind}:${fact.value}`}
          style={{ flexDirection: "row", alignItems: "baseline", gap: 14 }}
        >
          <Text style={{ width: 64, fontSize: 13, lineHeight: 20, color: colors.text2 }}>
            {fact.label ?? shared(`facts.${fact.kind}`)}
          </Text>
          <Text
            selectable
            style={{
              flex: 1,
              fontSize: mono.has(fact.kind) ? 13 : 14,
              lineHeight: 20,
              color: colors.text,
              fontFamily: mono.has(fact.kind) ? monoFont : undefined,
            }}
          >
            {approvalFactText(fact, shared)}
          </Text>
        </View>
      ))}
    </View>
  );
}
/** "Why it needs you", amber (red when dangerous), with the policy steps folded. */
function Why({ approval }: { approval: Approval }) {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText();
  const [open, setOpen] = useState(false);
  const explanation = approvalExplanation(approval, shared);
  if (!explanation.summary && !explanation.steps.length) return null;
  const fg = approval.risk === "danger" ? colors.danger : colors.warn;
  return (
    <View
      style={{
        marginHorizontal: 16,
        marginBottom: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: radius.code,
        backgroundColor: approval.risk === "danger" ? colors.dangerBg : colors.warnBg,
        gap: 4,
      }}
    >
      {!!explanation.summary && (
        <Text style={{ fontSize: 13, lineHeight: 19, color: fg }}>{explanation.summary}</Text>
      )}
      {explanation.steps.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28 }}
        >
          <Icon name={open ? "chevron" : "chevronRight"} color={fg} size={13} />
          <Text style={[type.caption, { color: fg }]}>{t(open ? "hideSteps" : "showSteps")}</Text>
        </Pressable>
      )}
      {open && (
        // One numbered block: steps can repeat, so they have no stable identity of their own.
        <Text style={{ fontSize: 12.5, lineHeight: 19, color: fg }}>
          {explanation.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}
        </Text>
      )}
    </View>
  );
}
function Detail({ approval }: { approval: Approval }) {
  const colors = useColors(),
    t = useText(),
    language = useLanguage(),
    shared = useSharedText(),
    time = useTimeText(),
    toast = useToast(),
    router = useRouter(),
    navigation = useNavigation(),
    insets = useSafeAreaInsets(),
    mobile = useLinkState(),
    approvals = useApprovals(),
    source = useApprovalSource()(approval);
  const [face, setFace] = useState(false);
  const left = useSecondsLeft(approval.expiresAt);
  const online = mobile.status === "online";
  const desktop = desktopOnly(approval);
  const disabled = !online || desktop || approvals.action.busy || left <= 0;
  const firstFact = approvalText(approval, language).facts[0];
  const target = approvalTarget(approval, language, shared);
  const remembered = !!approvals.remember[approval.id];
  const decide = async (decision: "allow" | "deny", allowConversation = false) => {
    setFace(false);
    if ((await approvals.resolve(approval, decision, allowConversation)) === undefined) return;
    toast(t(decision === "allow" ? "allowedToast" : "deniedToast"));
    // Only while this page is still shown: after a back gesture during the decision, a second
    // back popped the page underneath too (or switched tabs).
    if (navigation.isFocused()) router.back();
  };
  return (
    <PageTint name={source.look?.color}>
      <GlassScope>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <BlurTarget name="approval">
            <NavBar title={t("approvalBar")} subtitle={source.where} onBack={() => router.back()} />
            <ErrorLine text={approvals.action.error && t(approvals.action.error)} />
            <ScrollView
              contentContainerStyle={{
                paddingTop: 12,
                paddingHorizontal: 16,
                // Room for the floating glass bar, so the last line can scroll clear of it.
                paddingBottom: 132 + insets.bottom,
                gap: 14,
              }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}
              >
                {source.look && <BotAvatar bot={source.look} size={28} state="waiting" />}
                <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>
                  {source.botName}
                </Text>
                <Text style={{ fontSize: 13, color: colors.text2 }}>
                  {time.ago(approval.createdAt)}
                </Text>
                <RiskTag approval={approval} long />
              </View>
              <ListCard flush danger={approval.risk === "danger"}>
                <ApprovalHeader
                  approval={approval}
                  title={approvalText(approval, language).title}
                />
                {!!target && <CodeBlock text={target} />}
                {!!approvalLead(approval, language) && (
                  <Text
                    style={{
                      marginHorizontal: 16,
                      fontSize: 13,
                      lineHeight: 19,
                      color: colors.text2,
                    }}
                  >
                    {approvalLead(approval, language)}
                  </Text>
                )}
                <Facts approval={approval} />
                <Why approval={approval} />
                {canRemember(approval) && !desktop ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: remembered, disabled }}
                    disabled={disabled}
                    onPress={() =>
                      approvals.setRemember((rows) => ({ ...rows, [approval.id]: !remembered }))
                    }
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "flex-start",
                      gap: 10,
                      paddingVertical: 12,
                      paddingHorizontal: 16,
                      borderTopWidth: 1,
                      borderTopColor: colors.b1,
                      backgroundColor: pressed ? colors.hover : "transparent",
                      opacity: disabled ? 0.5 : 1,
                    })}
                  >
                    <CheckMark on={remembered} />
                    <Text style={{ flex: 1, fontSize: 14, lineHeight: 21, color: colors.text }}>
                      {isPiManagerApproval(approval)
                        ? piRememberText(approval, shared)
                        : approval.grantScope?.kind === "paid_image"
                          ? shared("approval.rememberPaidImage", {
                              model: `${approval.grantScope.provider} / ${approval.grantScope.model}`,
                            })
                          : t("remember")}
                    </Text>
                  </Pressable>
                ) : (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingVertical: 12,
                      paddingHorizontal: 16,
                      borderTopWidth: 1,
                      borderTopColor: colors.b1,
                    }}
                  >
                    <Icon name="lock" color={colors.text2} size={16} />
                    <Text style={{ flex: 1, fontSize: 14, color: colors.text2 }}>
                      {t(approval.risk === "danger" ? "rememberDanger" : "rememberNo")}
                    </Text>
                  </View>
                )}
              </ListCard>
              {(approval.conversationWebDomain || approval.taskWebRead) && !desktop && (
                <>
                  <Text style={{ color: colors.text2 }}>
                    {approval.taskWebRead
                      ? shared("approval.taskWebsiteHint")
                      : shared("approval.conversationWebsiteHint", {
                          domain: approval.conversationWebDomain ?? "",
                        })}
                  </Text>
                  <Button
                    title={shared(
                      approval.taskWebRead ? "approval.allowTaskWeb" : "approval.allowConversation",
                    )}
                    disabled={disabled}
                    onPress={() => void decide("allow", true)}
                  />
                </>
              )}
              {!online && <OfflineBanner text={t("approvalDetailOffline")} />}
              {desktop && <Banner tone="warn" icon="laptop" text={t("desktopOnly")} />}
              {source.chat && (
                <Button
                  icon="message"
                  title={t("openContext")}
                  style={{ alignSelf: "flex-start" }}
                  onPress={() =>
                    router.push(`/conversation/${source.chat?.kind}/${source.chat?.id}`)
                  }
                />
              )}
            </ScrollView>
          </BlurTarget>
          <ApprovalBar>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button
                size="lg"
                title={t("deny")}
                disabled={disabled}
                style={{ flex: 1 }}
                onPress={() => void decide("deny")}
              />
              <Button
                size="lg"
                variant="prim"
                icon={approval.risk === "danger" ? "face" : undefined}
                title={t("allowOnce")}
                disabled={disabled}
                style={{ flex: 1.4 }}
                onPress={() => (approval.risk === "danger" ? setFace(true) : void decide("allow"))}
              />
            </View>
            <Text
              style={{
                textAlign: "center",
                fontSize: 12,
                color: colors.text2,
                paddingTop: 4,
                fontVariant: ["tabular-nums"],
              }}
            >
              {t("autoDeny", { time: approvalCountdown(left) })}
            </Text>
          </ApprovalBar>
          <Sheet visible={face} onClose={() => setFace(false)}>
            <SheetIcon name="face" />
            <SheetTitle center text={t("faceTitle")} />
            <SheetText
              center
              text={t("faceHint", { fact: firstFact ? approvalFactText(firstFact, shared) : "" })}
            />
            <Button
              size="lg"
              variant="prim"
              title={t("faceConfirm")}
              disabled={disabled}
              onPress={() => void decide("allow")}
            />
            <Button size="lg" variant="ghost" title={t("cancel")} onPress={() => setFace(false)} />
          </Sheet>
        </View>
      </GlassScope>
    </PageTint>
  );
}
/** Deny / allow pinned to the bottom on glass; the details scroll beneath it. */
function ApprovalBar({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets(),
    target = useGlassTarget("approval");
  return (
    <Glass
      radius={24}
      target={target}
      style={{ position: "absolute", left: 10, right: 10, bottom: Math.max(insets.bottom, 10) }}
      innerStyle={{ paddingTop: 10, paddingHorizontal: 14, paddingBottom: 8 }}
    >
      {children}
    </Glass>
  );
}
