// Subpaths: this bundle is evaluated before the first frame of every window.
import {
  BROWSER_FRAME_CHANNEL,
  DESKTOP_RESTART_CHANNEL,
  DESKTOP_UPDATES_CHANNEL,
  DESKTOP_UPDATES_STATE_CHANNEL,
  DesktopRestartRequestSchema,
  DesktopRestartResultSchema,
  DesktopUpdateActionSchema,
  DesktopUpdateStateSchema,
  IdSchema,
  IndependentBackgroundMethods,
  PROVIDER_IMPORT_RESOLVE,
  ProviderImportDecisionSchema,
  ProviderImportResultSchema,
} from "@pibot/protocol-base/desktop-bridge";
import { DesktopBackgroundMethods } from "@pibot/routines-contract/desktop-bridge";
import { contextBridge, ipcRenderer } from "electron";
import { liveIslandSupport } from "../shared/live-island.ts";
import { parseStartupLabels } from "../shared/startup-labels.ts";
import {
  STARTUP_PROGRESS_CHANNEL,
  StartupProgressEventSchema,
} from "../shared/startup-progress.ts";
import { assertStartupCacheCleared } from "../shared/startup-receipt.ts";
import { STARTUP_SNAPSHOT_CHANNEL, StartupSnapshotSchema } from "../shared/startup-snapshot.ts";
import { SYSTEM_PROXY_CHANNEL, SYSTEM_PROXY_URL } from "../shared/system-proxy.ts";
import { TITLE_OVERLAY_ARG } from "../shared/title-overlay.ts";

