import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator, resolveLanguage } from "@pibot/i18n";
import type { Logger } from "@pibot/observability";
import {
  BackgroundStateSchema,
  type BackgroundWire,
  IndependentBackgroundMethods,
  IndependentBackgroundStateSchema,
  PROVIDER_IMPORT_RESOLVE,
  ProviderImportDecisionSchema,
  ProviderImportResultSchema,
  RpcError,
  RpcErrorCodes,
  SettingsSchema,
} from "@pibot/protocol";
import { app, dialog, ipcMain, nativeTheme } from "electron";
import { z } from "zod";
import { STARTUP_PROGRESS_CHANNEL } from "../../shared/startup-progress.ts";
import { connectBackground } from "../background/background-connection.ts";
import {
  GUI_LAUNCH_FLAG,
  type LaunchProgress,
  launchBackground,
  pause,
} from "../background/background-launch.ts";
import type { prelaunchBackground } from "../background/background-prelaunch.ts";
import { BackgroundStopError, drainBackgroundOwner } from "../background/background-stop.ts";
import { createStartupWake } from "../background/startup-wake.ts";
import { createWindowsBackgroundSecurity } from "../background/windows-background-security.ts";
import { createWindowFramePorts } from "../browser-frames/browser-frames-window.ts";
import { decodeFrameWire } from "../browser-frames/browser-frames-wire.ts";
import { startAppUpdates } from "../updates/update-bridge.ts";
import { installAppMenu } from "../window/app-menu.ts";
import { registerAppRestart } from "../window/app-restart.ts";
import { isAppUrl, parseAppUrl } from "../window/app-url.ts";
import type { ProviderLinkInbox } from "../window/provider-link-inbox.ts";
import { readSystemLocale } from "../window/system-locale.ts";
import { notifyBackground } from "../window/tray.ts";
import { createEarlyWindow, type EarlyWindow } from "./early-window.ts";
import { exportLogs } from "./export-logs.ts";
import { createGuiBusiness } from "./gui-business.ts";
import { createGuiHost } from "./gui-host.ts";

export async function startGuiClient(options: {
  dataDir: string;
  outputDir: string;
  dev: boolean;
  version: string;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
  logger: Logger;
  prelaunch?: ReturnType<typeof prelaunchBackground>;
  /** The window process-entry created before importing this module. */
  early?: EarlyWindow;
  systemLocale?: Promise<string>;
  providerLinks?: ProviderLinkInbox;
}) {
  const controller = new AbortController();
  const startup: { signal: AbortSignal; onQuit?: (event: Electron.Event) => void } = {
    signal: controller.signal,
  };
  const beforeQuit = (event: Electron.Event) => {
    if (startup.onQuit) {
      startup.onQuit(event);
      return;
    }
    event.preventDefault();
    controller.abort();
  };
  const keepGuiAlive = () => {
    // Closing the last window must not start a second quit while the owner is being drained.
  };
  const removeQuitListener = () => {
    app.off("before-quit", beforeQuit);
    app.off("window-all-closed", keepGuiAlive);
    app.off("will-quit", removeQuitListener);
  };
  app.on("before-quit", beforeQuit);
  app.on("window-all-closed", keepGuiAlive);
  app.once("will-quit", removeQuitListener);
  try {
    return await runGuiClient(options, startup);
  } catch (error) {
    removeQuitListener();
    if (!startup.signal.aborted) throw error;
    // An interrupted startup must not reopen a window through the startup error dialog.
    options.prelaunch?.dispose();
    app.quit();
  }
}

