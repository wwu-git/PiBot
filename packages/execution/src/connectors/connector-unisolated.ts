// Unisolated stdio MCP servers. Two callers only, both explicitly confirmed by the person:
// Windows, which has no command sandbox, and a macOS / Linux MCP the person
// moved outside the sandbox with its own switch. Never a fallback for a sandboxed
// start that failed: without `outsideSandbox` a POSIX caller is refused.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { userTerminalEnvironment } from "../command/environment.ts";
import { checkedRoot, within } from "../core/paths.ts";
import type { ExecRedactor } from "../core/types.ts";
import { ExecError } from "../core/types.ts";
import { windowsSystemRoot } from "../core/windows-environment.ts";
import {
  type ConnectorServerDiagnosis,
  ConnectorStartError,
  DIAGNOSIS_STDERR_CHARS,
  settleWithin,
} from "./connector-diagnosis.ts";
import {
  connectorProxyEnvironment,
  withoutConnectorProxyEnvironment,
} from "./connector-proxy-env.ts";
import type { ConnectorServerStream } from "./connector-server.ts";

/** Same bounds as the sandboxed path. */
const STDERR_TAIL_CHARS = 8 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const STOP_GRACE_MS = 3000;
const EXIT_SETTLE_MS = 1000;

export interface UnisolatedServerOptions {
  platform: NodeJS.Platform;
  command: string;
  args: readonly string[];
  cwd: string;
  /**
   * Windows: the full server environment (allowlist plus SecretStore results). POSIX: only the
   * MCP's own declared variables; the rest is the person's terminal environment below.
   */
  env: NodeJS.ProcessEnv;
  /**
   * macOS / Linux: the person confirmed this MCP runs as them. The server then gets
   * the real HOME and the same environment allowlist as an approved outside-sandbox
   * command; credential-valued variables are never copied from the app's environment.
   */
  outsideSandbox?: { userHome: string; userEnv: Readonly<NodeJS.ProcessEnv> };
  /** Brain-derived roots are revalidated here even though this confirmed path is unisolated. */
  readOnlyRoots?: readonly string[];
  readWriteRoots?: readonly string[];
  windowsRoot?: string;
  /** The person's extra command folders (Settings → Permissions), as agent commands get them. */
  pathEntries?: readonly string[];
  signal: AbortSignal;
  redactor?: ExecRedactor;
}

function connectorWindowsRoot(options: UnisolatedServerOptions) {
  return windowsSystemRoot({ SystemRoot: options.windowsRoot });
}

function serverEnvironment(options: UnisolatedServerOptions): NodeJS.ProcessEnv {
  const extra = [...(options.pathEntries ?? [])];
  if (options.platform === "win32") {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(options.env).filter(([key]) => key.toLowerCase() !== "systemroot"),
      ),
      SystemRoot: connectorWindowsRoot(options),
    };
    if (!extra.length) return env;
    // Windows names are case insensitive and a copied environment often spells it "Path".
    const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    // After the existing entries, as for an agent command, so System32 keeps precedence.
    env[key] = [...new Set([...(env[key] ?? "").split(";").filter(Boolean), ...extra])].join(";");
    return env;
  }
  const outside = options.outsideSandbox;
  if (!outside) throw new ExecError("isolation_unavailable");
  const temp = outside.userEnv.TMPDIR;
  const terminal = userTerminalEnvironment(
    options.platform,
    outside.userEnv,
    outside.userHome,
    temp && isAbsolute(temp) && !/[\0\r\n]/.test(temp) ? temp : tmpdir(),
    extra,
  );
  // Declared variables win over the terminal defaults, but HOME stays the person's own.
  return {
    ...terminal,
    ...withoutConnectorProxyEnvironment(options.env),
    ...connectorProxyEnvironment({ ...outside.userEnv, ...options.env }),
    HOME: outside.userHome,
  };
}