contextBridge.exposeInMainWorld(
  "pibotStartup",
  Object.freeze({
    /** Windows/Linux: main drew the window controls as an overlay (title strip needed). */
    titleOverlay: process.argv.includes(TITLE_OVERLAY_ARG),
    async locale() {
      const value: unknown = await ipcRenderer.invoke(STARTUP_SNAPSHOT_CHANNEL, "locale");
      return typeof value === "string" && value.length < 100 ? value : "en";
    },
    // The first frame's strings, so the renderer paints before loading @pibot/i18n.
    async labels() {
      return parseStartupLabels(await ipcRenderer.invoke(STARTUP_SNAPSHOT_CHANNEL, "labels"));
    },
    /** Resolves once the GUI client has registered the handlers the live App calls. */
    async ready() {
      await ipcRenderer.invoke(STARTUP_SNAPSHOT_CHANNEL, "ready");
    },
    async read() {
      const value: unknown = await ipcRenderer.invoke(STARTUP_SNAPSHOT_CHANNEL, "read");
      const parsed = StartupSnapshotSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    save(value: unknown) {
      return ipcRenderer.invoke(
        STARTUP_SNAPSHOT_CHANNEL,
        "save",
        StartupSnapshotSchema.parse(value),
      );
    },
    async clear() {
      assertStartupCacheCleared(await ipcRenderer.invoke(STARTUP_SNAPSHOT_CHANNEL, "clear"));
    },
    timing(value: { method: string; durationMs: number; ok: boolean }) {
      ipcRenderer.send("pibot:startup-timing", value);
    },
    // The first frame shows what the background is doing while the window attaches.
    onProgress(
      listener: (value: import("../shared/startup-progress.ts").StartupProgressEvent) => void,
    ) {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = StartupProgressEventSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(STARTUP_PROGRESS_CHANNEL, receive);
      return () => {
        ipcRenderer.off(STARTUP_PROGRESS_CHANNEL, receive);
      };
    },
  }),
);

// MessagePorts are transferable DOM objects, not contextBridge-cloneable values.
// Install only the subscription in the main world; keep all Electron objects isolated.
contextBridge.executeInMainWorld({
  func: (platform: NodeJS.Platform, frameChannel: string, liveIsland: string) => {
    let pendingBackground = 0;
    function background(method: string, params?: unknown): Promise<unknown> {
      if (pendingBackground >= 16) return Promise.reject(new Error("background_busy"));
      pendingBackground++;
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const finish = () => {
          pendingBackground--;
          clearTimeout(timer);
          window.removeEventListener("message", receive);
        };
        const receive = (event: MessageEvent) => {
          if (
            event.source !== window ||
            event.data?.type !== "pibot:background-result" ||
            event.data.id !== id
          )
            return;
          finish();
          if (event.data.reply?.ok) resolve(event.data.reply.result);
          else reject(new Error(event.data.reply?.message ?? "background_request_failed"));
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error("background_timeout"));
        }, 30_000);
        window.addEventListener("message", receive);
        window.postMessage({ type: "pibot:background", id, method, params }, "*");
      });
    }
    Object.defineProperty(window, "pibot", {
      value: Object.freeze({
        platform,
        liveIsland,
        restartApp: () => background("app.restart", { action: "restart" }),
        resolveProviderImport: (decision: unknown) =>
          background("desktop.providerImport.resolve", decision),
        background: Object.freeze({
          state: () => background("background.state"),
          restart: () => background("background.restart"),
          serviceState: () => background("background.serviceState"),
          preferences: (patch: { exitBehavior?: "stop" | "continue"; startAtLogin?: boolean }) =>
            background("background.preferences", patch),
          stopService: () => background("background.stopService"),
        }),
        onPort(callback: (port: MessagePort, options?: { scheduled: boolean }) => void) {
          const receive = (event: MessageEvent) => {
            if (
              event.source === window &&
              (event.data === "pibot:port" || event.data?.type === "pibot:port") &&
              event.ports[0]
            ) {
              callback(event.ports[0], { scheduled: event.data?.scheduled === true });
            }
          };
          window.addEventListener("message", receive);
          window.postMessage("pibot:request-port", "*");
          return () => window.removeEventListener("message", receive);
        },
        // Bot browser overlay frames: one port per Bot, separate from the business port.
        onBrowserFrames(callback: (botId: string, port: MessagePort, groupId?: string) => void) {
          const receive = (event: MessageEvent) => {
            if (
              event.source === window &&
              event.data?.type === frameChannel &&
              typeof event.data.botId === "string" &&
              event.ports[0]
            )
              callback(
                event.data.botId,
                event.ports[0],
                typeof event.data.groupId === "string" ? event.data.groupId : undefined,
              );
          };
          window.addEventListener("message", receive);
          return () => window.removeEventListener("message", receive);
        },
        // In-app updates: one request per action; state changes arrive through onState.
        updates: Object.freeze({
          run(action: string): Promise<unknown> {
            const id = crypto.randomUUID();
            return new Promise((resolve, reject) => {
              const receive = (event: MessageEvent) => {
                if (
                  event.source !== window ||
                  event.data?.type !== "pibot:updates-result" ||
                  event.data.id !== id
                )
                  return;
                window.removeEventListener("message", receive);
                if (event.data.ok) resolve(event.data.state);
                else reject(new Error("updates_unavailable"));
              };
              window.addEventListener("message", receive);
              window.postMessage({ type: "pibot:updates", id, action }, "*");
            });
          },
          onState(callback: (state: unknown) => void) {
            const receive = (event: MessageEvent) => {
              if (event.source === window && event.data?.type === "pibot:updates-state")
                callback(event.data.state);
            };
            window.addEventListener("message", receive);
            return () => window.removeEventListener("message", receive);
          },
        }),
        systemProxy(): Promise<string | null> {
          const id = Math.random().toString(36).slice(2);
          return new Promise((resolve) => {
            const receive = (event: MessageEvent) => {
              if (
                event.source === window &&
                event.data?.type === "pibot:system-proxy-result" &&
                event.data.id === id
              ) {
                window.removeEventListener("message", receive);
                resolve(typeof event.data.result === "string" ? event.data.result : null);
              }
            };
            window.addEventListener("message", receive);
            window.postMessage({ type: "pibot:system-proxy", id }, "*");
          });
        },
        exportLogs(): Promise<"saved" | "canceled" | "failed"> {
          const id = Math.random().toString(36).slice(2);
          return new Promise((resolve) => {
            const receive = (event: MessageEvent) => {
              if (
                event.source === window &&
                event.data?.type === "pibot:export-logs-result" &&
                event.data.id === id
              ) {
                window.removeEventListener("message", receive);
                resolve(event.data.result);
              }
            };
            window.addEventListener("message", receive);
            window.postMessage({ type: "pibot:export-logs", id }, "*");
          });
        },
      }),
      writable: false,
      configurable: false,
    });
  },
  // The same session check the live island's owner makes, so Settings can say why it is off.
  args: [process.platform, BROWSER_FRAME_CHANNEL, liveIslandSupport(process.platform, process.env)],
});

