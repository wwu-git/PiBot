// Protect the host’s system and credential trees from outside-workplace writes.
import type { PathContext, Platform } from "../core/types.ts";
import { canonicalPath, containsPath, pathApi } from "./paths.ts";

/**
 * Places a write outside every workplace may never reach, even with the user's
 * per-call approval. A write is refused when its target lies inside one of these trees or
 * contains one (deleting a parent removes the protected folder too).
 */
const SYSTEM_DIRS: Record<Platform, readonly string[]> = {
  darwin: [
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/private",
    "/Applications",
    "/dev",
    "/cores",
  ],
  linux: [
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/boot",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/var/lib",
    "/snap",
  ],
  win32: [],
};
/**
 * Per-user temporary folders sit under /private on macOS; cleaning a tool's temp files there is the
 * kind of request this ADR exists for, so they are not part of the system tree. A target that
 * contains one of the system trees is still refused.
 */
const SYSTEM_EXCEPTIONS: Record<Platform, readonly string[]> = {
  darwin: ["/private/tmp", "/private/var/folders", "/private/var/tmp"],
  linux: [],
  win32: [],
};
const WINDOWS_SYSTEM_DIRS = ["Windows", "Program Files", "Program Files (x86)", "ProgramData"];
/** Credential stores named by the ADR; brain adds exec's full sensitive list on top. */
const CREDENTIAL_DIRS: Record<Platform, readonly string[]> = {
  darwin: [
    ".ssh",
    ".gnupg",
    ".aws",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".pi",
    "Library/Keychains",
  ],
  linux: [
    ".ssh",
    ".gnupg",
    ".aws",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".pi",
    ".local/share/keyrings",
  ],
  win32: [
    ".ssh",
    ".gnupg",
    ".aws",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".pi",
    "AppData/Roaming/gcloud",
  ],
};

/** The lexical Windows scan shares protected names, but never claims canonical path analysis. */
export function windowsProtectedPathNames(): readonly string[] {
  return [...WINDOWS_SYSTEM_DIRS, ...CREDENTIAL_DIRS.win32];
}

export interface ProtectedPaths {
  /** Whether a canonical write target outside every workplace must be refused. */
  covers(path: string): boolean;
}

/**
 * A protected name that cannot be resolved (a dangling link, an unreadable parent) still protects
 * its spelled path; it must not turn every outside write into an unresolved-path refusal.
 */
async function canonical(path: string, context: PathContext) {
  try {
    return (await canonicalPath(path, context)).path;
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof Error) return path;
    throw error;
  }
}
/**
 * Built for outside writes and explicit additional-root validation, where a root must not
 * turn a protected tree into an ordinary inside write. `extra` comes from brain (exec's sensitive roots and the Pi Bot data directory); both the
 * spelled and the canonical form are kept so a link cannot move a protected folder out of reach.
 */
export async function protectedPaths(
  context: PathContext,
  extra: readonly string[],
): Promise<ProtectedPaths> {
  const { platform } = context;
  const api = pathApi(platform);
  const home = await canonical(context.home, context);
  const homeNames = [
    ...new Set([
      context.home,
      home,
      ...(context.protectionHome && context.protectionHome !== context.home
        ? [context.protectionHome, await canonical(context.protectionHome, context)]
        : []),
    ]),
  ];
  const drives = [
    ...new Set([
      api.parse(home).root,
      ...(platform === "win32"
        ? [context.windowsSystemDrive ?? "", ...context.roots.map((root) => api.parse(root).root)]
        : []),
    ]),
  ];
  const system =
    platform === "win32"
      ? [
          ...(context.windowsSystemTrees ?? []),
          ...drives
            .filter((drive) => /^[a-z]:[\\/]$/i.test(drive))
            .flatMap((drive) => WINDOWS_SYSTEM_DIRS.map((name) => api.join(drive, name))),
        ]
      : SYSTEM_DIRS[platform];
  const credentials = homeNames.flatMap((root) =>
    CREDENTIAL_DIRS[platform].map((entry) => api.join(root, ...entry.split("/"))),
  );
  const spelled = [...system, ...credentials, ...extra].filter((path) => api.isAbsolute(path));
  const resolved = (paths: readonly string[]) =>
    Promise.all(paths.map((path) => canonical(path, context)));
  const trees = new Set([...spelled, ...(await resolved(spelled))]);
  const systemTrees = new Set([...system, ...(await resolved(system))]);
  const exceptions = await resolved(SYSTEM_EXCEPTIONS[platform]);
  return {
    covers(path) {
      // The filesystem root, a drive root or the home folder itself (or anything containing it).
      if (api.parse(path).root === path || api.dirname(path) === path) return true;
      if (homeNames.some((root) => containsPath(path, root, platform))) return true;
      const excepted = exceptions.some((root) => containsPath(root, path, platform));
      for (const tree of trees) {
        if (containsPath(path, tree, platform)) return true;
        if (excepted && systemTrees.has(tree)) continue;
        if (containsPath(tree, path, platform)) return true;
      }
      return false;
    },
  };
}
