import { setTimeout as delay } from "node:timers/promises";
import type { BrainHost, RoutineHostAdapter } from "@pibot/brain-app";
import type { Logger } from "@pibot/observability";
import {
  type HostMethods,
  type HostParams,
  type HostResults,
  type Peer,
  type RoutineControlSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { type SecretStorageReason, secretStorageReason } from "@pibot/secrets";
import type { z } from "zod";
import type { createControlSource } from "./control-source.ts";

type RoutineControl = z.infer<typeof RoutineControlSchema>;
type ControlSource = ReturnType<typeof createControlSource<RoutineControl>>;

export type { BrainHost } from "@pibot/brain-app";

// `routines` is the routines capability's own host adapter, split off before the kernel sees the host.
export interface DesktopBrainHost extends BrainHost {
  routines: RoutineHostAdapter;
  remote: import("@pibot/remote/brain").RemoteHostPort;
  pickFolder(
    signal?: AbortSignal,
    options?: { create?: boolean; defaultPath?: string },
  ): Promise<HostResults["host.pickFolder"]>;
  pickFile(
    signal?: AbortSignal,
    options?: HostParams["host.pickFile"],
  ): Promise<HostResults["host.pickFile"]>;
  skills: { pickFile(signal: AbortSignal): Promise<HostResults["host.skills.pickFile"]> };
  notify(
    params: HostParams["host.notify"],
    signal?: AbortSignal,
  ): Promise<HostResults["host.notify"]>;
  revealPath(params: HostParams["host.revealPath"], signal?: AbortSignal): Promise<void>;
  openPath(params: HostParams["host.openPath"], signal?: AbortSignal): Promise<void>;
}

// Above the host's own per-step bounds (Cua 15 s, browser wait 25 s, page loads) plus queueing.
const HOST_ACTION_TIMEOUT_MS = 60_000;
// Bounded (5 s in all) so one credential read cannot stall a run through a whole login grace;
// the callers' own retries (remote setup backoff, the next request) cover the rest of it.
const TRANSIENT_STORAGE_BACKOFF_MS = 500;
const SESSION_PENDING_WAITS_MS = [500, 1000, 1500, 2000];

async function cancellable<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return action();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new RpcError(RpcErrorCodes.closed, "host_operation_cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createBrainHost(
  peer: Peer<typeof HostMethods, Record<string, never>>,
  logger: Pick<Logger, "warn">,
  controls?: ControlSource,
  devControls?: ReturnType<typeof createControlSource<import("@pibot/protocol").RoutineDevControl>>,
): DesktopBrainHost {
  let unavailableUntil = 0;
  // One handle per click whose note the host is checking. The host asks back through the
  // same private peer right before the system open; consuming the handle is what lets it proceed,
  // so a click revoked during the slow configuration read still opens nothing.
  const openingNotes = new Map<string, { confirm: () => Promise<void>; timer: NodeJS.Timeout }>();
  const MAX_PENDING_OPENS = 8;
  const OPEN_HANDLE_TTL_MS = 30_000;
  peer.handle("host.knowledge.confirmOpen", async ({ requestId }) => {
    const held = openingNotes.get(requestId);
    // Unknown, expired or already consumed: the answer is no, never "try again".
    openingNotes.delete(requestId);
    if (!held) throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_open_expired");
    clearTimeout(held.timer);
    await held.confirm();
    return null;
  });
  let unavailableReason: SecretStorageReason = "secrets_unavailable";
  async function secret<T>(method: string, action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        // The host holds the first keychain access until the session settles. That is not a
        // denial: wait briefly and ask again instead of backing off for thirty seconds.
        const pending =
          error instanceof RpcError && error.message === "secure_storage_session_pending";
        const wait = SESSION_PENDING_WAITS_MS[attempt];
        if (pending && wait !== undefined) {
          await delay(wait);
          continue;
        }
        // isEncryptionAvailable may still report true after the user denies decryption.
        // Back off across credential requests so a denied keyring is not immediately reprobed.
        const reason = secretStorageReason(error);
        if (!pending) {
          const transient = reason === "secure_storage_busy" || reason === "secure_storage_timeout";
          unavailableUntil =
            performance.now() + (transient ? TRANSIENT_STORAGE_BACKOFF_MS : 30_000);
          unavailableReason = reason;
        }
        const code = error instanceof RpcError ? error.code : RpcErrorCodes.secretsUnavailable;
        logger.warn(`host RPC ${method} code=${code} reason=${reason}`);
        throw new RpcError(RpcErrorCodes.secretsUnavailable, reason);
      }
    }
  }
  async function teamRequest<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const cancel = () => {
      void peer
        .call("host.teams.cancel", undefined)
        .catch(() => logger.warn("Team file cancellation unavailable"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await cancellable(action, signal);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  const browserView = (groupId?: string): NonNullable<BrainHost["browserView"]> => ({
    ...{
      clearGroupData: async (id: string) => {
        await peer.call("host.browser.clearGroupData", { groupId: id }, { timeoutMs: 60000 });
      },
      debug: (params) =>
        peer.call(
          "host.browser.view.debug",
          { ...params, ...(groupId ? { groupId } : {}) },
          { timeoutMs: 15000 },
        ),
      inspectPoint: (params) =>
        peer.call(
          "host.browser.view.inspectPoint",
          { ...params, ...(groupId ? { groupId } : {}) },
          { timeoutMs: 15000 },
        ),
      state: (botId) =>
        peer.call("host.browser.view.state", { botId, ...(groupId ? { groupId } : {}) }),
      visible: (botId, visible, display) =>
        peer.call("host.browser.view.visible", {
          botId,
          ...(groupId ? { groupId } : {}),
          visible,
          ...(display ? { display } : {}),
        }),
      takeover: (botId, on, options) =>
        peer.call("host.browser.view.takeover", {
          botId,
          ...(groupId ? { groupId } : {}),
          on,
          ...(options?.window === false ? { window: false } : {}),
        }),
      // A long poll (waitMs) plus the frame transfer; well under the host call timeout.
      remoteFrame: (botId, after, waitMs, signal) =>
        peer.call(
          "host.browser.view.remoteFrame",
          { botId, ...(groupId ? { groupId } : {}), after, waitMs },
          { signal, timeoutMs: waitMs + 10_000 },
        ),
      remoteStop: async (botId) => {
        await peer.call("host.browser.view.remoteStop", {
          botId,
          ...(groupId ? { groupId } : {}),
        });
      },
      input: async (botId, tab, event) => {
        await peer.call("host.browser.view.input", {
          botId,
          ...(groupId ? { groupId } : {}),
          tab,
          event,
        });
      },
      switchTab: (botId, tab) =>
        peer.call("host.browser.view.switchTab", { botId, ...(groupId ? { groupId } : {}), tab }),
      closeTab: (botId, tab) =>
        peer.call("host.browser.view.closeTab", { botId, ...(groupId ? { groupId } : {}), tab }),
      // Reopening up to 8 pages waits for their windows, not their loads (see BotBrowser.restore).
      wake: (botId) =>
        peer.call(
          "host.browser.view.wake",
          { botId, ...(groupId ? { groupId } : {}) },
          { timeoutMs: 60_000 },
        ),
      newTab: (botId) =>
        peer.call("host.browser.view.newTab", { botId, ...(groupId ? { groupId } : {}) }),
      clearData: async (botId) => {
        await peer.call(
          "host.browser.clearData",
          { botId, ...(groupId ? { groupId } : {}) },
          { timeoutMs: 60_000 },
        );
      },
      navigate: (botId, tab, action, url) =>
        peer.call("host.browser.view.navigate", {
          botId,
          ...(groupId ? { groupId } : {}),
          tab,
          action,
          ...(url !== undefined ? { url } : {}),
        }),
    },
    scoped: (id: string) => browserView(id),
  });
  return {
    connectorImports: {
      pick: (params) => peer.call("host.pickConnectorImport", params, { timeoutMs: 135 * 60_000 }),
      adopt: (params) => peer.call("host.adoptConnectorImport", params, { timeoutMs: 60_000 }),
      read: (params) => peer.call("host.readConnectorImport", params, { timeoutMs: 125 * 60_000 }),
      materialize: (params) =>
        peer.call("host.materializeConnectorImport", params, { timeoutMs: 125 * 60_000 }),
      release: (params) => peer.call("host.releaseConnectorImport", params),
      remove: (params) => peer.call("host.removeConnectorImport", params),
    },
    confirmConnectorCommand: (params, signal) =>
      peer.call("host.confirmConnectorCommand", params, { timeoutMs: 310_000, signal }),
    remote: {
      keepAwake: (enabled, signal) =>
        peer.call("host.remote.keepAwake", { enabled }, { signal, timeoutMs: 20_000 }),
    },
    routines: {
      keepAwake: (params, signal) => cancellable(() => peer.call("host.keepAwake", params), signal),
      updateTray: async (params, signal) => {
        await cancellable(() => peer.call("tray.update", params), signal);
      },
      backgroundState: (signal) =>
        cancellable(() => peer.call("host.backgroundState", undefined), signal),
      onControl: (listener) => {
        if (!controls) throw new RpcError(RpcErrorCodes.unsupported, "routine_control_unavailable");
        return controls.subscribe(listener);
      },
      ...(typeof __PIBOT_DEV_BUILD__ !== "undefined" && __PIBOT_DEV_BUILD__ && devControls
        ? { onDevControl: devControls.subscribe }
        : {}),
    },
    teams: {
      pickFile: (signal) =>
        teamRequest(
          () => peer.call("host.teams.pickFile", undefined, { timeoutMs: 630_000 }),
          signal,
        ),
      read: (file, signal) => teamRequest(() => peer.call("host.teams.read", { file }), signal),
      save: (payload, signal) =>
        teamRequest(() => peer.call("host.teams.save", payload, { timeoutMs: 630_000 }), signal),
      cancel: async () => {
        await peer.call("host.teams.cancel", undefined);
      },
    },
    updateProxy: async (url) => {
      await peer.call("host.updates.proxy", { url });
    },
    openExternal: async (url, signal) => {
      await cancellable(() => peer.call("host.openExternal", { url }), signal);
    },
    pickFolder: (signal, options) =>
      cancellable(
        () =>
          peer.call("host.pickFolder", options, {
            timeoutMs: 630_000,
          }),
        signal,
      ),
    pickFile: (signal, options) =>
      cancellable(() => peer.call("host.pickFile", options, { timeoutMs: 630_000 }), signal),
    // Read-only scan of this computer; the host bounds its own work, so the timeout only
    // needs to be generous enough for slow disks.
    knowledge: {
      detect: (signal) =>
        cancellable(
          () => peer.call("host.knowledge.detect", undefined, { timeoutMs: 25_000 }),
          signal,
        ),
      // The host re-checks the identities, asks `confirm` once after reading Obsidian's
      // configuration and before the system open, then rebuilds the URI itself.
      openNote: async (params, signal, confirm) => {
        if (openingNotes.size >= MAX_PENDING_OPENS)
          throw new RpcError(RpcErrorCodes.busy, "knowledge_open_busy");
        const timer = setTimeout(() => openingNotes.delete(params.requestId), OPEN_HANDLE_TTL_MS);
        timer.unref?.();
        openingNotes.set(params.requestId, { confirm, timer });
        try {
          return await cancellable(
            () => peer.call("host.knowledge.openNote", params, { timeoutMs: 25_000 }),
            signal,
          );
        } finally {
          clearTimeout(timer);
          openingNotes.delete(params.requestId);
        }
      },
    },
    skills: {
      pickFile: (signal) =>
        cancellable(
          () => peer.call("host.skills.pickFile", undefined, { timeoutMs: 630_000 }),
          signal,
        ),
    },
    memoryDreamActivity: (signal) =>
      peer.call("host.memoryDreamActivity", undefined, { signal, timeoutMs: 2000 }),
    notify: (params, signal) => cancellable(() => peer.call("host.notify", params), signal),
    openPath: async (params, signal) => {
      await cancellable(() => peer.call("host.openPath", params), signal);
    },
    revealPath: async (params, signal) => {
      await cancellable(() => peer.call("host.revealPath", params), signal);
    },
    attachments: {
      image: (params, signal) => {
        signal.throwIfAborted();
        return peer.call("host.attachments.image", params);
      },
      pdf: (params, signal) => {
        signal.throwIfAborted();
        return peer.call("host.attachments.pdf", params);
      },
      thumbnail: (params, signal) => {
        signal.throwIfAborted();
        return peer.call("host.attachments.thumbnail", params, { signal });
      },
      stepThumbnail: (params, signal) => {
        signal.throwIfAborted();
        return peer.call("host.attachments.stepThumbnail", params, { signal });
      },
      changeThumbnail: (params, signal) => {
        signal.throwIfAborted();
        return peer.call("host.attachments.changeThumbnail", params, { signal });
      },
      open: async (params) => {
        await peer.call("host.attachments.open", params);
      },
    },
    // Overlay controls; frames go to the window directly, never through brain.
    browserView: browserView(),
    // The background process owns the driver and the Bot browsers. Results carry
    // refusals as values; a stopped run only stops waiting, the host bounds its own work.
    office: {
      render: (params, signal) =>
        peer.call("host.office.render", params, { signal, timeoutMs: 35_000 }),
      apps: (params, signal) => peer.call("host.officeApps", params, { signal, timeoutMs: 25_000 }),
      open: async (params, signal) => {
        await peer.call("host.officeOpen", params, { signal, timeoutMs: 25_000 });
      },
    },
    computer: {
      call: (method, params, signal) =>
        peer.call(method, params, { signal, timeoutMs: HOST_ACTION_TIMEOUT_MS }),
    },
    browser: {
      call: (method, params, signal) =>
        peer.call(method, params, { signal, timeoutMs: HOST_ACTION_TIMEOUT_MS }),
    },
    // Login fill / capture and the system authentication sheet (which waits for the user).
    credentials: {
      call: (method, params, signal) =>
        peer.call(method, params, {
          signal,
          timeoutMs: method === "host.credentials.authenticate" ? 180_000 : HOST_ACTION_TIMEOUT_MS,
        }),
    },
    secrets: {
      isAvailable: async () => {
        if (performance.now() < unavailableUntil) {
          if (unavailableReason === "secrets_unavailable") return false;
          throw new RpcError(RpcErrorCodes.secretsUnavailable, unavailableReason);
        }
        try {
          return await secret("host.secrets.isAvailable", () =>
            peer.call("host.secrets.isAvailable", undefined),
          );
        } catch (error) {
          // A transient failure must retain its reason through SecretStore and business RPC,
          // rather than claim that this machine has no system keyring and disable retries.
          if (secretStorageReason(error) !== "secrets_unavailable") throw error;
          return false;
        }
      },
      encrypt: (plain) =>
        secret("host.secrets.encrypt", () => peer.call("host.secrets.encrypt", { plain })),
      decrypt: (cipher) =>
        secret("host.secrets.decrypt", () =>
          peer.call("host.secrets.decrypt", { cipher: new Uint8Array(cipher) }),
        ),
    },
    // Indicator / shortcut / Automation warm-up. The actions call is a long poll (≤25 s).
    computerGuard: {
      call: (method, params, signal) =>
        cancellable(() => peer.call(method, params, { timeoutMs: 30_000, signal }), signal),
    },
    env: {
      detect: () => peer.call("host.env.detect", undefined),
      read: async (name) => (await peer.call("host.env.read", { name })) ?? undefined,
    },
  };
}
