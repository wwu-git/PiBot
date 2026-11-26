// Build the platform-specific environment assigned to agent commands.
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { ExecError } from "../core/types.ts";
import { installedWindowsRoot } from "../core/windows-environment.ts";
import { bundledGit, bundledGitReady } from "../git/bundled-git.ts";
import { commandPaths } from "./command-paths.ts";

/**
 * Windows has no command sandbox: every command is an approved "unisolated run", so the
 * user's own PATH is no wider than what the user just approved. Without it Git, Node, Python and
 * winget-installed tools are not found at all, because Windows has no fixed /usr/local/bin
 * equivalent. Entries come after System32 so system tools keep precedence; only existing
 * absolute directories are kept, unexpanded %VAR% entries and duplicates are dropped.
 */
function windowsUserPath(original: Readonly<NodeJS.ProcessEnv>, taken: readonly string[]) {
  const value = Object.entries(original).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const key = (entry: string) =>
    win32
      .normalize(entry)
      .replace(/(?<=[^:\\])\\+$/, "")
      .toLowerCase();
  const seen = new Set(taken.map(key));
  const entries: string[] = [];
  for (const raw of value.split(";")) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !win32.isAbsolute(entry) || /[\0\r\n%"]/.test(entry)) continue;
    const id = key(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      if (statSync(entry).isDirectory()) entries.push(entry);
    } catch {
      // Stale PATH entries (uninstalled tools, unplugged drives) are common; skipping is safe.
    }
  }
  return entries;
}

/**
 * Windows builds ship MinGit (bundled-git.ts); most Windows computers have no Git. Its `cmd`
 * folder goes after everything else on PATH, so an installed Git always wins and the bundled copy
 * only fills the gap. Only a fully unpacked copy is added (command-context unpacks it first).
 * Nothing is added on other platforms, in dev runs, or for an odd path.
 */
function bundledGitPath(
  platform: NodeJS.Platform,
  original: Readonly<NodeJS.ProcessEnv>,
  resourcesDir: string | undefined,
) {
  const git = bundledGit(platform, original, resourcesDir);
  return git && bundledGitReady(git) ? [win32.dirname(git.program)] : [];
}

export function commandEnvironment(
  platform: NodeJS.Platform,
  original: Readonly<NodeJS.ProcessEnv>,
  home: string,
  temp: string,
  additions: string[] = [],
  resourcesDir?: string,
): NodeJS.ProcessEnv {
  const { delimiter, isAbsolute, join } = platform === "win32" ? win32 : posix;
  if (
    additions.some(
      (value) => !isAbsolute(value) || value.includes(delimiter) || /[\0\r\n]/.test(value),
    )
  )
    throw new ExecError("invalid_input");
  const windows = platform === "win32";
  const systemRoot = windows ? (installedWindowsRoot(original) ?? "") : "";
  if (windows && (!isAbsolute(systemRoot) || /[\0\r\n]/.test(systemRoot)))
    throw new ExecError("invalid_input");
  const paths = windows
    ? [join(systemRoot, "System32"), join(systemRoot, "System32", "WindowsPowerShell", "v1.0")]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const user = windows
    ? windowsUserPath(original, [...paths, ...additions])
    : commandPaths(platform, original.PATH ?? "");
  // Explicit choices and the launcher environment select the user's Node/toolchain on Unix.
  // Windows retains System32 precedence. No variables other than PATH are imported here.
  const search = windows
    ? [...paths, ...additions, ...user, ...bundledGitPath(platform, original, resourcesDir)]
    : [...additions, ...user, ...paths];
  return {
    PATH: [...new Set(search)].join(delimiter),
    HOME: home,
    LANG: original.LANG && !/[\0\r\n]/.test(original.LANG) ? original.LANG : "en_US.UTF-8",
    TERM: "dumb",
    SHELL: windows ? join(paths[1] as string, "powershell.exe") : "/bin/bash",
    TMPDIR: temp,
    // Git's other global file is $XDG_CONFIG_HOME/git/config, and commands get a per-run
    // XDG folder they can write. Pinning the global file to HOME/.gitconfig (what Git reads anyway)
    // keeps a command from planting hooks/helpers there for a later Git command in the same run.
    ...(windows ? {} : { GIT_CONFIG_GLOBAL: join(home, ".gitconfig") }),
    ...(windows
      ? {
          SystemRoot: systemRoot,
          TEMP: temp,
          TMP: temp,
          USERPROFILE: home,
          // Without PATHEXT PowerShell cannot resolve `git` to git.exe or `npm` to npm.cmd.
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          ComSpec: join(paths[0] as string, "cmd.exe"),
        }
      : {}),
  };
}

