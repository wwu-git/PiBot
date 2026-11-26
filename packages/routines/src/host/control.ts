import { randomUUID } from "node:crypto";
import type { Logger } from "@pibot/observability";
import {
  type HostParams,
  RoutineControlSchema,
  RoutineTimingSchema,
  RpcError,
  RpcErrorCodes,
  TrayUpdateSchema,
} from "@pibot/protocol";
import type { z } from "zod";
import { type Blocker, createPowerLease, type PowerSupply } from "./power/lease.ts";
import { linuxPower } from "./power/linux.ts";

export type RoutineControl = z.infer<typeof RoutineControlSchema>;
export type TrayState = z.infer<typeof TrayUpdateSchema>;
export function createRoutineHost(options: {
  platform: NodeJS.Platform;
  monitor: {
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
    isOnBatteryPower(): boolean;
  };
  window?: {
    on(event: "focus", listener: () => void): unknown;
    off(event: "focus", listener: () => void): unknown;
  };
  blocker: Blocker;
  test?: boolean;
  logger: Logger;
  send(control: RoutineControl): void;
  tray(state: TrayState | null): void;
}) {
  let supply: PowerSupply = "unknown";
  let closed = false,
    active = false;
  let epoch = 0;
  let lastActivity: string | undefined;
  let lastActivitySent = -Infinity;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let poll: Promise<void> | undefined;
  const shutdown = new AbortController();
  const listeners: [string, () => void][] = [];
  const power = createPowerLease({
    blocker: options.blocker,
    changed: () => {
      if (active) options.send(snapshot());
    },
    warn: () => options.logger.warn("power blocker request unavailable"),
  });
  const snapshot = (): RoutineControl => ({
    type: "power-snapshot",
    supply,
    keepAwake: power.status(),
    at: new Date().toISOString(),
  });
  function event(
    kind: "suspend" | "resume" | "on-ac" | "on-battery" | "lock-screen" | "unlock-screen",
  ) {
    if (closed) return;
    if (kind === "on-ac" || kind === "on-battery") setSupply(kind === "on-ac" ? "ac" : "battery");
    if (kind === "suspend") power.end();
    if (kind === "resume" && active) {
      power.begin(epoch);
      power.supply(supply);
    }
    options.send(
      RoutineControlSchema.parse({
        type: "power-event",
        supply,
        event: { id: randomUUID(), kind, at: new Date().toISOString() },
      }),
    );
  }
  function setSupply(next: PowerSupply) {
    supply = next;
    power.supply(next);
  }
  function focused(at = new Date().toISOString()) {
    if (closed) return;
    lastActivity = at;
    if (performance.now() - lastActivitySent >= 3_600_000) {
      lastActivitySent = performance.now();
      options.send({ type: "ui-active", at: lastActivity });
    }
  }
  const windowFocus = () => focused();
  async function pollLinux() {
    try {
      const next = await linuxPower(AbortSignal.any([shutdown.signal, AbortSignal.timeout(2000)]));
      if (closed) return;
      const previous = supply;
      setSupply(next);
      if (active && previous !== next) {
        if (next === "unknown") options.send(snapshot());
        else event(next === "ac" ? "on-ac" : "on-battery");
      }
    } catch {
      if (!closed) {
        setSupply("unknown");
        if (active) options.send(snapshot());
      }
    } finally {
      if (!closed)
        pollTimer = setTimeout(() => {
          poll = pollLinux();
        }, 5000);
    }
  }
  if (!options.test) {
    for (const kind of [
      "suspend",
      "resume",
      "lock-screen",
      "unlock-screen",
      "on-ac",
      "on-battery",
    ] as const) {
      const listener = () => event(kind);
      options.monitor.on(kind, listener);
      listeners.push([kind, listener]);
    }
    if (options.platform === "linux") poll = pollLinux();
    else {
      try {
        setSupply(options.monitor.isOnBatteryPower() ? "battery" : "ac");
      } catch {
        setSupply("unknown");
      }
    }
    options.window?.on("focus", windowFocus);
  }
  return {
    focused,
    powerSupply: () => supply,
    begin(owner: number) {
      active = false;
      epoch = owner;
      power.begin(owner);
      power.waitingLimit(1_800_000);
      power.supply(supply);
      active = true;
    },
    ready() {
      options.send(snapshot());
      // Replay the actual latest focus after child replacement, never fabricate a startup focus.
      if (lastActivity) options.send({ type: "ui-active", at: lastActivity });
    },
    activity(): RoutineControl | undefined {
      return lastActivity ? { type: "ui-active", at: lastActivity } : undefined;
    },
    end() {
      active = false;
      power.end();
      options.tray(null);
    },
    keepAwake(owner: number, params: HostParams["host.keepAwake"]) {
      if (closed || !active || owner !== epoch)
        throw new RpcError(RpcErrorCodes.closed, "stale_brain_epoch");
      return power.request(owner, params);
    },
    updateTray(owner: number, params: HostParams["tray.update"]) {
      if (closed || !active || owner !== epoch)
        throw new RpcError(RpcErrorCodes.closed, "stale_brain_epoch");
      options.tray(TrayUpdateSchema.parse(params));
    },
    simulateSupply(next: PowerSupply, event?: "suspend" | "resume") {
      if (!options.test) throw new Error("test_host_required");
      if (event === "suspend") power.end();
      if (event === "resume" && active) power.begin(epoch);
      setSupply(next);
    },
    simulateTiming(ms: number) {
      if (!options.test) throw new Error("test_host_required");
      power.waitingLimit(RoutineTimingSchema.shape.waitingKeepAwakeMs.parse(ms));
    },
    async stop() {
      closed = true;
      active = false;
      shutdown.abort();
      power.end();
      clearTimeout(pollTimer);
      options.window?.off("focus", windowFocus);
      for (const [kind, listener] of listeners) options.monitor.off(kind, listener);
      await poll;
    },
  };
}
