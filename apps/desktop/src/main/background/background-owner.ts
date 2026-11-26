import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveLanguage } from "@pibot/i18n";
import type { Logger } from "@pibot/observability";
import {
  type BackgroundControlSchema,
  BackgroundPreferencesSchema,
  BackgroundStateSchema,
  GuiHostMethods,
  type IndependentBackgroundState,
  IndependentBackgroundStateSchema,
  RpcError,
  RpcErrorCodes,
  type Settings,
  type UiNavigation,
} from "@pibot/protocol";
import { createRoutineHost, routineOutbox, type TrayState } from "@pibot/routines/host";
import type { Redactor } from "@pibot/secrets";
import { app, nativeTheme, powerMonitor, powerSaveBlocker, safeStorage } from "electron";
import type { z } from "zod";
import { shouldShowOwnerTray } from "../../shared/background-presentation.ts";
import type { startBrainHost } from "../brain/brain-host.ts";
import type { prelaunchBrainProcess } from "../brain/brain-process.ts";
import { createComputerGuard } from "../computer/computer-guard-adapter.ts";
import { createComputerHost } from "../computer/computer-host.ts";
import { createHostCapabilities } from "../host/host-capabilities.ts";
import { createSecureStorage } from "../host/secure-storage.ts";
import { createLiveIsland } from "../island/live-island.ts";
import type { MainStartupTiming } from "../startup-timing.ts";
import { createUpdateProxy } from "../updates/update-proxy.ts";
import { isAppUrl, parseAppUrl } from "../window/app-url.ts";
import { desktopLaunchEnvironment, loginItemSyncEnabled } from "../window/login-item-scope.ts";
import type { ProviderLinkInbox } from "../window/provider-link-inbox.ts";
import { readSystemLocale } from "../window/system-locale.ts";
import { createTray, notifyKeyringRestart, notifyLoginDefault } from "../window/tray.ts";
import { createBackgroundBrainCycle } from "./background-brain-cycle.ts";
import { createBackgroundClientLifetime } from "./background-client-lifetime.ts";
import { reserveDescriptor } from "./background-directory.ts";
import type { EarlyOwnerPreparation } from "./background-early.ts";
import { GUI_LAUNCH_FLAG } from "./background-launch.ts";
import { applyLoginPolicy } from "./background-login-policy.ts";
import { createBackgroundManagement } from "./background-management.ts";
import { createBackgroundOwnerLifecycle } from "./background-owner-lifecycle.ts";
import { applyBackgroundPreferences } from "./background-preferences.ts";
import { createBackgroundServer } from "./background-server.ts";
import { createBackgroundSleepOwner } from "./background-sleep-owner.ts";
import { createKeyringRecovery, createKeyringSessionGate } from "./keyring-recovery.ts";
import { watchKeyringSession } from "./keyring-session.ts";
import { watchMainLoop } from "./main-loop-watch.ts";
import { createProviderImportReview } from "./provider-import-review.ts";
import { createWindowsBackgroundSecurity } from "./windows-background-security.ts";

