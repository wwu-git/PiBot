/** Renders the app-owned update state in the Devices page. */

import { Platform, Text, View } from "react-native";
import { useText } from "../../runtime/context.tsx";
import { radius, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Button, ListCard } from "../../ui/controls.tsx";
import { Icon } from "../../ui/icons.tsx";
import type { useAndroidUpdate } from "./AndroidUpdateProvider.tsx";

function megabytes(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function AndroidUpdateCard({ update }: { update: ReturnType<typeof useAndroidUpdate> }) {
  const t = useText();
  const colors = useColors();
  const { state, start, cancel, settings } = update;
  if (Platform.OS !== "android" || !state.update || !state.phase) return null;
  const failed = state.phase === "verify_failed";
  const installing = state.phase === "installing";
  const downloading = state.phase === "downloading" || installing;
  const title =
    state.phase === "installed"
      ? t("updateInstallerOpened")
      : state.phase === "unknown_sources"
        ? t("updateUnknownSources")
        : state.phase === "network_error"
          ? t("updateNetworkError")
          : downloading
            ? t("updateDownloading", {
                version: state.update.version,
                percent: Math.round(state.progress * 100),
              })
            : failed
              ? t("updateVerifyFailed")
              : t("updateAvailable", { version: state.update.version });
  const hint =
    state.phase === "installed"
      ? t("updateInstallerOpenedHint")
      : state.phase === "unknown_sources"
        ? t("updateUnknownSourcesHint")
        : state.phase === "network_error"
          ? t("updateNetworkErrorHint")
          : downloading
            ? t("updateDownloadingHint", {
                done: megabytes(state.downloadedBytes),
                total: megabytes(state.update.size),
              })
            : failed
              ? t("updateVerifyFailedHint")
              : t("updateAvailableHint");
  const action = downloading
    ? t("updateCancel")
    : failed || state.phase === "network_error"
      ? t("updateRetry")
      : t("updateInstall");
  const onPress = downloading ? cancel : start;
  return (
    <ListCard style={{ marginTop: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: radius.card,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.accent,
          }}
        >
          <Icon name="download" color={colors.onUser} size={25} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={[type.body, { color: colors.text, fontWeight: "600" }]}>{title}</Text>
          <Text style={[type.caption, { color: failed ? colors.danger : colors.text2 }]}>
            {hint}
          </Text>
          {downloading && (
            <View style={{ height: 6, marginTop: 4, borderRadius: 3, backgroundColor: colors.b2 }}>
              <View
                style={{
                  width: `${Math.round(state.progress * 100)}%`,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: colors.accent,
                }}
              />
            </View>
          )}
          {state.phase === "unknown_sources" && (
            <Button title={t("updateOpenSettings")} onPress={() => void settings()} />
          )}
        </View>
        {state.phase !== "unknown_sources" && state.phase !== "installed" && !installing && (
          <Button title={action} onPress={onPress} />
        )}
      </View>
    </ListCard>
  );
}