/**
 * Names and paths CLIs read to find the user's own login and config (profile, region,
 * kubeconfig, agent socket, config folders). Values that ARE credentials (AWS_SECRET_ACCESS_KEY,
 * GH_TOKEN, …) are deliberately absent: the tools find those in the real HOME, and a token in the
 * app's own environment was never chosen by the user for this command. Each value must have the
 * shape of a name or a path; URL-like values are refused outright, since `scheme://user:pass@host`
 * would carry a credential (DOCKER_HOST is left out for that reason).
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+){1,4}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const FLAG = /^(?:0|1|true|false)$/i;
const absolutePath = (value: string) =>
  posix.isAbsolute(value) && value.length <= 1024 && !value.includes("://");
const pathList = (value: string) => value.split(":").every(absolutePath);
const USER_POINTERS: Readonly<Record<string, (value: string) => boolean>> = {
  USER: (value) => NAME.test(value),
  LOGNAME: (value) => NAME.test(value),
  AWS_PROFILE: (value) => NAME.test(value),
  AWS_DEFAULT_PROFILE: (value) => NAME.test(value),
  AWS_REGION: (value) => REGION.test(value),
  AWS_DEFAULT_REGION: (value) => REGION.test(value),
  AWS_CONFIG_FILE: absolutePath,
  AWS_SHARED_CREDENTIALS_FILE: absolutePath,
  AWS_SDK_LOAD_CONFIG: (value) => FLAG.test(value),
  KUBECONFIG: pathList,
  SSH_AUTH_SOCK: absolutePath,
  CLOUDSDK_CONFIG: absolutePath,
  CLOUDSDK_ACTIVE_CONFIG_NAME: (value) => NAME.test(value),
  DOCKER_CONTEXT: (value) => NAME.test(value),
  DOCKER_CONFIG: absolutePath,
  GH_CONFIG_DIR: absolutePath,
  GH_HOST: (value) => HOST.test(value),
  AZURE_CONFIG_DIR: absolutePath,
  GNUPGHOME: absolutePath,
  XDG_CONFIG_HOME: absolutePath,
  XDG_DATA_HOME: absolutePath,
  XDG_CACHE_HOME: absolutePath,
  XDG_STATE_HOME: absolutePath,
};

/**
 * A run a person approved outside the sandbox should see what their terminal sees:
 * the real HOME (USERPROFILE on Windows) and the user's own Git/XDG configuration. Inside the
 * sandbox the Bot's private HOME stays (commandEnvironment); PATH is chosen the same way for both.
 */
export function userTerminalEnvironment(
  platform: NodeJS.Platform,
  original: Readonly<NodeJS.ProcessEnv>,
  userHome: string,
  temp: string,
  additions: string[] = [],
  resourcesDir?: string,
): NodeJS.ProcessEnv {
  const env = commandEnvironment(platform, original, userHome, temp, additions, resourcesDir);
  // Pinned only so a sandboxed command cannot plant a global file for a later one.
  delete env.GIT_CONFIG_GLOBAL;
  for (const [name, valid] of Object.entries(USER_POINTERS)) {
    const value = original[name];
    if (value && !/[\0\r\n]/.test(value) && valid(value)) env[name] = value;
  }
  return env;
}
