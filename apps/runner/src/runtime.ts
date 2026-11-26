// Assemble the runner with boundaries from the machine that owns its files.
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createLocalExecutionTarget,
  type ExecOptions,
  type IsolationStatus,
  windowsSystemTrees,
} from "@pibot/execution";
import { UnsafeSandboxEnvironmentError } from "@pibot/execution/host-environment";
import { base64url } from "@pibot/link";
import type { Port } from "@pibot/protocol-base";
import {
  createExecutionJournal,
  createManagedGitPort,
  createRunnerJobRegistry,
  createRunnerRuntime,
  openRunnerIdentity,
} from "@pibot/runner";
import { prepareRunnerCommandTempDir } from "./command-temp-dir.ts";
import { createRunnerComputerHost } from "./computer/index.ts";
import { prepareRunnerDataDir } from "./data-dir.ts";
import { runnerDeviceName } from "./device-name.ts";
import { runnerExecution } from "./execution.ts";
import type { RunnerLifecycle } from "./fatal.ts";
import { isolationFields } from "./isolation.ts";
import type { RunnerLogger } from "./logger.ts";
import { createRunnerNetwork, OFFICIAL_RUNNER_RELAY } from "./network.ts";
import { readPassphrase } from "./passphrase.ts";
import { openPhoneAuthorizations } from "./phone-authorizations.ts";
import { phoneRunnerNetwork } from "./phone-network.ts";
import { createRunnerPolicyFacts } from "./policy-facts.ts";
import type { RunnerRedactor } from "./redactor.ts";
import { runnerResources } from "./resources.ts";
import { createRunnerRtcFactory } from "./rtc-peer.ts";
import { finalizeRunnerOwner, RunnerDrainIncompleteError } from "./shutdown.ts";
import { acquireRunnerLock, createRunnerControl, writeRunnerState } from "./state.ts";

declare const __PIBOT_RUNNER_VERSION__: string;

