// Which exec path starts a stdio MCP, and what is reported when it does not come up.
// Exec stays the only process creator; this module only chooses between its three entries.
import {
  type ConnectorServerStream,
  ConnectorStartError,
  childNodeRuntime,
  startSandboxedServer,
  startUnisolatedConnectorServer,
  windowsSystemRoot,
} from "@pibot/execution";
import type { ConnectorStartFailure } from "@pibot/plugins-contract/full";
import { classifyStartFailure } from "./connector-start-failure.ts";

export interface StdioStartOptions {
  platform: NodeJS.Platform;
  command: string;
  cwd?: string;
  args: readonly string[];
  /** The MCP's own declared variables, secrets resolved. */
  declaredEnv: NodeJS.ProcessEnv;
  /** The reduced allowlist (PATH/HOME/LANG/TMPDIR) a sandboxed or Windows server starts from. */
  baseEnv: NodeJS.ProcessEnv;
  /** Sanitized app environment; outside the sandbox the terminal allowlist is drawn from it. */
  commandEnv: NodeJS.ProcessEnv;
  networkDomains: readonly string[];
  home: string;
  dataDir?: string;
  tempDir: string;
  importedRoots?: { install: string; data: string };
  trustedStdio?: { machLookup?: readonly string[]; hostScriptPath?: string };
  /** MacOS / Linux, confirmed by the person and receipt-checked by the caller. */
  outsideSandbox: boolean;
  /** Settings → Permissions extra command folders; an MCP finds its launcher like a command. */
  pathEntries?: readonly string[];
  redact(value: string): string;
  reportStartFailure?(failure: ConnectorStartFailure): void;
  signal: AbortSignal;
}

/** Resolve only the bare Node launcher: explicit paths keep their declared meaning. */
function bundledNodeCommand(command: string, imported: boolean) {
  if (!imported) return command;
  return command === "node" || command === "node.exe" ? childNodeRuntime().executable : command;
}

/** True where this server runs without any system isolation. */
export const runsUnisolated = (options: Pick<StdioStartOptions, "platform" | "outsideSandbox">) =>
  options.platform === "win32" || options.outsideSandbox;

export async function startStdioStream(options: StdioStartOptions): Promise<ConnectorServerStream> {
  const roots = options.importedRoots;
  const common = {
    platform: options.platform,
    command: bundledNodeCommand(options.command, options.importedRoots !== undefined),
    args: options.args,
    cwd: options.cwd ?? roots?.install ?? options.home,
    readOnlyRoots: roots ? [roots.install] : undefined,
    readWriteRoots: roots ? [roots.data] : undefined,
    ...(options.pathEntries?.length ? { pathEntries: options.pathEntries } : {}),
    signal: options.signal,
  };
  try {
    if (options.platform === "win32")
      return await startUnisolatedConnectorServer({
        ...common,
        env: { ...options.baseEnv, ...options.declaredEnv },
        windowsRoot: windowsSystemRoot(options.commandEnv),
      });
    if (options.outsideSandbox)
      return await startUnisolatedConnectorServer({
        ...common,
        env: options.declaredEnv,
        outsideSandbox: { userHome: options.home, userEnv: options.commandEnv },
      });
    return await startSandboxedServer({
      ...common,
      useConfiguredCwd: options.cwd !== undefined,
      env: { ...options.baseEnv, ...options.declaredEnv },
      networkDomains: options.networkDomains,
      boundaryEnv: options.commandEnv,
      allowAll: false,
      tempDir: options.tempDir,
      systemHome: options.home,
      dataDir: options.dataDir,
      allowMachLookup: options.trustedStdio?.machLookup,
      hostScriptPath: options.trustedStdio?.hostScriptPath,
    });
  } catch (error) {
    if (error instanceof ConnectorStartError)
      options.reportStartFailure?.(
        classifyStartFailure({
          phase: "start",
          diagnosis: error.diagnosis,
          timedOut: false,
          outsideSandbox: runsUnisolated(options),
          redact: options.redact,
        }),
      );
    throw error;
  }
}

/**
 * The server started but the MCP handshake failed. The agent factory has already closed the
 * stream, so the diagnosis sees how the process ended. A stop by the person is not a failure.
 */
export async function reportInitializeFailure(
  stream: ConnectorServerStream,
  options: Pick<
    StdioStartOptions,
    "platform" | "outsideSandbox" | "redact" | "reportStartFailure" | "signal"
  >,
) {
  if (!options.reportStartFailure) return;
  const reason = options.signal.reason as { name?: unknown } | undefined;
  const timedOut = options.signal.aborted && reason?.name === "TimeoutError";
  if (options.signal.aborted && !timedOut) return;
  await stream.close().catch(() => undefined);
  options.reportStartFailure(
    classifyStartFailure({
      phase: "initialize",
      diagnosis: await stream.diagnose(),
      timedOut,
      outsideSandbox: runsUnisolated(options),
      redact: options.redact,
    }),
  );
}
