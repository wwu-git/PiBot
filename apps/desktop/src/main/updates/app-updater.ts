import type { Logger } from "@pibot/observability";
import {
  ANONYMOUS_STAGING_ID,
  type DesktopUpdateAction,
  type DesktopUpdateReason,
  type DesktopUpdateState,
  type ReleaseNotes,
  ReleaseNotesSchema,
  ReleaseVersionSchema,
  updateUserAgent,
} from "@pibot/protocol";
import type { AppUpdater as ElectronUpdater, ProgressInfo } from "electron-updater";

type UpdaterModule = typeof import("electron-updater");
type CancellationToken = InstanceType<UpdaterModule["CancellationToken"]>;

/**
 * The generic feed electron-builder's latest*.yml files are published to (tools/release/publish.mjs).
 * A check is one GET of latest.yml / latest-mac.yml / latest-linux.yml from this address, with a
 * random cache-busting query, the version and platform in the User-Agent and no identifiers;
 * nothing else is sent. HTTPS only.
 */
export const UPDATE_FEED_URL = "https://pibot.space/updates/";
/**
 * Maintainers 2026-10-22: the app checks on its own shortly after startup and then every few hours
 * (this replaces the earlier click-only policy). It only checks: downloading waits for the
 * user's 「更新」, installing for 「立即重启」 or the next quit after 「稍后」.
 */
const FIRST_CHECK_MS = 60_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

export interface AppUpdaterOptions {
  prepare?(updater: ElectronUpdater): Promise<void>;
  proxyLogin?(
    auth: Electron.AuthInfo,
    callback: (username: string, password: string) => void,
  ): void;
  logger: Logger;
  platform: NodeJS.Platform;
  currentVersion: string;
  blocker: DesktopUpdateReason | undefined;
  /** Loads electron-updater; injected so the background owner never loads it. */
  load(): Promise<UpdaterModule>;
  /** Squirrel.Mac's own events: it, not electron-updater, says when an update is staged. */
  nativeUpdater?: Pick<Electron.AutoUpdater, "on" | "removeListener">;
  /**
   * Stops the background service and releases the app's files before the installer runs.
   * False: this process could not prove that and stays open; nothing is installed.
   */
  shutdown(): Promise<boolean>;
  /** Last resort when the installer did not take over after shutdown: restart the old version. */
  relaunch(): void;
}

