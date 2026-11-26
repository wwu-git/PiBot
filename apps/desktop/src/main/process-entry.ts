import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TranslationKey } from "@pibot/i18n";
import { createLogger } from "@pibot/observability";
import { createRedactor } from "@pibot/secrets";
import { app, dialog } from "electron";
import type { prelaunchBackground } from "./background/background-prelaunch.ts";
import type { prelaunchBrainProcess } from "./brain/brain-process.ts";
import { monitorMainEventLoop } from "./event-loop-monitor.ts";
import { createMainStartupTiming } from "./startup-timing.ts";
import type { ProviderLinkInbox } from "./window/provider-link-inbox.ts";

/** Loaded after app ready; native owner and GUI graphs remain separate dynamic chunks. */
export async function startMain(options: {
  dataDir: string;
  version: string;
  dev: boolean;
  background: boolean;
  embedded: boolean;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
  prelaunch?: ReturnType<typeof prelaunchBackground>;
  compileCache?: Promise<{ status: number; durationMs: number } | undefined>;
  signal: AbortSignal;
  providerLinks: ProviderLinkInbox;
  /** The role's file logger, for work the entry point schedules later (the compile-cache flush). */
  onLogger?(logger: { info(message: string): void; warn(message: string): void }): void;
  bootstrap: {
    entryAtMs: number;
    cacheMs: number;
    appReadyAtMs: number;
    importMs: number;
    status: number;
    ownerLaunchAtMs?: number;
    cacheDeferred?: boolean;
  };
}) {
  const { dataDir, version, dev, background, embedded, originalEnv, prelaunch, signal, bootstrap } =
    options;
  const redactor = createRedactor();
  const logsDir = join(dataDir, background ? "host-logs" : "gui-logs");
  const logger = createLogger({
    dir: logsDir,
    redactor,
    dev,
  });
  options.onLogger?.(logger);
  logger[
    bootstrap.cacheDeferred || bootstrap.status === 0 || bootstrap.status === 1 ? "info" : "warn"
  ](
    JSON.stringify({
      module: "startup",
      event: "main_bootstrap",
      role: background ? "owner" : embedded ? "embedded" : "gui",
      ...bootstrap,
    }),
  );
  void options.compileCache?.then((cache) => {
    if (!cache || signal.aborted) return;
    logger[cache.status === 0 || cache.status === 1 ? "info" : "warn"](
      JSON.stringify({ module: "startup", event: "main_compile_cache_ready", ...cache }),
    );
  });
  const timing = createMainStartupTiming();
  timing.mark("app_ready", bootstrap.appReadyAtMs);
  timing.mark("bootstrap_import");
  const stopMonitor = monitorMainEventLoop(logger);
  app.once("will-quit", stopMonitor);
  const outputDir = fileURLToPath(new URL(".", import.meta.url));
  let prelaunchedBrain: ReturnType<typeof prelaunchBrainProcess> | undefined;
  const preparation = new AbortController();
  // Not the preparation signal: the adopted claim must outlive this function's finally.
  const earlyOwner = new AbortController();
  const cancelPreparation = () => {
    preparation.abort();
    // Reached after the role adopted the claim (the claim keeps no signal) or on a quit.
    earlyOwner.abort();
    prelaunchedBrain?.dispose();
  };
  signal.addEventListener("abort", cancelPreparation, { once: true });
  try {
    if (!background) {
      const { registerAppUrlScheme } = await import("./window/app-url.ts");
      if (signal.aborted) return;
      registerAppUrlScheme(dev, logger);
    }
    const started = performance.now();
    if (!background && !embedded) {
      // Window first. The early window module is small; the role graph below is not, and
      // the renderer process boots and paints the cached screen while it evaluates. The role
      // import starts only after the window exists: its synchronous evaluation would otherwise
      // run ahead of the window on this thread.
      const [{ createEarlyWindow }, { readSystemLocale }] = await Promise.all([
        import("./gui/early-window.ts"),
        import("./window/system-locale.ts"),
      ]);
      if (signal.aborted) return;
      const systemLocale = readSystemLocale({
        platform: process.platform,
        fallback: app.getLocale(),
        systemRoot: originalEnv.SystemRoot ?? originalEnv.SYSTEMROOT,
        logger,
        signal,
      });
      const early = createEarlyWindow({
        dataDir,
        outputDir,
        dev,
        rendererUrl: originalEnv.ELECTRON_RENDERER_URL,
        logger,
        systemLocale: process.platform === "win32" ? systemLocale : undefined,
      });
      timing.mark("early_window");
      // Serve the renderer's first-frame reads before this thread is busy evaluating the role
      // graph: IPC waits for this thread, and a read stuck behind the role import misses its
      // deadline, so the cached screen never shows. On a loaded machine the renderer needed
      // ~1.9 s to ask, so the cap is generous; a cold owner takes longer than
      // that to become ready, and with a running owner the App chunk load is the longer leg.
      await Promise.race([early.firstFrame, delay(3000, undefined, { ref: false })]);
      timing.mark("first_frame_served");
      if (signal.aborted) {
        early.window.destroy();
        return;
      }
      let startGuiClient: typeof import("./gui/gui-client.ts").startGuiClient;
      try {
        ({ startGuiClient } = await import("./gui/gui-client.ts"));
      } catch (error) {
        early.window.destroy();
        throw error;
      }
      if (signal.aborted) {
        early.window.destroy();
        return;
      }
      timing.mark("role_import");
      timing.report(logger, "gui_setup");
      await startGuiClient({
        dataDir,
        outputDir,
        version,
        dev,
        originalEnv,
        logger,
        prelaunch,
        early,
        systemLocale,
        providerLinks: options.providerLinks,
      });
      return;
    }
    const phase = (
      event: "role_import" | "brain_resources" | "brain_fork_import" | "owner_reserve_early",
      from: number,
    ) =>
      logger.info(
        JSON.stringify({
          module: "startup",
          event,
          role: embedded ? "embedded" : "owner",
          platform: process.platform,
          startMs: Math.round(from),
          endMs: Math.round(performance.now()),
          durationMs: Math.round(performance.now() - from),
          sinceProcessMs: Math.round(performance.now()),
        }),
      );
    const resources = import("./brain/brain-resources.ts")
      .then(({ prepareBrainResources }) =>
        prepareBrainResources({
          dev,
          outputDir,
          desktopDir: fileURLToPath(new URL("../../", import.meta.url)),
          packagedResourcesDir: process.resourcesPath,
          platform: process.platform,
          arch: process.arch,
        }),
      )
      .then((directory) => {
        phase("brain_resources", started);
        return directory;
      });
    // Trusted routine fixtures need role-level validation before choosing the child's env.
    const forkModule =
      background && app.hasSingleInstanceLock() && !(dev && originalEnv.PIBOT_ROUTINE_TEST_DIR)
        ? import("./brain/brain-process.ts").then((module) => {
            phase("brain_fork_import", started);
            return module;
          })
        : undefined;
    const warm = Promise.all([resources, forkModule]).then(([, module]) => {
      if (!module || signal.aborted || preparation.signal.aborted) return;
      try {
        prelaunchedBrain = module.prelaunchBrainProcess({
          dataDir,
          outputDir,
          originalEnv,
          logger,
          dev,
          version: app.getVersion(),
        });
      } catch {
        logger.warn("Early brain fork unavailable; the owner will fork after setup");
      }
    });
    // The brain's code load is the longest step before the first screen and runs in its own
    // process, so fork it before evaluating the owner role graph: importing both at once made the
    // fork wait for the whole owner graph (role_import and brain_fork_import ended together).
    const importRole = (): Promise<
      typeof import("./gui/embedded-desktop.ts") | typeof import("./background/background-owner.ts")
    > =>
      embedded ? import("./gui/embedded-desktop.ts") : import("./background/background-owner.ts");
    const importing = (forkModule ? warm : Promise.resolve()).then(importRole).then((role) => {
      phase("role_import", started);
      return role;
    });
    // The writer claim / private descriptor and the display language run beside the role
    // import (same conditions as the early fork: the single-instance lock is held).
    const ownerPrep =
      forkModule && !embedded
        ? import("./background/background-early.ts").then(({ prepareOwnerEarly }) => {
            const prepared = prepareOwnerEarly({
              dataDir,
              version,
              originalEnv,
              executable: process.execPath,
              locale: app.getLocale(),
              logger,
              signal: earlyOwner.signal,
            });
            void prepared.reservation.then(
              () => phase("owner_reserve_early", started),
              () => {},
            );
            return prepared;
          })
        : undefined;
    let preparedOwner: Awaited<typeof ownerPrep>;
    let role: Awaited<typeof importing>;
    let resourcesDir: Awaited<typeof resources>;
    try {
      [role, resourcesDir, , preparedOwner] = await Promise.all([
        importing,
        resources,
        warm,
        ownerPrep,
      ]);
    } catch (error) {
      // The role never adopted the early claim: stop it and give it back (best effort).
      earlyOwner.abort();
      void ownerPrep
        ?.then(({ reservation }) => reservation)
        .then((reservation) => reservation.release())
        .catch(() => {});
      throw error;
    }
    if (signal.aborted) return;
    timing.mark("owner_parallel_setup");
    const roleOptions = {
      dataDir,
      outputDir,
      resourcesDir,
      version,
      dev,
      originalEnv,
      logger,
      redactor,
    };
    if ("startEmbeddedDesktop" in role) await role.startEmbeddedDesktop(roleOptions);
    else
      await role.startBackgroundOwner({
        ...roleOptions,
        prelaunchedBrain,
        timing,
        early: preparedOwner,
        providerLinks: options.providerLinks,
      });
  } catch (error) {
    prelaunch?.dispose();
    if (signal.aborted) return;
    const code =
      error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
        ? error.message
        : "unexpected";
    logger.error(`Desktop role startup failed (${code}); no replacement writer authorized`);
    const exit = () => (embedded ? app.quit() : app.exit(1));
    if (!background) {
      // Translations are loaded only for this dialog; the owner and GUI roles import them
      // themselves, so the startup path does not evaluate both tables before forking the brain.
      const [{ createTranslator, resolveLanguage }, { DATA_DIR_SOCKET_BUDGET_BYTES }] =
        await Promise.all([import("@pibot/i18n"), import("./background/background-directory.ts")]);
      const t = createTranslator(
        resolveLanguage("system", app.getPreferredSystemLanguages()[0] ?? app.getLocale()),
      );
      // The old text told a fresh install to "quit the old version", which is wrong for
      // the common slow-start timeout; name the actual reason and let the user retry.
      const failureKey = (failure: string): TranslationKey => {
        if (failure === "background_windows_security_security_rejected_listener_missing")
          return "background.startupWindowsListenerUnverified";
        return failure === "database_newer_than_app"
          ? "startup.newerData"
          : failure.startsWith("background_windows_security_timeout")
            ? "background.startupSecurityTimeout"
            : failure === "background_launch_timeout" ||
                failure === "background_not_ready" ||
                failure === "background_owner_exited"
              ? "background.startupTimeout"
              : failure === "background_version_mismatch_stop_old_owner_first"
                ? "background.startupOldVersion"
                : // The data folder is writable by other accounts (e.g. created at C:\ root, which
                  // grants Authenticated Users: Modify); the generic text gave no way forward.
                  failure === "background_descriptor_permissions"
                  ? "background.startupDataFolderUnsafe"
                  : // A deep PIBOT_DATA_DIR leaves no room for the owner's socket path.
                    failure === "background_socket_path_too_long"
                    ? "background.startupDataFolderPathTooLong"
                    : "background.startupFailed";
      };
      // showErrorBox blocks the main thread until it is dismissed, so a failed GUI startup could
      // not handle SIGTERM and had to be force-quit. The async box keeps the process
      // responsive; closing it exits and "retry" starts a fresh process.
      void dialog
        .showMessageBox({
          type: "error",
          title: app.getName(),
          // The folder is named only in this local dialog, never in the log line above.
          message: t(failureKey(code), {
            folder: dataDir,
            logsFolder: logsDir,
            max: DATA_DIR_SOCKET_BUDGET_BYTES,
          }),
          buttons: [t("background.startupRetry"), t("background.startupQuit")],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) app.relaunch();
          exit();
        }, exit);
      return;
    }
    exit();
  } finally {
    signal.removeEventListener("abort", cancelPreparation);
    cancelPreparation();
  }
}
