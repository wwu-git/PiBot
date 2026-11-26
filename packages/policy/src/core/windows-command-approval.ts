// Keep implicit Windows approval tied to the same paths and permissions as file tools.
import { win32 } from "node:path";
import type { ApprovalFact } from "@pibot/protocol-base";
import { windowsLiteralPath, windowsReadShape } from "../commands/windows-approval-shape.ts";
import { canonicalPath, containsPath, withAbort } from "../paths/paths.ts";
import { windowsProtectedCommandPath } from "./command-path-risk.ts";
import { PolicyTargetError } from "./errors.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { EvaluationInput, PathContext } from "./types.ts";

type FileRead = {
  category: "read_file" | "list_dir";
  path: string;
};

function localDrivePath(path: string) {
  return /^[a-z]:[\\/]/i.test(path) && windowsLiteralPath(path);
}

type Protection = { roots: readonly string[]; own: readonly string[] };

async function approvedPath(path: string, context: PathContext, protection: Protection) {
  const { roots, own } = protection;
  const absolute = win32.resolve(context.cwd, path);
  if (!localDrivePath(absolute) || windowsProtectedCommandPath(absolute, roots, own))
    return undefined;
  const resolved = await canonicalPath(absolute, context);
  if (!localDrivePath(resolved.path) || windowsProtectedCommandPath(resolved.path, roots, own))
    return undefined;
  return resolved;
}

type CommandInput = EvaluationInput & {
  request: Extract<EvaluationInput["request"], { category: "run_command" }>;
};
type ReadPolicy = (request: FileRead) => Promise<RequestFacts>;

export async function proveWindowsReadOnly(
  input: CommandInput,
  context: PathContext,
  cwd: string | undefined,
  protectedRoots: Protection,
  readPolicy: ReadPolicy,
): Promise<ApprovalFact[] | undefined> {
  if (!cwd || !localDrivePath(cwd) || input.request.stdin || input.request.outsideSandbox) return;
  if (
    input.request.background ||
    input.request.writePaths?.length ||
    input.boundary?.location?.target.startsWith("acp:")
  )
    return;
  const reads = windowsReadShape(input.request.command);
  if (!reads) return;

  try {
    const work = input.boundary?.readRoots ?? [
      input.workplace.home,
      ...input.workplace.folders.map((folder) => folder.path),
    ];
    const directory = await approvedPath(cwd, context, protectedRoots);
    if (!directory?.exists || !work.some((root) => containsPath(root, directory.path, "win32")))
      return;
    const checked = { ...context, cwd: directory.path };
    return await readFacts(reads, checked, protectedRoots, readPolicy);
  } catch (error) {
    context.signal.throwIfAborted();
    // A filesystem proof may fail on a disconnected target or inaccessible path. Keep the card.
    if (
      error instanceof PolicyTargetError ||
      (error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(
          String(error.code),
        ))
    )
      return;
    throw error;
  }
}

async function readFacts(
  reads: readonly (FileRead & { recurse?: boolean; readEntries?: boolean })[],
  context: PathContext,
  protectedRoots: Protection,
  readPolicy: ReadPolicy,
): Promise<ApprovalFact[] | undefined> {
  const facts: ApprovalFact[] = [];
  for (const read of reads) {
    const path = await approvedPath(read.path, context, protectedRoots);
    if (!path) return;
    const lexical = win32.resolve(context.cwd, read.path);
    if (!readAllowed(await readPolicy({ category: read.category, path: lexical }))) return;
    if (
      (read.recurse || read.readEntries) &&
      (!path.exists ||
        !(await entriesAllowed(path.path, read, context, protectedRoots, readPolicy)))
    )
      return;
    facts.push({ kind: "read", value: path.path });
  }
  return facts;
}

function readAllowed(facts: RequestFacts) {
  const { result, outside } = facts;
  return (
    result.decision !== "deny" &&
    result.category !== "read_ai_config" &&
    (!outside || result.decision === "allow")
  );
}

async function entriesAllowed(
  path: string,
  read: { recurse?: boolean; readEntries?: boolean },
  context: PathContext,
  protectedRoots: Protection,
  readPolicy: ReadPolicy,
) {
  const enumerate = context.fs.windowsReadEntries;
  if (!enumerate) return false;
  const entries = await withAbort(
    () =>
      enumerate(
        path,
        read.recurse === true,
        context.signal,
        (entry) =>
          localDrivePath(entry) &&
          !windowsProtectedCommandPath(entry, protectedRoots.roots, protectedRoots.own),
      ),
    context.signal,
  );
  if (!entries) return false;
  for (const entry of entries) {
    if (
      read.readEntries &&
      !entry.directory &&
      !readAllowed(await readPolicy({ category: "read_file", path: entry.path }))
    )
      return false;
  }
  return true;
}