export async function runRunner(options: {
  dataDir: string;
  environmentPassphrase?: string;
  logger: RunnerLogger;
  redactor: RunnerRedactor;
  fixturePort?: Port;
  stopSignal?: AbortSignal;
  pair?: boolean;
  pairCode?: string;
  relay?: string;
  /** `pair --name`; omitted means this computer's host name. */
  deviceName?: string;
  listen?: readonly string[];
  pairingOutput?: (code: string) => void;
  /** Read by the fatal-exit line: what the runner was doing when it crashed. */
  lifecycle?: RunnerLifecycle;
}) {
  if (process.platform !== "darwin" && process.platform !== "win32" && process.platform !== "linux")
    throw new Error("unsupported_platform");
  // Report a broken service environment before opening credentials or acquiring ownership.
  UnsafeSandboxEnvironmentError.assertSafe(process.env);
  await prepareRunnerDataDir(options.dataDir);
  const lock = await acquireRunnerLock(options.dataDir);
  let passphrase = options.environmentPassphrase;
  options.environmentPassphrase = undefined;
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error("runner_stopped"));
  options.stopSignal?.addEventListener("abort", stop, { once: true });
  if (options.stopSignal?.aborted) stop();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.once(signal, stop);
  let identity: Awaited<ReturnType<typeof openRunnerIdentity>> | undefined;
  let policyFacts: Awaited<ReturnType<typeof createRunnerPolicyFacts>> | undefined;
  let runtime: Awaited<ReturnType<typeof createRunnerRuntime>> | undefined;
  let phoneControls: Awaited<ReturnType<typeof openPhoneAuthorizations>> | undefined;
  let phoneNetwork: ReturnType<typeof phoneRunnerNetwork> | undefined;
  const runnerRtc = createRunnerRtcFactory((code) =>
    options.logger.write("warn", "runner.rtc_close", { code }),
  );
  let target: ReturnType<typeof createLocalExecutionTarget> | undefined;
  let managedGit: ReturnType<typeof createManagedGitPort> | undefined;
  let journal: Awaited<ReturnType<typeof createExecutionJournal>> | undefined;
  let jobs: Awaited<ReturnType<typeof createRunnerJobRegistry>> | undefined;
  let control: Awaited<ReturnType<typeof createRunnerControl>> | undefined;
  let computer: ReturnType<typeof createRunnerComputerHost> | undefined;
  let isolation: IsolationStatus | undefined;
  let network: ReturnType<typeof createRunnerNetwork> | undefined;
  let commandTemp: Awaited<ReturnType<typeof prepareRunnerCommandTempDir>> | undefined;
  let pairingCode: string | undefined;
  let pairingExpiresAt = 0;
  let failure: unknown;
  let drainIncomplete = false;
  const cleanup: unknown[] = [];
  try {
    identity = await openRunnerIdentity({
      directory: join(options.dataDir, "identity"),
      // A passphrase in the environment is the headless choice of the encrypted file.
      // (options.environmentPassphrase was already moved into `passphrase` above.)
      preferFile: passphrase !== undefined,
      signal: shutdown.signal,
      passphrase: async () => {
        if (passphrase === undefined)
          passphrase = await readPassphrase(undefined, shutdown.signal, options.redactor);
        return passphrase;
      },
    });
    passphrase = undefined;
    const executionData = join(options.dataDir, "execution");
    // Command temp files must live outside the data directory, which the sandbox keeps
    // unwritable; see command-temp-dir.ts.
    commandTemp = await prepareRunnerCommandTempDir(options.dataDir);
    const commandHome = join(
      options.dataDir,
      "bots",
      "00000000-0000-4000-8000-000000000001",
      "home",
    );
    await mkdir(join(executionData, "patches"), { recursive: true, mode: 0o700 });
    for (const path of [
      join(options.dataDir, "bots"),
      join(options.dataDir, "bots", "00000000-0000-4000-8000-000000000001"),
      commandHome,
    ])
      await prepareRunnerDataDir(path);
    const command: ExecOptions = {
      ...runnerResources(),
      platform: process.platform,
      env: { ...process.env },
      systemHome: homedir(),
      tempDir: commandTemp.path,
      redactor: options.redactor,
      onDiagnostic: (event) =>
        options.logger.write("warn", "runner.command.diagnostic", { ...event }),
    };
    const localTarget = createLocalExecutionTarget({
      command,
      files: { journalDir: join(executionData, "patches") },
    });
    // Group worktrees on this runner. The desktop's dispatch confirmation is the authority;
    // here only shutdown can still stop a write.
    managedGit = createManagedGitPort(
      command,
      {
        home: commandHome,
        dataDir: options.dataDir,
        assertAuthorized: () => shutdown.signal.throwIfAborted(),
      },
      (event) => options.logger.write("warn", "runner.managed_git.failed", { ...event }),
    );
    // Command credentials/denials and logs belong to this runner, never to desktop-supplied paths.
    target = options.fixturePort
      ? localTarget
      : runnerExecution(localTarget, await realpath(options.dataDir), await realpath(commandHome), {
          platform: process.platform,
          userHome: homedir(),
          env: { ...process.env },
        });
    const targetId = `runner:${identity.deviceId}`;
    journal = await createExecutionJournal(join(options.dataDir, "journal"), targetId);
    jobs = await createRunnerJobRegistry(join(options.dataDir, "jobs.json"), targetId);
    process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
    process.env.CUA_TELEMETRY_ENABLED = "false";
    process.env.CUA_DRIVER_RS_UPDATE_CHECK = "false";
    process.env.CUA_DRIVER_DISABLE_RUN_SCRIPT = "1";
    computer = createRunnerComputerHost({
      resourcesDir: join(dirname(process.execPath), "resources"),
      platform: process.platform,
      env: { ...process.env },
      onAudit: (entry) =>
        options.logger.write("info", "runner.computer", {
          method: entry.method,
          botId: entry.botId,
          runId: entry.runId,
          ok: entry.ok,
          ms: entry.ms,
          ...(entry.code ? { code: entry.code } : {}),
        }),
      onDiagnostic: (code) => options.logger.write("warn", "runner.computer.diagnostic", { code }),
    });
    phoneControls = await openPhoneAuthorizations(
      options.dataDir,
      base64url(identity.keys.signingPublic),
    );
    policyFacts = await createRunnerPolicyFacts({
      target,
      platform: process.platform,
      home: homedir(),
      dataDir: options.dataDir,
      env: { ...process.env },
    });
    runtime = await createRunnerRuntime({
      computer,
      managedGitPort: managedGit,
      policyFacts: policyFacts.prepare,
      phoneControls,
      deviceId: identity.deviceId,
      appVersion: typeof __PIBOT_RUNNER_VERSION__ === "string" ? __PIBOT_RUNNER_VERSION__ : "0.0.0",
      platform: process.platform,
      target,
      commandProtectionRoots: [
        resolve(options.dataDir),
        await realpath(options.dataDir),
        ...(process.platform === "win32" ? windowsSystemTrees(process.env) : []),
      ],
      journal,
      jobs,
      registerSecrets: options.redactor.register,
    });
    if (options.fixturePort) await runtime.attach(options.fixturePort);
    if (!options.fixturePort) {
      phoneNetwork = phoneRunnerNetwork({
        dataDir: options.dataDir,
        identity,
        grants: phoneControls,
        runtime,
        createPeer: runnerRtc.createPeer,
        signal: shutdown.signal,
        logger: options.logger,
      });
      network = createRunnerNetwork({
        rtc: runnerRtc,
        listen: options.listen,
        dataDir: options.dataDir,
        identity,
        runtime,
        signal: shutdown.signal,
        logger: options.logger,
        redactor: options.redactor,
        pair: options.pair,
        pairCode: options.pairCode,
        onRevoked: stop,
        relay: options.relay ?? OFFICIAL_RUNNER_RELAY,
        deviceName: runnerDeviceName(options.deviceName),
        output: (code) => {
          pairingCode = code;
          pairingExpiresAt = Date.now() + 600_000;
          options.pairingOutput?.(code);
        },
        onPaired: () => {
          pairingCode = undefined;
        },
      });
      void network.settled.catch((error: unknown) => {
        failure = error;
        options.logger.write("error", "runner.network_failed", {
          code:
            error instanceof Error && /^[a-z][a-z0-9_]{1,63}$/.test(error.message)
              ? error.message
              : "internal",
        });
        stop();
      });
      const current = network;
      if (options.lifecycle) options.lifecycle.connection = () => current.status().connection;
    }
    control = await createRunnerControl(
      lock.startedAt,
      identity.deviceId,
      stop,
      async () => {
        await network?.revoke();
      },
      // A fixture runner has no relay, so it has nothing to reconnect to.
      () => ({
        ...(network?.status() ?? { connection: options.fixturePort ? "online" : "connecting" }),
        ...target?.activitySnapshot?.(),
      }),
      () => isolation,
      () => (Date.now() < pairingExpiresAt && !shutdown.signal.aborted ? pairingCode : undefined),
      computer.permissions,
    );
    await writeRunnerState(options.dataDir, control.state);
    options.logger.write("info", "runner.started", {
      pid: process.pid,
      targetId: runtime.targetId,
      platform: process.platform,
      arch: process.arch,
      credentialBackend: identity.backend,
      connectedSessions: options.fixturePort ? 1 : 0,
    });
    // The probe is lazy and a failing Linux host otherwise only shows up as every tool
    // call being refused. Run it once at startup so both the log and `runner status` can answer.
    void target.isolationStatus(shutdown.signal).then(
      (status) => {
        isolation = status;
        options.logger.write(
          status.available ? "info" : "warn",
          "runner.isolation",
          isolationFields(status),
        );
      },
      () => {
        // A rejected probe means the sandbox host could not be verified either.
        options.logger.write("warn", "runner.isolation", { available: false, probeFailed: true });
      },
    );
    if (options.lifecycle) options.lifecycle.stage = "running";
    if (!shutdown.signal.aborted)
      await new Promise<void>((resolve) =>
        shutdown.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
  } catch (error) {
    failure = error;
  } finally {
    pairingCode = undefined;
    if (options.lifecycle) options.lifecycle.stage = "stopping";
    for (const signal of signals) process.off(signal, stop);
    options.stopSignal?.removeEventListener("abort", stop);
    if (control) await control.close().catch((error: unknown) => cleanup.push(error));
    await finalizeRunnerOwner({
      dataDir: options.dataDir,
      deviceId: identity?.deviceId ?? "uninitialized",
      lock,
      async dispose() {
        const errors: unknown[] = [];
        if (network) await network.close().catch((error: unknown) => errors.push(error));
        await phoneNetwork?.close().catch((error: unknown) => errors.push(error));
        await runnerRtc.close().catch((error: unknown) => errors.push(error));
        policyFacts?.dispose();
        await phoneControls?.dispose().catch((error: unknown) => errors.push(error));
        if (runtime) await runtime.dispose().catch((error: unknown) => errors.push(error));
        else {
          if (computer) await computer.dispose().catch((error: unknown) => errors.push(error));
          managedGit?.dispose();
          if (target) await target.dispose().catch((error: unknown) => errors.push(error));
          if (journal) await journal.dispose().catch((error: unknown) => errors.push(error));
          if (jobs) await jobs.dispose().catch((error: unknown) => errors.push(error));
        }
        try {
          identity?.dispose();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, "runner_cleanup_failed");
      },
    }).catch((error: unknown) => {
      drainIncomplete = error instanceof RunnerDrainIncompleteError;
      cleanup.push(error);
    });
    // A leftover folder only wastes disk space and is removed again on the next start; it must
    // not turn a clean stop into a lifecycle failure.
    await commandTemp?.dispose().catch(() => {
      options.logger.write("warn", "runner.command_temp_cleanup_failed", {});
    });
    options.logger.write(cleanup.length || failure ? "error" : "info", "runner.stopped", {
      cleanupFailures: cleanup.length,
      failed: !!failure,
      drainIncomplete,
    });
  }
  if (failure || cleanup.length)
    throw new AggregateError(
      [
        ...(drainIncomplete ? [new Error("drain_incomplete")] : []),
        ...(failure ? [failure] : []),
        ...cleanup,
      ],
      "runner_lifecycle_failed",
    );
}
