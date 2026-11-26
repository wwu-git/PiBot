// Keep Windows computer actions tied to the host’s Windows app identities.
import type { AppInfo, ComputerDriver, SessionState } from "../core/types.ts";
import { windowsPackagedAppId } from "../core/windows-app-id.ts";
import type { Cua } from "../cua/loader.ts";
import { createCuaComputerDriver, runningAppRows } from "./cua-driver.ts";
import {
  packagedAppIdForImage,
  resolveWindowsAppName,
  uniqueWindowsApps,
  windowsAppId,
  windowsLaunchPath,
} from "./win-app-names.ts";
import { createWindowsFrameHosts, isFrameHostApp } from "./win-frame-hosts.ts";
import { createWindowsProcessPaths } from "./win-process-paths.ts";
import { createWindowsSecureFocus } from "./win-secure-focus.ts";

/**
 * Windows: Cua for everything including background coordinate input (20/20 hits
 * on occluded windows, cursor untouched). Known gaps: elevated (admin) windows
 * reject input from a normal process (UIPI); a non-interactive session (session 0) cannot
 * create the driver at all, which surfaces as `unavailableReason`. Password-field detection for
 * free-form keys comes from UI Automation plus the Win32 edit style (win-secure-focus); an
 * inconclusive answer refuses the input instead of letting it through.
 *
 * Classic store apps (Calculator, Settings) draw inside an ApplicationFrameHost.exe window and
 * were therefore listed as a process that belongs to no app; win-frame-hosts pairs each frame
 * window with the process drawing inside it and the rows below report that process.
 */
export function createWindowsDriver(options: {
  load(): Promise<Cua>;
  /** Idle seconds and lock state from the host (Electron powerMonitor). */
  session(signal?: AbortSignal): Promise<SessionState>;
  timeoutMs?: number;
  windowsProgramFiles?: string;
}): ComputerDriver {
  const cua = createCuaComputerDriver({
    platform: "win32",
    load: options.load,
    timeoutMs: options.timeoutMs,
    features: {
      backgroundClick: true,
      backgroundDrag: true,
      backgroundKeys: true,
      // Cua's Windows tree reports password edits as plain Edit.
      secureTree: false,
    },
    appId: (app, apps) => windowsAppId(app, apps, options.windowsProgramFiles),
    enrichApps: createWindowsProcessPaths(),
    session: options.session,
  });
  const secure = createWindowsSecureFocus();
  const frames = createWindowsFrameHosts();

  /**
   * The frame host row names no app the user can grant ("applicationframehost.exe"). Each frame it
   * hosts is listed under the hosted app's own identity instead; an identity the app list does not
   * prove keeps the frame host row and the honest "unsupported" answer.
   */
  async function hostedApps(
    installed: readonly { name: string; launchPath?: string | null }[],
    signal?: AbortSignal,
  ) {
    const rows: AppInfo[] = [];
    const replaced = new Set<number>();
    const hostedPids = new Set<number>();
    for (const frame of await frames.frames(signal)) {
      // Cua does not list the app's own process, so only the installed rows of the same list can
      // name it; passing the running rows never matched Calculator.
      const id = packagedAppIdForImage(frame.appPath ?? "", installed, options.windowsProgramFiles);
      if (!id || hostedPids.has(frame.appPid)) continue;
      hostedPids.add(frame.appPid);
      replaced.add(frame.hostPid);
      rows.push({ id, name: frame.title ?? id, pid: frame.appPid, active: frame.foreground });
    }
    return { rows, replaced, hostedPids };
  }

  const driver: ComputerDriver = {
    ...cua.driver,
    // Cua cannot tell whether the focused control is a password field; UI Automation can.
    secureFocus: secure.secureFocus,
    async listApps(signal) {
      // One Cua list feeds both the running rows and the hosted identity; asking Cua twice would
      // add a full round trip to every list_apps.
      const listed = await (await cua.cua()).listApps(signal);
      const apps = runningAppRows(listed.apps, windowsAppId);
      // Only a listed frame host can hide a store app, so the usual list_apps never pays for the
      // query at all.
      if (!listed.apps.some(isFrameHostApp)) return apps;
      const hosted = await hostedApps(listed.apps, signal);
      if (!hosted.rows.length) return apps;
      // The frame host row is not the app, and a running row for the hosted process itself would
      // repeat the hosted row (same id, same pid): Cua sometimes lists CalculatorApp.exe next to
      // ApplicationFrameHost.
      return [
        ...apps.filter((app) => !hosted.replaced.has(app.pid) && !hosted.hostedPids.has(app.pid)),
        ...hosted.rows,
      ];
    },
    // Cua's own foreground check reads its own list; it must see the hosted rows too, or a
    // foreground keystroke into a store app would be refused as "not frontmost".
    async frontmostApp(signal) {
      return (await driver.listApps(signal)).find((app) => app.active) ?? null;
    },
    async windows(pid, signal) {
      const own = (await frames.frames(signal)).filter((frame) => frame.appPid === pid);
      if (!own.length) return cua.driver.windows(pid, signal);
      const hostPid = own[0]?.hostPid;
      if (hostPid === undefined) return [];
      const listed = await cua.driver.windows(hostPid, signal);
      const byWindow = new Map(own.map((frame) => [frame.windowId, frame]));
      return listed.flatMap((window) => {
        const frame = byWindow.get(window.id);
        // The frame host may also carry windows we did not pair; they stay out of this app.
        return frame ? [{ ...window, pid: frame.appPid, hostPid: frame.hostPid }] : [];
      });
    },
    async onScreenWindows(signal) {
      const listed = await cua.driver.onScreenWindows(signal);
      const pairs = await frames.frames(signal);
      if (!pairs.length) return listed;
      const byWindow = new Map(pairs.map((frame) => [`${frame.hostPid}:${frame.windowId}`, frame]));
      return listed.map((window) => {
        const frame = byWindow.get(`${window.pid}:${window.id}`);
        return frame ? { ...window, pid: frame.appPid, hostPid: frame.hostPid } : window;
      });
    },
    // A covered window has no usable point, but its elements can still be identified.
    secureElement: secure.secureElement,
    // Selecting a row goes through UI Automation rather than Cua's "pick" click, which moved the
    // real pointer onto the row and back.
    selectElement: secure.selectElement,
    async release() {
      // The resident PowerShell helpers outlive a single call; stop them with the driver.
      frames.release();
      secure.release();
      await cua.driver.release?.();
    },
    async resolveAppName(name, signal) {
      const result = await (await cua.cua()).listApps(signal);
      return resolveWindowsAppName(name, result.apps, options.windowsProgramFiles);
    },
    async installedApps(limit, signal) {
      const result = await (await cua.cua()).listApps(signal);
      const apps = new Map<string, { id: string; name: string }>();
      for (const app of uniqueWindowsApps(result.apps, options.windowsProgramFiles)) {
        const id = windowsAppId(app, result.apps, options.windowsProgramFiles);
        const key = id.toLowerCase();
        // The installed (AppsFolder) row names a packaged app the way the Start menu does; its
        // running process row shares the id but may carry the bare exe name.
        const launcher = !!app.launchPath && windowsPackagedAppId(app.launchPath) === key;
        if (!apps.has(key) || launcher) apps.set(key, { id, name: app.name || id });
      }
      return { apps: [...apps.values()].slice(0, limit), truncated: apps.size > limit };
    },
    async launchPath(id, signal) {
      const result = await (await cua.cua()).listApps(signal);
      return windowsLaunchPath(id, result.apps, options.windowsProgramFiles);
    },
  };
  return driver;
}
