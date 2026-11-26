// Prove packaged app identities using the host’s actual system package store.
import { win32 } from "node:path";
import { windowsPackagedAppId } from "../core/windows-app-id.ts";

interface WindowsAppIdentity {
  name: string;
  launchPath?: string | null;
}

/*
 * One canonical Windows app id for every side: installed rows, running rows, grants, launch and
 * name resolution all go through `windowsAppId(app, apps)`.
 *
 * Why: Cua names an installed packaged app by its AUMID (`shell:appsFolder\Family!App`) but a
 * running one by the process image (`...\WindowsApps\<PackageFullName>\...\Notepad.exe`). Comparing
 * the two spellings for equality made a granted, just-launched Notepad "not running". A running
 * packaged process is mapped to its AUMID only when that is provable: the image lives in the
 * system package store and exactly one installed app of that package family exists. Anything else
 * keeps the exe basename (desktop apps, unchanged), which never matches an AUMID grant, so an
 * unproven process stays unsupported instead of borrowing another app's grant.
 */

// Only the host's Program Files package store. A lookalike `WindowsApps` folder elsewhere (user-writable drives) is not accepted.
const STORE_IMAGE = /^([^\\]+)\\(?:[^\\]+\\)*[^\\]+\.exe$/i;
// PackageFullName = Name_Version_Architecture_ResourceId_PublisherId (ResourceId may be empty).
const PACKAGE_FULL_NAME =
  /^([A-Za-z0-9][A-Za-z0-9.-]{0,49})_\d+(?:\.\d+){3}_[A-Za-z0-9]+_[A-Za-z0-9.-]*_([a-z0-9]{13})$/i;

/** The executable of a launch path / command line (Cua quotes paths containing spaces). */
function executablePath(launchPath: string): string {
  const quoted = /^"([^"]+)"/.exec(launchPath);
  return quoted?.[1] ?? launchPath;
}
export function packageFamilyOfImage(imagePath: string, programFiles?: string): string | undefined {
  if (!programFiles || !/^[a-z]:[\\/]/i.test(programFiles)) return undefined;
  const storeRoot = win32.join(programFiles, "WindowsApps") + win32.sep;
  const image = win32.normalize(executablePath(imagePath));
  if (!image.toLowerCase().startsWith(storeRoot.toLowerCase())) return undefined;
  const store = STORE_IMAGE.exec(image.slice(storeRoot.length));
  const parts = store?.[1] ? PACKAGE_FULL_NAME.exec(store[1]) : null;
  return parts ? `${parts[1]}_${parts[2]}`.toLowerCase() : undefined;
}

/**
 * The AUMID of a process Windows would not name (a frame-hosted UWP app), proven by the
 * installed rows of the same Cua list — the frame-styled process itself is not in that list, so
 * only the AppsFolder rows can name it. A package with several apps, or one not
 * installed, proves nothing and keeps the caller on "unsupported" instead of borrowing another
 * app's grant.
 */
export function packagedAppIdForImage(
  imagePath: string,
  apps: readonly WindowsAppIdentity[],
  programFiles?: string,
): string | undefined {
  const family = packageFamilyOfImage(imagePath, programFiles);
  if (!family) return undefined;
  const ids = packagedFamilyApps(apps, family);
  return ids.size === 1 ? [...ids][0] : undefined;
}
function packagedFamilyApps(apps: readonly WindowsAppIdentity[], family: string): Set<string> {
  const ids = new Set<string>();
  for (const app of apps) {
    const id = app.launchPath ? windowsPackagedAppId(app.launchPath) : undefined;
    if (id?.startsWith(`${family}!`)) ids.add(id);
  }
  return ids;
}

/**
 * `apps` is the same Cua list the row came from; without it a running packaged process cannot be
 * proven and keeps its exe basename.
 */