export async function startBackgroundOwner(options: {
  dataDir: string;
  outputDir: string;
  resourcesDir: string;
  version: string;
  dev: boolean;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
  logger: Logger;
  redactor: Redactor;
  timing?: MainStartupTiming;
  prelaunchedBrain?: ReturnType<typeof prelaunchBrainProcess>;
  /** Claim, Windows security and locale already started beside the role import. */
  early?: EarlyOwnerPreparation;
  providerLinks?: ProviderLinkInbox;
}) {
  const updateProxy = createUpdateProxy();
  if (!app.hasSingleInstanceLock()) throw new Error("background_writer_lock_required");
  const windows =
    options.early?.windows ??
    (process.platform === "win32"
      ? createWindowsBackgroundSecurity({
          systemRoot: options.originalEnv.SystemRoot ?? options.originalEnv.SYSTEMROOT,
          executable: process.execPath,
          logger: options.logger,
        })
      : undefined);
  const systemLocale = await (options.early?.systemLocale ??
    readSystemLocale({
      platform: process.platform,
      fallback: app.getLocale(),
      systemRoot: options.originalEnv.SystemRoot ?? options.originalEnv.SYSTEMROOT,
      logger: options.logger,
      powershell: windows?.powershell,
    }));
  let reservation: Awaited<ReturnType<typeof reserveDescriptor>> | undefined;
  let server: Awaited<ReturnType<typeof createBackgroundServer>> | undefined;
  let routineHost: ReturnType<typeof createRoutineHost> | undefined;
  const requestTimers = new Set<ReturnType<typeof setTimeout>>();
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let awaitingFirstClient = true;
  let removeListeners = () => {};
  let devHooks: { stop(): Promise<void> } | undefined;
  let brain: ReturnType<typeof startBrainHost> | undefined;
  let cycle: ReturnType<typeof createBackgroundBrainCycle> | undefined;
  let capabilities: ReturnType<typeof createHostCapabilities> | undefined;
  let sleepOwner: ReturnType<typeof createBackgroundSleepOwner> | undefined;
  let brainPhase: NonNullable<IndependentBackgroundState["brainPhase"]> = "waking";
  let hostWork = 0;
  const powerInputs = routineOutbox(options.logger);
  let tray: ReturnType<typeof createTray> | undefined;
  let trayState: TrayState | null = null;
  let activeRuns = 0;
  let trayVisible = true;
  let syncTray: (refresh?: boolean) => void = () => {};
  let language = resolveLanguage("system", systemLocale);
  let settings: Settings | undefined;
  let foreground = false;
  let island: ReturnType<typeof createLiveIsland> | undefined;
  // The window whose focus hides the live island. Another client (a second window, the CLI)
  // leaving must not bring the island over a Pi Bot window that is still in front.
  let focusedClient: unknown;
  const islandForeground = (client: unknown, focused: boolean) => {
    if (focused) focusedClient = client;
    else if (focusedClient !== client) return;
    else focusedClient = undefined;
    island?.foreground(focused);
  };
  let pendingNavigation: UiNavigation | undefined;
  let preferences = BackgroundPreferencesSchema.parse({});
  let lifecycle: IndependentBackgroundState["lifecycle"] = "starting";
  let startupFailure: "database_newer_than_app" | undefined;
  // A GUI attach must outlive a slow but advancing brain start. This is the last moment
  // the child reported progress; the GUI re-arms its attach window while it advances.
  let startupProgressAt: string | undefined;
  // The phase the last beat named, so a waiting GUI can show the current step instead of
  // only a deadline. Identifier only; the schema bounds and validates it.
  let startupPhase: string | undefined;
  // The last time a GUI control reached this owner. While a window is starting its
  // attach loop polls `state`; only when those polls stop may the no-client rule stop the owner.
  let guiPolledAt = 0;
  let childReady = false;
  let stopped = false,
    shutdownComplete = false;
  let stopReason:
    | "startup_no_client"
    | "gui_exit"
    | "stop_service"
    | "app_quit"
    | "tray_quit"
    | "keyring_recovery"
    | "owner_request"
    | "startup_failed"
    | undefined;
  let recoveryRestart: number | undefined;
  const recoveryFlag = "--pibot-keyring-recovery=";
  const priorAttempt = process.argv.filter((arg) => arg.startsWith(recoveryFlag));
  const parsedAttempt = Number(priorAttempt[0]?.slice(recoveryFlag.length) ?? "0");
  // Launchd / XDG autostart / Task Scheduler start the owner without the GUI's marker. A recovery
  // relaunch keeps the original arguments but runs inside the session that passed the gate.
  const loginLaunch = !process.argv.includes(GUI_LAUNCH_FLAG) && priorAttempt.length === 0;
  const gate = createKeyringSessionGate({
    platform: process.platform,
    login: loginLaunch,
    idle: () => powerMonitor.getSystemIdleState(1),
  });
  let keyringNotice = false;
  let keyringNotified = false;
  // A GUI window or its in-flight controls belong to a user who is present: never restart under
  // them; they are asked to restart instead if recovery keeps waiting.
  const restartHeld = () =>
    stopped || !storage.restartable() || clients.size > 0 || hostWork > 0 || requestTimers.size > 0;
  const recovery = createKeyringRecovery({
    attempt:
      priorAttempt.length <= 1 && Number.isInteger(parsedAttempt) && parsedAttempt >= 0
        ? parsedAttempt
        : 3,
    log: (event, attempt) =>
      options.logger.warn(
        JSON.stringify({
          module: "host",
          event,
          attempt,
          audit: true,
        }),
      ),
    notice: (needed) => {
      keyringNotice = needed;
      tray?.updateKeyringNotice(needed);
      if (needed && !keyringNotified && !stopped) keyringNotified = notifyKeyringRestart(language);
    },
    restart: async (next, current) => {
      if (!sleepOwner) return "unsupported";
      if (restartHeld()) return "deferred";
      let stopping: Promise<void> | undefined;
      const accepted = await sleepOwner.prepareRestart(() => {
        // Storage may have recovered, or a window attached, while the brain was being asked.
        if (!current() || restartHeld()) return false;
        recoveryRestart = next;
        options.logger.warn(
          JSON.stringify({
            module: "host",
            event: "keyring_restart_committed",
            attempt: next,
            audit: true,
          }),
        );
        stopReason ??= "keyring_recovery";
        stopping = lifetime.stop();
        return true;
      });
      if (stopping) await stopping;
      return accepted ? "committed" : "deferred";
    },
  });
  const storage = createSecureStorage(safeStorage, options.logger, {
    platform: process.platform,
    health: {
      ready: () => !stopped && gate.ready(),
      failed: () => recovery.failed(),
      healthy: () => recovery.healthy(),
    },
  });

  const startedAt = new Date().toISOString();
  const stopMainLoopWatch = watchMainLoop(options.logger);
  const clients = createBackgroundClientLifetime({
    effectiveStop: () => state().effectiveExitBehavior === "stop",
    drain: () => cycle?.desktopClient(false) ?? Promise.resolve(),
    stop: () => stop("gui_exit"),
    failed: () =>
      options.logger.warn("GUI exit/drain unconfirmed; writer retained until actual stop"),
  });

  const loginItemsEnabled = loginItemSyncEnabled({ dev: options.dev, env: options.originalEnv });
  const management = createBackgroundManagement({
    platform: process.platform,
    packaged: app.isPackaged,
    loginItemsEnabled,
    home: homedir(),
    dataDir: options.dataDir,
    executable: process.execPath,
    systemRoot: options.originalEnv.SystemRoot ?? options.originalEnv.SYSTEMROOT,
    configHome: options.originalEnv.XDG_CONFIG_HOME,
  });
  let managementState: Awaited<ReturnType<typeof management.query>> = {
    kind:
      process.platform === "darwin"
        ? "launchd"
        : process.platform === "win32"
          ? "task-scheduler"
          : process.platform === "linux"
            ? "xdg-autostart"
            : "systemd-user",
    available: false,
    registered: null,
    enabled: null,
    reason: "query_failed",
  };
  let managementRefresh: Promise<void> | undefined;
  // One OS query at a time; concurrent state polls share it.
  const refreshManagement = () => {
    managementRefresh ??= management
      .query()
      .then(
        (value) => {
          managementState = value;
        },
        // Each platform query already maps failures to a reason; keep the last value otherwise.
        () => {},
      )
      .finally(() => {
        managementRefresh = undefined;
      });
    return managementRefresh;
  };
  let transitions = Promise.resolve();
  let managementWork: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>) => {
    const pending = transitions.then(action);
    transitions = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  const startupGraceMs = process.argv.includes(GUI_LAUNCH_FLAG) ? 180_000 : 30_000;
  // Readiness no longer starts a fixed 30 s countdown. A GUI that was launched with this
  // owner is still busy connecting (module import, ACL reserve) long after the brain reports ready
  // on a loaded machine; stopping then made the GUI connect to a dead owner. Each state poll from
  // that GUI re-arms the grace, so only a GUI that gave up (polls stopped) triggers
  // `startup_no_client`, as before.
  function armStartupStop() {
    clearTimeout(startupTimer);
    startupTimer = undefined;
    if (stopped || !childReady || !awaitingFirstClient || clients.size) return;
    // Started by the sign-in item, this owner is the warm service a later window attaches
    // to; it waits for that first window instead of giving up after the grace. Once a window has
    // attached and quit, the normal exit behaviour applies.
    if (loginLaunch && preferences.startAtLogin) return;
    const timer = setTimeout(() => {
      void serial(async () => {
        if (
          stopped ||
          startupTimer !== timer ||
          !childReady ||
          !awaitingFirstClient ||
          clients.size ||
          state().effectiveExitBehavior !== "stop"
        )
          return;
        if (Date.now() - guiPolledAt < startupGraceMs) {
          armStartupStop();
          return;
        }
        await stop("startup_no_client");
      }).catch(() => {});
    }, startupGraceMs);
    startupTimer = timer;
  }
  const state = () =>
    IndependentBackgroundStateSchema.parse({
      lifecycle,
      brainPhase,
      ...(startupFailure ? { startupFailure } : {}),
      ...(startupProgressAt ? { startupProgressAt } : {}),
      ...(startupPhase ? { startupPhase } : {}),
      backgroundTrayAvailable: process.platform === "darwin" || process.platform === "win32",
      instance: reservation?.descriptor.instance,
      version: options.version,
      startedAt,
      preferences,
      effectiveExitBehavior:
        process.platform === "darwin" || process.platform === "win32"
          ? preferences.exitBehavior
          : "stop",
      clients: clients.size,
      management: managementState,
    });
  const open = () => {
    if (stopped) return;
    if (sleepOwner)
      void sleepOwner.wake("gui").catch(() => options.logger.warn("GUI wake unavailable"));
    if (clients.size) {
      server?.broadcast({ kind: "open" });
      return;
    }
    const child = spawn(process.execPath, options.dev ? [app.getAppPath()] : [], {
      detached: true,
      stdio: "ignore",
      env: desktopLaunchEnvironment(
        { dev: options.dev, env: options.originalEnv },
        options.dataDir,
      ),
    });
    child.on("error", () => options.logger.warn("GUI launch unavailable"));
    child.unref();
  };
  // Sign-in default / repair, once per owner after the brain and its settings are ready.
  let loginPolicyStarted = false;
  const runLoginPolicy = () => {
    const current = brain;
    if (loginPolicyStarted || stopped || !childReady || !current || !settings) return;
    loginPolicyStarted = true;
    const onboardingCompleted = settings.onboardingCompleted;
    // Not in the control lane: a window's attach right after ready must not queue behind OS
    // service-manager calls. Preference changes wait for it through managementWork instead.
    const previous = managementWork;
    const pending = (async () => {
      await previous;
      if (stopped || brain !== current) return;
      const result = await applyLoginPolicy({
        platform: process.platform,
        preferences,
        onboardingCompleted,
        management,
        write: (value) => current.preferences(value),
      });
      if (stopped) return;
      preferences = result.preferences;
      managementState = result.management;
      syncTray();
      if (result.defaulted) {
        options.logger.info("audit background start-at-login default applied");
        notifyLoginDefault(language);
      }
    })();
    managementWork = pending.then(
      () => {},
      () => {},
    );
    void pending.catch(() => options.logger.warn("Background sign-in setup unavailable"));
  };
  let quiesce = false;
  let loginKept = false;
  const quiesceLogin = async () => {
    // Only an explicit service stop (settings, upgrade drain) withdraws the sign-in item; an
    // ordinary quit, sign-out or window exit keeps it, or the next sign-in would not start the
    // service. A later owner re-registers a withdrawn item when the preference is still on.
    if (stopReason !== "stop_service") {
      quiesce = false;
      return;
    }
    await managementWork;
    managementState = await management.query();
    quiesce =
      loginItemsEnabled &&
      process.platform === "darwin" &&
      !!(preferences.startAtLogin || managementState.registered);
    if (quiesce) await management.disableLogin(AbortSignal.timeout(10_000));
  };
  // Startup timing: a relaunch waits for this process to exit, so each stop phase is timed (ms since
  // the stop request); the phase after "released" is only launchd cleanup and Electron's quit.
  let stopRequestedAt = 0;
  const stopPhases: Record<string, number> = {};
  const stopPhase = (name: string) => {
    const ms = Math.round(performance.now() - stopRequestedAt);
    stopPhases[name] = ms;
    options.logger.info(
      JSON.stringify({ module: "startup", event: "owner_stop_phase", phase: name, ms }),
    );
  };
  const lifetime = createBackgroundOwnerLifecycle({
    disposeTimedOut: (index) =>
      options.logger.warn(
        JSON.stringify({ module: "startup", event: "owner_dispose_timeout", resource: index }),
      ),
    requested: (failure) => {
      recovery.dispose();
      updateProxy.dispose();
      stopRequestedAt = performance.now();
      stopReason ??= "startup_failed";
      // Only an identifier-shaped message is logged: other errors may carry paths or input.
      const message = failure instanceof Error ? failure.message : "";
      options.logger[failure === undefined ? "info" : "error"](
        JSON.stringify({
          module: "startup",
          event: "owner_stop_requested",
          reason: stopReason,
          ...(failure === undefined
            ? {}
            : { failure: /^[a-z0-9_]{1,80}$/.test(message) ? message : "unexpected" }),
        }),
      );
      stopped = true;
      lifecycle = "stopping";
      tray?.updateBackground({ lifecycle, brainPhase });
      clearTimeout(startupTimer);
      for (const timer of requestTimers) clearTimeout(timer);
      requestTimers.clear();
      stopMainLoopWatch();
      clients.dispose();
      sleepOwner?.requestStop();
      server?.broadcast({ kind: "quit", stop: true });
    },
    prepareStop: async () => {
      if (!reservation) return;
      stopPhase("acp_disconnect_started");
      await server?.disconnectAcp();
      stopPhase("acp_disconnected");
      // A recovery relaunch keeps the login registration. A quit that arrives while that stop is
      // under way withdraws the relaunch, and finish then quiesces login like any other quit.
      if (recoveryRestart !== undefined) loginKept = true;
      else await quiesceLogin();
      stopPhase("prepared");
    },
    stopWriter: async () => {
      stopPhase("writer_retire_started");
      if (sleepOwner) await sleepOwner.stop();
      else await cycle?.retire();
      stopPhase("writer_stopped");
    },
    release: async () => {
      stopPhase("resources_disposed");
      await reservation?.release();
      stopPhase("released");
    },
    finish: async () => {
      if (loginKept && recoveryRestart === undefined) {
        await quiesceLogin();
        loginKept = false;
      }
      if (quiesce) {
        stopPhase("login_unregister_started");
        await management.unregister(AbortSignal.timeout(10_000));
      }
      stopPhase("finished");
      options.logger.info(
        JSON.stringify({
          module: "startup",
          event: "owner_stop",
          reason: stopReason,
          quiesce,
          phases: stopPhases,
        }),
      );
      lifecycle = "stopped";
      shutdownComplete = true;
      removeListeners();
      if (recoveryRestart !== undefined) {
        app.relaunch({
          args: [
            ...process.argv.slice(1).filter((arg) => !arg.startsWith(recoveryFlag)),
            `${recoveryFlag}${recoveryRestart}`,
          ],
        });
      }
      app.quit();
    },
    failed: () => {
      lifecycle = "failed";
      tray?.updateBackground({ lifecycle, brainPhase });
      options.logger.error("Background shutdown failed; writer ownership retained; stop may retry");
    },
  });
  function stop(reason: NonNullable<typeof stopReason> = "owner_request") {
    stopReason ??= reason;
    recoveryRestart = undefined;
    return lifetime.stop();
  }
  const beforeQuit = (event: Electron.Event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void stop("app_quit").catch(() => {});
  };
  app.on("before-quit", beforeQuit);
  const windowsClosed = () => {
    /* Only isolated file converters may have windows here. */
  };
  app.on("window-all-closed", windowsClosed);
  // With no window open, macOS may hand a pibot:// link to this process instead of the GUI.
  const openUrl = (event: Electron.Event, url: string) => {
    event.preventDefault();
    if (!isAppUrl(url)) return;
    const target = parseAppUrl(url);
    if (target) navigate(target);
    else if (new URL(url).hostname === "import") options.logger.warn("Invalid role import URL");
    open();
  };
  app.on("open-url", openUrl);
  // A background running alone has no window, so LaunchServices / a second instance only
  // activates this process. Without these, a plain `open` never brings up the GUI and the
  // app looks dead until someone kills the background.
  const activate = () => open();
  // A sign-in item that starts while this owner runs (or a registration that loads it) is a
  // second background launch, not a request for the window.
  const secondInstance = (_event: Electron.Event, argv: string[]) => {
    if (argv.includes("--pibot-background")) return;
    const target = argv.map(parseAppUrl).find((value) => value !== undefined);
    if (target) navigate(target);
    open();
  };
  app.on("activate", activate);
  app.on("second-instance", secondInstance);
  removeListeners = () => {
    removeListeners = () => {};
    app.off("before-quit", beforeQuit);
    app.off("window-all-closed", windowsClosed);
    app.off("open-url", openUrl);
    app.off("activate", activate);
    app.off("second-instance", secondInstance);
  };
  const navigate = (target: UiNavigation) => {
    pendingNavigation = target;
    open();
  };
  async function ensureWorking(reason: "gui" | "host") {
    if (stopped) throw new RpcError(RpcErrorCodes.closed, "background_stopping");
    if (startupFailure) throw new RpcError(RpcErrorCodes.closed, startupFailure);
    if (sleepOwner) await sleepOwner.wake(reason);
    if (stopped || !childReady || !brain)
      throw new RpcError(RpcErrorCodes.closed, "background_not_ready");
  }
  const providerImport = createProviderImportReview(open, options.logger);
  await lifetime.initialize(async () => {
    lifetime.own(() => providerImport.dispose());
    lifetime.own(
      options.providerLinks?.subscribe((intent) => providerImport.offer(intent)) ?? (() => {}),
    );
    lifetime.own(() => storage.dispose());
    lifetime.own(() => recovery.dispose());
    lifetime.own(
      watchKeyringSession({
        platform: process.platform,
        monitor: powerMonitor,
        gate,
        probe: () => storage.isAsyncEncryptionAvailable(),
        signal: lifetime.signal,
        log: (reason) =>
          options.logger.info(
            JSON.stringify({ module: "host", event: "keyring_resume_probe", reason }),
          ),
      }),
    );
    const ownedReservation = await (options.early?.reservation ??
      reserveDescriptor(options.dataDir, options.version, true, windows, lifetime.signal));
    reservation = ownedReservation;
    lifetime.active();
    options.timing?.mark("reserve_descriptor");
    const ownedServer = await createBackgroundServer({
      descriptor: reservation.descriptor,
      loopback: reservation.loopback,
      failed: () => options.logger.error("Background client drain failed"),
      log: (reason) => options.logger.warn(`Background socket dropped: ${reason}`),
      requestTimedOut: (method) =>
        options.logger.warn(
          JSON.stringify({ module: "background", event: "request_timeout", method }),
        ),
      disconnected: async (client, pid) => {
        providerImport.dismiss(client);
        foreground = false;
        islandForeground(client, false);
        await clients.disconnected(client, pid);
        syncTray();
      },
      control: (client, control: z.infer<typeof BackgroundControlSchema>) => {
        if (control.type === "restart-brain") {
          const wasStandby = sleepOwner?.phase === "standby";
          return ensureWorking("host").then(() => {
            if (wasStandby) return { status: "requested" };
            const current = brain;
            if (!current) throw new Error("background_brain_unavailable");
            const restart = current.requestRestart();
            const timer = setTimeout(() => {
              requestTimers.delete(timer);
              if (!stopped && brain === current) restart();
            }, 25);
            requestTimers.add(timer);
            return { status: "requested" };
          });
        }
        if (control.type === "stop-service") {
          options.logger.info("audit background stop requested");
          // An explicit stop (upgrade drain, user) supersedes a pending recovery relaunch.
          recoveryRestart = undefined;
          stopReason ??= "stop_service";
          lifetime.requestStop();
          return Promise.resolve({ status: "requested" });
        }
        if (control.type === "state") {
          // A GUI polls state while its attach loop waits; that poll is the only way this
          // owner learns a window still cares before it attaches. See armStartupStop.
          guiPolledAt = Date.now();
          // Startup polling only needs lifecycle/progress. Do not put platform service queries
          // in the path to observing a stop or a new writer becoming ready.
          if (lifecycle !== "ready") return Promise.resolve(state());
          // Nor in front of the first screen. A window that has not attached yet polls this
          // right before attaching; on Windows the query is a PowerShell Task Scheduler call.
          // It gets the last known value and the refresh runs beside it.
          if (!clients.size) {
            void refreshManagement();
            return Promise.resolve(state());
          }
          return refreshManagement().then(() => state());
        }
        if (control.type === "brain-state")
          return Promise.resolve(
            brain?.backgroundState() ??
              BackgroundStateSchema.parse({
                state: "stopped",
                startedAt: null,
                uptimeMs: 0,
                restartCount: 0,
                at: new Date().toISOString(),
              }),
          );
        hostWork++;
        const wake =
          control.type === "detach" ||
          control.type === "blur" ||
          control.type === "provider-import-dismiss"
            ? Promise.resolve()
            : ensureWorking("gui");
        void wake.catch(() => {}); // The serialized caller still observes failure; do not leak an early rejection.
        return serial(async () => {
          await wake;
          if (stopped) throw new RpcError(RpcErrorCodes.closed, "background_stopping");
          const current = brain;
          if (
            !current &&
            control.type !== "detach" &&
            control.type !== "blur" &&
            control.type !== "provider-import-dismiss"
          )
            throw new RpcError(RpcErrorCodes.closed, "background_not_ready");
          switch (control.type) {
            case "diagnostics":
              if (!current) throw new Error("background_not_ready");
              return current.diagnostics(AbortSignal.timeout(5000));
            case "attach":
              if (!current || !cycle) throw new Error("background_not_ready");
              await cycle.desktopClient(true, () => clients.attach(client));
              // After the attach reply: the window answers on this same socket, whose messages
              // wait behind this handler, so awaiting it here deadlocked every window start.
              setImmediate(() => {
                // A window that left meanwhile gets it on its next attach.
                void Promise.resolve()
                  .then(() => server?.gui("gui.updates.proxy", { url: updateProxy.get() }))
                  .catch(() =>
                    options.logger.warn(
                      JSON.stringify({ module: "updates", event: "proxy_sync_unavailable" }),
                    ),
                  );
              });
              syncTray();
              awaitingFirstClient = false;
              clearTimeout(startupTimer);
              if (settings) server?.broadcast({ kind: "settings", settings });
              return state();
            case "detach":
              providerImport.dismiss(client);
              foreground = false;
              islandForeground(client, false);
              await clients.detach(client, control.stop === true);
              syncTray();
              return state();
            case "focus":
              foreground = true;
              islandForeground(client, true);
              routineHost?.focused(control.at);
              return null;
            case "blur":
              foreground = false;
              islandForeground(client, false);
              return null;
            case "ui-ready":
              if (current) await providerImport.present(client, current);
              if (pendingNavigation) {
                if (!current) throw new Error("background_not_ready");
                current.navigate(pendingNavigation);
                pendingNavigation = undefined;
              }
              return null;
            case "provider-import":
              providerImport.offer(control.intent, client);
              return null;
            case "provider-import-decide":
              return providerImport.resolve(client, control.decision);
            case "provider-import-dismiss":
              providerImport.dismiss(client);
              return null;
            case "navigate":
              if ("view" in control.target && control.target.view === "provider-import")
                throw new RpcError(RpcErrorCodes.invalidParams, "desktop_method_unavailable");
              if (!current) throw new Error("background_not_ready");
              current.navigate(control.target);
              return null;
            case "preferences": {
              // The sign-in policy may still be writing the same preferences.
              await managementWork;
              const current = brain;
              if (!current) throw new Error("background_brain_unavailable");
              const pending = applyBackgroundPreferences({
                platform: process.platform,
                previous: preferences,
                patch: control.patch,
                management,
                write: (value) => current.preferences(value),
              });
              managementWork = pending.then(
                () => {},
                () => {},
              );
              const result = await pending;
              preferences = result.preferences;
              managementState = result.management;
              syncTray();
              options.logger.info("audit background preferences changed");
              return state();
            }
          }
        }).finally(() => {
          hostWork--;
        });
      },
    });
    server = ownedServer;
    lifetime.own(() => ownedServer.close());
    lifetime.active();
    await reservation.socketPrivate();
    // Login-item state is only shown in settings, and Windows answers it through Task Scheduler
    // (10 s bound, often reached on a busy machine at sign-in). It no longer delays the brain;
    // a GUI state poll after readiness queries it again anyway.
    const initialManagement = managementState;
    void management.query().then((value) => {
      if (managementState === initialManagement && !stopped) managementState = value;
    });
    options.timing?.mark("management_query");
    lifetime.active();
    let testDirectory: string | undefined;
    let devModule: typeof import("@pibot/routines/host/dev") | undefined;
    if (__PIBOT_DEV_BUILD__ && options.dev && options.originalEnv.PIBOT_ROUTINE_TEST_DIR) {
      devModule = await import("@pibot/routines/host/dev");
      lifetime.active();
      const { resolveDataDir } = await import("@pibot/storage");
      lifetime.active();
      const normal = resolveDataDir({
        platform: process.platform,
        env: {},
        homedir: homedir(),
        dev: true,
      });
      if (!options.originalEnv.PIBOT_DATA_DIR) throw new Error("routine_test_isolation_required");
      testDirectory = await devModule.routineTestDirectory(
        options.dataDir,
        options.originalEnv.PIBOT_ROUTINE_TEST_DIR,
        normal,
      );
    }
    lifetime.active();
    let fakeBlockerId = 0;
    routineHost = createRoutineHost({
      platform: process.platform,
      monitor: powerMonitor,
      blocker: testDirectory ? { start: () => ++fakeBlockerId, stop: () => {} } : powerSaveBlocker,
      test: !!testDirectory,
      logger: options.logger,
      send: (control) => {
        if (childReady && brain && (!sleepOwner || sleepOwner.phase === "working"))
          brain.control(control);
        else powerInputs.push(control);
        if (control.type === "power-event" && sleepOwner && !stopped)
          void sleepOwner.wake("power").catch(() => options.logger.warn("Power wake unavailable"));
      },
      tray: (next) => {
        trayState = next;
        tray?.updateRoutines(next);
      },
    });
    lifetime.own(() => routineHost?.stop());
    const makeTray = () =>
      createTray({
        resourcesDir: fileURLToPath(new URL("../../resources/", import.meta.url)),
        language,
        open,
        show: (view) => navigate({ view }),
        // The old "Quit": with a window attached it closes only the GUI, and this owner keeps
        // scheduling when the exit preference says so. Without a window, or when the owner
        // would stop with it, it did the same as "Quit completely", so it is not offered.
        closeWindow: {
          available: () => clients.size > 0 && state().effectiveExitBehavior === "continue",
          run: () => server?.broadcast({ kind: "quit" }),
        },
        // The old "Quit and stop background scheduling".
        quitAll: () => {
          if (clients.size) server?.broadcast({ kind: "quit", stop: true });
          else void stop("tray_quit").catch(() => {});
        },
        inbox: {
          // Never wakes a standby brain: a menu count is not worth a brain start.
          count: (signal) => {
            if (!brain || !childReady) return Promise.reject(new Error("background_not_ready"));
            return brain.inboxCount(signal);
          },
        },
        routines: {
          pause: async (until) => {
            await ensureWorking("host");
            if (!brain) throw new Error("background_brain_unavailable");
            await brain.pauseAll(until);
          },
          resume: async () => {
            await ensureWorking("host");
            if (!brain) throw new Error("background_brain_unavailable");
            await brain.resumeAll();
          },
          failed: () => options.logger.warn("Tray routine action unavailable"),
        },
      });
    syncTray = (refresh = false) => {
      const visible = shouldShowOwnerTray({
        guiConnected: clients.size > 0,
        showTrayIcon: settings?.showTrayIcon ?? true,
      });
      if (refresh || trayVisible !== visible || (visible && !tray)) {
        tray?.destroy();
        trayVisible = visible;
        tray = visible ? makeTray() : undefined;
        tray?.updateRoutines(trayState);
        tray?.updateActiveRuns(activeRuns);
        tray?.updateKeyringNotice(keyringNotice);
      }
      tray?.updateBackground({ lifecycle, brainPhase });
    };
    syncTray();
    lifetime.own(() => tray?.destroy());
    lifetime.own(() => clearTimeout(startupTimer));
    lifetime.active();
    capabilities = createHostCapabilities({
      logger: options.logger,
      redactor: options.redactor,
      foreground: () => foreground,
      gui: {
        call: (method, params, options) => {
          if (!clients.size) throw new RpcError(RpcErrorCodes.unsupported, "gui_offline");
          return ownedServer.gui(method, params, options);
        },
      },
      focusBot: (botId, tab, target) => navigate(target ?? { botId, tab }),
    });
    lifetime.own(() => capabilities?.dispose());
    // Lives with the brain, like the run indicator, so it also shows with no desktop window.
    const ownedIsland = createLiveIsland({
      outputDir: options.outputDir,
      logger: options.logger,
      platform: process.platform,
      env: options.originalEnv,
      open: (target) => navigate(target),
    });
    island = ownedIsland;
    lifetime.own(() => {
      island = undefined;
      ownedIsland.dispose();
    });
    // macOS keeps the computer driver in the owner so routines can use it after the desktop
    // quits. Nothing native loads until a grant is used.
    // The indicator and stop shortcut live here too, so they work with no desktop window.
    const computerGuard = createComputerGuard({
      logger: options.logger,
      outputDir: options.outputDir,
      // While stopping, the guard's own reset must not bring the island back for a moment.
      visibilityChanged: (visible) => {
        if (!stopped) island?.guardVisible(visible);
      },
    });
    lifetime.own(() => computerGuard.dispose());
    const computer = createComputerHost({
      logger: options.logger,
      blocked: computerGuard.blocked,
      officeBlocked: computerGuard.listed,
    });
    lifetime.own(() => computer.dispose());
    cycle = createBackgroundBrainCycle({
      reservation: ownedReservation,
      server: ownedServer,
      signal: lifetime.signal,
      active: () => lifetime.active(),
      connected: () => clients.size > 0,
      retiring: () => {
        childReady = false;
      },
      created: (current) => {
        brain = current;
      },
      ready: (current) => powerInputs.flush((value) => current.control(value)),
      preferences: (value) => {
        preferences = value;
        syncTray();
      },
      host: {
        ...options,
        systemLocale,
        storage,
        routines: routineHost,
        capabilities,
        computer,
        // Overlay frames go to attached windows over the socket, outside the business queue.
        frames: {
          send: (message) => ownedServer.browserFrame(message),
          onAck: (listener) => ownedServer.onBrowserFrameAck(listener),
        },
        computerGuard,
        routineTesting: !!testDirectory,
        gui: {
          // Drop nothing: the picker's own deadline (e.g. a plugin folder dialog) must survive
          // the hop into the window, not fall back to the short default.
          call: (method, params, options) => {
            if (method === "gui.updates.proxy") {
              const value = GuiHostMethods["gui.updates.proxy"].params.parse(params);
              updateProxy.set(value.url);
              if (!clients.size)
                return Promise.resolve(null) as ReturnType<typeof ownedServer.gui<typeof method>>;
            }
            if (!clients.size) throw new RpcError(RpcErrorCodes.unsupported, "gui_offline");
            return ownedServer.gui(method, params, options);
          },
        },
        foreground: () => foreground,
        onLoginItem: () => {},
        onSettings: (next) => {
          if (stopped) return;
          settings = next;
          runLoginPolicy();
          nativeTheme.themeSource = next.theme;
          const nextLanguage = resolveLanguage(next.language, systemLocale);
          const changed = language !== nextLanguage;
          language = nextLanguage;
          island?.settings(next, nextLanguage);
          syncTray(changed);
          tray?.refresh();
          server?.broadcast({ kind: "settings", settings: next });
        },
        focusBot: (botId, tab, target) => {
          navigate(target ?? { botId, tab });
        },
        onInboxChanged: () => tray?.refreshInbox(),
        onActiveRuns: (count) => {
          activeRuns = count;
          tray?.updateActiveRuns(count);
        },
        onLiveActivity: (value) => island?.activity(value),
        onStartupProgress: (phase) => {
          startupProgressAt = new Date().toISOString();
          startupPhase = phase;
        },
        onStatus: (next, reason) => {
          if (reason) startupFailure = reason;
          if (stopped) return;
          clearTimeout(startupTimer);
          startupTimer = undefined;
          childReady = next === "ready";
          if (childReady) startupPhase = undefined;
          lifecycle = next === "restarting" ? "starting" : next;
          if (next === "failed") {
            sleepOwner?.unavailable();
            brainPhase = "unavailable";
          } else if (next !== "ready") brainPhase = "waking";
          else if (sleepOwner?.phase === "working") brainPhase = "working";
          tray?.updateBackground({ lifecycle, brainPhase });
          if (childReady) tray?.refreshInbox();
          // Attach requires a ready cycle: the grace starts after readiness and pauses if the
          // child restarts. The cycle watchdog still bounds orphan startup.
          if (childReady && awaitingFirstClient) armStartupStop();
          if (childReady) runLoginPolicy();
          server?.broadcast({
            kind: "status",
            state: { state: next, ...(startupFailure ? { reason: startupFailure } : {}) },
          });
        },
      },
    });
    sleepOwner =
      process.platform === "darwin"
        ? createBackgroundSleepOwner({
            signal: lifetime.signal,
            eligible: () =>
              !stopped &&
              !hostWork &&
              !clients.size &&
              !requestTimers.size &&
              (!brain || childReady) &&
              preferences.exitBehavior === "continue",
            hasBrain: () => !!brain,
            sleep: () => {
              if (!brain) throw new Error("background_brain_unavailable");
              return brain.backgroundSleep;
            },
            launch: (signal) => {
              if (!cycle) return Promise.reject(new Error("background_not_initialized"));
              return cycle.launch(signal);
            },
            retire: () => cycle?.retire() ?? Promise.resolve(),
            changed: (phase) => {
              brainPhase = phase;
              if (phase === "standby") lifecycle = "ready";
              else if (phase === "waking") lifecycle = "starting";
              else if (phase === "unavailable") lifecycle = "failed";
              else if (phase === "working") lifecycle = "ready";
              tray?.updateBackground({ lifecycle, brainPhase });
            },
            failed: () =>
              options.logger.warn("Background lifecycle unavailable; writer claim retained"),
          })
        : undefined;
    lifetime.own(() => powerInputs.clear());
    options.timing?.mark("owner_setup");
    // Logged before the brain spawns: the brain's own lines time everything after this point.
    options.timing?.report(options.logger, "owner_setup");
    try {
      if (sleepOwner) await sleepOwner.wake("host");
      else await cycle.launch(lifetime.signal);
    } catch (error) {
      if (!startupFailure || lifetime.signal.aborted) throw error;
      // Keep the authenticated failure receipt available to a GUI that connects after child exit.
      // The usual explicit stop/quit path still owns the server, reservation and failed host.
      clearTimeout(startupTimer);
      return;
    }
    brainPhase = "working";
    tray?.updateBackground({ lifecycle, brainPhase });
    sleepOwner?.start();
    lifetime.active();
    if (testDirectory && devModule)
      devHooks = devModule.registerRoutineDev({
        directory: testDirectory,
        host: routineHost,
        send: (control) => {
          if (!brain?.devControl) throw new Error("routine_dev_unavailable");
          brain.devControl(control);
        },
        failed: () => options.logger.warn("routine dev command failed"),
      });
    lifetime.own(() => devHooks?.stop());
    lifetime.active();
  });
  return { stop, open };
}
