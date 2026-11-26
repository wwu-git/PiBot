/*
 * Owns the brain child process in the desktop main process: fork, channels and bootstrap, startup
 * watchdog, restart policy, retirement, and the host RPC surface the child talks to. The pieces
 * that do not need the lifecycle are next to this file: `host-services.ts` (browsers, storage,
 * capabilities), `login-item-runtime.ts`, `background-control.ts`, `host-options.ts`.
 */
import { rulesGuard, type UserBrowser } from "@pibot/browser/host";
import { inboxTotal } from "@pibot/client-core";
import { createTranslator, resolveLanguage } from "@pibot/i18n";
import { detectKnowledge, openKnowledgeNote } from "@pibot/plugins/host";
import {
  BackgroundBrainReplySchema,
  type BackgroundPreferences,
  BackgroundStateSchema,
  BrainStartupProgressSchema,
  createPeer,
  EventBuffer,
  type EventPayloads,
  Events,
  Methods,
  RoutineControlSchema,
  RpcError,
  RpcErrorCodes,
  SettingsSchema,
  type UiNavigation,
  UiNavigationSchema,
} from "@pibot/protocol";
import { createPowerLease, type RoutineControl, routineOutbox } from "@pibot/routines/host";
import {
  app,
  dialog,
  MessageChannelMain,
  type MessagePortMain,
  powerMonitor,
  powerSaveBlocker,
  shell,
} from "electron";
import { createUserBrowser } from "../browser-extension/user-browser.ts";
import { registerHostRpc } from "../host/host-rpc.ts";
import { createLinkBridge } from "../link-bridge/index.ts";
import { loginItemSyncEnabled } from "../window/login-item-scope.ts";
import { createBackgroundControl } from "./background-control.ts";
import { forkBrainProcess } from "./brain-process.ts";
import { createBrainWakeBridge } from "./brain-wake-bridge.ts";
import type { BrainHostOptions } from "./host-options.ts";
import { createHostServices, type MainPeer, toolbarEvents } from "./host-services.ts";
import { createLoginItemRuntime } from "./login-item-runtime.ts";
import {
  readCachedLoginShellPath,
  readLoginShellPath,
  writeCachedLoginShellPath,
} from "./login-shell-path.ts";
import { mainPort } from "./port.ts";
import { RestartPolicy } from "./restart-policy.ts";
import { retireBrain } from "./retire-brain.ts";
import { createStartupWatchdog } from "./startup-watchdog.ts";

