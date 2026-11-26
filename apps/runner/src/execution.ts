// Enforce runner-local boundaries on paths supplied over the authenticated link.
import { access, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import {
  type ExecutionTarget,
  type FolderLevel,
  sensitiveReadBoundary,
  windowsHostNames,
  windowsPathName,
  windowsReservedRoot,
  windowsSystemTrees,
  windowsWithin,
} from "@pibot/execution";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";

/** The paired brain can authorize project roots, never this runner's credentials or owner files. */
export function runnerExecution(
  local: ExecutionTarget,
  dataDir: string,
  commandHome: string,
  host: {
    platform: "darwin" | "linux" | "win32";
    userHome: string;
    env: Readonly<NodeJS.ProcessEnv>;
  },
): ExecutionTarget {
  // Windows reaches one file under several names: a drive path, an admin share of this machine
  // (`\\localhost\c$`) and the `\\?\` namespace. Comparing the raw strings showed such an alias
  // as unrelated to the path it opens, so it walked past the data and credential directories
  //; compare the normalized names instead.
  const hosts =
    host.platform === "win32" ? windowsHostNames(hostname(), host.env.COMPUTERNAME) : [];
  const systemTrees = host.platform === "win32" ? windowsSystemTrees(host.env) : [];
  const contains = (root: string, path: string) => {
    if (host.platform === "win32")
      return windowsWithin(windowsPathName(root, hosts), windowsPathName(path, hosts));
    const part = relative(root, path);
    return (
      part === "" ||
      (!part.startsWith(`..${sep}`) &&
        part !== ".." &&
        !part.startsWith(sep) &&
        !/^[A-Za-z]:/.test(part))
    );
  };
  /**
   * Brain authorizes the search root once, so a walk still has to refuse this runner's
   * own private directories per path — `skipSensitive` matches names, and a credential file with
   * an ordinary name sits inside `dataDir`. Computed once per call: a boundary lookup per visited
   * file made the walk measurably slower, and only canonicalization needs the full picture.
   */
  const privateRoots = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const boundary = await sensitiveReadBoundary(host.platform, [host.userHome], host.env);
    return boundary.denyRead;
  };
  const searchAuthorizer = async (
    input: {
      cwd: string;
      authorizePath(
        path: string,
        kind: "directory" | "file",
        signal: AbortSignal,
      ): Promise<boolean>;
    },
    signal: AbortSignal,
  ) => {
    const denyRead = await privateRoots(signal);
    return async (
      path: string,
      kind: "directory" | "file",
      current: AbortSignal,
    ): Promise<boolean> => {
      current.throwIfAborted();
      const absolute = resolve(input.cwd, path);
      if (
        contains(dataDir, path) ||
        denyRead.some((root) => contains(root, path) || contains(root, absolute))
      )
        return false;
      return input.authorizePath(path, kind, current);
    };
  };
  const canonicalize: ExecutionTarget["canonicalizePath"] = async (path, cwd, signal) => {
    signal.throwIfAborted();
    // Re-resolve aliases per operation, using the runner host rather than desktop paths/env.
    const requested = host.platform === "win32" ? windowsPathName(path, []) : undefined;
    if (requested && requested.kind !== "drive" && win32.isAbsolute(path))
      throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    const denyRead = await privateRoots(signal);
    const result = await local.canonicalizePath(path, cwd, signal);
    signal.throwIfAborted();
    if (host.platform === "win32") {
      const name = windowsPathName(result.path, []);
      // Another machine's share and device paths cannot be shown to stay outside the private
      // directories, and a drive root or an install tree is no workplace: refuse instead of guessing.
      if (
        name.kind !== "drive" ||
        (requested?.kind === "drive" &&
          (win32.parse(requested.path).root !== win32.parse(name.path).root ||
            windowsReservedRoot(requested, systemTrees))) ||
        windowsReservedRoot(name, systemTrees)
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    }
    if (
      contains(dataDir, result.path) ||
      denyRead.some((root) => contains(root, resolve(cwd, path)) || contains(root, result.path))
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    return result;
  };
  const accessible: ExecutionTarget["canonicalizePath"] = async (path, cwd, signal) => {
    const result = await canonicalize(path, cwd, signal);
    // Policy resolves a project component by component, including ancestors of the private
    // data root. That metadata is not permission to list/read/write the ancestor itself.
    if (contains(result.path, dataDir))
      throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    return result;
  };
  const guard = async (input: {
    cwd: string;
    signal: AbortSignal;
    writeRoots: string[];
    path?: string;
    expectedPath?: string;
  }) => {
    await accessible(input.cwd, input.cwd, input.signal);
    const checked = await accessible(input.path ?? input.cwd, input.cwd, input.signal);
    if (
      input.expectedPath &&
      !(host.platform === "win32"
        ? windowsPathName(input.expectedPath, []).path === windowsPathName(checked.path, []).path
        : input.expectedPath === checked.path)
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    for (const root of input.writeRoots) await accessible(root, root, input.signal);
    return checked.path;
  };
  /**
   * The folder chooser walks from a drive or the user's profile down to a
   * project. Those ancestors contain this runner's own data, so `listDir` (a workplace read) refuses
   * them. This lists folder names only, never inside the data or private directories and never
   * showing them; choosing a folder still goes through `canonicalize`, which refuses those ancestors
   * as workplaces.
   */
  const listFolders = async (
    path: string | null | undefined,
    signal: AbortSignal,
  ): Promise<FolderLevel> => {
    signal.throwIfAborted();
    const windows = host.platform === "win32";
    if ((path === null || (path === undefined && !host.userHome)) && windows) {
      const folders: FolderLevel["folders"] = [];
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        signal.throwIfAborted();
        const root = `${letter}:\\`;
        if (
          await access(root).then(
            () => true,
            () => false,
          )
        )
          folders.push({ name: `${letter}:`, path: root });
      }
      signal.throwIfAborted();
      return { path: null, parent: null, top: true, folders, truncated: false };
    }
    const asked = path ?? (windows ? host.userHome : "/");
    if (!isAbsolute(asked))
      throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    const requested = windows ? windowsPathName(asked, []) : undefined;
    if (requested && requested.kind !== "drive")
      throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    const real = (await local.canonicalizePath(asked, asked, signal)).path;
    signal.throwIfAborted();
    if (requested) {
      const target = windowsPathName(real, []);
      if (
        target.kind !== "drive" ||
        win32.parse(target.path).root !== win32.parse(requested.path).root
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    }
    const hidden = [dataDir, ...(await privateRoots(signal))];
    if (hidden.some((root) => contains(root, real)))
      throw new RpcError(RpcErrorCodes.invalidParams, "runner_path_unavailable");
    const entries = await readdir(real, { withFileTypes: true });
    const folders: FolderLevel["folders"] = [];
    let truncated = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || (windows && entry.name.startsWith("$"))) continue;
      const child = join(real, entry.name);
      if (hidden.some((root) => contains(root, child))) continue;
      if (folders.length >= 500) {
        truncated = true;
        break;
      }
      folders.push({ name: entry.name, path: child });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const root = parse(real).root;
    const atRoot = real === root;
    return {
      path: real,
      parent: atRoot ? null : dirname(real),
      // A drive root goes up to the drive list; "/" and a share root are the top.
      top: atRoot && !(windows && /^[A-Za-z]:\\$/.test(root)),
      folders,
      truncated,
    };
  };
  return {
    ...local,
    listFolders,
    canonicalizePath: canonicalize,
    realpath: async (path, signal) => (await canonicalize(path, path, signal)).path,
    async runCommand(input) {
      await guard(input);
      return local.runCommand({
        ...input,
        dataDir,
        botHome: commandHome,
        homeDir: commandHome,
        skillGroupId: undefined,
        skillPackageIds: undefined,
      });
    },
    // The entry scan runs here, against this runner's files and its own command HOME.
    async inspectGitEntries(input, signal) {
      if (!local.inspectGitEntries)
        throw new RpcError(RpcErrorCodes.unsupported, "runner_git_entries_unavailable");
      for (const invocation of input.invocations)
        await accessible(invocation.cwd, invocation.cwd, signal);
      return local.inspectGitEntries({ ...input, botHome: commandHome }, signal);
    },
    async startBackground(input) {
      await guard(input);
      return local.startBackground({
        ...input,
        dataDir,
        botHome: commandHome,
        homeDir: commandHome,
        skillGroupId: undefined,
        skillPackageIds: undefined,
      });
    },
    async inspectPath(input) {
      if (!local.inspectPath)
        throw new RpcError(RpcErrorCodes.unsupported, "workspace_files_unsupported");
      await guard(input);
      return local.inspectPath(input);
    },
    async listEntries(input) {
      if (!local.listEntries)
        throw new RpcError(RpcErrorCodes.unsupported, "workspace_files_unsupported");
      await guard(input);
      return local.listEntries(input);
    },
    async listDir(input) {
      const expectedPath = await guard(input);
      return local.listDir({ ...input, expectedPath });
    },
    async readFile(input) {
      const expectedPath = await guard(input);
      return local.readFile({ ...input, expectedPath });
    },
    async readLog(input) {
      const expectedPath = await guard(input);
      return local.readLog({ ...input, expectedPath });
    },
    async observeChanges(input) {
      const expectedPath = await guard(input);
      return local.observeChanges({ ...input, expectedPath });
    },
    async findFiles(input) {
      await guard(input);
      return local.findFiles({
        ...input,
        authorizePath: await searchAuthorizer(input, input.signal),
      });
    },
    async searchText(input) {
      await guard(input);
      return local.searchText({
        ...input,
        authorizePath: await searchAuthorizer(input, input.signal),
      });
    },
    async writeFile(input) {
      await guard(input);
      return local.writeFile(input);
    },
    async editFile(input) {
      await guard(input);
      return local.editFile(input);
    },
    async applyPatch(input) {
      await guard(input);
      for (const path of input.expectedPaths) await accessible(path, input.cwd, input.signal);
      return local.applyPatch(input);
    },
    async readBinary(input) {
      const expectedPath = await guard(input);
      return local.readBinary({ ...input, expectedPath });
    },
    async writeBinary(input) {
      await guard(input);
      return local.writeBinary(input);
    },
    async writeImage(input) {
      await guard(input);
      return local.writeImage(input);
    },
    async readCheckpoint(path, signal) {
      await accessible(path, path, signal);
      return local.readCheckpoint(path, signal);
    },
  };
}
