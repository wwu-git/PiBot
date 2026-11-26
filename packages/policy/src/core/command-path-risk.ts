import { canonicalPath, containsPath, pathApi } from "../paths/paths.ts";
import { windowsProtectedPathNames } from "../paths/protected-paths.ts";
import type { EvaluationInput, PathContext, Platform } from "./types.ts";

export interface CommandPathScope {
  writeRoots: readonly string[];
  denyWriteRoots: readonly string[];
}

export function commandPathScope(input: EvaluationInput): CommandPathScope {
  if (input.boundary) return input.boundary;
  return {
    writeRoots: [
      input.workplace.home,
      ...input.workplace.folders.filter((folder) => folder.role !== "readonly").map((f) => f.path),
    ],
    denyWriteRoots: input.workplace.folders.filter((f) => f.role === "readonly").map((f) => f.path),
  };
}

/** A display-only exception: the execution snapshot, not a textual match, grants access. */
export function isWritableCommandPath(path: string, platform: Platform, scope: CommandPathScope) {
  const api = pathApi(platform);
  if (!api.isAbsolute(path) || /[$%`*?{}]/.test(path) || path.split(/[\\/]/).includes(".."))
    return false;
  return (
    scope.writeRoots.some((root) => containsPath(root, path, platform)) &&
    !scope.denyWriteRoots.some((root) => containsPath(root, path, platform))
  );
}

/** Locate literal arguments once; quoted spaces belong to a path, shell expressions do not. */
export function commandLiteralPaths(command: string) {
  return [...command.matchAll(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;&|()<>{}]+/g)].map((match) => {
    const quoted = match[0].startsWith('"') || match[0].startsWith("'");
    const value = quoted ? match[0].slice(1, -1) : match[0];
    const equals = value.indexOf("=");
    const offset = !quoted && equals >= 0 ? equals + 1 : 0;
    return {
      path: value.slice(offset),
      start: match.index + (quoted ? 1 : 0) + offset,
      end: match.index + match[0].length - (quoted ? 1 : 0),
    };
  });
}

/** Windows has no sandbox: a junction below a writable root must not hide a data-root warning. */
export async function verifiedCommandPaths(
  command: string,
  scope: CommandPathScope,
  context: PathContext,
) {
  const verified = new Set<string>();
  const candidates = new Set(commandLiteralPaths(command).map((entry) => entry.path));
  let checked = 0;
  for (const path of candidates) {
    if (!isWritableCommandPath(path, context.platform, scope)) continue;
    if (++checked > 32) break;
    try {
      const canonical = await canonicalPath(path, context);
      if (isWritableCommandPath(canonical.path, context.platform, scope)) verified.add(path);
    } catch {
      context.signal.throwIfAborted();
      // Unavailable identities retain their warning; text inspection cannot authorize an alias.
    }
  }
  return verified;
}

/**
 * `ownRoots` is the Bot's own work folder. It lives inside the data directory, which is otherwise
 * protected as a whole, so without this a plain `dir` there asked and a write there was "danger"
 * while the same command in a picked folder was fine. Only a protected root that contains the own
 * folder yields to it; protected names, `.git` and roots inside the own folder still apply.
 */
export function windowsProtectedCommandPath(
  path: string,
  roots: readonly string[],
  ownRoots: readonly string[] = [],
) {
  return (
    roots.some(
      (root) =>
        containsPath(root, path, "win32") &&
        !ownRoots.some(
          (own) => containsPath(root, own, "win32") && containsPath(own, path, "win32"),
        ),
    ) ||
    windowsProtectedPathNames().some((name) =>
      `\\${path.replaceAll("/", "\\").toLowerCase()}\\`.includes(
        `\\${name.replaceAll("/", "\\").toLowerCase()}\\`,
      ),
    ) ||
    /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(path)
  );
}
