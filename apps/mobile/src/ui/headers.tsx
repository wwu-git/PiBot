/** Shared navigation headers keep compatibility actions consistent across screens. */

import { PHONE_COMPAT_LEVEL, PIBOT_WEBSITE_URL } from "@pibot/protocol";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAndroidUpdate } from "../features/updates/AndroidUpdateProvider.tsx";
import { compatNotice } from "../runtime/compat.ts";
import { useLinkState, useMobileSelector, useText } from "../runtime/context.tsx";
import { usePageTint } from "../theme/page-tint.tsx";
import { PageWash } from "../theme/page-wash.tsx";
import { slopFor, space, type } from "../theme/scale.ts";
import { TAB_TINT, type TabName, tintOf } from "../theme/tint.ts";
import { useColors } from "../theme/use-theme.ts";
import { Banner } from "./controls.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { useShowLink } from "./link-sheet.tsx";
import { useTimeText } from "./time.ts";

/**
 * The connection line under the chat tab's title (the desktop sidebar's backend status): a dot,
 * the computer and how it is linked; amber when offline. Tapping it opens the Devices tab.
 */
export function ComputerStatus() {
  const colors = useColors(),
    mobile = useMobileSelector((s) => ({
      status: s.status,
      devices: s.devices,
      selectedId: s.selectedId,
      path: s.path,
      reconnecting: s.reconnecting,
      lastSeen: s.lastSeen,
    })),
    router = useRouter(),
    t = useText();
  const online = mobile.status === "online";
  const connecting = mobile.status === "connecting";
  const time = useTimeText();
  const name = mobile.devices.find((d) => d.id === mobile.selectedId)?.name;
  const text =
    online && name
      ? `${name} · ${t(mobile.path === "lan" ? "pathLan" : mobile.path === "direct" ? "pathDirect" : "pathRelay")}`
      : connecting
        ? t(mobile.reconnecting ? "reconnecting" : "connecting")
        : mobile.lastSeen
          ? t("offlineLastSeen", { time: time.ago(new Date(mobile.lastSeen).toISOString()) })
          : t("offline");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      hitSlop={slopFor(20)}
      onPress={() => router.navigate("/(tabs)/devices")}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}
    >
      {connecting ? (
        <ActivityIndicator size="small" color={colors.text2} style={{ width: 10, height: 10 }} />
      ) : (
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: online ? colors.ok : colors.warn,
          }}
        />
      )}
      <Text
        numberOfLines={1}
        style={[type.caption, { color: online || connecting ? colors.text2 : colors.warn }]}
      >
        {text}
      </Text>
    </Pressable>
  );
}
/**
 * Tab page header: the tab's colour washed in from the top, a large left-aligned title with
 * an optional line under it, pill actions on the right, then any summary the tab adds (stats).
 */
export function TabHeader({
  title,
  tab,
  subtitle,
  actions,
  children,
}: {
  title: string;
  tab: TabName;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const colors = useColors(),
    insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: colors.bg }}>
      <PageWash color={tintOf(colors, TAB_TINT[tab]).wash} />
      <View
        style={{
          minHeight: 60,
          paddingTop: 8,
          paddingLeft: 20,
          paddingRight: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={[type.tabTitle, { color: colors.text }]}
          >
            {title}
          </Text>
          {typeof subtitle === "string" ? (
            <Text numberOfLines={1} style={[type.caption, { color: colors.text2 }]}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )}
        </View>
        {actions}
      </View>
      {children}
      <View style={{ height: 10 }} />
      <CompatBanner />
    </View>
  );
}
/**
 * The header's pill button (36, touch area 44) on the colour wash: frosted `wash-pill`, no
 * border; `prim` is filled with the page colour. Without a title it is round, icon only.
 */