export function createAppUpdater(options: AppUpdaterOptions) {
  const { logger } = options;
  let state: DesktopUpdateState = {
    phase: "idle",
    currentVersion: options.currentVersion,
    installable: !options.blocker,
    ...(options.blocker ? { reason: options.blocker } : {}),
    notice: false,
  };
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  // 「稍后」 on the first prompt holds for this launch only.
  const dismissed = new Set<string>();
  let token: CancellationToken | undefined;
  let downloadExceptionGuard: ((error: Error) => void) | undefined;
  let disposed = false;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const cleanups: (() => void)[] = [];
  const set = (patch: Partial<DesktopUpdateState>) => {
    const next: DesktopUpdateState = { ...state, ...patch };
    for (const key of ["version", "percent", "error"] as const)
      if (key in patch && patch[key] === undefined) delete next[key];
    state = next;
    for (const listener of listeners) listener(state);
  };
  const failure = (error: unknown) =>
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code.replace(/[^A-Z0-9_]/gi, "").slice(0, 60)
      : "unexpected";
  const isUpdaterNetworkException = (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const text = `${error.message}\n${error.stack ?? ""}`;
    return (
      /net::ERR_[A-Z0-9_]+/.test(text) &&
      /(electron-updater|builder-util-runtime|DifferentialDownloader)/.test(text)
    );
  };
  const stopDownloadExceptionGuard = () => {
    if (!downloadExceptionGuard) return;
    process.removeListener("uncaughtException", downloadExceptionGuard);
    downloadExceptionGuard = undefined;
  };

  // Dev runs have nothing installed to replace; electron-updater is not even loaded there.
  const loaded: Promise<UpdaterModule | undefined> =
    options.blocker === "dev" ? Promise.resolve(undefined) : options.load();
  const updater: Promise<ElectronUpdater | undefined> = loaded.then((module) => {
    if (!module) return undefined;
    const instance = module.autoUpdater;
    // electron-updater logs feed URLs and file paths; Pi Bot logs its own state changes.
    instance.logger = null;
    instance.autoDownload = false;
    // After 「稍后」 on the second prompt the staged update installs on the next normal quit.
    // On macOS this also lets Squirrel.Mac stage (and verify) the download right away.
    instance.autoInstallOnAppQuit = true;
    instance.allowDowngrade = false;
    instance.allowPrerelease = false;
    instance.fullChangelog = false;
    // Differential: the publish step uploads each installer's .blockmap, so an update fetches
    // only changed blocks (falling back to the full file); the yml's sha512 still checks the result.
    instance.disableDifferentialDownload = false;
    instance.disableWebInstaller = true;
    instance.setFeedURL({ provider: "generic", url: UPDATE_FEED_URL });
    // Electron-updater adds a persistent random `x-user-staging-id` to every check (staged
    // rollouts, which Pi Bot does not use); request headers override it with a constant, and the
    // User-Agent carries only version and platform so the update server can count checks.
    instance.requestHeaders = {
      "User-Agent": updateUserAgent(options.currentVersion, options.platform, process.arch),
      "x-user-staging-id": ANONYMOUS_STAGING_ID,
    };
    const progress = (info: ProgressInfo) => {
      const percent = Math.max(0, Math.min(100, Math.floor(info.percent)));
      if (state.phase === "downloading" && percent !== state.percent) set({ percent });
    };
    instance.on("download-progress", progress);
    if (options.proxyLogin) instance.on("login", options.proxyLogin);
    // Errors also reject the awaited call. Keep the emitter from throwing and publish the same
    // retryable state when an updater error arrives after its promise has settled.
    const error = (reason?: unknown) => {
      if (state.phase !== "downloading") return;
      logger.warn(`Update download failed (${failure(reason)})`);
      set({ phase: "error", error: "download", percent: undefined });
    };
    instance.on("error", error);
    const remove = () => {
      instance.removeListener("download-progress", progress);
      if (options.proxyLogin) instance.removeListener("login", options.proxyLogin);
      instance.removeListener("error", error);
    };
    if (disposed) remove();
    else cleanups.push(remove);
    return instance;
  });
  void updater.catch(() => logger.warn("Update service unavailable"));

  const staged = () => {
    if (state.phase === "downloading") set({ phase: "downloaded", percent: 100, notice: true });
  };
  const stageFailed = () => {
    if (state.phase === "downloading" || state.phase === "downloaded") {
      logger.warn("Update could not be staged for installation");
      set({ phase: "error", error: "install", percent: undefined });
    }
  };
  if (options.platform === "darwin" && options.nativeUpdater) {
    const native = options.nativeUpdater;
    native.on("update-downloaded", staged);
    native.on("error", stageFailed);
    cleanups.push(() => {
      native.removeListener("update-downloaded", staged);
      native.removeListener("error", stageFailed);
    });
  }

  async function check(automatic: boolean) {
    if (["checking", "downloading", "downloaded", "installing"].includes(state.phase)) return;
    const instance = await updater.catch(() => undefined);
    if (!instance || disposed) {
      if (!automatic && options.blocker !== "dev") set({ phase: "error", error: "network" });
      return;
    }
    const previous = state;
    set({ phase: "checking", error: undefined });
    try {
      await options.prepare?.(instance);
      if (disposed) return;
      const result = await instance.checkForUpdates();
      const version = ReleaseVersionSchema.safeParse(result?.updateInfo.version);
      if (!result?.isUpdateAvailable) {
        set({
          phase: "current",
          version: undefined,
          notes: undefined,
          percent: undefined,
          notice: false,
        });
        return;
      }
      if (!version.success) throw new Error("update_version_invalid");
      const notes = releaseNotes(result.updateInfo.releaseNotes);
      logger.info(`Update ${version.data} found (${automatic ? "automatic" : "manual"} check)`);
      set({
        phase: "available",
        version: version.data,
        notes,
        percent: undefined,
        // A manual check shows the result in its own panel.
        notice: automatic ? !dismissed.has(version.data) : state.notice,
      });
    } catch (error) {
      const code = failure(error);
      // No feed for this platform on the release server (none published yet, or a release was
      // withdrawn) means nothing newer to install, not a network problem; showing "check your
      // network" here sent people looking for a fault that did not exist (v0.0.2 test, 2026-11-13).
      if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") {
        logger.info("Update check: no release feed for this platform");
        set({
          phase: "current",
          version: undefined,
          notes: undefined,
          percent: undefined,
          notice: false,
        });
        return;
      }
      logger.warn(`Update check failed (${code})`);
      // An automatic check fails quietly; the next one or a manual check reports it.
      if (automatic) set({ ...previous });
      else set({ phase: "error", error: "network" });
    }
  }

  /** Resolves once downloading has started; progress and the outcome arrive as state pushes. */
  async function download() {
    const retry = state.phase === "error" && state.error === "download";
    if (!state.installable || !state.version || (state.phase !== "available" && !retry)) return;
    const instance = await updater.catch(() => undefined);
    const module = await loaded.catch(() => undefined);
    if (!instance || !module || disposed || state.phase === "downloading") return;
    const current = new module.CancellationToken();
    token = current;
    set({ phase: "downloading", percent: 0, error: undefined });
    const uncaught = (error: Error) => {
      if (isUpdaterNetworkException(error) && state.phase === "downloading") {
        logger.warn(`Update download failed (${failure(error)})`);
        set({ phase: "error", error: "download", percent: undefined });
        return;
      }
      stopDownloadExceptionGuard();
      // Let Electron's default handler own unrelated exceptions after our guard is gone.
      setImmediate(() => {
        if (process.listenerCount("uncaughtException") > 0) return;
        throw error;
      });
    };
    downloadExceptionGuard = uncaught;
    process.on("uncaughtException", uncaught);
    void Promise.resolve()
      .then(() => options.prepare?.(instance))
      .then(() => {
        if (disposed) return;
        if (current.cancelled) {
          set({ phase: "available", percent: undefined });
          return;
        }
        return instance.downloadUpdate(current);
      })
      .then(() => {
        if (disposed || current.cancelled) return;
        logger.info(`Update ${state.version} downloaded`);
        // Squirrel.Mac verifies the signature after this; its own event marks the update ready.
        if (options.platform !== "darwin") staged();
      })
      .catch((error: unknown) => {
        if (current.cancelled) set({ phase: "available", percent: undefined });
        else if (state.phase === "downloading") {
          logger.warn(`Update download failed (${failure(error)})`);
          set({ phase: "error", error: "download", percent: undefined });
        }
      })
      .finally(() => {
        if (token === current) token = undefined;
        if (downloadExceptionGuard === uncaught) stopDownloadExceptionGuard();
      });
  }

  async function install() {
    if (state.phase !== "downloaded") return;
    const instance = await updater.catch(() => undefined);
    if (!instance) return;
    set({ phase: "installing", error: undefined, notice: false });
    let released = false;
    try {
      released = await options.shutdown();
    } catch {
      released = false;
    }
    if (!released) {
      logger.warn("Update install postponed: the app could not release its files");
      set({ phase: "downloaded", error: "install", notice: true });
      return;
    }
    logger.info(`Installing update ${state.version} and restarting`);
    // Silent and relaunching: NSIS runs without its window and starts the new version; the
    // AppImage is swapped and restarted; Squirrel.Mac relaunches on its own.
    instance.quitAndInstall(true, true);
    // Everything is already shut down; if the installer never quit this process, come back up
    // as the old version instead of lingering without a window (the update stays cached).
    timers.push(
      setTimeout(() => {
        logger.error("Update installer did not take over; restarting the current version");
        options.relaunch();
      }, 20_000),
    );
  }

  function dismiss() {
    if (state.version && state.phase !== "downloaded") dismissed.add(state.version);
    set({ notice: false });
  }

  return {
    state: () => state,
    async run(action: DesktopUpdateAction) {
      switch (action) {
        case "check":
          await check(false);
          break;
        case "download":
          await download();
          break;
        case "cancel":
          token?.cancel();
          break;
        case "install":
          await install();
          break;
        case "dismiss":
          dismiss();
          break;
        case "state":
          break;
      }
      return state;
    },
    subscribe(listener: (state: DesktopUpdateState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Starts the automatic checks; packaged builds only. */
    start() {
      if (options.blocker === "dev" || disposed) return;
      const automatic = () => void check(true);
      timers.push(setTimeout(automatic, FIRST_CHECK_MS), setInterval(automatic, CHECK_INTERVAL_MS));
    },
    /** A staged update installs when the app quits, so the background service must stop too. */
    installPending: () => state.phase === "downloaded" || state.phase === "installing",
    dispose() {
      disposed = true;
      // clearTimeout also clears setInterval handles in Node.
      for (const timer of timers) clearTimeout(timer);
      timers = [];
      token?.cancel();
      stopDownloadExceptionGuard();
      for (const cleanup of cleanups.splice(0)) cleanup();
      listeners.clear();
    },
  };
}
export type AppUpdater = ReturnType<typeof createAppUpdater>;

/** The feed's releaseNotes is a JSON string (tools/release/publish.mjs); anything else is ignored. */
function releaseNotes(raw: unknown): ReleaseNotes | undefined {
  if (typeof raw !== "string" || raw.length > 20_000) return undefined;
  try {
    const parsed = ReleaseNotesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Notes are optional; a malformed field must not block the update itself.
    return undefined;
  }
}