export function windowsAppId(
  app: WindowsAppIdentity,
  apps: readonly WindowsAppIdentity[] = [],
  programFiles?: string,
): string {
  if (!app.launchPath) return app.name;
  const packaged = windowsPackagedAppId(app.launchPath);
  if (packaged) return packaged;
  const family = packageFamilyOfImage(app.launchPath, programFiles);
  if (family) {
    const candidates = packagedFamilyApps(apps, family);
    // A package with several apps (or none installed) cannot say which one this process is.
    if (candidates.size === 1) return candidates.values().next().value as string;
  }
  return win32.basename(app.launchPath).toLowerCase();
}

/** Exe-name grants cannot distinguish two installations with the same basename. */
export function uniqueWindowsApps<T extends WindowsAppIdentity>(
  apps: readonly T[],
  programFiles?: string,
): T[] {
  const paths = new Map<string, Set<string>>();
  const packaged = new Set<string>();
  for (const app of apps) {
    if (!app.launchPath) continue;
    const id = windowsAppId(app, apps, programFiles).toLowerCase();
    // An AUMID is the OS identity itself: its installed row and its running process share it
    // although their paths differ, so path uniqueness only applies to exe-basename ids.
    if (windowsPackagedAppId(id) === id) packaged.add(id);
    const known = paths.get(id) ?? new Set<string>();
    known.add(win32.normalize(app.launchPath).toLowerCase());
    paths.set(id, known);
  }
  return apps.filter((app) => {
    if (!app.launchPath) return false;
    const id = windowsAppId(app, apps, programFiles).toLowerCase();
    return packaged.has(id) || paths.get(id)?.size === 1;
  });
}

export function windowsLaunchPath(
  id: string,
  apps: readonly WindowsAppIdentity[],
  programFiles?: string,
): string | undefined {
  const wanted = id.toLowerCase();
  const rows = uniqueWindowsApps(apps, programFiles).filter(
    (app) => windowsAppId(app, apps, programFiles).toLowerCase() === wanted,
  );
  // A packaged app is launched through its AppsFolder activation, never its store executable.
  return (
    (
      rows.find((app) => app.launchPath && windowsPackagedAppId(app.launchPath) === wanted) ??
      rows[0]
    )?.launchPath ?? undefined
  );
}

function isPackagedNotepadAlias(name: string, launch: string): boolean {
  // Windows localizes the display name; bind aliases to the OS-provided AppUserModelID,
  // not a filename or display name that another installation could also use.
  return (
    windowsPackagedAppId(launch) === "microsoft.windowsnotepad_8wekyb3d8bbwe!app" &&
    (name === "notepad" || name === "notepad.exe")
  );
}

/** Aliases are derived only from the OS list, never from the caller's path basename. */
export function resolveWindowsAppName(
  name: string,
  apps: WindowsAppIdentity[],
  programFiles?: string,
): string | undefined {
  const requested = name.toLowerCase();
  const absolute = win32.isAbsolute(name);
  const matches = new Set<string>();
  for (const app of uniqueWindowsApps(apps, programFiles)) {
    const launch = app.launchPath;
    if (!launch) continue;
    const executable = win32.basename(launch).toLowerCase();
    const isExecutable = executable.endsWith(".exe");
    const path = win32.normalize(launch).toLowerCase();
    const matchesName =
      (isExecutable &&
        (requested === app.name.toLowerCase() ||
          requested === executable ||
          requested === executable.slice(0, -4))) ||
      isPackagedNotepadAlias(requested, launch);
    if (
      absolute
        ? isExecutable && win32.isAbsolute(launch) && win32.normalize(name).toLowerCase() === path
        : matchesName
    )
      matches.add(windowsAppId(app, apps, programFiles).toLowerCase());
  }
  // Rows already unique per id (uniqueWindowsApps); the installed and running rows of one packaged
  // app now agree on its AUMID instead of counting as two candidates.
  return matches.size === 1 ? matches.values().next().value : undefined;
}