export function HeaderPill({
  title,
  icon,
  label,
  onPress,
  disabled,
  prim,
  danger,
  tint,
}: {
  title?: string;
  icon?: IconName;
  /** Read by screen readers; defaults to the title. */
  label?: string;
  onPress: () => void;
  disabled?: boolean;
  prim?: boolean;
  danger?: boolean;
  /** The page colour (an avatar colour name) for `prim`; defaults to the page's own. */
  tint?: string;
}) {
  const colors = useColors(),
    pageTint = usePageTint();
  const tone = tintOf(colors, tint ?? pageTint);
  const fg = prim ? tone.onFill : danger ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={slopFor(36)}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 36,
        minWidth: 36,
        paddingHorizontal: title ? 14 : 0,
        borderRadius: 18,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        backgroundColor: prim ? tone.fill : pressed ? colors.card : colors["wash-pill"],
        opacity: disabled ? 0.5 : pressed && prim ? 0.85 : 1,
      })}
    >
      {icon && <Icon name={icon} color={fg} size={title ? 15 : 18} />}
      {!!title && (
        <Text numberOfLines={1} style={[type.pill, { color: fg, fontWeight: "600" }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}
/**
 * When the two compatibility levels
 * differ, every tab says which side to update; equal levels (even with different versions) say
 * nothing. The download page is the fixed official site, never a link from the computer.
 */
function CompatBanner() {
  const mobile = useMobileSelector((s) => ({ desktop: s.desktop, selectedId: s.selectedId })),
    t = useText(),
    showLink = useShowLink();
  const about = mobile.desktop?.computerId === mobile.selectedId ? mobile.desktop : undefined;
  const notice = compatNotice(PHONE_COMPAT_LEVEL, about);
  const androidUpdate = useAndroidUpdate();
  if (!notice) return null;
  const version = about?.version ?? "";
  const download = () => {
    if (Platform.OS !== "android" || !androidUpdate.state.update) {
      void Linking.openURL(PIBOT_WEBSITE_URL).catch(() => showLink(PIBOT_WEBSITE_URL));
      return;
    }
    if (androidUpdate.state.phase === "unknown_sources") void androidUpdate.settings();
    else if (androidUpdate.state.phase === "downloading") androidUpdate.cancel();
    else if (androidUpdate.state.phase !== "installed") void androidUpdate.start();
  };
  return (
    <View style={{ marginHorizontal: space.page, marginBottom: 10 }}>
      {notice === "update_phone" ? (
        <Banner
          tone="warn"
          icon="info"
          text={t("compatUpdatePhone", { version })}
          action={
            androidUpdate.state.phase === "installed" || androidUpdate.state.phase === "installing"
              ? undefined
              : {
                  title: t(
                    androidUpdate.state.phase === "downloading"
                      ? "updateCancel"
                      : androidUpdate.state.phase === "unknown_sources"
                        ? "updateOpenSettings"
                        : androidUpdate.state.update
                          ? "updateInstall"
                          : "compatDownload",
                  ),
                  onPress: download,
                }
          }
        />
      ) : (
        <Banner tone="warn" icon="info" text={t("compatUpdateDesktop", { version })} />
      )}
    </View>
  );
}
/** Borderless 44pt round icon button of navigation bars. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  size = 22,
  color,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  size?: number;
  color?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? colors.hover : "transparent",
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <Icon name={icon} color={color ?? colors.text} size={size} />
    </Pressable>
  );
}
/** A text action in a navigation bar ("Save", "Create", "Cancel"). */
export function TextAction({
  title,
  onPress,
  disabled,
  plain,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  /** Regular weight, for the dismissive side. */
  plain?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 10,
        borderRadius: 22,
        justifyContent: "center",
        backgroundColor: pressed ? colors.hover : "transparent",
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Text style={{ fontSize: 15, fontWeight: plain ? "400" : "600", color: colors.text }}>
        {title}
      </Text>
    </Pressable>
  );
}
/**
 * Pushed page bar (56pt) on the page's colour wash: back, a left-aligned two-line title, then actions. With `lead` (the
 * chat avatar) and `onTitlePress` the whole identity block is one button, as in the desktop chat
 * header; `left` replaces the back button (e.g. "Cancel" on a creation page).
 */
export function NavBar({
  title,
  subtitle,
  onBack,
  onTitlePress,
  titleHint,
  onMore,
  lead,
  right,
  left,
  mono,
  tint,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  onTitlePress?: () => void;
  titleHint?: string;
  onMore?: () => void;
  lead?: ReactNode;
  right?: ReactNode;
  left?: ReactNode;
  /** Title in the monospace face (file paths). */
  mono?: string;
  /** Page colour (an avatar colour name): the Bot's on its pages, else the area's. */
  tint?: string;
}) {
  const colors = useColors(),
    insets = useSafeAreaInsets(),
    t = useText(),
    pageTint = usePageTint();
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: colors.bg }}>
      <PageWash color={tintOf(colors, tint ?? pageTint).wash} />
      <View
        style={{
          minHeight: 56,
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
          paddingVertical: 4,
          paddingLeft: 2,
          paddingRight: 10,
        }}
      >
        {left ?? <IconButton icon="back" label={t("back")} onPress={onBack} />}
        <Pressable
          accessibilityRole={onTitlePress ? "button" : "header"}
          accessibilityHint={titleHint}
          disabled={!onTitlePress}
          onPress={onTitlePress}
          style={({ pressed }) => ({
            flex: 1,
            minWidth: 0,
            minHeight: 48,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingLeft: lead ? 4 : 2,
            paddingRight: 10,
            borderRadius: 14,
            backgroundColor: pressed ? colors.hover : "transparent",
          })}
        >
          {lead}
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Text
                numberOfLines={1}
                style={[
                  type.headName,
                  { color: colors.text, flexShrink: 1 },
                  mono ? { fontFamily: mono, fontSize: 15 } : null,
                ]}
              >
                {title}
              </Text>
              {!!onTitlePress && <Icon name="chevron" color={colors.text2} size={14} />}
            </View>
            {!!subtitle && (
              <Text numberOfLines={1} style={[type.headSub, { color: colors.text2 }]}>
                {subtitle}
              </Text>
            )}
          </View>
        </Pressable>
        {right}
        {onMore && <IconButton icon="more" label={t("more")} onPress={onMore} />}
      </View>
    </View>
  );
}

/** An offline notice that, while the link is reconnecting, says so instead of "computer offline". */
export function OfflineBanner({
  text,
  onDetails,
  singleLine,
}: {
  text: string;
  onDetails?: () => void;
  singleLine?: boolean;
}) {
  const mobile = useLinkState(),
    t = useText();
  return mobile.status === "connecting" ? (
    <Banner
      tone="accent"
      icon="spinner"
      text={t(mobile.reconnecting ? "reconnecting" : "connecting")}
    />
  ) : (
    <Banner
      text={text}
      singleLine={singleLine}
      action={onDetails ? { title: t("offlineHintOpen"), onPress: onDetails } : undefined}
    />
  );
}
