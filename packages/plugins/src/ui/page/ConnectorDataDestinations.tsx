import type { Peer } from "@pibot/renderer-kit";
import {
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpcEvent,
  useSettings,
} from "@pibot/renderer-kit";
import { useCallback, useEffect } from "react";
import { useConnectorRead } from "../shell/remote.ts";
import { ConnectorFeedback } from "./ConnectorFeedback.tsx";

/** Where this connection's data goes, by destination and category; never content. */
export function ConnectorDataDestinations({ id, snapshot }: { id: string; snapshot: number }) {
  const { t, language } = useSettings();
  const load = useCallback(
    (peer: Peer, signal: AbortSignal) =>
      peer.call("connectors.dataDestinations", { id }, { signal }),
    [id],
  );
  const read = useConnectorRead(load);
  const refresh = read.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A connector change (mode, tools, reconnect) retires the projection.
  useEffect(() => refresh(), [snapshot, refresh]);
  useRpcEvent("chat.done", refresh);
  useRpcEvent("drafts.changed", refresh);
  const separator = language === "zh" ? "、" : ", ";
  return (
    <SettingsSection title={t("connections.drawer.destinations")}>
      <SettingsLine>{t("connectors.destinationsNote")}</SettingsLine>
      <ConnectorFeedback loading={read.loading} error={read.error} retry={refresh} />
      {read.value?.items.map((item) => (
        <SettingsRow
          key={item.destination.kind === "domain" ? item.destination.domain : "this_computer"}
          icon={item.destination.kind === "domain" ? "globe" : "laptop"}
          tone={item.destination.kind === "domain" ? "blue" : "green"}
          label={
            item.destination.kind === "domain"
              ? item.destination.domain
              : t("connectors.destination.this_computer")
          }
          note={[
            item.categories
              .map((category) => t(`connectors.dataCategory.${category}`))
              .join(separator),
            item.lastAt
              ? t("connectors.lastUsed", { time: new Date(item.lastAt).toLocaleString() })
              : t("connectors.neverUsed"),
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
      {read.value && !read.value.items.length && (
        <SettingsLine>{t("connectors.noDestinations")}</SettingsLine>
      )}
    </SettingsSection>
  );
}
