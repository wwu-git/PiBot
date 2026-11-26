// Compare Windows path names and guard the runner’s system roots.
import { win32 } from "node:path";

/**
 * Windows names one file in several spellings: a drive path, an admin-share UNC path that uses a
 * local host name (`\\localhost\c$\...`), and the `\\?\` / `\\.\` namespaces; it also compares names
 * case-insensitively. Comparing the raw strings made such an alias look unrelated to the drive path
 * it reaches, so an execution target could open its own private data directory through
 * `\\localhost\c$` with no confirmation. Boundary checks therefore compare these names.
 */
export interface WindowsPathName {
  /** The path in drive spelling; safe to store or reuse, and keeps the original case. */
  readonly path: string;
  /** Lowercase comparable key: every alias of one file has the same key. */
  readonly key: string;
  /**
   * `drive` and `share` are absolute; `device` (namespace or volume name, or a relative path) is
   * neither and can never be shown to be inside another path.
   */
  readonly kind: "drive" | "share" | "device";
}

/** Host names that reach this machine over UNC without asking the OS. */
const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"] as const;

/** Host names that address this machine, given what the caller knows about itself. */
export function windowsHostNames(...names: (string | undefined)[]): string[] {
  const hosts: string[] = [...loopback];
  for (const name of names) {
    const value = name?.trim().toLowerCase();
    if (!value) continue;
    hosts.push(value);
    const label = value.split(".")[0] ?? "";
    // Windows resolves a computer by its short name as well as by its DNS name.
    if (label && label !== value) hosts.push(label);
  }
  return hosts;
}

function trimmed(value: string, shrinkTo: number): string {
  let result = value;
  while (result.length > shrinkTo && result.endsWith("\\")) result = result.slice(0, -1);
  return result;
}

export function windowsPathName(
  value: string,
  localHosts: readonly string[] = loopback,
): WindowsPathName {
  // Win32 accepts `/` as a separator, and both device prefixes open the same files without them.
  let path = value.replaceAll("/", "\\");
  if (/^\\\\[?.]\\/u.test(path)) {
    path = path.slice(4);
    if (/^unc\\/iu.test(path)) path = `\\\\${path.slice(4)}`;
  }
  const normalized = win32.normalize(path);
  if (normalized.startsWith("\\\\")) {
    const [host = "", share = "", ...rest] = normalized.slice(2).split("\\");
    const admin = /^([a-z])\$$/u.exec(share.toLowerCase())?.[1];
    if (admin && localHosts.includes(host.toLowerCase())) {
      const drive = `${admin.toUpperCase()}:`;
      const mapped = rest.length ? `${drive}\\${rest.join("\\")}` : `${drive}\\`;
      return { path: mapped, key: mapped.toLowerCase(), kind: "drive" };
    }
    // Another machine's share keeps its spelling: only this machine's admin shares alias a drive.
    const shareRoot = trimmed(normalized, `\\\\${host}\\${share}`.length);
    return { path: shareRoot, key: shareRoot.toLowerCase(), kind: "share" };
  }
  // `C:` without a separator is the process's current directory on that drive, not an absolute path.
  if (/^[a-z]:\\/iu.test(normalized)) {
    const drive = normalized.charAt(0).toUpperCase() + trimmed(normalized, 3).slice(1);
    return { path: drive, key: drive.toLowerCase(), kind: "drive" };
  }
  return { path: normalized, key: normalized.toLowerCase(), kind: "device" };
}

/** `within` for two Windows names: the same drive or share, and the root an ancestor of the path. */
export function windowsWithin(root: WindowsPathName, path: WindowsPathName): boolean {
  if (root.kind === "device" || root.kind !== path.kind) return false;
  const part = win32.relative(root.key, path.key);
  return part === "" || (!win32.isAbsolute(part) && part !== ".." && !part.startsWith("..\\"));
}

/**
 * A root no folder may use as a workplace: a drive root and the Windows install trees, matching the
 * Linux refusal of `/`. A workplace there hands the Bot writes to the whole system.
 */
export function windowsReservedRoot(
  name: WindowsPathName,
  systemTrees: readonly string[],
): boolean {
  if (name.kind !== "drive") return false;
  if (/^[a-z]:\\$/u.test(name.key)) return true;
  return systemTrees.some((tree) => {
    const system = windowsPathName(tree);
    return windowsWithin(system, name) || windowsWithin(name, system);
  });
}
