// Binds a native picker selection to read-only, policy-checked access to one file.
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname } from "node:path";
import type { CapabilityContext } from "@pibot/brain/kit";
import { sensitiveReadBoundary } from "@pibot/execution";
import type { ImportSource } from "@pibot/import-contract";
import { nodeFileSystem, protectedPaths } from "@pibot/policy";
import { ImportFailure, type ImportFile, type ImportInput } from "./adapter.ts";
import {
  isLocalSource,
  localSelection,
  sameLocalPath,
  supportsLocalSources,
} from "./local/locations.ts";

type HostPaths = Pick<
  CapabilityContext["local"]["deps"],
  "dataDir" | "env" | "platform" | "userHome"
>;

const MAX_FILE_BYTES = 1024n * 1024n * 1024n;
const CHUNK_BYTES = 64 * 1024;

function sameFile(left: BigIntStats, right: BigIntStats) {
  return (
    right.isFile() &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

async function authorize(
  deps: HostPaths,
  source: ImportSource,
  path: string,
  resolved: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { platform, userHome, env, dataDir } = deps;
  const narrowRoots = new Set<string>();
  let projectNote = false;
  if (
    source === "gemini" &&
    [path, resolved].some((name) => extname(name).toLowerCase() !== ".zip")
  )
    throw new ImportFailure("format");
  if (isLocalSource(source)) {
    if (!supportsLocalSources(platform)) throw new ImportFailure("unsupported");
    const requested = localSelection(source, platform, userHome, path);
    const home = await realpath(userHome);
    if (!sameLocalPath(platform, userHome, home, path, resolved))
      throw new ImportFailure("source_changed");
    const actual = localSelection(source, platform, home, resolved);
    if (requested.configRoot && actual.configRoot) {
      narrowRoots.add(requested.configRoot);
      narrowRoots.add(actual.configRoot);
    }
    projectNote = requested.kind === "projectNote";
  }
  const sensitive = await sensitiveReadBoundary(platform, [userHome], env);
  // The narrow picker grant excludes just the relevant AI root, never overlapping credentials.
  const excluded = narrowRoots.size
    ? [
        ...sensitive.credentialReadRoots,
        ...sensitive.aiConfigReadBoundary.roots.filter((root) => !narrowRoots.has(root)),
      ]
    : sensitive.denyRead;
  const policy = await protectedPaths(
    {
      platform,
      home: userHome,
      cwd: userHome,
      roots: [path, resolved],
      fs: nodeFileSystem,
      signal,
    },
    [...excluded, dataDir],
  );
  signal.throwIfAborted();
  if (policy.covers(path) || policy.covers(resolved)) throw new ImportFailure("source_changed");
  return projectNote;
}

export async function selectedInput(
  deps: HostPaths,
  path: string,
  signal: AbortSignal,
  source: ImportSource = "fixture",
): Promise<ImportInput> {
  signal.throwIfAborted();
  if (isLocalSource(source)) {
    if (!supportsLocalSources(deps.platform)) throw new ImportFailure("unsupported");
    localSelection(source, deps.platform, deps.userHome, path);
  }
  const resolved = await realpath(path);
  const projectNote = await authorize(deps, source, path, resolved, signal);
  const selected = await lstat(path, { bigint: true });
  if (!selected.isFile() || selected.nlink !== 1n) throw new ImportFailure("source_changed");
  if (selected.size > MAX_FILE_BYTES) throw new ImportFailure("limit");
  const file = (readSignal: AbortSignal) =>
    openSelected(deps, source, path, resolved, selected, readSignal);
  const input: ImportInput = async function* (readSignal) {
    for await (const selectedFile of file(readSignal)) {
      for (let offset = 0; offset < selectedFile.size; offset += CHUNK_BYTES) {
        yield await selectedFile.read(offset, Math.min(CHUNK_BYTES, selectedFile.size - offset));
      }
    }
  };
  input.file = file;
  input.modifiedAt = new Date(Number(selected.mtimeMs)).toISOString();
  if (projectNote) input.projectNote = true;
  return input;
}

async function* openSelected(
  deps: HostPaths,
  source: ImportSource,
  path: string,
  resolved: string,
  selected: BigIntStats,
  signal: AbortSignal,
): AsyncGenerator<ImportFile> {
  signal.throwIfAborted();
  const current = await realpath(path);
  await authorize(deps, source, path, current, signal);
  if (current !== resolved || !sameFile(selected, await lstat(path, { bigint: true })))
    throw new ImportFailure("source_changed");
  signal.throwIfAborted();
  const file = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!sameFile(selected, await file.stat({ bigint: true })))
      throw new ImportFailure("source_changed");
    const size = Number(selected.size);
    yield {
      size,
      async read(position, length) {
        if (position < 0 || length < 0 || position + length > size)
          throw new ImportFailure("format");
        const buffer = Buffer.allocUnsafe(length);
        for (let offset = 0; offset < length; ) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
          if (!bytesRead) throw new ImportFailure("source_changed");
          offset += bytesRead;
        }
        signal.throwIfAborted();
        return buffer;
      },
    };
    if (
      !sameFile(selected, await file.stat({ bigint: true })) ||
      current !== (await realpath(path)) ||
      !sameFile(selected, await lstat(path, { bigint: true }))
    )
      throw new ImportFailure("source_changed");
    signal.throwIfAborted();
  } finally {
    await file.close();
  }
}
