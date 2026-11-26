// Browse authenticated runners without creating workplace authority.
import { posix, win32 } from "node:path";
import { ExecError } from "@pibot/execution";
import { RpcError, RpcErrorCodes, type RunnerBrowse } from "@pibot/protocol-base";
import type { ExecutionTargets } from "./execution-targets.ts";

/**
 * The folder chooser browses a runner the way the system dialog browses this computer: one
 * level at a time, folders only. It runs only for the renderer's chooser — no Bot tool reaches it —
 * and lists with no write roots, so it can never change anything on the runner. The runner still
 * refuses on its own when its file capability is off.
 */

// One level above the user's own folder, so the user picks their name the way a dialog shows it.
const starts = { darwin: "/Users", linux: "/home" } as const;
const DRIVES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const browseTimeoutMs = 20_000;
const driveTimeoutMs = 5_000;

type Target = ReturnType<ExecutionTargets["require"]>;

function unreadable(error: unknown): never {
  // A link that dropped or a revoked runner keeps its own message (folderError / runner texts).
  if (error instanceof RpcError) throw error;
  if (
    error instanceof ExecError &&
    (error.code === "closed" || error.reason === "runner_disconnected")
  )
    throw new RpcError(RpcErrorCodes.closed, "runner_target_offline");
  if (error instanceof ExecError || (error instanceof Error && error.name === "AbortError"))
    throw new RpcError(RpcErrorCodes.invalidParams, "runner_folder_unreadable");
  throw error;
}

function hidden(name: string, platform: Target["platform"]) {
  return name.startsWith(".") || (platform === "win32" && name.startsWith("$"));
}

async function level(entry: Target, path: string, signal: AbortSignal): Promise<RunnerBrowse> {
  const paths = entry.platform === "win32" ? win32 : posix;
  const listing = await entry.target.listDir({ path, cwd: path, writeRoots: [], signal });
  const root = paths.parse(listing.path).root;
  const atRoot = listing.path === root;
  // A Windows drive root goes up to the drive list; a UNC share root and "/" are the top.
  const driveRoot = entry.platform === "win32" && /^[A-Za-z]:\\$/.test(root);
  return {
    platform: entry.platform,
    path: listing.path,
    parent: atRoot ? null : paths.dirname(listing.path),
    top: atRoot && !driveRoot,
    folders: listing.entries
      .filter((item) => item.type === "directory" && !hidden(item.name, entry.platform))
      .map((item) => ({ name: item.name, path: paths.join(listing.path, item.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    truncated: listing.truncated,
  };
}

async function drives(entry: Target, signal: AbortSignal): Promise<RunnerBrowse> {
  const found = await Promise.all(
    [...DRIVES].map(async (letter) => {
      const path = `${letter}:\\`;
      const probe = AbortSignal.any([signal, AbortSignal.timeout(driveTimeoutMs)]);
      try {
        const root = await entry.target.canonicalizePath(path, path, probe);
        if (root.device === null || root.inode === null) return [];
        return [{ name: `${letter}:`, path }];
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RpcError && error.code === RpcErrorCodes.closed) throw error;
        // A missing or unready drive is simply not listed.
        return [];
      }
    }),
  );
  return {
    platform: "win32",
    path: null,
    parent: null,
    top: true,
    folders: found.flat(),
    truncated: false,
  };
}

/**
 * A runner that can list folder names itself: it may show ancestors such as the user's
 * home that a workplace listing refuses. Undefined on an older runner (method not found).
 */
async function viaRunner(
  entry: Target,
  path: string | null | undefined,
  signal: AbortSignal,
): Promise<RunnerBrowse | undefined> {
  const listFolders = entry.target.listFolders?.bind(entry.target);
  if (!listFolders) return undefined;
  const list = async (at: string | null | undefined): Promise<RunnerBrowse | undefined> => {
    try {
      return { platform: entry.platform, ...(await listFolders(at, signal)) };
    } catch (error) {
      if (error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound)
        return undefined;
      throw error;
    }
  };
  if (path !== undefined) return list(path);
  try {
    return await list(entry.platform === "win32" ? undefined : starts[entry.platform]);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RpcError && error.code === RpcErrorCodes.closed) throw error;
    // Older runners with a strict required-path schema can still list drive roots.
    return list(entry.platform === "win32" ? null : "/");
  }
}

export async function browseRunner(
  targets: ExecutionTargets,
  location: string,
  path: string | null | undefined,
  parent: AbortSignal,
): Promise<RunnerBrowse> {
  const entry = targets.require(location);
  const signal = AbortSignal.any([parent, AbortSignal.timeout(browseTimeoutMs)]);
  const paths = entry.platform === "win32" ? win32 : posix;
  if (path && !paths.isAbsolute(path))
    throw new RpcError(RpcErrorCodes.invalidParams, "runner_folder_invalid");
  const listed = await viaRunner(entry, path, signal).catch((error: unknown) => unreadable(error));
  if (listed) return listed;
  if (path == null && entry.platform === "win32") return drives(entry, signal);
  try {
    if (path) return await level(entry, paths.normalize(path), signal);
    if (path === null) return await level(entry, "/", signal);
    if (entry.platform === "win32")
      throw new RpcError(RpcErrorCodes.invalidParams, "runner_folder_invalid");
    try {
      return await level(entry, starts[entry.platform], signal);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      return await level(entry, "/", signal);
    }
  } catch (error) {
    unreadable(error);
  }
}
