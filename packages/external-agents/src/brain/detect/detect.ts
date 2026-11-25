// Detection happens only when the user opens the "external agents" category or
// the settings page. It looks up exact command names on PATH (never `codex*` wrappers), then in a
// fixed list of common install folders (an app started from the Dock gets a minimal PATH; no
// login shell is started and no shell profile is read), and runs `--version` inside the agent's
// sandbox with no network. It reads no account or chat data.
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, delimiter as posixDelimiter, relative, win32 } from "node:path";
import { AGENTS, type CustomAgent, type KnownAgentId } from "@pibot/external-agents-contract";
import { type LaunchDeps, launchAgent } from "../acp/launch.ts";

/** Cursor took 3.3 s alone on an idle Mac (2026-11-14) and timed out at 10 s while the app ran. */
const VERSION_TIMEOUT_MS = 25_000;

/** `path` is `root` or below it, compared by path segments (never a string prefix). */
function inside(root: string, path: string, platform: string) {
  const rel = platform === "win32" ? win32.relative(root, path) : relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function executable(path: string, platform: string) {
  try {
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isFile()) return undefined;
    if (platform !== "win32") await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    // Not there, not a file or not executable: the next PATH entry may have it.
    return undefined;
  }
}

/** Newest `~/.nvm/versions/node/v*` first (numeric compare), as their `bin` folders. */
async function nvmBins(home: string) {
  const root = join(home, ".nvm", "versions", "node");
  const versions = await readdir(root).catch(() => [] as string[]);
  const parts = (name: string) => name.replace(/^v/, "").split(".").map(Number);
  return versions
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    })
    .map((name) => join(root, name, "bin"));
}

/** Where the official installers and common Node managers put commands, after PATH. */
async function commonDirs(
  platform: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  if (platform === "win32") {
    const profile = env.USERPROFILE ?? home;
    return [
      win32.join(profile, ".local", "bin"),
      ...(env.APPDATA ? [win32.join(env.APPDATA, "npm")] : []),
      win32.join(env.LOCALAPPDATA ?? win32.join(profile, "AppData", "Local"), "agy", "bin"),
      ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, "pnpm")] : []),
      win32.join(profile, "scoop", "shims"),
      win32.join(profile, ".bun", "bin"),
      win32.join(profile, ".opencode", "bin"),
    ];
  }
  return [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".claude", "local"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".npm-global", "bin"),
    ...(platform === "darwin" ? [join(home, "Library", "pnpm")] : []),
    join(home, ".local", "share", "pnpm"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".asdf", "shims"),
    ...(await nvmBins(home)),
    ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    ...(platform === "linux" ? ["/home/linuxbrew/.linuxbrew/bin", "/snap/bin"] : []),
  ];
}

/** First match of `names` on PATH, then in the common folders, as the resolved program path. */
export async function findOnPath(
  names: readonly string[],
  deps: Pick<LaunchDeps, "env" | "platform" | "dataDir" | "userHome">,
): Promise<string | undefined> {
  const env = Object.fromEntries(
    Object.entries(deps.env).map(([key, value]) => [key.toUpperCase(), value]),
  );
  const delimiter = deps.platform === "win32" ? ";" : posixDelimiter;
  const dirs = [
    ...new Set([
      ...(env.PATH ?? "").split(delimiter),
      ...(await commonDirs(deps.platform, deps.userHome, env)),
    ]),
  ].filter((dir) => dir && isAbsolute(dir));
  const extensions =
    deps.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD")
          .split(";")
          .map((ext) => ext.toLowerCase())
          .filter((ext) => ext === ".exe" || ext === ".cmd")
      : [""];
  const join_ = deps.platform === "win32" ? win32.join : join;
  // Compare canonical paths: a symlinked data directory must still be recognised.
  const dataDir = await realpath(deps.dataDir).catch(() => deps.dataDir);
  for (const name of names) {
    // Only stats: every candidate at once, then the first one in search order wins.
    const candidates = dirs.flatMap((dir) => extensions.map((ext) => join_(dir, `${name}${ext}`)));
    const found = await Promise.all(candidates.map((path) => executable(path, deps.platform)));
    // Never treat something inside Pi Bot's own data as the user's agent.
    const hit = found.find(
      (path) =>
        path && !inside(dataDir, path, deps.platform) && !inside(deps.dataDir, path, deps.platform),
    );
    if (hit) return hit;
  }
  return undefined;
}

/** Resolves a custom agent's command: an absolute program, or a bare name on PATH. */
export async function resolveCustomProgram(
  custom: CustomAgent,
  deps: Pick<LaunchDeps, "env" | "platform" | "dataDir" | "userHome">,
) {
  if (isAbsolute(custom.command)) return executable(custom.command, deps.platform);
  if (/[\\/]/.test(custom.command)) return undefined;
  return findOnPath([custom.command], deps);
}