export function startBrainHost(options: BrainHostOptions) {
  const terminalPath = readCachedLoginShellPath(options.dataDir, process.platform);
  // Once per app run: a brain restart bootstraps with the value already read.
  let terminalPathRefreshed = false;
  // A brain reads its first message as the bootstrap: only one that has it gets the update.
  let bootstrappedChild: Electron.UtilityProcess | undefined;
  const refreshTerminalPath = () => {
    if (terminalPathRefreshed) return;
    terminalPathRefreshed = true;
    const started = performance.now();
    void readLoginShellPath(process.platform, options.originalEnv)
      .then(async (path) => {
        const changed = path && JSON.stringify(path) !== JSON.stringify(terminalPath);
        options.logger.info(
          JSON.stringify({
            module: "environment",
            event: path ? "login_shell_path_read" : "login_shell_path_unavailable",
            entries: path?.length ?? 0,
            durationMs: Math.round(performance.now() - started),
          }),
        );
        if (!path || !changed) return;
        // Updated in place first: a brain that bootstraps later (restart) carries the new value.
        terminalPath.splice(0, terminalPath.length, ...path);
        // The current brain (maybe a restarted one); one not bootstrapped yet gets it there.
        if (child && child === bootstrappedChild)
          child.postMessage({ type: "terminal_path", path });
        await writeCachedLoginShellPath(options.dataDir, path);
      })
      // A failed cache write only costs the next start the cached value; this run already has it.
      .catch(() => undefined);
  };
  const remotePower = createPowerLease({
    blocker: powerSaveBlocker,
    changed: () => {},
    warn: () => options.logger.warn(JSON.stringify({ module: "remote", event: "power_failed" })),
  });
  const systemLocale = options.systemLocale ?? app.getLocale();
  let language: "zh" | "en" = resolveLanguage("system", systemLocale);
  let mainPeer: MainPeer | undefined;
  const requirePeer = () => {
    if (!mainPeer) throw new RpcError(RpcErrorCodes.closed, "brain_disconnected");
    return mainPeer;
  };
  const {
    storage,
    env,
    officeRender,
    attachments,
    capabilities,
    connectorImports,
    logins,
    toolbars,
    browsers,
    frames,
  } = createHostServices(options, { requirePeer, locale: () => language });
  // The user's own browser lives as long as this process, across brain restarts. Created in
  // the background so startup never waits on it; until then nothing is routed to it.
  let userBrowser: Awaited<ReturnType<typeof createUserBrowser>> | undefined;
  const userBrowserReady = createUserBrowser({
    dataDir: options.dataDir,
    // Same rule as login items: only the platform default folder acts for the whole account.
    defaultDataDir: loginItemSyncEnabled({ dev: options.dev, env: options.originalEnv }),
    executable: process.execPath,
    ...(app.isPackaged ? {} : { entry: app.getAppPath() }),
    logger: options.logger,
    fallback: (botId, runId) =>
      void mainPeer?.call("browserExtension.fallback", { botId, runId }).catch(() => undefined),
    changed: () => undefined,
  }).then(
    (value) => {
      userBrowser = value;
      return value;
    },
    () => {
      options.logger.warn(JSON.stringify({ module: "browser-extension", event: "start_failed" }));
      return undefined;
    },
  );
  const userBrowserPort: UserBrowser = {
    extension: () => userBrowser?.extension(),
    browserId: () => userBrowser?.browserId?.(),
    record: (input) =>
      mainPeer?.call("browserExtension.record", input).then(() => undefined) ?? Promise.resolve(),
    ensureConnected: (signal) => userBrowser?.ensureConnected?.(signal) ?? Promise.resolve(false),
    supported: () => userBrowser?.supported() ?? false,
    navigation: async (rules, href, request) =>
      (await userBrowserReady)?.navigation(rules, href, request) ?? { kind: "site", url: href },
    fallback: (botId, runId) => userBrowser?.fallback(botId, runId),
    takeStop: (botId) => userBrowser?.takeStop?.(botId) ?? false,
    status: async () =>
      (await userBrowserReady)?.status() ?? {
        defaultBrowser: null,
        supported: false,
        extension: "unsupported",
      },
    register: async (enabled, request) => {
      await (await userBrowserReady)?.register(enabled, request);
    },
  };
  let policy = new RestartPolicy();
  let mainBusinessPort: MessagePortMain | undefined;
  let epoch = 0,
    launchCount = 0;
  let startedAt: string | null = null;
  let startedMono = 0;
  // When the bootstrap message went out (after descriptor publication), for timing.
  let bootstrappedMono = 0;
  const controls = routineOutbox(options.logger);
  const backgroundState = () =>
    BackgroundStateSchema.parse({
      state: state === "failed" ? state : stopped ? "stopped" : state,
      startedAt,
      uptimeMs: child ? Math.max(0, Math.floor(performance.now() - startedMono)) : 0,
      restartCount: Math.max(0, launchCount - 1),
      at: new Date().toISOString(),
    });
  function control(raw: RoutineControl) {
    if (stopped) return;
    const value = RoutineControlSchema.parse(raw);
    if (child && state === "ready" && !replacing) {
      child.postMessage(value);
      return;
    }
    controls.push(value);
  }
  const statuses = new EventBuffer(Events);
  let state: EventPayloads["brain.status"]["state"] = "starting";
  let activeRunCount = 0;
  let liveActivity: EventPayloads["runtime.liveActivity"] = { items: [] };
  let child: Electron.UtilityProcess | undefined;
  let host: ReturnType<typeof registerHostRpc> | undefined;
  let pendingPort: MessagePortMain | undefined;
  let hostPort: MessagePortMain | undefined;
  let linkBridge: ReturnType<typeof createLinkBridge> | undefined;
  let rendererReady = false;
  let delivered = false;
  let terminalStartupFailure = false;
  let stopped = false;
  let startupWatchdog: ReturnType<typeof createStartupWatchdog> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let replacing = false;
  let retirement: Promise<void> | undefined;
  let navigationTarget: UiNavigation | undefined;
  let businessOff: (() => void) | undefined;
  const backgroundSleep = createBrainWakeBridge((request) => {
    if (!child || stopped || replacing || state !== "ready" || !options.business)
      throw new Error("brain_wake_unavailable");
    child.postMessage(request);
  });
  const backgroundControl = createBackgroundControl({
    available: () =>
      Boolean(child) && !stopped && !replacing && state === "ready" && Boolean(options.business),
    post: (message) => child?.postMessage(message),
  });
  const deliverNavigation = () => {
    if (
      !stopped &&
      (options.business || (rendererReady && delivered)) &&
      state === "ready" &&
      child &&
      navigationTarget
    ) {
      child.postMessage({ type: "navigate", target: navigationTarget });
      navigationTarget = undefined;
    }
  };

  const status = (next: typeof state, reason?: "database_newer_than_app") => {
    state = next;
    options.onActiveRuns?.(next === "ready" ? activeRunCount : 0);
    options.onLiveActivity?.(next === "ready" ? liveActivity : { items: [] });
    options.onStatus?.(next, reason);
    if (rendererReady && options.window && !options.window.isDestroyed()) {
      options.window.webContents.send("pibot:status", statuses.append("brain.status", { state }));
    }
  };
  const deliver = () => {
    if (rendererReady && pendingPort && state === "ready" && options.window) {
      options.window.webContents.postMessage("pibot:port", null, [pendingPort]);
      pendingPort = undefined;
      delivered = true;
      deliverNavigation();
    }
  };
  const login = createLoginItemRuntime({
    dev: options.dev,
    originalEnv: options.originalEnv,
    logger: options.logger,
    onLoginItem: options.onLoginItem,
    publish: (openAtLogin) => {
      if (state === "ready") child?.postMessage({ type: "login-item-state", openAtLogin });
    },
  });
  const loginItem = login.loginItem;
  let acpOff: (() => void) | undefined;
  let acpMainPort: MessagePortMain | undefined;
  const disposePorts = () => {
    activeRunCount = 0;
    options.onActiveRuns?.(0);
    liveActivity = { items: [] };
    options.onLiveActivity?.(liveActivity);
    acpOff?.();
    acpOff = undefined;
    acpMainPort?.close();
    acpMainPort = undefined;
    linkBridge?.dispose();
    linkBridge = undefined;
    backgroundSleep.disconnected();
    businessOff?.();
    businessOff = undefined;
    backgroundControl.fail(new Error("brain_disconnected"));
    mainPeer?.dispose();
    mainPeer = undefined;
    mainBusinessPort?.close();
    mainBusinessPort = undefined;
    remotePower.end();
    host?.dispose();
    host = undefined;
    frames.closeAll();
    browsers.closeAll();
    logins.clear();
    hostPort?.close();
    hostPort = undefined;
    pendingPort?.close();
    pendingPort = undefined;
    delivered = false;
  };

  function launch() {
    if (stopped || terminalStartupFailure || child || options.bootstrapSignal?.aborted) return;
    const business = new MessageChannelMain();
    const hostChannel = new MessageChannelMain();
    const mainBusiness = new MessageChannelMain();
    const linkChannel = new MessageChannelMain();
    const acpChannel = new MessageChannelMain();
    acpMainPort = acpChannel.port1;
    if (options.acp) {
      acpOff = options.acp.onMessage((message) => acpChannel.port1.postMessage(message));
      acpChannel.port1.on("message", (event) => options.acp?.post(event.data));
      acpChannel.port1.start();
    }
    linkBridge = createLinkBridge({
      port: linkChannel.port1,
      outputDir: options.outputDir,
      devUrl: options.dev ? options.originalEnv.ELECTRON_RENDERER_URL : undefined,
    });
    mainBusinessPort = mainBusiness.port1;
    mainPeer = createPeer(mainPort(mainBusiness.port1), {
      methods: Methods,
      events: toolbarEvents,
    });
    for (const event of ["settings.changed", "credentials.changed", "bots.changed"] as const)
      mainPeer.on(event, () => toolbars.notifyAll());
    const owner = ++epoch;
    mainPeer.on("inbox.changed", () => options.onInboxChanged?.());
    mainPeer.on("runtime.activeRuns", ({ count }) => {
      if (stopped || replacing || owner !== epoch || state === "failed") return;
      activeRunCount = count;
      if (state === "ready") options.onActiveRuns?.(count);
    });
    mainPeer.on("runtime.liveActivity", (value) => {
      if (stopped || replacing || owner !== epoch || state === "failed") return;
      liveActivity = value;
      if (state === "ready") options.onLiveActivity?.(value);
    });
    pendingPort = business.port1;
    if (options.business) {
      const receive = (event: { data: unknown }) => options.business?.post(event.data);
      business.port1.on("message", receive);
      business.port1.start();
      const off = options.business.onMessage((message) => business.port1.postMessage(message));
      businessOff = () => {
        off();
        business.port1.off("message", receive);
      };
    }
    hostPort = hostChannel.port1;
    host = registerHostRpc(mainPort(hostChannel.port1), {
      storage,
      memoryDreamActivity: () => {
        const idleSeconds = powerMonitor.getSystemIdleTime();
        return Number.isFinite(idleSeconds) && idleSeconds >= 0
          ? { idleSeconds, supply: options.routines?.powerSupply() ?? "unknown" }
          : null;
      },
      remoteKeepAwake: (enabled) =>
        remotePower.request(owner, {
          mode: enabled ? "always" : "never",
          reason: enabled ? "running" : "none",
          leaseId: "e427cab8-5774-4da2-86bb-3444a72c911e",
          leaseMs: 90_000,
        }).status,
      connectorImports,
      env,
      redactor: options.redactor,
      logger: options.logger,
      updateProxy: async (url) => {
        if (options.gui) await options.gui.call("gui.updates.proxy", { url });
        else await options.updateProxy?.(url);
      },
      openExternal: async (url) => {
        if (options.gui) await options.gui.call("gui.openExternal", { url });
        else await shell.openExternal(url);
      },
      setLoginItem: loginItem,
      onBusyChange: (busy) => watchdog.setBusy(busy),
      attachments,
      officeRender: officeRender.render,
      capabilities,
      browser: { browsers, guard: rulesGuard, frames, logins, userBrowser: userBrowserPort },
      computer: options.computer,
      computerGuard: options.computerGuard,
      // The scan reads Obsidian's own vault list and checks the two apps' install
      // locations; it never opens a vault or Notion's data.
      knowledge: {
        detect: () =>
          detectKnowledge({
            platform: process.platform,
            home: app.getPath("home"),
            env: (name) => options.originalEnv[name],
          }),
        // The brain verified the note; this side proves the name still means exactly that
        // vault, asks the brain once more, then rebuilds and opens the URI. `shell.openExternal`
        // gets only that rebuilt string, so the http(s) check on general links stays untouched.
        openNote: (params, signal, confirm) =>
          openKnowledgeNote({
            platform: process.platform,
            home: app.getPath("home"),
            env: (name) => options.originalEnv[name],
            params,
            signal,
            confirm: () => confirm(params.requestId),
            openExternal: (url) => shell.openExternal(url),
          }),
      },
      routines: {
        keepAwake: async (params) => {
          if (!options.routines)
            throw new RpcError(RpcErrorCodes.unsupported, "routine_host_unavailable");
          return options.routines.keepAwake(owner, params);
        },
        updateTray: async (params) => {
          if (!options.routines)
            throw new RpcError(RpcErrorCodes.unsupported, "routine_host_unavailable");
          options.routines.updateTray(owner, params);
        },
        backgroundState: async () => backgroundState(),
      },
    });
    let forked: ReturnType<typeof forkBrainProcess>;
    try {
      forked = options.prelaunchedBrain?.take() ?? forkBrainProcess(options);
    } catch {
      disposePorts();
      business.port2.close();
      hostChannel.port2.close();
      mainBusiness.port2.close();
      linkChannel.port2.close();
      acpChannel.port2.close();
      options.logger.error("brain process launch failed");
      status("failed");
      return;
    }
    const processHandle = forked.child;
    child = processHandle;
    options.onChild?.(processHandle);
    launchCount++;
    startedAt = new Date().toISOString();
    startedMono = forked.at;
    bootstrappedMono = 0;
    remotePower.begin(owner);
    options.routines?.begin(owner);
    const watchdog = createStartupWatchdog(
      15_000,
      ({ afterPhase, idleMs }) => {
        if (child !== processHandle || stopped || replacing) return;
        options.logger.error(
          JSON.stringify({
            module: "startup",
            event: "brain_startup_timeout",
            launch: launchCount,
            afterPhase,
            idleMs,
            spawnToTimeoutMs: Math.round(performance.now() - startedMono),
          }),
        );
        processHandle.kill();
      },
      {
        // A utility process shows up in the app metrics under its own pid; cumulative CPU is the
        // child's work as seen from outside, so a starved event loop cannot hide it.
        cpuSeconds: () =>
          app.getAppMetrics().find((metric) => metric.pid === processHandle.pid)?.cpu
            .cumulativeCPUUsage,
        minCpuSeconds: 1,
        // 20 × 15 s: five minutes of measurable work before a still-unready child is treated as hung.
        maxExtensions: 20,
        extended: ({ afterPhase, idleMs, cpuSeconds, extension }) => {
          // The launch cycle and the GUI's attach wait extend on startup progress; measurable work
          // is progress for them too, or they give up while this watchdog still waits.
          options.onStartupProgress?.(afterPhase);
          options.logger.warn(
            JSON.stringify({
              module: "startup",
              event: "brain_startup_slow",
              launch: launchCount,
              afterPhase,
              idleMs,
              cpuSeconds: Math.round(cpuSeconds * 10) / 10,
              extension,
            }),
          );
        },
      },
    );
    startupWatchdog = watchdog;
    processHandle.on("message", (message: unknown) => {
      if (child !== processHandle || stopped) return;
      if (backgroundSleep.receive(message)) return;
      const progress = BrainStartupProgressSchema.safeParse(message);
      if (progress.success) {
        watchdog.progress(progress.data.phase);
        options.onStartupProgress?.(progress.data.phase);
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "startup-failed" &&
        "reason" in message &&
        message.reason === "database_newer_than_app"
      ) {
        terminalStartupFailure = true;
        watchdog.stop();
        status("failed", "database_newer_than_app");
        if (options.window)
          dialog.showErrorBox(app.getName(), createTranslator(language)("startup.newerData"));
        return;
      }
      const reply = BackgroundBrainReplySchema.safeParse(message);
      if (reply.success) {
        backgroundControl.settle(reply.data);
        return;
      }
      if (message && typeof message === "object" && "type" in message && message.type === "ready") {
        watchdog.stop();
        const now = performance.now();
        options.logger.info(
          JSON.stringify({
            module: "startup",
            event: "brain_ready",
            launch: launchCount,
            spawnToReadyMs: Math.round(now - startedMono),
            spawnToBootstrapMs: bootstrappedMono
              ? Math.round(bootstrappedMono - startedMono)
              : null,
            // Owner process uptime: includes app ready, bundle hashing and owner setup.
            sinceProcessMs: Math.round(now),
          }),
        );
        status("ready");
        controls.flush((value) => processHandle.postMessage(value));
        // Replay history first; the current snapshot must remain the final authority.
        options.routines?.ready();
        login.apply();
        deliver();
        deliverNavigation();
        options.onReady?.();
      }
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "settings" &&
        "settings" in message
      ) {
        const settings = SettingsSchema.safeParse(message.settings);
        if (settings.success) {
          language = resolveLanguage(settings.data.language, systemLocale);
          options.onSettings(settings.data);
        }
      }
    });
    processHandle.on("error", () => {
      if (child !== processHandle) return;
      remotePower.end();
      options.routines?.end();
      options.logger.error("brain fatal process error");
      status("failed");
      try {
        processHandle.kill();
      } catch {
        // Keep the current writer owned; only a confirmed exit can authorize replacement.
        options.logger.error("brain fatal stop unavailable");
      }
    });
    processHandle.on("exit", (code) => {
      options.computer?.revokeAll();
      options.computerGuard?.reset();
      if (child !== processHandle) return;
      options.onAcpRetired?.();
      child = undefined;
      startedAt = null;
      remotePower.end();
      options.routines?.end();
      watchdog.stop();
      disposePorts();
      if (stopped || replacing || terminalStartupFailure) return;
      options.logger.warn(`brain exited code=${code}`);
      if (policy.recordExit(Date.now()) === "failed") {
        status("failed");
        options.logger.error("brain restart limit reached");
        return;
      }
      status("restarting");
      restartTimer = setTimeout(launch, 250);
    });
    let transferred = false;
    const bootstrap = () => {
      bootstrappedMono = performance.now();
      processHandle.postMessage(
        {
          dataDir: options.dataDir,
          resourcesDir: options.resourcesDir,
          version: app.getVersion(),
          platform: process.platform,
          dev: options.dev,
          independent: options.business !== undefined,
          ...(terminalPath.length ? { terminalPath } : {}),
        },
        [
          business.port2,
          hostChannel.port2,
          mainBusiness.port2,
          linkChannel.port2,
          acpChannel.port2,
        ],
      );
      transferred = true;
      bootstrappedChild = processHandle;
      refreshTerminalPath();
    };
    if (!options.beforeBootstrap) bootstrap();
    else {
      let starting = false;
      const start = () => {
        if (starting || processHandle.pid === undefined) return;
        starting = true;
        // The child is idle until it gets the bootstrap; the owner's descriptor publication before
        // it (Windows ACL checks) may take longer than one idle window on a busy machine, and a
        // timeout here killed and respawned the brain forever (Windows VM, 2026-11-11). Paused
        // while the owner works; the launch cycle's own stall ceiling still bounds this wait.
        watchdog.setBusy(true);
        void options
          .beforeBootstrap?.(processHandle.pid)
          .then(() => {
            if (child !== processHandle || stopped || replacing || options.bootstrapSignal?.aborted)
              return;
            watchdog.progress("owner_bootstrap");
            bootstrap();
          })
          .catch(() => {
            if (!options.bootstrapSignal?.aborted)
              options.logger.error("Brain owner descriptor publication failed");
            try {
              processHandle.kill();
            } catch {
              options.logger.error("Unbootstrapped child exit unconfirmed");
            }
          });
      };
      processHandle.once("spawn", start);
      start();
      processHandle.once("exit", () => {
        processHandle.off("spawn", start);
        if (transferred) return;
        business.port2.close();
        hostChannel.port2.close();
        mainBusiness.port2.close();
        linkChannel.port2.close();
        acpChannel.port2.close();
      });
    }
  }

  function replace(next: "starting" | "restarting") {
    if (stopped || replacing || terminalStartupFailure) return;
    clearTimeout(restartTimer);
    const previous = child;
    if (!previous) {
      policy = new RestartPolicy();
      status(next);
      launch();
      return;
    }
    replacing = true;
    remotePower.end();
    options.routines?.end();
    startupWatchdog?.stop();
    status(next);
    retirement = retireBrain(previous, options.logger);
    void retirement
      .then(() => {
        replacing = false;
        retirement = undefined;
        if (!stopped) {
          policy = new RestartPolicy();
          launch();
        }
      })
      .catch(() => {
        stopped = true;
        // Keep the actual child owned, but permit an explicit stop to retry retirement.
        retirement = undefined;
        options.logger.error("brain exit unconfirmed, restart blocked");
        status("failed");
      });
  }
  try {
    launch();
  } catch {
    // Preserve a usable stop handle even if setup fails after utility creation. No exit
    // handler may restart a child while its owning factory is rolling back.
    stopped = true;
    clearTimeout(restartTimer);
    startupWatchdog?.stop();
    options.logger.error("Brain host initialization failed; stop handle retained");
    status("failed");
  }
  return {
    backgroundSleep,
    /** Kernel access for the screencast port, takeover and recording (T7 / T10). */
    browsers,
    desktopClient: (connected: boolean) => backgroundControl.request("client", connected),
    preferences: (preferences?: BackgroundPreferences) =>
      backgroundControl.request("preferences", undefined, preferences),
    control,
    backgroundState,
    requestRestart() {
      if (stopped || replacing || terminalStartupFailure)
        throw new RpcError(
          stopped || terminalStartupFailure ? RpcErrorCodes.closed : RpcErrorCodes.busy,
          "brain_restart_unavailable",
        );
      options.logger.info("audit background.restart requested");
      return () => replace("restarting");
    },
    ...(typeof __PIBOT_DEV_BUILD__ !== "undefined" && __PIBOT_DEV_BUILD__
      ? {
          devControl(control: import("@pibot/protocol").RoutineDevControl) {
            if (
              !options.dev ||
              !options.routineTesting ||
              stopped ||
              replacing ||
              state !== "ready"
            )
              throw new Error("routine_dev_unavailable");
            child?.postMessage(control);
          },
        }
      : {}),
    async pauseAll(until: string) {
      if (state !== "ready" || stopped || replacing || !mainPeer)
        throw new Error("brain_unavailable");
      await mainPeer.call("routines.pauseAll", { until });
    },
    async resumeAll() {
      if (state !== "ready" || stopped || replacing || !mainPeer)
        throw new Error("brain_unavailable");
      await mainPeer.call("routines.resumeAll", undefined);
    },
    stageProviderImport(intent: import("@pibot/protocol").ProviderImportIntent) {
      return requirePeer().call("providerImport.stage", intent, { timeoutMs: 8_000 });
    },
    resolveProviderImport(decision: import("@pibot/protocol").ProviderImportDecision) {
      return requirePeer().call("providerImport.resolve", decision, { timeoutMs: 22_000 });
    },
    async diagnostics(signal: AbortSignal) {
      return requirePeer().call("diagnostics.snapshot", undefined, { signal, timeoutMs: 5000 });
    },
    async inboxCount(signal: AbortSignal) {
      if (state !== "ready" || stopped || replacing || !mainPeer)
        throw new Error("brain_unavailable");
      return inboxTotal(await mainPeer.call("inbox.counts", undefined, { signal }));
    },
    loginItem,
    navigate(target: UiNavigation) {
      if (stopped) return;
      // Keep only the latest click while a renderer/brain port is being replaced.
      navigationTarget = UiNavigationSchema.parse(target);
      deliverNavigation();
    },
    markCloseHint() {
      if (state === "ready") child?.postMessage({ type: "close-hint-shown" });
    },
    rendererReady() {
      if (stopped) return;
      rendererReady = true;
      status(state);
      deliver();
    },
    rendererReloading() {
      if (options.business) return;
      rendererReady = false;
      if (stopped || replacing || terminalStartupFailure) return;
      // A transferred port dies with the old document. A development reload gets fresh channels.
      if (delivered && child) replace("starting");
    },
    async stop() {
      // Flush the actual latest focus before stop, including a child still initializing.
      const activity = options.routines?.activity();
      if (activity && child) {
        try {
          child.postMessage(activity);
        } catch {
          options.logger.warn("last UI activity flush unavailable");
        }
      }
      stopped = true;
      // Started now, awaited last: a separate copy removes its own native host manifests before
      // it exits, without holding up the brain's retirement.
      const browserClosed = userBrowserReady.then((value) => value?.close()).catch(() => undefined);
      if (!options.storage) storage.dispose();
      remotePower.end();
      options.routines?.end();
      if (!options.retainRoutineHost) await options.routines?.stop();
      controls.clear();
      navigationTarget = undefined;
      if (!options.capabilities) capabilities.dispose();
      clearTimeout(restartTimer);
      startupWatchdog?.stop();
      const previous = child;
      if (previous) {
        await (retirement ?? retireBrain(previous, options.logger));
      }
      await Promise.all([attachments.dispose(), officeRender.dispose()]);
      await login.settled();
      disposePorts();
      frames.dispose();
      browsers.dispose();
      toolbars.dispose();
      await connectorImports.dispose();
      logins.clear();
      await browserClosed;
    },
  };
}
