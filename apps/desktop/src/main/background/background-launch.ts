import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "@pibot/observability";
import { type BackgroundWire, IndependentBackgroundStateSchema } from "@pibot/protocol/background";
import { desktopLaunchEnvironment } from "../window/login-item-scope.ts";
import { connectBackground } from "./background-connection.ts";
import {
  assertBackgroundSocketFits,
  readDescriptor,
  secureDirectory,
} from "./background-directory.ts";
import { processAlive, waitBackgroundExit } from "./background-exit.ts";
import { drainBackgroundForUpgrade } from "./background-upgrade.ts";
import { createStartupWake } from "./startup-wake.ts";
import {
  createWindowsBackgroundSecurity,
  type WindowsBackgroundSecurity,
} from "./windows-background-security.ts";
import { WindowsSecurityError } from "./windows-security-diagnostics.ts";

export const pause = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("background_wait_cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });

/** Marks an owner the GUI started; its absence means a login item (launchd / systemd / tasks). */
export const GUI_LAUNCH_FLAG = "--pibot-from-gui";

/** Budget for reaching a live owner, or for a freshly spawned one to accept connections. */
const CONNECT_BUDGET_MS = 30_000;
/**
 * A loaded Windows VM spent 29–78 s inside the owner before it could accept anything
 * (module import, role setup, ACL reservation), so the old 30 s budget gave up on a healthy
 * start. While our own spawned owner is alive the budget is renewed, up to this total ceiling; a
 * different owner that is alive but unreachable is still subject to the plain budget.
 */
const CONNECT_CEILING_MS = 180_000;
// A retiring owner may legitimately take this long: brain retirement alone allows 90 s + 3 s
// (retire-brain.ts). The wait ends on the PID's exit, so the common case costs well under 1 s.
const RETIRING_OWNER_EXIT_MS = 100_000;
export type LaunchProgress =
  | "spawned"
  | "respawned"
  | "upgrade_drained"
  | "upgrade_drain_started"
  | "upgrade_connected"
  | "upgrade_stop_requested"
  | "owner_connected"
  | "retiring_owner_wait_started"
  | "retiring_owner"
  | "retiring_owner_exited"
  | "retry";

/**
 * Connects the GUI to the data directory's owner, starting one when none exists.
 *
 * The GUI never takes or releases ownership itself: at most one owner per data directory is
 * enforced by the owner (Electron's single-instance lock on the data dir, then the exclusive
 * owner.lock claim, which is reclaimed only after both recorded PIDs are proven dead). This loop
 * only decides when spawning can succeed, so a relaunch right after a quit waits for the old
 * owner's actual exit instead of spawning into its locks or attaching to it while it stops.
 */
export async function launchBackground(options: {
  dataDir: string;
  version: string;
  dev: boolean;
  env: Readonly<NodeJS.ProcessEnv>;
  /** The owner command: this executable with `--pibot-background` (and the dev app path). */
  owner: { file: string; args: readonly string[] };
  receive(message: BackgroundWire): void;
  closed(): void;
  signal?: AbortSignal;
  /** Authenticated by the caller's previous connection and already known to be retiring. */
  retiringPid?: number;
  /** Startup timing: launch-loop milestones for the GUI's startup timing line (identifiers only). */
  progress?(event: LaunchProgress, at?: number): void;
  logger: Pick<Logger, "warn">;
  /** The process's security checker, so one GUI process keeps a single warm PowerShell. */
  windows?: WindowsBackgroundSecurity;
}) {
  const windows =
    options.windows ??
    (process.platform === "win32"
      ? createWindowsBackgroundSecurity({
          systemRoot: options.env.SystemRoot ?? options.env.SYSTEMROOT,
          executable: options.owner.file,
          logger: options.logger,
        })
      : undefined);
  await assertBackgroundSocketFits(options.dataDir);
  let drained = false;
  let child: ChildProcess | undefined;
  // undefined while the spawned owner runs; its exit code (signal deaths as 128) afterwards.
  let childExit: number | undefined;
  let deadClaim: Awaited<ReturnType<typeof readDescriptor>> | undefined;
  let respawnDelay = 100;
  // An owner seen earlier in this launch that is not ours; spawning while it lives would only
  // lose its single-instance lock (index.ts quits with code 0) and burn a process start.
  let previousOwner: number | undefined;
  let deadline = Date.now() + CONNECT_BUDGET_MS;
  // Each spawned owner gets a bounded total start window, independent of time spent
  // waiting out a predecessor.
  let childCeiling = 0;
  // A security check that timed out is retried for at most this long (each attempt takes
  // up to WINDOWS_SECURITY_TIMEOUT_MS), so a real ACL refusal still surfaces promptly.
  let securityRetryUntil = 0;
  const SECURITY_RETRY_MS = 60_000;
  const extendForLiveChild = () => {
    if (!child || childExit !== undefined || Date.now() >= childCeiling) return false;
    deadline = Math.min(Date.now() + CONNECT_BUDGET_MS, childCeiling);
    options.progress?.("retry");
    return true;
  };
  const spawnOwner = () => {
    const milestone = child ? "respawned" : "spawned";
    childExit = undefined;
    childCeiling = Date.now() + CONNECT_CEILING_MS;
    options.signal?.throwIfAborted();
    // The owner receives only its own switches (never the GUI's argv) and stdio "ignore",
    // so it inherits no pipe, console or listener handle from this call. A debug port that stays
    // LISTEN under the owner's PID would therefore come from Windows handle inheritance inside
    // Node/Chromium itself, which this layer cannot switch off.
    const current = spawn(options.owner.file, [...options.owner.args], {
      detached: true,
      stdio: "ignore",
      env: desktopLaunchEnvironment(options, options.dataDir),
    });
    child = current;
    current.once("error", () => {
      if (child === current) childExit = 128;
      wake.notify();
    });
    current.once("exit", (code) => {
      if (child === current) childExit = code ?? 128;
      wake.notify();
    });
    current.unref();
    options.progress?.(milestone);
  };
  const trySpawn = async () => {
    if (!child) return spawnOwner();
    if (childExit === undefined) return;
    // A busy machine can report the Electron child exit before its descriptor/socket cleanup is
    // observable. Give the next owner a chance within the bounded launch ceiling; the descriptor
    // read below remains the authority for whether another writer is still alive.
    await delay(respawnDelay, undefined, { signal: options.signal });
    respawnDelay = Math.min(respawnDelay * 2, 1000);
    spawnOwner();
  };
  const ownerDead = (descriptor: { pid: number; utilityPid: number | null }) =>
    !processAlive(descriptor.pid) &&
    (descriptor.utilityPid === null || !processAlive(descriptor.utilityPid));
  const missingWindowsListener = (error: unknown): error is WindowsSecurityError =>
    error instanceof WindowsSecurityError &&
    error.reason === "security_rejected" &&
    error.check === "listener_missing";
  const sameDeadClaim = (descriptor: Awaited<ReturnType<typeof readDescriptor>>) =>
    deadClaim !== undefined &&
    descriptor.pid === deadClaim.pid &&
    descriptor.utilityPid === deadClaim.utilityPid &&
    descriptor.instance === deadClaim.instance &&
    descriptor.version === deadClaim.version &&
    descriptor.endpoint === deadClaim.endpoint &&
    descriptor.token === deadClaim.token;
  const retirementSignal = () =>
    AbortSignal.any([
      AbortSignal.timeout(RETIRING_OWNER_EXIT_MS),
      ...(options.signal ? [options.signal] : []),
    ]);
  const retired = () => {
    options.progress?.("retiring_owner_exited");
    previousOwner = undefined;
    respawnDelay = 100;
    deadline = Date.now() + CONNECT_BUDGET_MS;
  };
  const waitRetiring = async (pid: number, signal = retirementSignal()) => {
    options.progress?.("retiring_owner_wait_started");
    options.progress?.("retiring_owner");
    await waitBackgroundExit(options.dataDir, pid, signal);
    retired();
  };
  const wake = createStartupWake();
  let watcher: FSWatcher | undefined;
  try {
    // Install before the first descriptor read, so publication cannot fall between read and wait.
    watcher = watch(await secureDirectory(options.dataDir, windows, options.signal), () =>
      wake.notify(),
    );
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
      wake.notify();
    });
    watcher.unref();
  } catch {
    // Some filesystems cannot be watched; bounded retries remain the fallback.
  }
  // The connect budget counts from here: on Windows the directory check above includes this
  // process's PowerShell cold start (bounded on its own), which on a busy machine used up the
  // whole budget before an owner was even spawned (VM acceptance 2026-11-11).
  deadline = Date.now() + CONNECT_BUDGET_MS;
  let lastListenerFailure: WindowsSecurityError | undefined;
  try {
    if (options.retiringPid !== undefined) await waitRetiring(options.retiringPid);
    for (;;) {
      // Renew only for our own live child; a foreign owner that stays unreachable still
      // fails on the plain budget.
      if (Date.now() >= deadline && !extendForLiveChild()) break;
      options.signal?.throwIfAborted();
      lastListenerFailure = undefined;
      // Messages and close of a candidate reach the GUI only once it is handed over: a retiring
      // owner's connection is dropped here, and its close must not look like a GUI disconnect.
      let accepted = false;
      let connection: Awaited<ReturnType<typeof connectBackground>>;
      try {
        connection = await connectBackground(
          options.dataDir,
          options.version,
          (message) => {
            if (accepted) options.receive(message);
          },
          () => {
            if (accepted) options.closed();
          },
          options.signal,
          windows,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // An installed update starts while the previous version's owner may still be running
        // (its stop before the update could not be confirmed). Ask that owner to stop through its
        // own protocol, once, and wait for its exit; its claim is never taken over. Development
        // builds keep failing instead: every rebuild changes the version fingerprint.
        if (
          !options.dev &&
          (error as Error).message === "background_version_mismatch_stop_old_owner_first"
        ) {
          const descriptor = await readDescriptor(options.dataDir, windows, options.signal).catch(
            (failure: NodeJS.ErrnoException) => {
              if (failure.code === "ENOENT") return undefined;
              throw failure;
            },
          );
          // The old version's owner can be gone while its claim is still on disk (it was killed
          // or SIGTERMed, which Electron does not turn into a graceful quit). That claim is not a
          // live owner: handle it like the dead claim after ENOENT below — start our own owner, or
          // let the one already spawned publish its claim — and retry. A live claim is still never
          // taken over; only ownerDead decides which of the two this is.
          if (descriptor && ownerDead(descriptor)) {
            await trySpawn();
            options.progress?.("retry");
            await wake.wait(watcher ? 500 : 100, options.signal);
            continue;
          }
          if (!drained) {
            drained = true;
            options.progress?.("upgrade_drain_started");
            const live =
              descriptor ??
              (await readDescriptor(options.dataDir, windows, options.signal).catch(
                () => undefined,
              ));
            const signal = retirementSignal();
            if (live) {
              try {
                await drainBackgroundForUpgrade({
                  dataDir: options.dataDir,
                  expectedVersion: live.version,
                  guiPids: [],
                  windows,
                  signal,
                  phase: options.progress,
                });
                options.progress?.("upgrade_drained");
                retired();
              } catch (failure) {
                signal.throwIfAborted();
                // An already-retiring owner can close its socket between the state and stop
                // receipts. Only that transport loss permits falling through to exit proof.
                const code = (failure as NodeJS.ErrnoException).code;
                if (
                  code !== "ECONNREFUSED" &&
                  code !== "ENOENT" &&
                  (failure as Error).message !== "background_disconnected"
                )
                  throw failure;
                await waitRetiring(live.pid, signal);
              }
              continue;
            }
          }
        }
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          const descriptor = await readDescriptor(options.dataDir, windows, options.signal).catch(
            (failure: NodeJS.ErrnoException) => {
              if (failure.code === "ENOENT") return undefined;
              throw failure;
            },
          );
          if (descriptor) {
            // A published claim whose socket is not accepting: its owner is still starting, is
            // retiring (server closed, release pending), or died and left the claim behind.
            if (descriptor.pid !== child?.pid) previousOwner = descriptor.pid;
            // Recovery after a crash stays the owner's: it re-verifies both deaths before reclaiming.
            if (ownerDead(descriptor)) await trySpawn();
          } else if (previousOwner !== undefined && processAlive(previousOwner)) {
            // Released its claim but still exiting (launchd unregister, app.quit).
            await waitRetiring(previousOwner);
            continue;
          } else await trySpawn();
          options.progress?.("retry");
          await wake.wait(watcher ? 500 : 100, options.signal);
          continue;
        }
        // A child may exit while a replacement/retiring owner still holds the authenticated
        // descriptor. Treat that as a transient hand-off under load and wait for the descriptor
        // owner rather than reporting startup failure to the window.
        if (child && childExit !== undefined) {
          const descriptor = await readDescriptor(options.dataDir, windows, options.signal).catch(
            () => undefined,
          );
          if (descriptor && !ownerDead(descriptor)) {
            if (missingWindowsListener(error)) lastListenerFailure = error;
            previousOwner = descriptor.pid === child.pid ? undefined : descriptor.pid;
            options.progress?.("retry");
            await wake.wait(watcher ? 500 : 100, options.signal);
            continue;
          }
          if (Date.now() < childCeiling) {
            await trySpawn();
            options.progress?.("retry");
            await wake.wait(watcher ? 500 : 100, options.signal);
            continue;
          }
        }
        // An existing descriptor is an owner claim, even when it is unreachable. Never replace it.
        const descriptor = await readDescriptor(options.dataDir, windows, options.signal).catch(
          () => undefined,
        );
        if (
          !child &&
          descriptor &&
          (!windows || missingWindowsListener(error)) &&
          ownerDead(descriptor)
        ) {
          if (windows) deadClaim = descriptor;
          spawnOwner();
          await wake.wait(watcher ? 500 : 100, options.signal);
          continue;
        }
        // Windows reports an owner that published its claim but is not listening yet as a missing
        // listener, where a socket would refuse the connection (ECONNREFUSED, handled above). A
        // live claimant is still starting: wait within the budget. Waiting trusts nothing; it
        // must still pass every identity check. Giving up here left a crashed owner's successor
        // unreachable ("quit the old Pi Bot completely and reopen", Windows 2026-11-04).
        // Our own spawned owner may also be between claims (replacing a dead predecessor's file
        // took 6 s on the Windows test machine), so an unreadable descriptor is not a stop either.
        // While it swaps the claim file, the private-file check of a half-written descriptor can
        // fail too (seen as check "unknown" at 10:06:42 on the test machine): any Windows security
        // rejection is "still starting" while our own child lives, and nothing is trusted from it.
        const liveClaimMissingListener =
          windows && missingWindowsListener(error) && descriptor && !ownerDead(descriptor);
        if (
          windows &&
          ((child && childExit === undefined && error instanceof WindowsSecurityError) ||
            liveClaimMissingListener)
        ) {
          if (liveClaimMissingListener) lastListenerFailure = error;
          if (descriptor && descriptor.pid !== child?.pid) previousOwner = descriptor.pid;
          options.progress?.("retry");
          await wake.wait(watcher ? 500 : 100, options.signal);
          continue;
        }
        // A dead predecessor's descriptor can remain while our new owner starts. Waiting
        // does not trust that claim; the replacement must pass the full connection checks.
        if (
          windows &&
          child &&
          descriptor &&
          missingWindowsListener(error) &&
          sameDeadClaim(descriptor) &&
          ownerDead(descriptor)
        ) {
          await trySpawn();
          options.progress?.("retry");
          await wake.wait(watcher ? 500 : 100, options.signal);
          continue;
        }
        // Reopening while an owner is stopping could exceed the security check's own
        // timeout under load; the check is read-only, so a timeout is "not known yet" rather than
        // a refusal. Retrying here lets the caller wait out the stop instead of reporting
        // background_windows_security_timeout on the first screen.
        if (windows && error instanceof WindowsSecurityError && error.reason === "timeout") {
          securityRetryUntil ||= Date.now() + SECURITY_RETRY_MS;
          if (Date.now() < securityRetryUntil) {
            deadline = Math.max(
              deadline,
              Math.min(Date.now() + CONNECT_BUDGET_MS, securityRetryUntil),
            );
            options.progress?.("retry");
            await wake.wait(watcher ? 500 : 100, options.signal);
            continue;
          }
        }
        throw error;
      }
      // A stopping owner still accepts connections until it closes its server, but it will never
      // become ready again; attaching to it only ran out the GUI's timeouts.
      let lifecycle: string | undefined;
      try {
        lifecycle = IndependentBackgroundStateSchema.parse(
          await connection.control(
            { type: "state" },
            AbortSignal.any([
              AbortSignal.timeout(5_000),
              ...(options.signal ? [options.signal] : []),
            ]),
          ),
        ).lifecycle;
      } catch {
        // The caller's attach loop retries state and owns the error reporting, as before.
      }
      if (options.signal?.aborted) {
        connection.close();
        options.signal.throwIfAborted();
      }
      if (lifecycle !== "stopping" && lifecycle !== "stopped") {
        accepted = true;
        options.progress?.("owner_connected");
        return connection;
      }
      connection.close();
      await waitRetiring(connection.descriptor.pid);
    }
    // If the last attempt still refused a live claim, preserve the listener error for the GUI.
    throw lastListenerFailure ?? new Error("background_launch_timeout");
  } finally {
    watcher?.close();
  }
}