/** `--version` of the agent program inside its sandbox; null when it cannot be read. */
export async function programVersion(
  deps: LaunchDeps,
  agentId: KnownAgentId,
  program: string,
  signal: AbortSignal,
  /** Windows: the user confirmed running this agent unisolated, which covers `--version`. */
  confirmedUnisolated = false,
): Promise<string | null> {
  // Windows has no sandbox: without the confirmation the program is never started.
  if (deps.platform === "win32" && !confirmedUnisolated) return null;
  const folder = await realpath(await mkdtemp(join(await realpath(deps.tempDir), "agent-probe-")));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(VERSION_TIMEOUT_MS)]);
  try {
    const stream = await launchAgent(deps, {
      agent: { id: agentId, custom: null },
      target: { kind: "program", path: program, args: ["--version"] },
      cwd: folder,
      writeRoots: [folder],
      isolation: deps.platform === "win32" ? "unisolated" : "sandbox",
      offline: true,
      signal: deadline,
    });
    try {
      return await new Promise<string | null>((resolve) => {
        const done = (value: string | null) => {
          stopMessage();
          stopClose();
          deadline.removeEventListener("abort", aborted);
          resolve(value);
        };
        const aborted = () => done(null);
        const stopMessage = stream.onMessage((line) => {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal escapes.
          const text = line.replace(/[\u0000-\u001f\u007f]/g, "").trim();
          if (text) done(text.slice(0, 100));
        });
        const stopClose = stream.onClose(() => done(null));
        deadline.addEventListener("abort", aborted, { once: true });
        if (deadline.aborted) aborted();
      });
    } finally {
      await stream.close();
    }
  } catch {
    // Version is decoration: a failed probe still lists the agent as installed.
    return null;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * Versions the installers write into the program's own path, read without starting anything:
 * Claude Code `…/claude/versions/<version>`, Cursor `…/cursor-agent/versions/<version>/cursor-agent`,
 * Codex `…/releases/<version>-<target>/bin/codex`.
 */
export function versionFromPath(agentId: KnownAgentId, program: string) {
  const parts = program.split(/[\\/]/);
  const at = (index: number) => parts[parts.length - index] ?? "";
  const semver = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/;
  if (agentId === "claude" && at(2) === "versions" && semver.test(at(1)))
    return `${at(1)} (Claude Code)`;
  if (agentId === "cursor" && at(3) === "versions" && /^\d{4}\.\d+\.\d+-[0-9a-f]+$/.test(at(2)))
    return at(2);
  if (agentId === "codex" && at(4) === "releases" && at(2) === "bin") {
    const version = /^(\d+\.\d+\.\d+)-/.exec(at(3))?.[1];
    if (version) return `codex-cli ${version}`;
  }
  return undefined;
}

/**
 * `--version` results by program file (canonical path, size, mtime, inode): an unchanged binary
 * never starts a process again, also after a restart (a small JSON file in Pi Bot's data).
 */
export class VersionCache {
  private entries?: Map<string, string | null>;
  constructor(private readonly file: string) {}
  private async load() {
    if (this.entries) return this.entries;
    const parsed = await readFile(this.file, "utf8").then(
      (text) => JSON.parse(text) as unknown,
      () => ({}),
    );
    this.entries = new Map(
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.entries(parsed).filter(
            (entry): entry is [string, string | null] =>
              typeof entry[1] === "string" || entry[1] === null,
          )
        : [],
    );
    return this.entries;
  }
  static async key(program: string) {
    const info = await stat(program);
    return `${program}|${info.size}|${Math.trunc(info.mtimeMs)}|${info.ino}`;
  }
  async get(key: string) {
    const entries = await this.load();
    return entries.has(key) ? { version: entries.get(key) ?? null } : undefined;
  }
  async set(key: string, version: string | null) {
    const entries = await this.load();
    entries.set(key, version);
    // Bounded: old program versions fall out first.
    while (entries.size > 32) entries.delete(entries.keys().next().value as string);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

/** npm packages the agents' Windows installs come from (`<prefix>\\<name>.cmd` shims). */
const NPM_PACKAGES: Partial<Record<KnownAgentId, string>> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
};

/**
 * Windows: an npm shim's version from its package.json, read without starting anything (W6: the
 * card had no version on Windows because the sandboxed probe does not exist there).
 */
async function npmShimVersion(agentId: KnownAgentId, program: string) {
  const name = NPM_PACKAGES[agentId];
  if (!name || !/\.cmd$/i.test(program)) return undefined;
  const file = win32.join(
    win32.dirname(program),
    "node_modules",
    ...name.split("/"),
    "package.json",
  );
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && /^[0-9][0-9A-Za-z.+-]{0,60}$/.test(parsed.version)
      ? parsed.version
      : undefined;
  } catch {
    // No package.json there (another kind of install): the version stays unknown.
    return undefined;
  }
}

/** The version without a process where the path says it, else the cached or sandboxed probe. */
export async function agentVersion(
  deps: LaunchDeps,
  agentId: KnownAgentId,
  program: string,
  signal: AbortSignal,
  cache?: VersionCache,
  confirmedUnisolated = false,
) {
  const fromPath =
    versionFromPath(agentId, program) ??
    (deps.platform === "win32" ? await npmShimVersion(agentId, program) : undefined);
  if (fromPath) return fromPath;
  const key = await VersionCache.key(program).catch(() => undefined);
  const cached = key && cache ? await cache.get(key) : undefined;
  if (cached) return cached.version;
  const version = await programVersion(deps, agentId, program, signal, confirmedUnisolated);
  // A failed probe (timeout) is not remembered: the next detection tries again.
  if (key && cache && version !== null) await cache.set(key, version).catch(() => undefined);
  return version;
}

export async function findAgentProgram(id: KnownAgentId, deps: LaunchDeps) {
  const descriptor = AGENTS.find((agent) => agent.id === id);
  return descriptor ? findOnPath(descriptor.commands, deps) : undefined;
}
