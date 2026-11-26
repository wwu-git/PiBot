// Define and adapt the host operations shared by local and remote execution.
import { lstat } from "node:fs/promises";
import { createExec } from "../command/command.ts";
import { fileIdentity } from "../core/file-identity.ts";
import { canonicalPath } from "../core/paths.ts";
import { type CommandResult, ExecError, type ExecOptions } from "../core/types.ts";
import { readBinaryFile, writeBinaryFile } from "../files/binary-files.ts";
import { createFileTools } from "../files/file-tools.ts";
import { writeImageBinary } from "../files/image-binary.ts";
import { replaceBinaryFile } from "../files/replace-binary.ts";
import { createSearchEngine } from "../files/search-rg.ts";
import { inspectPath, listEntries } from "../files/workspace-metadata.ts";
import {
  type GitEntryResult,
  type GitEntryTargetInput,
  inspectGitEntries,
} from "../git/git-entry-scan.ts";
import { hashCheckpointFile, readCheckpointFile } from "../managed/file-checkpoint.ts";
import type { RemoteManagedGit } from "../managed/managed-git-target.ts";
import { createSandboxConfig } from "../sandbox/sandbox-config.ts";

type LocalExec = ReturnType<typeof createExec>;
type LocalFiles = ReturnType<typeof createFileTools>;

/**
 * The execution-side boundary used by brain services. A future editor target may implement the
 * same contract without exposing where the work runs.
 */
/** One level of folders for a chooser (names and paths only). */
export interface FolderLevel {
  path: string | null;
  parent: string | null;
  top: boolean;
  folders: { name: string; path: string }[];
  truncated: boolean;
}
export interface ExecutionTarget {
  /** Managed Git for group worktrees on a runner; absent on an older runner (and locally). */
  managedGit?: RemoteManagedGit;
  computer?: {
    call(
      method: string,
      input: unknown,
      signal: AbortSignal,
      assertCurrent: () => void | Promise<void>,
      blockedApps?: readonly string[],
    ): Promise<unknown>;
  };
  /** Owner facts only; zero is not a substitute for dispose/drain confirmation. */
  activitySnapshot?(): { runningCommands: number; backgroundTasks: number };
  /** Local only: commands are paused because a previous command was not confirmed stopped. */
  commandPause?: LocalExec["commandPause"];
  recheckCommandPause?: LocalExec["recheckCommandPause"];
  readonly supportsCommandPromotion?: boolean;
  /**
   * Operations that always fail on this target whatever the input, so callers can avoid offering
   * them. Capability that may change at runtime stays out of this set and fails per call instead.
   */
  readonly unsupportedOperations?: ReadonlySet<keyof ExecutionTarget>;
  /** Trusted target roots for command text warnings only; never grants write authority. */
  commandProtectionRoots?(signal: AbortSignal): Promise<readonly string[]>;
  /** Policy-compatible target realpath; remote callers must inject this instead of local fs. */
  realpath(path: string, signal: AbortSignal): Promise<string>;
  /** Target-side canonicalization used before policy grants any path authority. */
  canonicalizePath(
    path: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ path: string; device: string | null; inode: string | null }>;
  isolationStatus: LocalExec["isolationStatus"];
  runCommand(input: Parameters<LocalExec["runCommand"]>[0]): Promise<CommandResult>;
  releaseRun: LocalExec["releaseRun"];
  startBackground: LocalExec["startBackground"];
  writeBackground: LocalExec["writeBackground"];
  background: LocalExec["background"];
  inspectPath?: typeof inspectPath;
  listEntries?: typeof listEntries;
  listDir: LocalFiles["listDir"];
  readFile: LocalFiles["readFile"];
  /** Redacted command logs use the same bounded, canonical text reader. */
  readLog: LocalFiles["readFile"];
  /** A bounded metadata snapshot used by local and remote change observers. */
  observeChanges: LocalFiles["listDir"];
  findFiles: LocalFiles["findFiles"];
  searchText: LocalFiles["searchText"];
  writeFile: LocalFiles["writeFile"];
  editFile: LocalFiles["editFile"];
  applyPatch: LocalFiles["applyPatch"];
  readBinary: typeof readBinaryFile;
  writeBinary: typeof writeBinaryFile;
  replaceBinary?: typeof replaceBinaryFile;
  writeImage: typeof writeImageBinary;
  readCheckpoint: typeof readCheckpointFile;
  hashCheckpoint?: typeof hashCheckpointFile;
  /**
   * Which project hooks / executable config an ordinary Git command would run, scanned
   * where the repository lives. `botHome` is the command HOME this target uses; a runner supplies
   * its own. Targets without it cannot run Git that the brain has to bind.
   */
  inspectGitEntries?(
    input: GitEntryTargetInput & { botHome?: string },
    signal: AbortSignal,
  ): Promise<GitEntryResult>;
  /**
   * One level of folder names for the folder chooser, including
   * ancestors such as the user's home that `listDir` refuses because they contain the target's own
   * data. Never lists inside private folders and never shows them. `null`: the drive list (Windows)
   * or "/". Grants nothing: picking a folder still goes through `canonicalizePath`.
   */
  listFolders?(path: string | null | undefined, signal: AbortSignal): Promise<FolderLevel>;
  dispose: LocalExec["dispose"];
}