let backgroundRequests = 0;
let updateRequests = 0;
const backgroundMethods = {
  ...DesktopBackgroundMethods,
  ...IndependentBackgroundMethods,
  [PROVIDER_IMPORT_RESOLVE]: {
    params: ProviderImportDecisionSchema,
    result: ProviderImportResultSchema,
  },
  "app.restart": { params: DesktopRestartRequestSchema, result: DesktopRestartResultSchema },
};
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data === "pibot:request-port") ipcRenderer.send("pibot:renderer-ready");
  if (event.data === "pibot:first-screen-ready") ipcRenderer.send("pibot:first-screen-ready");
  if (event.data?.type === "pibot:background") {
    const { method, id, params } = event.data as { method: unknown; id: unknown; params: unknown };
    if (
      typeof method !== "string" ||
      !Object.hasOwn(backgroundMethods, method) ||
      typeof id !== "string" ||
      id.length > 64 ||
      backgroundRequests >= 16
    )
      return;
    backgroundRequests++;
    const schema = backgroundMethods[method as keyof typeof backgroundMethods];
    if (!schema.params.safeParse(params).success) {
      backgroundRequests--;
      return;
    }
    void ipcRenderer
      .invoke(
        method === "app.restart" ? DESKTOP_RESTART_CHANNEL : "pibot:background",
        method === "app.restart" ? params : { method, params },
      )
      .then((reply) => {
        if (reply?.ok) return { ok: true, result: schema.result.parse(reply.result) };
        return { ok: false, message: "background_request_failed" };
      })
      .catch(() => ({ ok: false, message: "background_request_failed" }))
      .then((reply) => {
        window.postMessage({ type: "pibot:background-result", id, reply }, "*");
      })
      .finally(() => {
        backgroundRequests--;
      });
  }
  if (
    event.data?.type === "pibot:updates" &&
    typeof event.data.id === "string" &&
    event.data.id.length <= 64 &&
    updateRequests < 8
  ) {
    const id = event.data.id;
    const request = DesktopUpdateActionSchema.safeParse({ action: event.data.action });
    if (!request.success) return;
    updateRequests++;
    void ipcRenderer
      .invoke(DESKTOP_UPDATES_CHANNEL, request.data)
      .then((state) => ({ ok: true, state: DesktopUpdateStateSchema.parse(state) }))
      .catch(() => ({ ok: false }))
      .then((reply) => window.postMessage({ type: "pibot:updates-result", id, ...reply }, "*"))
      .finally(() => {
        updateRequests--;
      });
  }
  if (
    event.data?.type === "pibot:system-proxy" &&
    typeof event.data.id === "string" &&
    event.data.id.length <= 64
  ) {
    const id = event.data.id;
    void ipcRenderer
      .invoke(SYSTEM_PROXY_CHANNEL)
      .then((value: unknown) =>
        typeof value === "string" && SYSTEM_PROXY_URL.test(value) ? value : null,
      )
      .catch(() => null)
      .then((result) => window.postMessage({ type: "pibot:system-proxy-result", id, result }, "*"));
  }
  if (event.data?.type === "pibot:export-logs" && typeof event.data.id === "string") {
    const id = event.data.id;
    void ipcRenderer
      .invoke("pibot:export-logs")
      .catch(() => "failed")
      .then((result) => window.postMessage({ type: "pibot:export-logs-result", id, result }, "*"));
  }
});
ipcRenderer.on("pibot:port", (event, options: unknown) => {
  const scheduled =
    !!options &&
    typeof options === "object" &&
    "scheduled" in options &&
    options.scheduled === true;
  if (event.ports[0]) window.postMessage({ type: "pibot:port", scheduled }, "*", [event.ports[0]]);
});
ipcRenderer.on(BROWSER_FRAME_CHANNEL, (event, value: unknown) => {
  const botId =
    value && typeof value === "object" && "botId" in value ? IdSchema.safeParse(value.botId) : null;
  if (botId?.success && event.ports[0]) {
    const groupId = IdSchema.optional().safeParse((value as { groupId?: unknown }).groupId);
    if (!groupId.success) return;
    window.postMessage(
      {
        type: BROWSER_FRAME_CHANNEL,
        botId: botId.data,
        ...(groupId.data ? { groupId: groupId.data } : {}),
      },
      "*",
      [event.ports[0]],
    );
  }
});
ipcRenderer.on("pibot:status", (_event, envelope: unknown) => {
  window.postMessage({ type: "pibot:status", envelope }, "*");
});
ipcRenderer.on(DESKTOP_UPDATES_STATE_CHANNEL, (_event, value: unknown) => {
  const state = DesktopUpdateStateSchema.safeParse(value);
  if (state.success) window.postMessage({ type: "pibot:updates-state", state: state.data }, "*");
});
