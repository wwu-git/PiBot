import { mkdirSync, realpathSync } from "node:fs";
import { enableCompileCache, flushCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDataDir } from "@pibot/storage/data-dir";
import { app } from "electron";
import { bundleIdentity, pruneCompileCache } from "../shared/bundle-identity.ts";
import { guardConsoleStreams } from "../shared/console-guard.ts";
import { linuxPasswordStore } from "./window/linux-password-store.ts";
import { captureProviderLinks } from "./window/provider-link-inbox.ts";

/** The compile-cache flush waits for this much quiet after the last input in any window. */
const CACHE_FLUSH_QUIET_MS = 5_000;
const CACHE_FLUSH_MAX_WAIT_MS = 10 * 60_000;

// A closed stdout/stderr pipe must never become a crash dialog (see console-guard.ts).
guardConsoleStreams([process.stdout, process.stderr]);

// Chromium switches, process identity and the role lock must precede every asynchronous import.
// FeatureList is initialized before per-window renderer arguments can override it.
const disabledRtcFeatures = app.commandLine
  .getSwitchValue("disable-features")
  .split(",")
  .filter(Boolean);
app.commandLine.appendSwitch(
  "disable-features",
  [...new Set([...disabledRtcFeatures, "WebRtcHideLocalIpsWithMdns"])].join(","),
);
// Apply before any page loads, including future Bot browser WebContents.
app.on("web-contents-created", (_event, contents) => {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
});
const entryAtMs = Math.round(performance.now());
const originalEnv = Object.freeze({ ...process.env });
const dev = !app.isPackaged;
const background = process.argv.includes("--pibot-background");
const embedded = false;
if (process.platform === "linux") {
  app.enableSandbox();
  app.commandLine.appendSwitch("disable-setuid-sandbox");
}
if (process.argv.includes("--sandbox-doctor")) {
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  void import("./sandbox-doctor-entry.ts")
    .then(({ startSandboxDoctor }) =>
      startSandboxDoctor(originalEnv, app.isPackaged ? process.resourcesPath : undefined),
    )
    .then((code) => app.exit(code))
    .catch(() => {
      process.stderr.write("pibot sandbox doctor: startup_failed\n");
      app.exit(1);
    });
} else if (process.platform === "linux" && process.argv.includes("--pibot-sandbox-probe")) {
  void import("./linux/sandbox-probe.ts")
    .then(({ probeChromiumSandbox }) => probeChromiumSandbox())
    .then(() => app.exit(0))
    .catch(() => app.exit(1));
} else if (process.argv.includes("--pibot-browser-native-host")) {
  // Started by the user's browser for the extension; no window, no Dock icon.
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  void import("./browser-extension/browser-native-entry.ts")
    .then(({ startBrowserNativeEntry }) => startBrowserNativeEntry({ env: originalEnv, dev }))
    .then((code) => app.exit(code))
    .catch(() => app.exit(1));
} else if (process.argv.includes("--acp")) {
  void import("./acp-entry.ts")
    .then(({ startAcpEntry }) =>
      startAcpEntry({ env: originalEnv, dev, version: app.getVersion(), entry: import.meta.url }),
    )
    .then((code) => app.exit(code))
    .catch(() => {
      process.stderr.write("pibot acp: protocol_error\n");
      app.exit(1);
    });
} else {
  if (process.platform === "darwin") {
    if (background) app.commandLine.appendSwitch("disable-gpu-compositing");
    else app.setActivationPolicy("regular");
  }
  const passwordStore =
    process.platform === "linux" ? linuxPasswordStore(originalEnv, process.argv) : undefined;
  if (passwordStore) app.commandLine.appendSwitch("password-store", passwordStore);
  if (background && embedded) app.exit(1);
  else {
    const requested = resolveDataDir({
      platform: process.platform,
      env: originalEnv,
      homedir: homedir(),
      dev,
    });
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    const dataDir = realpathSync(requested);
    app.setName(dev ? "Pi Bot Dev" : "Pi Bot");
    if (process.platform === "win32" && !dev) app.setAppUserModelId("app.pibot.desktop");
    const roleDir = background || embedded ? dataDir : join(dataDir, "gui-instance");
    mkdirSync(roleDir, { recursive: true, mode: 0o700 });
    app.setPath("userData", roleDir);
    if (background && process.platform === "darwin") app.dock?.hide();
    if (!app.requestSingleInstanceLock()) app.quit();
    else {
      let prelaunch:
        | ReturnType<typeof import("./background/background-prelaunch.ts").prelaunchBackground>
        | undefined;
      const lifetime = new AbortController();
      const providerLinks = captureProviderLinks(process.argv, lifetime.signal);
      const quitGui = () => app.quit();
      if (!background && !embedded) process.on("SIGTERM", quitGui);
      app.once("will-quit", () => {
        process.off("SIGTERM", quitGui);
        lifetime.abort();
        prelaunch?.dispose();
      });
      const ready = app.whenReady().then(() => Math.round(performance.now()));
      void (async () => {
        let status = 2;
        const started = performance.now();
        const hash = await bundleIdentity(import.meta.url, app.getVersion());
        const version = `${app.getVersion()}:${hash}`;
        const initializeCache = () => {
          const start = performance.now();
          try {
            status = enableCompileCache(join(dataDir, "main-compile-cache", hash)).status;
          } catch {
            /* Cache failure is diagnostic only; the role logger reports the fixed status. */
          }
          return { status, durationMs: Math.round(performance.now() - start) };
        };
        // Enabled before the launcher import: the GUI must evaluate zod and the protocol schemas
        // before it can spawn the owner, and on a normal launch that compile comes from the cache
        // (enabling costs a few ms of directory IO; the hash read above is one small file).
        const compileCache = Promise.resolve(initializeCache());
        const launcher =
          !background && !embedded ? import("./background/background-prelaunch.ts") : undefined;
        let ownerLaunchAtMs: number | undefined;
        const launching = launcher
          ? launcher.then(({ prelaunchBackground }) => {
              if (lifetime.signal.aborted) return;
              ownerLaunchAtMs = Math.round(performance.now());
              prelaunch = prelaunchBackground({
                dataDir,
                version,
                dev,
                env: originalEnv,
                owner: {
                  file: process.execPath,
                  args: [
                    ...(dev ? [app.getAppPath()] : []),
                    "--pibot-background",
                    "--pibot-from-gui",
                    ...process.argv.filter((arg) => arg.startsWith("--password-store=")),
                  ],
                },
              });
            })
          : Promise.resolve();
        void launching.catch(() => {}); // The startup catch below owns failures.
        await launching;
        if (lifetime.signal.aborted) return;
        // The owner is the long pole of the first screen. Let the launcher's few descriptor awaits
        // reach the spawn before this thread evaluates the window graph (hundreds of ms of
        // synchronous module code). Only its first decision is awaited, never a retiring owner's
        // exit, and the cap keeps a slow Windows security check from holding the window back.
        if (prelaunch)
          await Promise.race([prelaunch.decided, delay(1000, undefined, { ref: false })]);
        if (lifetime.signal.aborted) return;
        const cacheMs = Math.round(performance.now() - started);
        const appReadyAtMs = await ready;
        if (lifetime.signal.aborted) return;
        const importing = performance.now();
        const { startMain } = await import("./process-entry.ts");
        if (lifetime.signal.aborted) return;
        let mainLogger: { info(message: string): void; warn(message: string): void } | undefined;
        // Any keyboard or mouse input, or a window gaining focus, counts as someone using the app.
        let lastInput = 0;
        const noteInput = () => {
          lastInput = performance.now();
        };
        app.on("browser-window-created", (_event, window) => {
          window.on("focus", noteInput);
          window.webContents.on("input-event", noteInput);
        });
        await startMain({
          onLogger: (logger) => {
            mainLogger = logger;
          },
          dataDir,
          version,
          dev,
          background,
          embedded,
          originalEnv,
          prelaunch,
          providerLinks,
          compileCache,
          signal: lifetime.signal,
          bootstrap: {
            entryAtMs,
            cacheMs,
            appReadyAtMs,
            importMs: Math.round(performance.now() - importing),
            status,
            ownerLaunchAtMs,
          },
        });
        if (lifetime.signal.aborted) return;
        await compileCache;
        if (lifetime.signal.aborted) return;
        // Best-effort disk writes must not compete with first-screen reads. The flush is one
        // synchronous call that, after an install or update, freezes this process (and every
        // window) for as long as it writes; like the brain's, it waits until nobody has touched
        // a window for a few seconds, gives up waiting after ten minutes, and exit still flushes.
        const flushStarted = performance.now();
        let cacheTimer: ReturnType<typeof setTimeout>;
        const flushWhenQuiet = () => {
          if (lifetime.signal.aborted) return;
          const quiet = performance.now() - lastInput;
          if (
            quiet < CACHE_FLUSH_QUIET_MS &&
            performance.now() - flushStarted < CACHE_FLUSH_MAX_WAIT_MS
          ) {
            cacheTimer = setTimeout(flushWhenQuiet, CACHE_FLUSH_QUIET_MS - quiet + 250);
            cacheTimer.unref();
            return;
          }
          const began = performance.now();
          try {
            flushCompileCache();
            mainLogger?.info(
              JSON.stringify({
                module: "startup",
                event: "compile_cache_flushed",
                process: "main",
                durationMs: Math.round(performance.now() - began),
              }),
            );
          } catch {
            (mainLogger ?? console).warn(
              JSON.stringify({ module: "startup", event: "main_compile_cache_flush_failed" }),
            );
          }
          void pruneCompileCache(join(dataDir, "main-compile-cache"), hash).then((ok) => {
            if (!ok)
              (mainLogger ?? console).warn(
                JSON.stringify({ module: "startup", event: "main_compile_cache_prune_failed" }),
              );
          });
        };
        cacheTimer = setTimeout(flushWhenQuiet, 30_000);
        cacheTimer.unref();
        app.once("will-quit", () => clearTimeout(cacheTimer));
      })().catch(() => {
        if (lifetime.signal.aborted) return;
        console.error(JSON.stringify({ module: "startup", event: "main_bootstrap_failed" }));
        app.exit(1);
      });
    }
  }
}