export interface LocalExecutionTargetOptions {
  command: ExecOptions;
  files: NonNullable<Parameters<typeof createFileTools>[0]>;
}

/** One local target owns one command runtime and one shared file writer/recovery latch. */
export function createLocalExecutionTarget(options: LocalExecutionTargetOptions): ExecutionTarget {
  // Preserve the previous file-tools-before-exec order and the single file-tools owner.
  // The same checked rg the command sandbox uses; a target without one searches on JS.
  const searchEngine = createSearchEngine(
    createSandboxConfig(options.command).ripgrepPath,
    (code) =>
      options.command.onDiagnostic?.({
        runId: "search",
        stage: "dispatch",
        code,
        readonlyRoots: 0,
      }),
  );
  const files = createFileTools({ ...options.files, searchEngine });
  const exec = createExec(options.command);
  return {
    supportsCommandPromotion: true,
    async realpath(path, signal) {
      signal.throwIfAborted();
      const result = await canonicalPath(path, path);
      signal.throwIfAborted();
      return result;
    },
    async canonicalizePath(path, cwd, signal) {
      signal.throwIfAborted();
      const result = await canonicalPath(path, cwd);
      const stat = await lstat(result, { bigint: true }).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      signal.throwIfAborted();
      return { path: result, ...(stat ? fileIdentity(stat) : { device: null, inode: null }) };
    },
    activitySnapshot: exec.activitySnapshot,
    commandPause: exec.commandPause,
    recheckCommandPause: exec.recheckCommandPause,
    isolationStatus: exec.isolationStatus,
    runCommand: exec.runCommand,
    releaseRun: exec.releaseRun,
    startBackground: exec.startBackground,
    writeBackground: exec.writeBackground,
    background: exec.background,
    inspectPath,
    listEntries,
    listDir: files.listDir,
    readFile: files.readFile,
    readLog: files.readFile,
    observeChanges: files.listDir,
    findFiles: files.findFiles,
    searchText: files.searchText,
    writeFile: files.writeFile,
    editFile: files.editFile,
    applyPatch: files.applyPatch,
    readBinary: readBinaryFile,
    writeBinary: writeBinaryFile,
    replaceBinary: replaceBinaryFile,
    writeImage: writeImageBinary,
    readCheckpoint: readCheckpointFile,
    hashCheckpoint: hashCheckpointFile,
    async inspectGitEntries(input, signal) {
      if (!input.botHome) throw new ExecError("invalid_input");
      return inspectGitEntries(
        {
          ...input,
          botHome: input.botHome,
          platform: options.command.platform,
          env: options.command.env,
          privateTempRoot: options.command.tempDir,
        },
        signal,
      );
    },
    dispose: exec.dispose,
  };
}