export async function startUnisolatedConnectorServer(
  options: UnisolatedServerOptions,
): Promise<ConnectorServerStream> {
  const windows = options.platform === "win32";
  if (!windows && !options.outsideSandbox) throw new Error("unisolated_connector_not_confirmed");
  options.signal.throwIfAborted();
  const grantedRoots = [...(options.readOnlyRoots ?? []), ...(options.readWriteRoots ?? [])];
  if (grantedRoots.length) {
    const cwd = await checkedRoot(resolve(options.cwd));
    const roots = await Promise.all(grantedRoots.map((root) => checkedRoot(resolve(root))));
    if (!roots.some((root) => within(root, cwd))) throw new ExecError("outside_workplace");
  }
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: serverEnvironment(options),
    windowsHide: true,
    shell: false,
    // POSIX: its own process group, so stop reaches whatever the server started (tunnels).
    detached: !windows,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = new Set<(message: string) => void>();
  const closes = new Set<() => void>();
  const queued: string[] = [];
  let queuedBytes = 0;
  let buffer = "";
  let closed = false;
  let failed: Error | undefined;
  let spawnFailed = false;
  let stopRequested = false;
  let exit: { code: number | null; signal: string | null; own: boolean } | undefined;
  let stderrTail = "";
  let shutdown: Promise<void> | undefined;
  let writes = Promise.resolve();
  const decoder = new StringDecoder("utf8");
  // "close" waits for every stdio pipe; on Windows a server that printed to stderr and quit is
  // often still "open" when the failed handshake closes the stream, so that exit was recorded as
  // our stop and the reason became protocol_error. "exit" says the process ended by itself.
  child.once("exit", (code, signal) => {
    exit ??= { code, signal, own: !stopRequested };
  });
  const exited = new Promise<void>((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      exit ??= { code, signal, own: !stopRequested };
      for (const listener of closes) listener();
      resolve();
    }),
  );
  child.on("error", () => {
    // ENOENT / EACCES: the program could not be started at all. The raw error carries paths.
    if (!child.pid) spawnFailed = true;
    failed = new Error("connector_process_unavailable");
  });
  child.stdin.on("error", () => {
    failed = new Error("connector_process_write_failed");
  });
  const stderrDecoder = new StringDecoder("utf8");
  const redacted = options.redactor?.stream();
  child.stderr.on("data", (chunk: Buffer) => {
    const text = redacted ? redacted.push(stderrDecoder.write(chunk)) : stderrDecoder.write(chunk);
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
  });
  child.stderr.once("end", () => {
    const text = redacted ? redacted.finish() : stderrDecoder.end();
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
  });
  child.stderr.once("error", () => {});

  const groupAlive = (pid: number) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signalGroup = (pid: number, signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  const waitGroupGone = async (pid: number, ms: number) => {
    const started = Date.now();
    while (groupAlive(pid)) {
      if (Date.now() - started >= ms) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  };
  const killTree = async () => {
    const pid = child.pid;
    if (!windows) {
      // The leader may be gone while its children (a tunnel, the real server) still run.
      if (pid && groupAlive(pid)) {
        signalGroup(pid, "SIGTERM");
        if (!(await waitGroupGone(pid, STOP_GRACE_MS))) signalGroup(pid, "SIGKILL");
        if (!(await waitGroupGone(pid, STOP_GRACE_MS)))
          throw new Error("connector_process_cleanup_failed");
      }
      if (pid) await exited;
      return;
    }
    if (closed) return;
    if (pid)
      await new Promise<void>((resolve, reject) => {
        const killer = spawn(
          join(connectorWindowsRoot(options), "System32", "taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", shell: false },
        );
        killer.once("error", () => reject(new Error("connector_process_cleanup_failed")));
        killer.once("close", (code) =>
          code === 0 || closed ? resolve() : reject(new Error("connector_process_cleanup_failed")),
        );
      });
    await exited;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
      failed = new Error("connector_frame_too_large");
      void close().catch(() => undefined);
      return;
    }
    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      const message = buffer.slice(0, boundary).replace(/\r$/, "");
      buffer = buffer.slice(boundary + 1);
      if (message) {
        if (messages.size) for (const listener of messages) listener(message);
        else {
          queuedBytes += Buffer.byteLength(message);
          if (queuedBytes > MAX_FRAME_BYTES) {
            failed = new Error("connector_frame_too_large");
            void close().catch(() => undefined);
            return;
          }
          queued.push(message);
        }
      }
      boundary = buffer.indexOf("\n");
    }
  });
  const close = () => {
    // A server whose process already ended stopped by itself; the recorded exit is its own.
    if (!closed && !exit) stopRequested = true;
    shutdown ??= killTree().catch((error) => {
      shutdown = undefined;
      throw error;
    });
    return shutdown;
  };
  const diagnose = async (): Promise<ConnectorServerDiagnosis> => {
    if (!spawnFailed) await settleWithin(exited, EXIT_SETTLE_MS);
    const own = exit?.own === true;
    return {
      exited: own,
      exitCode: own ? (exit?.code ?? null) : null,
      signal: own ? (exit?.signal ?? null) : null,
      hostFailed: false,
      spawnFailed,
      outsideSandbox: !windows,
      stderrTail: stderrTail.slice(-DIAGNOSIS_STDERR_CHARS),
      denials: [],
    };
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("connector_process_unavailable")));
    });
    options.signal.throwIfAborted();
  } catch (error) {
    await close().catch(() => undefined);
    if (options.signal.aborted) throw error;
    throw new ConnectorStartError("process_spawn_failed", await diagnose());
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
  return {
    write(message, signal) {
      const pending = writes.then(async () => {
        signal.throwIfAborted();
        if (closed || failed) throw new Error("connector_process_unavailable");
        if (Buffer.byteLength(message) > MAX_FRAME_BYTES || /[\r\n]/.test(message))
          throw new Error("connector_invalid_frame");
        await new Promise<void>((resolve, reject) =>
          child.stdin.write(`${message}\n`, (error) =>
            error ? reject(new Error("connector_process_write_failed")) : resolve(),
          ),
        );
      });
      writes = pending.catch(() => undefined);
      return pending;
    },
    onMessage(listener) {
      messages.add(listener);
      for (const message of queued.splice(0)) listener(message);
      queuedBytes = 0;
      return () => messages.delete(listener);
    },
    onClose(listener) {
      closes.add(listener);
      if (closed) listener();
      return () => closes.delete(listener);
    },
    close,
    stderrTail: () => stderrTail,
    diagnose,
  };
}
