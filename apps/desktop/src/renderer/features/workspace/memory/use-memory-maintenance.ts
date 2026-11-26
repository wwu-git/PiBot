// Keeps the maintenance summary scoped to the open view and its live connection.
import type { MemoryMaintenanceStatus } from "@pibot/protocol";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";

export function useMemoryMaintenance(botId?: string, enabled = true) {
  const { peer } = useRpc();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    peer: typeof peer;
    botId: string | undefined;
    revision: number;
    status: MemoryMaintenanceStatus | undefined;
  }>();
  const refresh = () => setRevision((value) => value + 1);
  useRpcEvent("memory.status.changed", () => {
    // A run owned by another Bot can exhaust the shared daily budget.
    if (enabled) refresh();
  });
  useRpcEvent("memory.changed", (event) => {
    if (enabled && !botId && event.scope === "user") refresh();
  });
  useRpcEvent("settings.changed", () => {
    if (enabled) refresh();
  });
  useEffect(() => {
    if (!peer || !enabled) return;
    // The budget can reset at local midnight even when there is no new maintenance event.
    const timer = setInterval(() => setRevision((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [peer, enabled]);
  useEffect(() => {
    if (!peer || !enabled) return;
    const controller = new AbortController();
    void peer
      .call("memory.status", botId ? { botId } : {}, { signal: controller.signal })
      .then(({ maintenance }) => {
        if (!controller.signal.aborted) setSnapshot({ peer, botId, revision, status: maintenance });
      })
      .catch(() => {
        // Missing or disconnected peers provide no current status.
        if (!controller.signal.aborted) setSnapshot({ peer, botId, revision, status: undefined });
      });
    return () => controller.abort();
  }, [peer, botId, enabled, revision]);
  return enabled &&
    snapshot?.peer === peer &&
    snapshot?.botId === botId &&
    snapshot.revision === revision
    ? snapshot?.status
    : undefined;
}