async function runGuiClient(
  options: Parameters<typeof startGuiClient>[0],
  startup: { signal: AbortSignal; onQuit?: (event: Electron.Event) => void },
) {
  const windows =
    options.prelaunch?.windows ??
    (process.platform === "win32"
      ? createWindowsBackgroundSecurity({
          systemRoot: options.originalEnv.SystemRoot ?? options.originalEnv.SYSTEMROOT,
          executable: process.execPath,
          logger: options.logger,
        })
      : undefined);
  // Started by process-entry next to the early window; on Windows it is a PowerShell call and no
  // longer holds the window back.
  const earlyWindow =
    options.early ??
    createEarlyWindow({
      dataDir: options.dataDir,
      outputDir: options.outputDir,
      dev: options.dev,
      rendererUrl: options.originalEnv.ELECTRON_RENDERER_URL,
      logger: options.logger,
    });
  const window = earlyWindow.window;
  const saved = earlyWindow.saved;
  const documentLoad = earlyWindow.documentLoad;
  let systemLocale: string;
  try {
    systemLocale = await (options.systemLocale ??
      readSystemLocale({
        platform: process.platform,
        fallback: app.getLocale(),
        systemRoot: options.originalEnv.SystemRoot ?? options.originalEnv.SYSTEMROOT,
        logger: options.logger,
        powershell: windows?.powershell,
        signal: startup.signal,
      }));
    startup.signal.throwIfAborted();
  } catch (error) {
    window.destroy();
    throw error;
  }
  // Startup timing: where the "Starting the background service" wait goes, logged once attached.
  const timing = {
    started: performance.now(),
    connected: 0,
    spawned: false,
    respawns: 0,
    upgradeDrained: false,
    upgradeDrainStartedMs: null as number | null,
    connectRetries: 0,
    // A previous owner still stopping when this GUI started: when seen and when it exited.
    retiringOwnerMs: null as number | null,
    retiringOwnerWaitStartedMs: null as number | null,
    retiringOwnerExitedMs: null as number | null,
    relaunches: 0,
    statePolls: 0,
    // Times the attach window was re-armed because the owner's brain reported progress.
    progressExtensions: 0,
    launchPhases: {} as Partial<
      Record<LaunchProgress | "attach_requested" | "attach_received", number>
    >,
    // First time (ms since GUI startup) each owner lifecycle value was seen.
    lifecycles: {} as Record<string, number>,
  };
  const startupLine = (event: string) =>
    JSON.stringify({
      module: "startup",
      event,
      connectMs: timing.connected ? Math.round(timing.connected - timing.started) : null,
      totalMs: Math.round(performance.now() - timing.started),
      sinceProcessMs: Math.round(performance.now()),
      spawnedOwner: timing.spawned,
      respawns: timing.respawns,
      upgradeDrained: timing.upgradeDrained,
      upgradeDrainStartedMs: timing.upgradeDrainStartedMs,
      retiringOwnerMs: timing.retiringOwnerMs,
      retiringOwnerWaitStartedMs: timing.retiringOwnerWaitStartedMs,
      retiringOwnerExitedMs: timing.retiringOwnerExitedMs,
      relaunches: timing.relaunches,
      connectRetries: timing.connectRetries,
      statePolls: timing.statePolls,
      progressExtensions: timing.progressExtensions,
      lifecycles: timing.lifecycles,
      launchPhases: timing.launchPhases,
    });
  let quitting = false,
    finished = false,
    draining = false,
    explicitStop = false,
    // A relaunch (Dock, `open`, second instance) that arrived while this GUI was still exiting.
    relaunchAfterExit = false;
  let disconnected = false;
  let initialized = false;
  let startupFailure: "database_newer_than_app" | undefined;
  let repairing: Promise<void> | undefined;
  let repairController: AbortController | undefined;
  let pendingFocus: string | undefined;
  const sendFocus = async (signal?: AbortSignal) => {
    const at = pendingFocus;
    if (!at) return;
    await connection.control({ type: "focus", at }, signal);
    if (pendingFocus === at) pendingFocus = undefined;
  };
  let language = resolveLanguage("system", systemLocale);
  let business: ReturnType<typeof createGuiBusiness> | undefined;
  let status: "starting" | "ready" | "restarting" | "failed" | "stopped" = "starting";
  const guiListeners = new Set<(message: unknown) => void>();
  // The bounds, close hint and login cache keep using the early window's saved state.
  const adoptWindow = () =>
    earlyWindow.adopt({
      isQuitting: () => quitting,
      onClose: () => {
        if (!saved.state.closeToTrayHintShown && notifyBackground(language)) {
          saved.state.closeToTrayHintShown = true;
          saved.save();
        }
      },
    });
  const hideForStartupQuit = () => {
    quitting = true;
    if (!window.isDestroyed()) window.hide();
  };
  startup.signal.addEventListener("abort", hideForStartupQuit, { once: true });
  window.once("closed", () => startup.signal.removeEventListener("abort", hideForStartupQuit));
  const updates = startAppUpdates({
    window,
    logger: options.logger,
    appImage: options.originalEnv.APPIMAGE,
    shutdown: shutdownForUpdate,
  });
  let rendererWaiting = false;
  let firstScreen = false;
  const ready = (event: Electron.IpcMainEvent) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      quitting
    )
      return;
    rendererWaiting = true;
    business?.ready();
    if (!firstScreen) {
      firstScreen = true;
      options.logger.info(startupLine("gui_renderer_connected"));
    }
  };
  ipcMain.on("pibot:renderer-ready", ready);
  window.once("closed", () => ipcMain.off("pibot:renderer-ready", ready));
  window.webContents.on("did-navigate", () => {
    rendererWaiting = false;
    business?.reloading();
  });
  // Bot browser overlay frames relayed from the owner; acks go back the same way.
  const frames = createWindowFramePorts(window);
  frames.onAck((botId, seq, groupId) => {
    try {
      connection.send({ kind: "browser-frame-ack", botId, seq, ...(groupId ? { groupId } : {}) });
    } catch {
      // Disconnected: the owner stops streams nobody acknowledges.
    }
  });
  const open = () => {
    // While quitting the window stays hidden: it would only show the stopped page.
    if (window.isDestroyed() || quitting) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (initialized && disconnected && !quitting)
      void repair().catch(() => options.logger.warn("GUI reconnect unavailable"));
  };
  const menuNavigation = (
    target: Parameters<typeof installAppMenu>[1] extends (target: infer T) => void ? T : never,
  ) => {
    // A menu callback can outlive its template; never touch the connection before attach.
    if (!initialized || quitting) return;
    open();
    void connection
      .control({ type: "navigate", target })
      .catch(() => options.logger.warn("GUI menu navigation unavailable"));
  };
  installAppMenu(language, menuNavigation, options.dev, initialized);
  // Every handler the document may call before attach now exists (the old load point).
  adoptWindow();
  const ownerWake = createStartupWake();
  const receive = (message: BackgroundWire) => {
    switch (message.kind) {
      case "gui":
        for (const listener of guiListeners) listener(message.message);
        break;
      case "business":
        business?.receive(message.message);
        break;
      case "browser-frame": {
        const frame = decodeFrameWire(message.message);
        if (frame) frames.send(frame);
        break;
      }
      case "settings": {
        const parsed = SettingsSchema.safeParse(message.settings);
        if (!parsed.success) return;
        nativeTheme.themeSource = parsed.data.theme;
        language = resolveLanguage(parsed.data.language, systemLocale);
        installAppMenu(language, menuNavigation, options.dev, initialized);
        saved.state.closeToTrayHintShown ||= parsed.data.closeToTrayHintShown;
        saved.state.openAtLogin = parsed.data.openAtLogin;
        saved.save();
        break;
      }
      case "status": {
        ownerWake.notify();
        const parsed = z
          .strictObject({
            state: z.enum(["starting", "ready", "restarting", "failed", "stopped"]),
            reason: z.literal("database_newer_than_app").optional(),
          })
          .safeParse(message.state);
        if (parsed.success) {
          status = parsed.data.state;
          if (initialized && !quitting && parsed.data.reason && !startupFailure)
            dialog.showErrorBox(app.getName(), createTranslator(language)("startup.newerData"));
          startupFailure = parsed.data.reason ?? startupFailure;
          business?.statusChanged();
        }
        break;
      }
      case "open":
        open();
        if (business?.available())
          void connection
            .control({ type: "ui-ready" })
            .catch(() => options.logger.warn("GUI navigation unavailable"));
        break;
      case "quit":
        // Before attach this GUI is a relaunch: a quit broadcast by an owner that is already
        // stopping must not close it; the startup loop waits for that owner to exit instead.
        if (!initialized) {
          ownerWake.notify();
          break;
        }
        explicitStop ||= message.stop === true;
        app.quit();
        break;
    }
  };
  const sinceStart = () => Math.round(performance.now() - timing.started);
  type Connection = Awaited<ReturnType<typeof launchBackground>>;
  let early = options.prelaunch;
  let connection: Connection;
  const launch = async (retiringPid?: number) => {
    // A launch's callbacks act only while its connection is the current one: a connection the
    // startup loop drops must not mark the GUI disconnected or deliver its messages.
    let owned: Connection | undefined;
    const prepared = early;
    early = undefined;
    const launchOptions: Parameters<typeof launchBackground>[0] = {
      ...options,
      windows,
      env: options.originalEnv,
      signal: startup.signal,
      retiringPid,
      owner: {
        file: process.execPath,
        args: [
          ...(options.dev ? [app.getAppPath()] : []),
          "--pibot-background",
          // Keyring gating waits out a forming login session only for login-item launches.
          GUI_LAUNCH_FLAG,
          // The owner holds the keys; a user's explicit Linux credential store must reach it too.
          ...process.argv.filter((arg) => arg.startsWith("--password-store=")),
        ],
      },
      progress: (event, at = performance.now()) => {
        const processMs = Math.round(at);
        timing.launchPhases[event] ??= processMs;
        const guiMs = Math.max(0, Math.round(at - timing.started));
        if (event === "spawned") timing.spawned = true;
        else if (event === "respawned") timing.respawns++;
        else if (event === "upgrade_drained") timing.upgradeDrained = true;
        else if (event === "upgrade_drain_started") timing.upgradeDrainStartedMs ??= guiMs;
        else if (event === "retiring_owner_wait_started")
          timing.retiringOwnerWaitStartedMs ??= guiMs;
        else if (event === "retiring_owner") timing.retiringOwnerMs ??= guiMs;
        else if (event === "retiring_owner_exited") timing.retiringOwnerExitedMs = guiMs;
        else if (event === "retry") timing.connectRetries++;
      },
      receive: (message) => {
        if (owned && owned === connection) receive(message);
      },
      closed: () => {
        if (!owned || owned !== connection) return;
        // The background logs its side; without this line a GUI-side drop left no trace at all.
        if (initialized && !quitting)
          options.logger.warn(
            JSON.stringify({ module: "gui", event: "background_connection_lost" }),
          );
        disconnected = true;
        ownerWake.notify();
        status = "stopped";
        frames.reset();
        business?.disconnected();
        business?.statusChanged();
        if (initialized && !quitting)
          void repair().catch(() => options.logger.warn("GUI reconnect unavailable"));
        if (explicitStop && !draining) {
          app.quit();
        }
      },
    };
    if (prepared) {
      try {
        owned = await prepared.take(launchOptions);
      } catch (error) {
        // An owner can retire while app ready is pending; re-enter its original exit/launch loop.
        if (!(error instanceof Error) || error.message !== "background_prelaunch_disconnected")
          throw error;
        startup.signal.throwIfAborted();
        owned = await launchBackground(launchOptions);
      }
    } else owned = await launchBackground(launchOptions);
    return owned;
  };
  try {
    connection = await launch();
  } catch (error) {
    frames.dispose();
    updates.dispose();
    window.destroy();
    throw error;
  }
  timing.connected = performance.now();
  function repair(signal?: AbortSignal) {
    if (repairing) return repairing;
    repairController = new AbortController();
    const controller = repairController;
    // A fixed 15 s gave up while the owner was still busy (a long import kept
    // the control lane occupied), and the window stayed dead. Retry with backoff until the
    // owner answers or the app quits; the caller's signal still bounds a single attempt.
    const deadline = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    repairing = (async () => {
      let candidate: Awaited<ReturnType<typeof connectBackground>> | undefined;
      let accepted = false;
      let backoff = 100;
      for (;;) {
        try {
          candidate = await connectBackground(
            options.dataDir,
            options.version,
            receive,
            () => {
              if (accepted && candidate === connection) {
                disconnected = true;
                status = "stopped";
                frames.reset();
                business?.disconnected();
                business?.statusChanged();
                if (!quitting)
                  void repair().catch(() => options.logger.warn("GUI reconnect unavailable"));
              }
            },
            deadline,
            windows,
          );
          break;
        } catch (error) {
          if (quitting || deadline.aborted) throw error;
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
          await pause(backoff, deadline);
          backoff = Math.min(backoff * 2, 2_000);
        }
      }
      try {
        connection = candidate;
        await candidate.control({ type: "attach" }, deadline);
        accepted = true;
        disconnected = false;
        status = "ready";
        await sendFocus(deadline);
        if (!quitting) business?.statusChanged();
      } catch (error) {
        candidate.close();
        throw error;
      }
    })().finally(() => {
      if (repairController === controller) repairController = undefined;
      repairing = undefined;
    });
    return repairing;
  }
  const gui = createGuiHost(
    window,
    {
      post: (message) => connection.send({ kind: "gui", message }),
      onMessage: (listener) => {
        guiListeners.add(listener);
        return () => guiListeners.delete(listener);
      },
    },
    updates.setProxy,
  );
  let attached = false;
  let lifecycle: string | undefined;
  let attachStarted = performance.now();
  // Absolute ceiling, so a child that keeps reporting progress but never becomes ready still
  // fails instead of leaving the window waiting forever.
  const attachCeiling = attachStarted + 600_000;
  let lastStartupProgressAt: string | undefined;
  // The first frame shows the current startup step while the window attaches.
  let sentStartupEvent: string | undefined;
  try {
    while (!quitting) {
      if (startupFailure) throw new Error(startupFailure);
      // An owner that keeps reporting "starting" is making progress (its own launch deadline is
      // 90 s, background-brain-cycle.ts); a fixed 30 s turned a slow start into a failed one.
      const budget = lifecycle === "starting" ? 95_000 : 30_000;
      // Whole milliseconds: AbortSignal.timeout rejects fractions with ERR_OUT_OF_RANGE.
      const remaining = Math.ceil(attachStarted + budget - performance.now());
      if (remaining <= 0) break;
      if (
        (disconnected || lifecycle === "stopping" || lifecycle === "stopped") &&
        timing.relaunches < 3
      ) {
        // The owner began stopping or went away before this GUI attached. It can never become
        // ready again; launch waits for its actual exit and starts the next owner.
        timing.relaunches++;
        const retiringPid =
          lifecycle === "stopping" || lifecycle === "stopped"
            ? connection.descriptor.pid
            : undefined;
        connection.close();
        connection = await launch(retiringPid);
        disconnected = false;
        lifecycle = undefined;
        attachStarted = performance.now();
        continue;
      }
      // Stop polling on quit, but let an already dispatched attach settle before detach.
      const signal = AbortSignal.timeout(remaining);
      const pollSignal = AbortSignal.any([signal, startup.signal]);
      try {
        timing.statePolls++;
        const state = IndependentBackgroundStateSchema.parse(
          await connection.control({ type: "state" }, pollSignal),
        );
        if (quitting) break;
        if (state.startupFailure) throw new Error(state.startupFailure);
        const startupEvent = { lifecycle: state.lifecycle, phase: state.startupPhase ?? null };
        const startupKey = `${startupEvent.lifecycle}:${startupEvent.phase ?? ""}`;
        if (startupKey !== sentStartupEvent) {
          sentStartupEvent = startupKey;
          if (!window.isDestroyed())
            window.webContents.send(STARTUP_PROGRESS_CHANNEL, startupEvent);
        }
        if (state.startupProgressAt && state.startupProgressAt !== lastStartupProgressAt) {
          lastStartupProgressAt = state.startupProgressAt;
          // The owner's brain is still starting and advancing. A fixed window failed
          // the attach while a slow session-tail recovery was still making progress.
          if (performance.now() < attachCeiling) {
            timing.progressExtensions++;
            attachStarted = performance.now();
          }
        }
        lifecycle = state.lifecycle;
        timing.lifecycles[state.lifecycle] ??= sinceStart();
        if (state.lifecycle === "ready") {
          timing.launchPhases.attach_requested ??= Math.round(performance.now());
          await connection.control({ type: "attach" }, signal);
          timing.launchPhases.attach_received = Math.round(performance.now());
          attached = true;
          status = "ready";
          break;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "database_newer_than_app") throw error;
        /* A launch receipt precedes brain readiness; retry is bounded. */
      }
      if (
        timing.relaunches < 3 &&
        (disconnected || lifecycle === "stopping" || lifecycle === "stopped")
      )
        continue;
      await ownerWake.wait(1000, pollSignal).catch(() => {
        // The attach deadline reports the failure; an event only accelerates the next state read.
      });
    }
    if (!attached && !quitting) {
      options.logger.warn(startupLine("gui_attach_timeout"));
      throw new Error("background_not_ready");
    }
  } catch (error) {
    if (!quitting) throw error;
    // A retry may fail after quit closed the startup loop. Drain the last known owner below.
    options.logger.warn("GUI attach interrupted before exit");
  } finally {
    if (!attached && !quitting) {
      gui.dispose();
      connection.close();
      frames.dispose();
      updates.dispose();
      window.destroy();
    }
  }
  startup.onQuit = (event) => {
    if (finished) return;
    event.preventDefault();
    requestExit();
  };
  if (startup.signal.aborted) {
    requestExit();
    return { open };
  }
  initialized = true;
  installAppMenu(language, menuNavigation, options.dev, initialized);
  options.logger.info(startupLine("gui_attached"));
  business = createGuiBusiness({
    window,
    send: (message) => connection.send(message),
    status: () => status,
    ready: () => {
      void connection
        .control({ type: "ui-ready" })
        .catch(() => options.logger.warn("GUI navigation unavailable"));
    },
    failed: () => options.logger.warn("GUI business channel unavailable"),
  });
  if (rendererWaiting) business.ready();
  const focused = () => {
    if (!quitting) {
      pendingFocus = new Date().toISOString();
      void sendFocus().catch(() => options.logger.warn("GUI focus delivery unavailable"));
    }
  };
  window.on("focus", focused);
  window.on("blur", () => {
    if (!quitting)
      void connection
        .control({ type: "blur" })
        .catch(() => options.logger.warn("GUI blur delivery unavailable"));
  });
  // A window focused before attach fired its "focus" too early; the owner (live island, "is the
  // user here") would otherwise think it is in the background until the next focus change.
  if (!window.isDestroyed() && window.isFocused()) focused();
  let active = 0;
  const request = z.strictObject({ method: z.string(), params: z.unknown().optional() });
  ipcMain.handle("pibot:background", async (event, value: unknown) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      active >= 16
    )
      return { ok: false, code: -32001, message: "background_unavailable" };
    active++;
    try {
      const { method, params } = request.parse(value);
      if (method === PROVIDER_IMPORT_RESOLVE) {
        const decision = ProviderImportDecisionSchema.parse(params);
        if (decision.botIds !== null && (!window.isVisible() || !window.isFocused() || quitting))
          return { ok: false, code: RpcErrorCodes.closed, message: "provider_import_unfocused" };
        const result = await connection.control({ type: "provider-import-decide", decision });
        return { ok: true, result: ProviderImportResultSchema.parse(result) };
      }
      if (Object.hasOwn(IndependentBackgroundMethods, method)) {
        const name = method as keyof typeof IndependentBackgroundMethods;
        const schema = IndependentBackgroundMethods[name];
        schema.params.parse(params);
        if (name === "background.stopService") {
          explicitStop = true;
          app.quit();
          return { ok: true, result: { status: "requested" } };
        }
        const result = await connection.control(
          name === "background.serviceState"
            ? { type: "state" }
            : {
                type: "preferences",
                patch: params as { exitBehavior?: "stop" | "continue"; startAtLogin?: boolean },
              },
        );
        return { ok: true, result: schema.result.parse(result) };
      }
      if (method === "background.state") {
        const result = BackgroundStateSchema.parse(
          await connection.control({ type: "brain-state" }),
        );
        return { ok: true, result };
      }
      if (method === "background.restart")
        return { ok: true, result: await connection.control({ type: "restart-brain" }) };
      throw new Error("unsupported_background_method");
    } catch (error) {
      return {
        ok: false,
        code:
          error instanceof RpcError
            ? error.code
            : error instanceof z.ZodError
              ? RpcErrorCodes.invalidParams
              : RpcErrorCodes.internal,
        message: "background_request_failed",
      };
    } finally {
      active--;
    }
  });
  ipcMain.handle("pibot:export-logs", (event) =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
      ? exportLogs(
          window,
          join(options.dataDir, "logs"),
          [
            { name: "host-logs", path: join(options.dataDir, "host-logs") },
            { name: "gui-logs", path: join(options.dataDir, "gui-logs") },
          ],
          (signal) => connection.control({ type: "diagnostics" }, signal),
        )
      : "failed",
  );
  // A relaunch while this GUI still waits for the owner to exit would otherwise be swallowed:
  // the new instance loses the single-instance lock (or macOS reactivates this process).
  // The bundle on disk may have been replaced (an update or a manual install) while this GUI
  // ran. Relaunching then starts the old version again and races the new one; only relaunch
  // when the bundle still is the version this process started.
  function bundleVersion() {
    try {
      const parsed = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
        version?: unknown;
      };
      return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  }
  const reopen = (...argv: string[]) => {
    if (quitting) relaunchAfterExit = true;
    else {
      open();
      const target = argv.map(parseAppUrl).find((value) => value !== undefined);
      if (target)
        void connection
          .control({ type: "navigate", target })
          .catch(() => options.logger.warn("GUI app URL navigation unavailable"));
    }
  };
  app.on("second-instance", (_event, argv) => reopen(...argv));
  app.on("activate", () => reopen());
  // macOS delivers pibot:// links here; Windows / Linux arrive as a second instance.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (!isAppUrl(url)) return;
    open();
    const target = parseAppUrl(url);
    if (target)
      void connection
        .control({ type: "navigate", target })
        .catch(() => options.logger.warn("GUI app URL navigation unavailable"));
    else if (new URL(url).hostname === "import") options.logger.warn("Invalid role import URL");
  });
  const stopProviderLinks = options.providerLinks?.subscribe((intent) => {
    if (quitting) return;
    open();
    void connection
      .control({ type: "provider-import", intent })
      .catch(() => options.logger.warn("Provider import link unavailable"));
  });
  const dismissProviderImport = () => {
    void connection
      .control({ type: "provider-import-dismiss" })
      .catch(() => options.logger.warn("Provider import review cleanup unavailable"));
  };
  window.on("hide", dismissProviderImport);
  window.webContents.on("did-navigate", dismissProviderImport);
  window.once("closed", () => {
    stopProviderLinks?.();
    dismissProviderImport();
  });
  // Closes the GUI before draining the independent owner. Hiding alone can leave a compositor
  // frame visible while ports retire.
  function beginExit() {
    draining = true;
    quitting = true;
    if (!window.isDestroyed()) {
      window.hide();
      window.destroy();
    }
    status = "stopped";
  }
  async function drainOwner(
    signal: AbortSignal,
    phase: NonNullable<Parameters<typeof drainBackgroundOwner>[0]["phase"]>,
  ) {
    await repairing?.catch(() => {});
    return drainBackgroundOwner({
      dataDir: options.dataDir,
      connection,
      explicitStop,
      signal,
      attached,
      phase,
      ...(disconnected && initialized
        ? {
            reconnect: async (deadline: AbortSignal) => {
              await repair(deadline);
              return connection;
            },
          }
        : {}),
    });
  }
  function finishExit() {
    repairController?.abort();
    // Closing also rejects any older repair/control call and releases its timers.
    connection.close();
    gui.dispose();
    frames.dispose();
    business?.dispose();
    ipcMain.off("pibot:renderer-ready", ready);
    ipcMain.removeHandler("pibot:background");
    ipcMain.removeHandler("pibot:export-logs");
    if (!window.isDestroyed()) window.destroy();
    finished = true;
  }
  async function exitWithin(milliseconds: number, failed: string) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), milliseconds);
    repairController?.abort();
    const started = performance.now();
    try {
      const outcome = await drainOwner(deadline.signal, (phase) =>
        options.logger.info(
          JSON.stringify({
            module: "startup",
            event: "gui_owner_stop_phase",
            phase,
            ms: Math.round(performance.now() - started),
          }),
        ),
      );
      if (outcome === "stopped")
        options.logger.info(
          JSON.stringify({
            module: "background",
            event: "owner_stop_confirmed",
            explicit: explicitStop,
            ms: Math.round(performance.now() - started),
          }),
        );
      else if (outcome === "unattached")
        // Exiting before the first attach is a normal startup quit, not a failed
        // shutdown. The owner sees the GUI disconnect and stops itself (`owner_stop gui_exit`).
        options.logger.info(
          JSON.stringify({
            module: "background",
            event: "gui_exited_before_attach",
            explicit: explicitStop,
            ms: Math.round(performance.now() - started),
          }),
        );
    } catch (error) {
      // The GUI may exit without proving owner death. Never release its claim or start a
      // replacement: owner detach intent/PID observation remains responsible for stop.
      options.logger.warn(
        `${failed} (${error instanceof BackgroundStopError ? error.message : "unexpected"})`,
      );
    } finally {
      clearTimeout(timer);
      deadline.abort();
      finishExit();
    }
  }
  registerAppRestart({
    window,
    logger: options.logger,
    restart: () => {
      if (quitting) return;
      explicitStop = true;
      relaunchAfterExit = true;
      app.quit();
    },
  });
  async function shutdownForUpdate() {
    // Updates IPC is available to the renderer before the GUI owns an attached connection.
    if (!initialized || quitting) return false;
    explicitStop = true;
    beginExit();
    // An unconfirmed stop still installs; the next launch retires an outdated owner.
    await exitWithin(
      20_000,
      "Background stop before update unconfirmed; the new version stops the old service",
    );
    return true;
  }
  function requestExit() {
    if (draining) return;
    // A staged update installs on this quit; the service must not keep running the old files.
    explicitStop ||= updates.installPending();
    beginExit();
    void exitWithin(
      10_000,
      explicitStop
        ? "Explicit background stop unconfirmed; GUI exits with owner ownership retained"
        : "GUI exit proceeds; background shutdown unconfirmed, owner ownership retained",
    ).finally(() => {
      // The relaunched GUI waits for this owner's proven exit before starting the next one.
      if (relaunchAfterExit) {
        if (bundleVersion() === options.version) app.relaunch();
        else
          options.logger.info(
            JSON.stringify({ module: "background", event: "relaunch_skipped_bundle_replaced" }),
          );
      }
      app.quit();
    });
  }
  try {
    await documentLoad;
  } catch (error) {
    if (!quitting) throw error;
  }
  return { open };
}
