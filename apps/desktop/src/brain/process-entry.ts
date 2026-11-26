import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, flushCompileCache } from "node:module";
import { join } from "node:path";
import { sanitizeBrainEnv } from "@pibot/agent/env";
import { createLogger } from "@pibot/observability";
import {
  BackgroundBrainRequestSchema,
  BrainBootstrapSchema,
  BrainControlSchema,
  BrainTerminalPathSchema,
  BrainWakeRequestSchema,
  BrainWakeResultSchema,
  createPeer,
  HostMethods,
  type Port,
  RoutineControlSchema,
  RpcError,
} from "@pibot/protocol";
import { createRedactor } from "@pibot/secrets";
import type { MessagePortMain } from "electron";
import { pruneCompileCache } from "../shared/bundle-identity.ts";
import { createDesktopAcp } from "./acp-channel.ts";
import { createBrainHost } from "./brain-host.ts";
import { businessPorts } from "./business-ports.ts";
import { createControlSource } from "./control-source.ts";
import { desktopSettingsPort } from "./desktop-settings.ts";
import { waitForHost } from "./host-readiness.ts";
import { createDesktopRtcBridge } from "./link-bridge/index.ts";
import type { startDesktopBrain } from "./runtime.ts";

// Error messages can carry paths or content; only protocol identifiers and class names are logged.
function shutdownReason(error: unknown): string {
  const identifier = (text: string) => /^[a-z][a-z0-9_]{0,63}$/.test(text);
  if (error instanceof RpcError)
    return identifier(error.message) ? `rpc ${error.code} ${error.message}` : `rpc ${error.code}`;
  if (error instanceof Error) return identifier(error.message) ? error.message : error.name;
  return typeof error;
}

function utilityPort(port: MessagePortMain): Port {
  return {
    post: (message) => port.postMessage(message),
    onMessage(listener) {
      const receive = (event: { data: unknown }) => listener(event.data);
      port.on("message", receive);
      port.start();
      return () => port.off("message", receive);
    },
  };
}

