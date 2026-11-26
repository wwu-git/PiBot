// Resolve, create and register the work folder a source project goes to, within the write policy.
import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { CapabilityContext } from "@pibot/brain/kit";
import { directoryIdentity, matchesFileIdentity, sensitiveReadBoundary } from "@pibot/execution";
import type { ImportFolderTarget } from "@pibot/import-contract";
import { nodeFileSystem, type Platform, protectedPaths } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import type { ImportProjects } from "../store/projects.ts";

type Deps = CapabilityContext["local"]["deps"];
const unavailable = () => new RpcError(-32602, "import_project_unavailable");
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function pathApi(platform: string) {
  return platform === "win32" ? win32 : posix;
}

/** One folder name that is valid on all three platforms; never a path. */
export function folderName(name: string, fallback: string) {
  const cleaned = Array.from(
    name
      .normalize("NFC")
      .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]+/gu, "-")
      .replace(/\s+/gu, " ")
      .replace(/^[\s.-]+|[\s.]+$/gu, ""),
  )
    .slice(0, 80)
    .join("")
    .trim();
  const value = cleaned && cleaned !== ".." ? cleaned : fallback;
  return RESERVED.test(value) ? `${value}-project` : value;
}

/** ~/Documents on every platform, built from the user's home rather than any drive letter. */
export function documentsFolder(deps: Pick<Deps, "platform" | "userHome">) {
  return pathApi(deps.platform).join(deps.userHome, "Documents");
}

/** A path as the user reads it: the home folder abbreviated to "~", native separators. */
export function displayPath(deps: Pick<Deps, "platform" | "userHome">, path: string) {
  const api = pathApi(deps.platform);
  const relative = api.relative(deps.userHome, path);
  if (!relative) return "~";
  if (relative.startsWith("..") || api.isAbsolute(relative)) return path;
  return `~${api.sep}${relative}`;
}

export function sameName(left: string, right: string) {
  const key = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  return !!left && key(left) === key(right);
}

/** Refuses folders inside credential, system, AI-config or Pi Bot data trees. */
export async function assertFolderAllowed(deps: Deps, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const { platform, userHome, env, dataDir } = deps;
  const sensitive = await sensitiveReadBoundary(platform, [userHome], env);
  const policy = await protectedPaths(
    {
      platform: platform as Platform,
      home: userHome,
      cwd: path,
      roots: [path],
      fs: nodeFileSystem,
      signal,
    },
    [...sensitive.denyRead, dataDir],
  );
  signal.throwIfAborted();
  if (policy.covers(path) || !pathApi(platform).isAbsolute(path)) throw unavailable();
}

export type ResolvedFolder = { path: string; exists: boolean };

/**
 * The brain resolves every target itself: a registered local work folder, ~/Documents/<name>,
 * or the local tool's own working directory. Nothing is created here.
 */
export async function resolveFolder(
  ctx: CapabilityContext,
  target: ImportFolderTarget,
  project: { newName: string; source?: string },
  signal: AbortSignal,
): Promise<ResolvedFolder> {
  const deps = ctx.local.deps;
  const api = pathApi(deps.platform);
  let path: string;
  // The Bot's own folder is never a project folder: nothing to resolve, create or write.
  if (target.kind === "home") throw unavailable();
  if (target.kind === "folder") {
    const row = ctx.local.deps.db
      .prepare(`SELECT f.path FROM working_folders f JOIN bots b ON b.id=f.bot_id
        WHERE f.id=? AND f.association='user' AND b.archived_at IS NULL`)
      .get(target.folderId);
    if (typeof row?.path !== "string" || !api.isAbsolute(row.path)) throw unavailable();
    path = row.path;
  } else if (target.kind === "source") {
    if (!project.source) throw unavailable();
    path = project.source;
  } else {
    path = api.join(documentsFolder(deps), project.newName);
  }
  await assertFolderAllowed(deps, path, signal);
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  signal.throwIfAborted();
  if (info && !info.isDirectory()) throw unavailable();
  if (!info && target.kind !== "new") throw unavailable();
  return { path: info ? await realpath(path) : path, exists: !!info };
}

/**
 * Creates a missing ~/Documents/<name>: each new level gets a receipt before mkdir, so undo
 * (or crash recovery) can remove exactly the levels this batch made while they stay empty.
 */
export async function createFolder(
  deps: Deps,
  projects: ImportProjects,
  importId: string,
  path: string,
  signal: AbortSignal,
) {
  const api = pathApi(deps.platform);
  await assertFolderAllowed(deps, path, signal);
  const missing: string[] = [];
  for (let level = path; ; level = api.dirname(level)) {
    if (
      await stat(level).then(
        () => true,
        () => false,
      )
    )
      break;
    if (api.dirname(level) === level || level === deps.userHome) throw unavailable();
    missing.unshift(level);
  }
  for (const level of missing) {
    signal.throwIfAborted();
    projects.rememberFolder(importId, level);
    await mkdir(level);
    const { device, inode } = await directoryIdentity(level);
    projects.folderCreated(importId, { path: level, device, inode });
  }
  return realpath(path);
}

/**
 * Makes the folder one of the Bot's work folders so its topics can start there. A record that was
 * not listed before is remembered, and undo hides it again once nothing uses it.
 */
export function registerFolder(
  ctx: CapabilityContext,
  remember: (botId: string, folderId: string) => void,
  botId: string,
  path: string,
) {
  const listed = ctx.local.deps.db
    .prepare(`SELECT 1 FROM working_folders
      WHERE bot_id=? AND path=? AND hidden_at IS NULL AND association='user'`)
    .get(botId, path);
  const api = pathApi(ctx.local.deps.platform);
  const folder = ctx.local.workplaces.repo.register(botId, path, api.basename(path) || path);
  if (!listed) remember(botId, folder.id);
  return folder.id;
}

/** Removes a created folder only while it is still the same, empty directory. */
export async function removeFolder(
  deps: Deps,
  folder: { path: string; device: string; inode: string },
  signal: AbortSignal,
): Promise<"removed" | "kept"> {
  signal.throwIfAborted();
  const info = await stat(folder.path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return "removed";
  // No identity means the batch stopped between mkdir and its receipt: leave that folder alone.
  if (
    !info.isDirectory() ||
    !folder.device ||
    !matchesFileIdentity(info, { device: folder.device, inode: folder.inode })
  )
    return "kept";
  await assertFolderAllowed(deps, folder.path, signal);
  if ((await readdir(folder.path)).length) return "kept";
  try {
    await rmdir(folder.path);
    return "removed";
  } catch (error) {
    // Something appeared in the folder after the check: it is the user's now.
    if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return "kept";
    throw error;
  }
}
