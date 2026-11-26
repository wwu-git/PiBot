/** The Devices tab manages paired computers and phone settings. */

import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { Platform, ScrollView, Text, View } from "react-native";
import { useNotifications } from "../../push/NotificationsProvider.tsx";
import { useText } from "../../runtime/context.tsx";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import {
  Button,
  ErrorLine,
  FootNote,
  ListCard,
  SectionTitle,
  Separator,
  Switch,
} from "../../ui/controls.tsx";
import { TabHeader } from "../../ui/headers.tsx";
import { SettingRow } from "../../ui/rows.tsx";
import { Sheet, SheetText, SheetTitle } from "../../ui/sheet.tsx";
import { useTabBarInset } from "../../ui/tab-bar.tsx";
import { AndroidUpdateCard } from "../updates/AndroidUpdateCard.tsx";
import { useAndroidUpdate } from "../updates/AndroidUpdateProvider.tsx";
import { DisplaySettings } from "./DisplaySettings.tsx";
import { LinkCard } from "./LinkCard.tsx";
import { useBackgroundLimits } from "./use-background-limits.ts";
import { useDevices } from "./use-devices.ts";

function pushHint(notify: ReturnType<typeof useNotifications>) {
  if (notify.availability === "unconfigured") return "pushNotSetUp";
  if (notify.availability === "apple_account") return "pushNeedsAppleAccount";
  if (notify.availability !== "ready") return "pushNoDevice";
  if (!notify.enabled) return "pushOff";
  return notify.pushOn ? "pushOn" : "pushPending";
}
/** 通知与安全: a blocked system permission offers the system settings, never a switch that looks on. */
function NotifyCard() {
  const colors = useColors(),
    t = useText(),
    notify = useNotifications();
  const blocked = notify.permission === "denied";
  return (
    <>
      <SectionTitle title={t("notifyAndSecurity")} />
      <ListCard>
        <SettingRow
          icon="bell"
          tint="amber"
          title={t("notifyTitle")}
          hint={t(blocked ? "notifyBlocked" : "notifyHint")}
          hintTone={blocked ? "warn" : undefined}
          right={
            blocked ? (
              <Button title={t("openSystemSettings")} onPress={() => void Linking.openSettings()} />
            ) : (
              <Switch
                label={t("notifyTitle")}
                value={notify.enabled}
                disabled={!notify.ready || notify.action.busy}
                onValueChange={(value) => void notify.setEnabled(value)}
              />
            )
          }
        />
        <Separator />
        <SettingRow icon="up" tint="orange" title={t("pushTitle")} hint={t(pushHint(notify))} />
        <Separator />
        <SettingRow icon="lock" tint="pink" title={t("faceSetting")} hint={t("faceSettingHint")} />
      </ListCard>
      {Platform.OS === "android" && (
        <Text style={[type.caption, { paddingHorizontal: 20, paddingTop: 8, color: colors.text2 }]}>
          {t("androidPush")}
        </Text>
      )}
    </>
  );
}
export function DevicesScreen() {
  const t = useText(),
    colors = useColors(),
    devices = useDevices(),
    notify = useNotifications(),
    battery = useBackgroundLimits(),
    router = useRouter(),
    tabInset = useTabBarInset();
  const androidUpdate = useAndroidUpdate();
  const current = devices.devices.find((d) => d.id === devices.selectedId) ?? devices.devices[0];
  const others = devices.devices.filter((d) => d.id !== current?.id);
  const host = current ? new URL(current.relay).host : "";
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader title={t("devices")} tab="devices" />
      <ScrollView contentContainerStyle={{ paddingBottom: tabInset }}>
        <ErrorLine text={devices.action.error && t(devices.action.error)} />
        <ErrorLine text={notify.action.error && t(notify.action.error)} />
        {!current && (
          <ListCard>
            <View style={{ padding: 16, gap: 12 }}>
              <Text style={[type.emptyTitle, { color: colors.text }]}>{t("pairTitle")}</Text>
              <Text style={[type.caption, { color: colors.text2 }]}>{t("pairHint")}</Text>
              <Button
                size="lg"
                title={t("pairScan")}
                variant="prim"
                icon="qr"
                onPress={() => router.push("/pair")}
              />
            </View>
          </ListCard>
        )}
        {current && (
          <LinkCard
            computer={current}
            status={current.id === devices.selectedId ? devices.status : "offline"}
            path={devices.path}
            pathKind={devices.pathKind}
            directFailure={devices.directFailure}
            error={devices.error}
            reconnecting={devices.reconnecting}
            lastSeen={current.id === devices.selectedId ? devices.lastSeen : undefined}
          />
        )}
        {current && battery.notice && (
          <ListCard style={{ marginTop: 10 }}>
            <SettingRow
              icon="warning"
              tint="amber"
              title={t(
                battery.notice === "restricted"
                  ? "batteryRestrictedTitle"
                  : "batteryOptimizedTitle",
              )}
              hint={t(
                battery.notice === "restricted" ? "batteryRestrictedHint" : "batteryOptimizedHint",
              )}
              right={<Button title={t("batteryOpen")} onPress={battery.open} />}
            />
          </ListCard>
        )}
        {others.length > 0 && (
          <>
            <SectionTitle title={t("otherComputers")} />
            <ListCard>
              {others.map((computer, index) => (
                <View key={computer.id}>
                  {index > 0 && <Separator />}
                  <SettingRow
                    icon="laptop"
                    tint="gray"
                    title={computer.name}
                    hint={new URL(computer.relay).host}
                    right={
                      <Button
                        title={t("connect")}
                        disabled={devices.action.busy}
                        onPress={() => void devices.select(computer.id)}
                      />
                    }
                  />
                </View>
              ))}
            </ListCard>
          </>
        )}
        {current && (
          <>
            <SectionTitle title={t("capabilitiesSection")} />
            <ListCard>
              <SettingRow
                icon="puzzle"
                tint="blue"
                title={t("endpointsTitle")}
                hint={t("endpointsEntryHint")}
                onPress={() => router.push("/endpoint-capabilities")}
              />
              <Separator />
              <SettingRow
                icon="camera"
                tint="pink"
                title={t("phoneDataTitle")}
                hint={t("phoneDataEntryHint")}
                onPress={() => router.push("/phone-data")}
              />
              <Separator />
              <SettingRow
                icon="message"
                tint="teal"
                title={t("offlineEntryTitle")}
                hint={t("offlineEntryHint")}
                onPress={() => router.push("/offline")}
              />
            </ListCard>
          </>
        )}
        <NotifyCard />
        <DisplaySettings />
        <SectionTitle title={t("connectionSection")} />
        <ListCard>
          {current && devices.canKeepConnected && (
            <>
              <SettingRow
                icon="link"
                tint="violet"
                title={t("keepConnected")}
                hint={t("keepConnectedHint")}
                right={
                  <Switch
                    label={t("keepConnected")}
                    value={devices.keepConnected}
                    disabled={devices.action.busy}
                    onValueChange={(value) => void devices.setKeepConnected(value)}
                  />
                }
              />
              <Separator />
            </>
          )}
          <SettingRow icon="globe" tint="gray" title={t("relay")} hint={t("relayHint", { host })} />
          <Separator />
          <SettingRow icon="hand" tint="green" title={t("scopeTitle")} hint={t("scopeHint")} />
          {current && (
            <>
              <Separator />
              <SettingRow
                title={t("unpair")}
                titleTone="danger"
                chevron={false}
                disabled={devices.action.busy}
                onPress={() => devices.setRemoving(current.id)}
              />
            </>
          )}
        </ListCard>
        {Platform.OS === "android" && (
          <ListCard style={{ marginTop: 10 }}>
            <SettingRow
              icon="download"
              title={t("updateCheck")}
              chevron={false}
              disabled={androidUpdate.checkDisabled}
              onPress={() => void androidUpdate.check()}
            />
          </ListCard>
        )}
        <AndroidUpdateCard update={androidUpdate} />
        {/* A count would only grow with every reload of the same list; the fact is what matters. */}
        {devices.skipped > 0 && <FootNote text={t("skippedItems")} />}
        <FootNote
          text={[
            t("devicesFoot"),
            t("versionFooter", {
              phone: Constants.expoConfig?.version ?? "",
              desktop:
                current && devices.desktop?.computerId === current.id
                  ? (devices.desktop.version ?? "")
                  : "",
            }),
          ].join("\n")}
        />
      </ScrollView>
      <Sheet visible={!!devices.removing} onClose={() => devices.setRemoving(undefined)}>
        <SheetTitle text={t("unpairTitle")} />
        <SheetText text={t("unpairHint")} />
        <Button
          size="lg"
          variant="dangerFill"
          title={t("unpair")}
          disabled={devices.action.busy}
          onPress={() => void devices.forget()}
        />
        <Button
          size="lg"
          variant="ghost"
          title={t("cancel")}
          onPress={() => devices.setRemoving(undefined)}
        />
      </Sheet>
    </View>
  );
}