/** The compile-cache flush waits for this much quiet after the last user request. */
const CACHE_FLUSH_QUIET_MS = 5_000;
const CACHE_FLUSH_MAX_WAIT_MS = 10 * 60_000;
const parent = process.parentPort;
if (!parent) throw new Error("Brain entry requires a utilityProcess parent");
export function startBrainProcess(
  event: { data: unknown; ports: MessagePortMain[] },
  bootstrapAtMs: number,
  cache: {
    status: number;
    durationMs: number;
    root?: string;
    key?: string;
    stages?: {
      processStartupMs: number;
      bootstrapWaitMs: number;
      bootstrapLoadMs: number;
      entryImportMs: number;
      importedAtMs: number;
    };
  },
  pending: readonly { data: unknown }[] = [],
  preparedRuntime?: {
    pending: Promise<typeof import("./runtime.ts")>;
    startedAt: number;
    completedAt?: number;
  },
) {
  const [businessPort, hostPort, mainBusinessPort, linkBridgePort, acpPort] = event.ports;
  const parsed = BrainBootstrapSchema.safeParse(event.data);
  if (
    !businessPort ||
    !hostPort ||
    !mainBusinessPort ||
    !linkBridgePort ||
    !acpPort ||
    event.ports.length !== 5 ||
    !parsed.success
  ) {
    process.exit(1);
  }
  const { dataDir, resourcesDir, version, platform, dev, terminalPath } = parsed.data;
  sanitizeBrainEnv(process.env, dataDir);
  const logger = createLogger({
    dir: join(dataDir, "logs"),
    redactor: createRedactor(),
    dev: dev === true,
  });
  logger[cache.status === 0 || cache.status === 1 ? "info" : "warn"](
    JSON.stringify({
      module: "startup",
      event: "compile_cache",
      status: cache.status,
      durationMs: cache.durationMs,
    }),
  );
  const hostPeer = createPeer(utilityPort(hostPort), { methods: HostMethods, events: {} });
  const rtcBridge = createDesktopRtcBridge(linkBridgePort);
  let failControl = () => {};
  const controls = createControlSource<ReturnType<typeof RoutineControlSchema.parse>>(
    (value) =>
      value.type === "ui-active" || value.type === "power-snapshot" ? value.type : undefined,
    () => failControl(),
  );
  const source = new AsyncLocalStorage<"acp" | "desktop-main" | undefined>();
  const acp = createDesktopAcp(
    utilityPort(acpPort),
    version,
    // One ACP client's teardown failure stays with that client: stopping the brain here used to
    // cancel every other topic's run of the same Bot.
    (failures) =>
      logger.warn(JSON.stringify({ module: "acp", event: "connection_cleanup_failed", failures })),
    (event) => logger.info(JSON.stringify({ module: "acp", event, diagnostic: true })),
    join(dataDir, "acp-sessions.json"),
  );
  const settings = desktopSettingsPort(
    businessPorts(
      utilityPort(businessPort),
      utilityPort(mainBusinessPort),
      acp.business,
      (origin, action) => source.run(origin, action),
    ),
    (settings) => {
      parent.postMessage({ type: "settings", settings });
    },
  );
  void (async () => {
    let development: ReturnType<typeof import("./dev-controls.ts").devControls> | undefined;
    let brain: Awaited<ReturnType<typeof startDesktopBrain>> | undefined;
    let stopping = false;
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
    // The brain reports a phase only when startup work actually finishes; the owner's watchdog
    // treats each report as liveness. Throttle so a page-by-page recovery cannot flood the port.
    let reportedPhase = "";
    let reportedAt = 0;
    const reportStartupProgress = (phase: string) => {
      if (stopping) return;
      const now = performance.now();
      if (phase === reportedPhase && now - reportedAt < 1_000) return;
      reportedPhase = phase;
      reportedAt = now;
      parent.postMessage({ type: "startup-progress", phase });
    };
    const startup = new AbortController();
    let starting: Promise<typeof brain> | undefined;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(cacheTimer);
      startup.abort();
      parent.off("message", receive);
      // Every step runs even after an earlier one failed; the failures name their step so a
      // non-zero exit is diagnosable from the log alone.
      const failures: string[] = [];
      const attempt = async (step: string, action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          failures.push(`step=${step} reason=${shutdownReason(error)}`);
        }
      };
      let current: typeof brain;
      await attempt("startup", async () => {
        current = brain ?? (await starting);
      });
      const [routineControls, devControls] = await Promise.allSettled([
        controls.stop(),
        development?.source.stop(),
      ]);
      for (const [step, result] of [
        ["routine_controls", routineControls],
        ["dev_controls", devControls],
      ] as const)
        if (result.status === "rejected")
          failures.push(`step=${step} reason=${shutdownReason(result.reason)}`);
      // A failed input consumer must still release sessions, listeners and the database.
      await attempt("acp_stop", () => acp.dispose());
      await attempt("brain_stop", () => current?.stop());
      await attempt("ports", () => {
        rtcBridge.dispose();
        hostPeer.dispose();
        businessPort.close();
        hostPort.close();
        mainBusinessPort.close();
        acpPort.close();
      });
      if (failures.length) {
        logger.error(`brain shutdown failed ${failures.join("; ")}`);
        process.exit(1);
      }
      process.exit(0);
    };
    const receive = (incoming: { data: unknown }) => {
      if (stopping) return;
      const terminalPath = BrainTerminalPathSchema.safeParse(incoming.data);
      if (terminalPath.success) {
        const path = terminalPath.data.path;
        if (brain) brain.updateTerminalPath(path);
        // Still starting: applied once it is up; a failed start has no environment to update.
        else
          void starting
            ?.then((current) => current?.updateTerminalPath(path))
            .catch(() => undefined);
        return;
      }
      try {
        const wake = BrainWakeRequestSchema.safeParse(incoming.data);
        if (wake.success && parsed.data.independent) {
          const request = wake.data;
          void (async () => {
            const current = brain ?? (await starting);
            if (!current || stopping) throw new Error("brain_not_ready");
            const result = BrainWakeResultSchema.parse(
              await current.backgroundSleep(request.control),
            );
            if (!stopping)
              parent.postMessage({ type: "brain-wake-reply", id: request.id, ok: true, result });
          })().catch(() => {
            logger.warn("Trusted brain sleep control failed");
            if (!stopping)
              parent.postMessage({ type: "brain-wake-reply", id: request.id, ok: false });
          });
          return;
        }
        const background = BackgroundBrainRequestSchema.safeParse(incoming.data);
        if (background.success && parsed.data.independent) {
          const request = background.data;
          void (async () => {
            const current = brain ?? (await starting);
            if (!current) throw new Error("brain_not_ready");
            if (request.operation === "client") {
              if (request.connected === undefined) throw new Error("missing_client_state");
              if (!request.connected) await acp.host.disconnect(AbortSignal.timeout(30_000));
              await current.desktopClient(request.connected);
            }
            parent.postMessage({
              type: "background-reply",
              id: request.id,
              ok: true,
              preferences: current.backgroundPreferences(request.preferences),
            });
          })().catch(() => {
            logger.warn("Trusted background control failed");
            parent.postMessage({ type: "background-reply", id: request.id, ok: false });
          });
          return;
        }
        if (
          development &&
          incoming.data &&
          typeof incoming.data === "object" &&
          "type" in incoming.data &&
          typeof incoming.data.type === "string" &&
          incoming.data.type.startsWith("dev-")
        ) {
          development.receive(incoming.data);
          return;
        }
        const control = BrainControlSchema.safeParse(incoming.data);
        if (!control.success) {
          logger.warn("invalid brain control message");
          return;
        }
        if (control.data.type !== "stop" && brain && !brain.backgroundActivity()) return;
        const routine = RoutineControlSchema.safeParse(control.data);
        if (routine.success) {
          controls.push(routine.data);
          return;
        }
        if (control.data.type === "close-hint-shown") settings.markCloseHint();
        if (control.data.type === "login-item-state")
          settings.syncLoginItem(control.data.openAtLogin);
        if (control.data.type === "navigate") brain?.navigate(control.data.target);
        if (control.data.type === "stop") void stop();
      } catch {
        logger.error("brain control failed");
        void stop();
      }
    };
    failControl = () => {
      logger.error("brain control consumer failed");
      void stop();
    };
    // Register before startup so initialization cannot lose power events or early stop requests.
    parent.on("message", receive);
    starting = (async () => {
      const importingAt = preparedRuntime?.startedAt ?? performance.now();
      const runtime = (preparedRuntime?.pending ?? import("./runtime.ts")).then((module) => {
        const completedAt = preparedRuntime?.completedAt ?? performance.now();
        logger.info(
          JSON.stringify({
            module: "startup",
            event: "brain_runtime_import",
            durationMs: Math.round(completedAt - importingAt),
            startMs: Math.round(importingAt),
            endMs: Math.round(completedAt),
          }),
        );
        return module;
      });
      // A live utility PID cannot prove that the separately transferred host port works.
      // Probe without touching safeStorage so a transport failure is distinct from a locked keyring.
      const [, { startDesktopBrain }] = await Promise.all([
        waitForHost(hostPeer, logger, startup.signal).catch((error) => {
          if (stopping) return;
          logger.error(
            JSON.stringify({
              module: "startup",
              event: "host_rpc_failed",
              method: "host.backgroundState",
              reason: shutdownReason(error),
            }),
          );
          throw error;
        }),
        runtime,
      ]);
      if (stopping) return;
      logger.info(
        JSON.stringify({
          module: "startup",
          event: "host_rpc_ready",
          method: "host.backgroundState",
        }),
      );
      development =
        __PIBOT_DEV_BUILD__ && dev && process.env.PIBOT_TRUSTED_ROUTINE_TEST === dataDir
          ? (await import("./dev-controls.ts")).devControls(() => failControl())
          : undefined;
      const {
        routines: routineHost,
        remote: remoteHost,
        ...host
      } = createBrainHost(hostPeer, logger, controls, development?.source);
      return startDesktopBrain({
        startupProgress: reportStartupProgress,
        // Electron's archive view is useful for code loading, but not physical inode scans.
        aliasFileSystem: (createRequire(import.meta.url)("original-fs") as typeof import("node:fs"))
          .promises,
        interactiveAttached: !parsed.data.independent,
        backgroundControlIdle: () =>
          controls.isIdle() && (!development || development.source.isIdle()),
        port: settings.port,
        host: {
          ...host,
          pickFolder: (signal, options) =>
            source.getStore() === "acp"
              ? acp.folders.host(signal ?? startup.signal)
              : host.pickFolder(signal, options),
        },
        requestSource: () => source.getStore(),
        acp: acp.host,
        routineHost,
        routineDev: development?.routineDev,
        remote: { createRtcPeer: rtcBridge.createPeer, host: remoteHost },
        dataDir,
        resourcesDir,
        version,
        platform,
        terminalPath,
        dev,
        ...(process.env.PIBOT_LOCAL_GMAIL === "1" ? { includeLocalGmail: true } : {}),
      });
    })();
    for (const incoming of pending) receive(incoming);
    brain = await starting;
    if (stopping) return;
    settings.read();
    logger.info(
      JSON.stringify({
        module: "startup",
        event: "brain_process_ready",
        bootstrapAtMs,
        stages: cache.stages,
        readyAtMs: Math.round(performance.now()),
      }),
    );
    parent.postMessage({ type: "ready" });
    // Writing the compile cache is one synchronous native call. After a fresh install or update it
    // writes every module this thread compiled and held the brain for about two seconds, 30 s after
    // ready, often while the user was typing. It now waits until nobody has used the app for a
    // few seconds (or flushes anyway after ten minutes; the process also flushes on exit).
    const flushStarted = performance.now();
    const flushWhenQuiet = () => {
      if (stopping) return;
      const quiet = brain?.quietForMs() ?? Number.POSITIVE_INFINITY;
      if (
        quiet < CACHE_FLUSH_QUIET_MS &&
        performance.now() - flushStarted < CACHE_FLUSH_MAX_WAIT_MS
      ) {
        cacheTimer = setTimeout(flushWhenQuiet, CACHE_FLUSH_QUIET_MS - quiet + 250);
        cacheTimer.unref();
        return;
      }
      brain?.markPhase("compile_cache.flush");
      const began = performance.now();
      try {
        flushCompileCache();
        logger.info(
          JSON.stringify({
            module: "startup",
            event: "compile_cache_flushed",
            durationMs: Math.round(performance.now() - began),
          }),
        );
      } catch {
        logger.warn(JSON.stringify({ module: "startup", event: "compile_cache_flush_failed" }));
      }
      if (cache.root && cache.key)
        void pruneCompileCache(cache.root, cache.key).then((ok) => {
          if (!ok)
            logger.warn(
              JSON.stringify({ module: "startup", event: "compile_cache_cleanup_failed" }),
            );
        });
    };
    cacheTimer = setTimeout(flushWhenQuiet, 30_000);
    cacheTimer.unref();
  })().catch((error: unknown) => {
    if (error instanceof Error && error.message === "database_newer_than_app") {
      logger.error(JSON.stringify({ module: "startup", event: "database_newer_than_app" }));
      parent.postMessage({ type: "startup-failed", reason: "database_newer_than_app" });
    }
    logger.error("brain startup failed");
    rtcBridge.dispose();
    hostPeer.dispose();
    process.exit(1);
  });
  return logger;
}
