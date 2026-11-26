// Resolve policy paths without erasing the filesystem identities they refer to.
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { SCRIPT_MAX_BYTES } from "../commands/scripts.ts";
import { PolicyTargetError } from "../core/errors.ts";
import type { FileSystem, PathContext, Platform, ResolvedPath } from "../core/types.ts";
import { windowsReadEntries } from "./windows-read-tree.ts";

/**
 * A name the kernel refuses as too long cannot be an existing file and no command can open it, so
 * it is absent like ENOENT. Maintainers 2026-11-18: a whole HTML mail body passed as one argument made
 * realpath throw ENAMETOOLONG, which failed the approval itself ("Tool approval failed", no card).
 */
export function absentPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENAMETOOLONG")
  );
}

export const nodeFileSystem = {
  async isSymbolicLink(path, signal) {
    signal.throwIfAborted();
    try {
      return (await lstat(path)).isSymbolicLink();
    } catch (error) {
      if (absentPath(error)) return false;
      throw error;
    }
  },
  async realpath(path, signal) {
    signal.throwIfAborted();
    const result = await realpath(path);
    signal.throwIfAborted();
    return result;
  },
  async readScript(path, signal) {
    signal.throwIfAborted();
    let bytes: Buffer;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > SCRIPT_MAX_BYTES) return undefined;
      bytes = await readFile(path, { signal });
    } catch (error) {
      signal.throwIfAborted();
      // Missing or unreadable: the run is judged without the script, as before.
      if (absentPath(error) || (error instanceof Error && "code" in error)) return undefined;
      throw error;
    }
    // The file may have grown between stat and read.
    if (bytes.length > SCRIPT_MAX_BYTES || bytes.includes(0)) return undefined;
    // Lossy decoding turned invalid bytes into U+FFFD, so the text judged was not the text that
    // runs; a NUL ends a string for some interpreters. Either way the file is not judged. The BOM
    // is kept so the text encodes back to exactly these bytes (the digest execution re-checks).
    return strictUtf8(bytes);
  },
  async listNames(directory, signal) {
    signal.throwIfAborted();
    const names: string[] = [];
    try {
      // Bounded: a directory with more entries than this is treated as unknown, not scanned.
      for await (const entry of await opendir(directory, { bufferSize: 256 })) {
        signal.throwIfAborted();
        if (names.length >= LIST_NAMES_MAX) return undefined;
        names.push(entry.name);
      }
      return names;
    } catch (error) {
      signal.throwIfAborted();
      if (absentPath(error) || (error instanceof Error && "code" in error)) return undefined;
      throw error;
    }
  },
} satisfies FileSystem;
const LIST_NAMES_MAX = 4096;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function strictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch (error) {
    // A fatal decoder reports malformed input as a TypeError and nothing else.
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** Parallel protected-root walks share prefixes; keep only pending reads in this decision. */
export function decisionFileSystem(platform: Platform): FileSystem {
  const resolving = new Map<string, Promise<string>>();
  const links = new Map<string, Promise<boolean>>();
  const walk: FileSystem = {
    realpath(path, signal) {
      signal.throwIfAborted();
      const current = resolving.get(path);
      if (current) return current;
      const pending = nodeFileSystem.realpath(path, signal).finally(() => resolving.delete(path));
      resolving.set(path, pending);
      return pending;
    },
    readScript: (path, signal) => nodeFileSystem.readScript(path, signal),
    listNames: (directory, signal) => nodeFileSystem.listNames(directory, signal),
    isSymbolicLink(path, signal) {
      signal.throwIfAborted();
      const current = links.get(path);
      if (current) return current;
      const pending = nodeFileSystem.isSymbolicLink(path, signal).finally(() => links.delete(path));
      links.set(path, pending);
      return pending;
    },
  };
  // Keep Windows' component handling for drive/UNC aliases until its native path is verified.
  if (platform === "win32" && process.platform === "win32") return { ...walk, windowsReadEntries };
  if (platform !== process.platform) return walk;
  return {
    ...walk,
    async canonicalize(path, signal) {
      try {
        // Existing paths without '..' need one native resolution, rather than one per component.
        return { path: await walk.realpath(path, signal), exists: true };
      } catch (error) {
        signal.throwIfAborted();
        if (!absentPath(error)) throw error;
        // Missing paths retain the component walk, including its dangling-link rejection.
        return canonicalPath(path, {
          platform,
          cwd: pathApi(platform).parse(path).root,
          home: "",
          roots: [],
          fs: walk,
          signal,
        });
      }
    },
  };
}
export function pathApi(platform: Platform) {
  return platform === "win32" ? win32 : posix;
}
export function containsPath(root: string, path: string, platform: Platform): boolean {
  const api = pathApi(platform);
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = api.relative(fold(root), fold(path));
  return (
    relative === "" ||
    (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`))
  );
}
export function expandHome(value: string, home: string): string {
  if (value.includes("\0")) throw new PolicyTargetError("path_resolution_failed");
  if (value === "~") return home;
  if (/^~[\\/]/.test(value)) return `${home}/${value.slice(2)}`;
  if (value.startsWith("~")) throw new PolicyTargetError("path_resolution_failed");
  return value;
}
export async function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(operation)
      .then(accept, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
/** Resolve component by component: lexical normalization before following links misreads link/../x. */
export async function canonicalPath(
  value: string,
  context: PathContext,
): Promise<{ path: string; exists: boolean }> {
  const api = pathApi(context.platform);
  const expanded = expandHome(value, context.home);
  if (context.platform === "win32" && /^[a-z]:(?![\\/])/i.test(expanded))
    throw new PolicyTargetError("path_resolution_failed");
  const absolute = api.isAbsolute(expanded) ? expanded : `${context.cwd}${api.sep}${expanded}`;
  const root = api.parse(absolute).root;
  let current = root;
  let exists = true;
  const parts = absolute.slice(root.length).split(context.platform === "win32" ? /[\\/]/ : /\//);
  // Without `..` the remote machine's whole-path resolution equals this walk; with it, keep the
  // walk so link/../x is still followed component by component.
  const whole = context.fs.canonicalize;
  if (whole && !parts.includes("..")) {
    try {
      return await withAbort(
        () => whole.call(context.fs, absolute, context.signal),
        context.signal,
      );
    } catch (error) {
      context.signal.throwIfAborted();
      // A dangling link on the way (the runner refuses it) is what the walk refuses too.
      if (
        error instanceof Error &&
        /path_canonicalization_failed/.test(
          String((error as { reason?: string }).reason ?? error.message),
        )
      )
        throw new PolicyTargetError("path_resolution_failed");
      throw error;
    }
  }
  for (const part of parts) {
    context.signal.throwIfAborted();
    if (!part || part === ".") continue;
    const next = api.resolve(current, part);
    try {
      current = await withAbort(() => context.fs.realpath(next, context.signal), context.signal);
      exists = true;
    } catch (error) {
      if (!absentPath(error)) throw error;
      const isLink = context.fs.isSymbolicLink;
      if (
        isLink &&
        (await withAbort(() => isLink.call(context.fs, next, context.signal), context.signal))
      )
        throw new PolicyTargetError("path_resolution_failed");
      current = next;
      exists = false;
    }
  }
  return { path: current, exists };
}
export async function resolvePath(value: string, context: PathContext): Promise<ResolvedPath> {
  const resolved = await canonicalPath(value, context);
  // Prefer the most specific associated root for grant scope stability.
  const root = context.roots
    .filter((entry) => containsPath(entry, resolved.path, context.platform))
    .sort((a, b) => b.length - a.length)[0];
  return { ...resolved, ...(root ? { root } : {}) };
}
