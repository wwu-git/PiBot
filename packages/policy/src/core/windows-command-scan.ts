// Retain Windows danger hints and verify known targets before the stored Windows consent can release the call.

import type { ApprovalFact } from "@pibot/protocol-base";
import { powershellDirectoryWrites } from "../commands/powershell-directories.ts";
import { canonicalPath, expandHome } from "../paths/paths.ts";
import { windowsProtectedPathNames } from "../paths/protected-paths.ts";
import {
  type CommandPathScope,
  commandLiteralPaths,
  isWritableCommandPath,
  verifiedCommandPaths,
  windowsProtectedCommandPath,
} from "./command-path-risk.ts";

import type { PathContext } from "./types.ts";
import {
  safeWindowsDeletePath,
  windowsDeleteTarget,
  windowsNetworkOrDevicePath,
  windowsObfuscatedCommand,
} from "./windows-command-exceptions.ts";

const MAX_FRAGMENTS = 16;
const MAX_FRAGMENT_LENGTH = 160;
const boundary = /[\\\s"'`;&|(){}=:%]/;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Conservative text hints only: no shell interpretation, readonly proof or permission grant. */
export function scanWindowsCommand(
  command: string,
  protectedRoots: readonly string[] = [],
  scope: CommandPathScope = { writeRoots: [], denyWriteRoots: [] },
  verifiedPaths: ReadonlySet<string> = new Set(),
  directoryWrites?: ReturnType<typeof powershellDirectoryWrites>,
  verifiedDelete = false,
  ownRoots: readonly string[] = [],
) {
  const fragments = new Set<string>();
  let privilegeEscalation = false;
  const add = (value: string) => {
    if (fragments.size < MAX_FRAGMENTS) fragments.add(value.slice(0, MAX_FRAGMENT_LENGTH));
  };
  for (const match of command.matchAll(
    /\b(?:sudo|runas)(?:\.exe)?\b|[-\u2013-\u2015]verb\s*(?:[:=]\s*)?["']?runas\b/gi,
  )) {
    privilegeEscalation = true;
    add(match[0]);
  }
  if (!verifiedDelete) {
    for (const match of command.matchAll(
      /\b(?:remove-item|ri|rm|rmdir|rd|del|erase)\b(?:[ \t]+(?:-recurse\b|-force\b|-[rf]+\b|\/[sq]\b))*/gi,
    ))
      add(match[0]);
  }
  // Slash folding preserves offsets so fragments remain the exact text shown by the caller.
  const folded = command.replaceAll("/", "\\");
  const paths = commandLiteralPaths(command);
  const systemNames = windowsProtectedPathNames();
  for (const name of [...systemNames, ".git", ...protectedRoots]) {
    const needle = name.replaceAll("/", "\\").replace(/\\+$/, "");
    if (!needle) continue;
    let pathIndex = 0;
    for (const match of folded.matchAll(new RegExp(escapePattern(needle), "gi"))) {
      const start = match.index;
      const end = start + needle.length;
      if (
        (start === 0 || boundary.test(folded[start - 1] ?? "")) &&
        (end === folded.length || boundary.test(folded[end] ?? ""))
      ) {
        while (paths[pathIndex] && (paths[pathIndex]?.end ?? 0) <= start) pathIndex++;
        const literal = paths[pathIndex];
        if (
          (systemNames.includes(name) ||
            (protectedRoots.includes(name) &&
              !!literal &&
              !windowsProtectedCommandPath(literal.path, protectedRoots, ownRoots))) &&
          literal &&
          literal.start <= start &&
          literal.end >= end &&
          verifiedPaths.has(literal.path) &&
          isWritableCommandPath(literal.path, "win32", scope)
        )
          continue;
        add(command.slice(start, end));
      }
    }
  }
  for (const match of command.matchAll(
    /%(?:systemroot|windir|programfiles(?:\(x86\))?|programdata)%|\$env:(?:systemroot|windir|programfiles|programdata)\b/gi,
  ))
    add(match[0]);
  if (directoryWrites) {
    for (const path of directoryWrites.writes)
      if (
        !isWritableCommandPath(path, "win32", scope) ||
        windowsProtectedCommandPath(path, protectedRoots, ownRoots)
      )
        add(path);
    if (directoryWrites.unknownWrite) add("unknown_command_directory");
  }
  return { privilegeEscalation, fragments: [...fragments] };
}

export async function prepareWindowsCommandScan(
  command: string,
  options: {
    protectedRoots: readonly string[];
    /** The Bot's own work folder, exempt from the data-directory root (see the predicate). */
    ownRoots?: readonly string[];
    scope: CommandPathScope;
    writePaths?: readonly string[];
    cwd: string | undefined;
    context: PathContext | undefined;
  },
) {
  const { protectedRoots, scope, cwd, context } = options;
  const ownRoots = options.ownRoots ?? [];
  const needsConfirmation =
    windowsNetworkOrDevicePath(command) ||
    (cwd !== undefined && windowsNetworkOrDevicePath(cwd)) ||
    options.writePaths?.some(windowsNetworkOrDevicePath) === true ||
    windowsObfuscatedCommand(command);
  const directoryWrites = cwd ? powershellDirectoryWrites(command, cwd) : undefined;
  const declaredWrites = options.writePaths?.map((path) =>
    expandHome(path, context?.home ?? cwd ?? ""),
  );
  const writes = new Set([...(directoryWrites?.writes ?? []), ...(declaredWrites ?? [])]);
  const deleteTarget = cwd ? windowsDeleteTarget(command, cwd) : undefined;
  const verifiedPaths =
    context && !needsConfirmation
      ? await verifiedCommandPaths(command, scope, context)
      : new Set<string>();
  const confirmed = await checkWindowsWrites(writes, deleteTarget, {
    protectedRoots,
    ownRoots,
    scope,
    context: context && !needsConfirmation && cwd ? { ...context, cwd } : undefined,
  });
  const scan = scanWindowsCommand(
    command,
    protectedRoots,
    scope,
    verifiedPaths,
    directoryWrites,
    confirmed.verifiedDelete,
    ownRoots,
  );
  return {
    privilegeEscalation: scan.privilegeEscalation,
    fragments: [...new Set([...scan.fragments, ...confirmed.fragments])].slice(0, MAX_FRAGMENTS),
    needsConfirmation,
    facts: confirmed.facts,
  };
}

async function checkWindowsWrites(
  paths: ReadonlySet<string>,
  deleteTarget: string | undefined,
  options: {
    protectedRoots: readonly string[];
    ownRoots: readonly string[];
    scope: CommandPathScope;
    context?: PathContext;
  },
) {
  const { protectedRoots, ownRoots, scope, context } = options;
  const facts: ApprovalFact[] = [];
  const fragments: string[] = [];
  let verifiedDelete = false;
  if (!context) return { facts, fragments, verifiedDelete };
  for (const path of paths) {
    context.signal.throwIfAborted();
    if (facts.length + fragments.length >= 32) {
      fragments.push("unknown_command_directory");
      break;
    }
    if (windowsProtectedCommandPath(path, protectedRoots, ownRoots)) {
      fragments.push(path.slice(0, MAX_FRAGMENT_LENGTH));
      continue;
    }
    try {
      const resolved = await canonicalPath(path, context);
      if (
        windowsNetworkOrDevicePath(resolved.path) ||
        windowsProtectedCommandPath(resolved.path, protectedRoots, ownRoots)
      ) {
        fragments.push(path.slice(0, MAX_FRAGMENT_LENGTH));
        continue;
      }
      facts.push({ kind: "write", value: resolved.path });
      if (path === deleteTarget)
        verifiedDelete =
          safeWindowsDeletePath(path, protectedRoots, scope, ownRoots) &&
          safeWindowsDeletePath(resolved.path, protectedRoots, scope, ownRoots);
    } catch {
      // An unreadable target cannot rule out a junction into a protected directory.
      context.signal.throwIfAborted();
      fragments.push("unknown_command_directory");
    }
  }
  return { facts, fragments, verifiedDelete };
}
