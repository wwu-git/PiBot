import { failureReasonKey } from "@pibot/i18n";
import type { ConnectionUse } from "@pibot/plugins-contract/full";
import type { Peer } from "@pibot/renderer-kit";
import { SettingsLine, SettingsRow, SettingsSection, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { useCallback, useState } from "react";
import { useConnectorsPorts } from "../shell/ports.tsx";
import { useConnectorPage } from "../shell/remote.ts";
import { ConnectorFeedback, ConnectorPagination } from "./ConnectorFeedback.tsx";
import { connectionUseReasonKey } from "./use-reason-text.ts";

const PAGE = 10;

/** The connection's latest calls (audit and send drafts), each opening its receipt. */
export function ConnectorRecentUse({ id, snapshot }: { id: string; snapshot: number }) {
  const t = useT();
  const load = useCallback(
    (peer: Peer, signal: AbortSignal, cursor?: string) =>
      peer.call("connectors.recentUse", { id, before: cursor, limit: PAGE }, { signal }),
    [id],
  );
  const page = useConnectorPage(load, snapshot);
  // A call ends a run or settles an approval / draft; both change what this list shows.
  useRpcEvent("chat.done", page.refresh);
  useRpcEvent("approval.resolved", page.refresh);
  useRpcEvent("drafts.changed", page.refresh);
  return (
    <SettingsSection title={t("connections.drawer.recent")}>
      <SettingsLine>{t("connectors.recentUseNote")}</SettingsLine>
      <ConnectorFeedback loading={page.loading} error={page.error} retry={page.refresh} />
      {page.value?.items.map((use) => (
        <UseRow key={use.id} use={use} />
      ))}
      {page.value && !page.value.items.length && (
        <SettingsLine>{t("connectors.noRecentUse")}</SettingsLine>
      )}
      <ConnectorPagination previous={page.previous} next={page.next} disabled={page.loading} />
    </SettingsSection>
  );
}

function UseRow({ use }: { use: ConnectionUse }) {
  const t = useT();
  const { RunReceipt } = useConnectorsPorts();
  const [open, setOpen] = useState(false);
  const who = use.groupId
    ? (use.groupName ?? t("connectors.unavailableGroup"))
    : (use.botName ?? t("connectors.unavailableBot"));
  const receipt = RunReceipt && use.runId ? { Receipt: RunReceipt, runId: use.runId } : undefined;
  const reasonKey = use.reasonCode
    ? (connectionUseReasonKey(use.reasonCode) ?? failureReasonKey(use.reasonCode))
    : undefined;
  // A code with no text yet still says what happened; the code is only a last-resort detail.
  const result = !use.reasonCode
    ? t(`connectors.use.${use.outcome}`)
    : reasonKey
      ? `${t(`connectors.use.${use.outcome}`)} · ${t(reasonKey)}`
      : t(use.outcome === "denied" ? "connectors.use.deniedCode" : "connectors.use.failedCode", {
          code: use.reasonCode,
        });
  return (
    <>
      <SettingsRow
        icon={use.outcome === "failed" ? "warning" : use.outcome === "denied" ? "stop" : "clock"}
        tone={use.outcome === "failed" ? "red" : use.outcome === "denied" ? "orange" : "teal"}
        label={`${use.tool ?? t("connectors.use.unknownTool")} · ${t(`connectors.use.${use.kind}`)}`}
        note={`${new Date(use.at).toLocaleString()} · ${who}`}
      >
        <Chip tone={use.outcome === "failed" ? "danger" : "neutral"}>{result}</Chip>
        {receipt && (
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {t(open ? "connectors.use.hideReceipt" : "connectors.use.receipt")}
          </Button>
        )}
      </SettingsRow>
      {receipt && open && <receipt.Receipt runId={receipt.runId} />}
    </>
  );
}
