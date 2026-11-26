// Keep filesystem authorization tied to canonical paths and roots.
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { ExecError } from "./types.ts";
import { windowsPathName, windowsWithin } from "./windows-paths.ts";

export function within(root: string, path: string): boolean {
  // Windows reaches one file under several names (a drive, an admin-share UNC alias, a `\\?\`
  // prefix). Comparing the raw strings showed an alias as unrelated to the path it opens, which is
  // how a workplace spelled `\\localhost\c$` reached a private directory.
  if (process.platform === "win32")
    return windowsWithin(windowsPathName(root), windowsPathName(path));
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function sameSpelling(left: string, right: string): boolean {
  if (process.platform !== "win32") return left === right;
  const driveSpelling = (path: string) =>
    win32.normalize(path).replace(/^[a-z](?=:)/i, (letter) => letter.toUpperCase());
  // Case-sensitive NTFS directories can contain separate names differing only by case.
  return driveSpelling(left) === driveSpelling(right);
}

export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Resolve the closest existing ancestor; a dangling link must never be treated as a new path. */
export async function canonicalPath(path: string, cwd: string): Promise<string> {
  if (process.platform === "win32" && /^[a-z]:(?![\\/])/i.test(path))
    throw new ExecError("invalid_input");
  const absolute = resolve(cwd, path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!missing(error)) throw error;
    try {
      await lstat(absolute);
      throw new ExecError("file_failed", "path_canonicalization_failed");
    } catch (statError) {
      if (!missing(statError)) throw statError;
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw new ExecError("file_failed", "path_canonicalization_failed");
    return join(await canonicalPath(parent, cwd), relative(parent, absolute));
  }
}

export async function writablePath(
  path: string,
  cwd: string,
  roots: string[],
  denied: string[] = [],
): Promise<string> {
  const target = await canonicalPath(path, cwd);
  const lexical = resolve(cwd, path);
  if (!sameSpelling(target, lexical)) throw new ExecError("outside_workplace", "write_path_alias");
  if (denied.some((root) => within(root, target) || within(root, lexical)))
    throw new ExecError("outside_workplace", "write_path_protected");
  try {
    if ((await lstat(target)).nlink > 1)
      throw new ExecError("outside_workplace", "write_path_hardlink");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const canonicalRoots = await Promise.all(roots.map((root) => checkedRoot(resolve(cwd, root))));
  if (!canonicalRoots.some((root) => within(root, target)))
    throw new ExecError("outside_workplace", "write_path_outside_root");
  return target;
}

/**
 * Every path a deny rule must cover for `path`: the name itself and what it resolves to. A dangling
 * link (say a dotfiles symlink onto an unmounted volume) yields its link text resolved as far as it
 * exists instead of failing: one broken link in the home directory used to make the whole sandbox
 * configuration throw, so isolation reported "unavailable".
 */
export async function denyTargets(path: string): Promise<string[]> {
  const name = resolve(path);
  try {
    return [name, await canonicalPath(name, dirname(name))];
  } catch (error) {
    if (!(error instanceof ExecError && error.code === "file_failed")) throw error;
    let link: string;
    try {
      link = await readlink(name);
    } catch {
      // A dangling ancestor, not the name itself: nothing below it is reachable; deny the name.
      return [name];
    }
    const target = resolve(dirname(name), link);
    try {
      return [name, await canonicalPath(target, dirname(target))];
    } catch {
      // A link onto another dangling link: deny both names as written.
      return [name, target];
    }
  }
}

/** Approval supplies canonical roots; replacing a root with a link cannot redefine that permission. */
export async function checkedRoot(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!sameSpelling(canonical, resolve(path)))
    throw new ExecError("outside_workplace", "workspace_root_alias");
  return canonical;
}

/** Most specific authorized root owns a changed file; the primary remains the default cwd. */
export function owningWriteRoot(
  path: string,
  roots: readonly string[],
  platform: string,
): string | undefined {
  const api = platform === "win32" ? win32 : posix;
  return roots
    .filter((root) => {
      const rel = api.relative(root, path);
      return !api.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${api.sep}`);
    })
    .sort((a, b) => b.length - a.length)[0];
}
