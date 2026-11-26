import { randomUUID } from "node:crypto";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { commandEnvironment } from "../command/environment.ts";
import { executeHostedCommand } from "../command/foreground-host.ts";
import { withDeadline } from "../core/deadline.ts";
import {
  ExecError,
  type ExecOptions,
  type IsolationStatus,
  type NetworkSettings,
} from "../core/types.ts";
import { type GitHookSnapshot, gitHookSnapshotDirectory } from "../git/git-hook-snapshot.ts";
import { linuxIsolationFailure, linuxProbeDiagnostic } from "./linux-isolation.ts";
import { cleanupSandboxPlaceholders, recordSandboxPlaceholders } from "./placeholder-ledger.ts";
import { createSandboxConfig } from "./sandbox-config.ts";
import type { BotReadContext } from "./sensitive-paths.ts";
import { allowedSandboxSystemService } from "./system-services.ts";

/** Builds profiles without touching the parent process's SRT singleton, including status probes. */
export function createSandboxProfiles(options: ExecOptions) {
  const builder = createSandboxConfig(options);
  const lifetime = new AbortController();
  let pending: Promise<IsolationStatus> | undefined;
  let retryAt: number | undefined;
  let proxy: string | undefined;
  const active = new Set<Promise<unknown>>();
  // Leftovers of a killed earlier sandbox go before this process starts its first one: deleting
  // a mount point under a running bwrap would detach that sandbox's deny rule.
  const ledger = options.platform === "linux" ? options.placeholderLedger : undefined;
  const leftovers = ledger ? cleanupSandboxPlaceholders(ledger).catch(() => 0) : Promise.resolve(0);
  const recorded = new Set<string>();
  async function probe(): Promise<IsolationStatus> {
    if (options.platform === "win32") return { available: false, reason: "windows_unisolated" };
    if (options.platform !== "darwin" && options.platform !== "linux")
      return { available: false, reason: "platform_unsupported" };
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]);
    let dir: string | undefined;
    let drained = true;
    let output = "";
    const probeId = randomUUID();
    try {
      const config = await builder.config([], { allowAll: false, domains: [] }, signal);
      dir = await mkdtemp(join(await realpath(options.tempDir), "sandbox-status-"));
      const file = await open(join(dir, "output.log"), "wx", 0o600);
      const log = file.createWriteStream({ autoClose: false });
      try {
        const result = await executeHostedCommand({
          options,
          config,
          allowAll: false,
          command: "true",
          commandId: probeId,
          onOutput: (text) => {
            output = (output + text).slice(-8192);
          },
          cwd: dir,
          env: {
            ...commandEnvironment(options.platform, options.env, options.systemHome, dir),
            // Fixed probe diagnostics must not depend on the user's locale.
            LC_ALL: "C",
          },
          signal,
          log,
          prepared: async () => signal.throwIfAborted(),
        });
        output = (output + result.truncatedOutput).slice(-8192);
        if (result.exitCode !== 0) throw new ExecError("isolation_unavailable");
        return { available: true };
      } finally {
        log.destroy();
        await file.close();
      }
    } catch (error) {
      if (error instanceof ExecError && error.reason === "cleanup_failed") {
        drained = false;
        throw error;
      }
      if (lifetime.signal.aborted) return { available: false, reason: "exec_closed" };
      const diagnostic =
        options.platform !== "linux"
          ? undefined
          : error instanceof ExecError && error.reason === "seccomp_helper_unavailable"
            ? "apply-seccomp: unavailable (not found or not executable)"
            : linuxProbeDiagnostic(output);
      const reason =
        options.platform === "linux"
          ? await linuxIsolationFailure(
              await builder.ripgrepPath().catch(() => ""),
              diagnostic,
              options.env?.PATH,
            )
          : "sandbox_dependencies_or_runtime_unavailable";
      options.onDiagnostic?.({
        runId: probeId,
        stage: "isolation",
        code: reason,
        readonlyRoots: 0,
        ...(diagnostic ? { diagnostic } : {}),
      });
      return { available: false, reason };
    } finally {
      if (dir && drained) await rm(dir, { recursive: true, force: true });
    }
  }
  const isolationStatus = (signal?: AbortSignal) => {
    if (lifetime.signal.aborted)
      return Promise.resolve({ available: false, reason: "exec_closed" });
    if (
      !pending ||
      proxy !== options.proxy?.()?.url ||
      (retryAt !== undefined && performance.now() >= retryAt)
    ) {
      proxy = options.proxy?.()?.url;
      retryAt = undefined;
      const work = probe();
      pending = work;
      // A failed but fully drained probe is recoverable; cleanup failures remain rejected and
      // must never authorize a retry while the previous host's lifetime is uncertain.
      void work.then(
        (value) => {
          if (pending === work && !value.available) retryAt = performance.now() + 5_000;
        },
        () => {
          // Preserve the rejection for callers and the existing failed-drain contract.
        },
      );
      active.add(work);
      void work
        .finally(() => active.delete(work))
        .catch(() => {
          /* The status caller receives the probe failure. */
        });
    }
    return signal
      ? withDeadline(pending, 25_000, new ExecError("isolation_unavailable"), signal)
      : pending;
  };
  return {
    isolationStatus,
    async config(
      roots: string[],
      network: NetworkSettings,
      signal: AbortSignal,
      bot: BotReadContext,
      settings: {
        tempDir: string;
        git?: { phase: "directories" | "initialize"; gitDirectory: string };
        localBinding?: boolean;
        dockerSocket?: string;
        systemServices?: string[];
        localServices?: { ports: number[]; sockets: string[] };
        denyWriteRoots?: string[];
        readonlyReferences?: boolean;
        readRoots?: string[];
        hookSnapshot?: GitHookSnapshot;
      },
    ) {
      if (!(await isolationStatus(signal)).available) throw new ExecError("isolation_unavailable");
      if (ledger) {
        await leftovers;
        // Best effort: a failed record only means a killed sandbox's placeholders stay.
        await recordSandboxPlaceholders(ledger, roots, recorded).catch(() => undefined);
      }
      if (settings.denyWriteRoots?.length && options.platform !== "darwin")
        throw new ExecError("isolation_unavailable");
      let snapshot: string | undefined;
      if (settings.hookSnapshot) {
        if (
          options.platform !== "linux" ||
          process.platform !== "linux" ||
          settings.git ||
          settings.dockerSocket ||
          settings.readonlyReferences
        )
          throw new ExecError("isolation_unavailable");
        snapshot = await gitHookSnapshotDirectory(settings.hookSnapshot, settings.tempDir);
      }
      const value = await builder.config(
        roots,
        network,
        signal,
        bot,
        [...(settings.denyWriteRoots ?? []), ...(snapshot ? [snapshot] : [])],
        settings.git?.phase === "initialize",
        settings.git?.phase === "directories",
        settings.git?.gitDirectory,
        settings.localBinding === true,
        settings.tempDir,
        settings.readonlyReferences === true,
        settings.readRoots,
      );
      if (settings.dockerSocket) {
        if (
          options.platform !== "darwin" ||
          settings.git ||
          /[\p{Cc}\p{Cf}]/u.test(settings.dockerSocket)
        )
          throw new ExecError("invalid_input");
        value.network.allowUnixSockets = [settings.dockerSocket];
      }
      if (settings.systemServices?.length) {
        if (
          options.platform !== "darwin" ||
          settings.git ||
          !settings.systemServices.every(allowedSandboxSystemService)
        )
          throw new ExecError("invalid_input");
        value.network.allowMachLookup = [
          ...new Set([...(value.network.allowMachLookup ?? []), ...settings.systemServices]),
        ];
      }
      if (settings.localServices) {
        // Only macOS Seatbelt can admit one loopback port or socket path; Linux puts the
        // command in its own network namespace, so policy offers a run outside the sandbox there.
        const { ports, sockets } = settings.localServices;
        if (
          options.platform !== "darwin" ||
          settings.git ||
          ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
          sockets.some((path) => !isAbsolute(path) || /[\p{Cc}\p{Cf}]/u.test(path))
        )
          throw new ExecError("invalid_input");
        if (ports.length) value.network.allowLoopbackPorts = [...new Set(ports)];
        if (sockets.length)
          value.network.allowUnixSockets = [
            ...new Set([...(value.network.allowUnixSockets ?? []), ...sockets]),
          ];
      }
      return value;
    },
    async dispose() {
      lifetime.abort();
      await Promise.allSettled([...active]);
    },
  };
}
