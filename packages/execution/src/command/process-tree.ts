import { spawn } from "node:child_process";
import { stallTolerantTimeout } from "../core/deadline.ts";
import { ExecError } from "../core/types.ts";

export type ProcessRow = { pid: number; parent: number; group: number; started: string };
// Busy brain callbacks can delay delivery of a completed ps result beyond the former 1s limit.
// Windows starts a PowerShell per snapshot and measured 1.7–3.1 s on a loaded VM, so a 5 s limit
// turned ordinary load into failed commands; the cleanup budget in process.ts allows it.
const SNAPSHOT_TIMEOUT_MS = { win32: 10_000, default: 5_000 };
// Windows starts a PowerShell per snapshot (p50 ~650 ms on a VM), so a 100 ms poll would only queue
// another one behind the running scan. Poll less often there; POSIX `ps` stays cheap.
const POLL_INTERVAL_MS = { win32: 1_000, default: 100 };
// A transient stall (Defender / AMSI or the CIM service) must not end a running command: one
// snapshot over the deadline is not evidence that the tree is unknown.
const POLL_FAILURE_LIMIT = 3;
// Windows membership only sees children of a parent that is still alive in a snapshot, so a gap
// without a successful snapshot lets short-lived intermediates start descendants that final
// cleanup never learns about. Time counts even before the failure limit is reached (W6-1 review):
// two timed-out snapshots put the real blind window at roughly 11s, not the 6s threshold alone.
const POLL_BLIND_MS = 6_000;
/** .NET ticks (100 ns since 0001-01-01) of the Unix epoch, the unit of Windows CreationDate. */
const EPOCH_TICKS = 621355968000000000n;

// Loading the CIM cmdlets on every scan can exceed the cleanup deadline on Windows.
const WINDOWS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "$searcher=[Management.ManagementObjectSearcher]::new('root\\cimv2','SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process');",
  "try {",
  "  $rows=$searcher.Get();",
  "  try {",
  "    foreach ($row in $rows) {",
  "      try {",
  "        $created=$row.CreationDate;",
  "        if ($created) {",
  "          $started=[Management.ManagementDateTimeConverter]::ToDateTime($created).ToUniversalTime().Ticks;",
  "          '{0} {1} 0 {2}' -f $row.ProcessId,$row.ParentProcessId,$started",
  "        }",
  "      } finally { $row.Dispose() }",
  "    }",
  "  } finally { $rows.Dispose() }",
  "} finally { $searcher.Dispose() }",
].join(" ");

function ticks(value: string | undefined) {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

/** Compare ps start times as well as ancestry to avoid retaining stale process identities. */
export async function snapshot(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  timeoutMs?: number,
): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    const windows = platform === "win32";
    const args = windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT_SCRIPT]
      : ["-A", "-o", "pid=,ppid=,pgid=,lstart="];
    const ps = spawn(windows ? (env.SHELL as string) : "/bin/ps", args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      // A console child of a windowless process otherwise opens a visible console on Windows.
      windowsHide: true,
    });
    let text = "";
    // A stalled brain must not turn a finished snapshot into a timeout (Windows 2026-11-21: a
    // ~9 s stall failed a worktree add's cleanup as unconfirmed although nothing was left).
    const timer = stallTolerantTimeout(
      () => {
        ps.kill("SIGKILL");
        reject(new ExecError("command_failed", "process_snapshot_timeout"));
        ps.stdout.destroy();
        ps.unref();
      },
      timeoutMs ?? SNAPSHOT_TIMEOUT_MS[windows ? "win32" : "default"],
    );
    ps.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 4 * 1024 * 1024) {
        ps.kill("SIGKILL");
        reject(new ExecError("command_failed", "process_snapshot_limit"));
      }
    });
    ps.once("error", () => {
      timer.clear();
      reject(new ExecError("command_failed", "process_snapshot_failed"));
    });
    ps.once("close", (code) => {
      timer.clear();
      if (code !== 0) return reject(new ExecError("command_failed", "process_snapshot_failed"));
      const rows: ProcessRow[] = [];
      for (const line of text.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (match)
          rows.push({
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            started: match[4] as string,
          });
      }
      resolve(rows);
    });
  });
}

/**
 * Membership of one process tree across snapshots: the root, its process group (POSIX) and every
 * descendant seen while its parent was known, so reparented orphans stay members. Shared by the
 * per-command monitor below and the background-command monitor (one ps for all jobs).
 */
export function createTreeState(root: number, platform: NodeJS.Platform, spawnedAt = Date.now()) {
  const known = new Map<number, string>();
  let firstSnapshot = true;
  let rootStarted: string | undefined;
  // Windows: the latest creation time a child of the exited root can have. Its PID may be reused
  // by an unrelated process whose children then name the same parent; those start later.
  let rootEnded: bigint | undefined;
  return {
    get rootStarted() {
      return rootStarted;
    },
    update(rows: ProcessRow[]): ProcessRow[] {
      const live = new Map(rows.map((row) => [row.pid, row]));
      if (firstSnapshot) {
        rootStarted = live.get(root)?.started;
        firstSnapshot = false;
      }
      const rootReused = live.has(root) && live.get(root)?.started !== rootStarted;
      if (platform === "win32" && rootEnded === undefined && (rootReused || !live.has(root))) {
        // The update runs after the snapshot was read, so "now" is no earlier than the exit; a
        // reusing process was created after the root ended.
        const now = BigInt(Date.now()) * 10_000n + EPOCH_TICKS;
        const reuser = rootReused ? ticks(live.get(root)?.started) : undefined;
        rootEnded = reuser !== undefined && reuser < now ? reuser : now;
      }
      for (const [pid, started] of known) if (live.get(pid)?.started !== started) known.delete(pid);
      const children = new Map<number, ProcessRow[]>();
      for (const row of rows) {
        const list = children.get(row.parent) ?? [];
        list.push(row);
        children.set(row.parent, list);
        if (!rootReused && (row.pid === root || (platform !== "win32" && row.group === root)))
          known.set(row.pid, row.started);
      }
      // Windows keeps the creator's PID after its exit; this also discovers orphaned children.
      const queue = [...new Set([...(rootReused ? [] : [root]), ...known.keys()])];
      for (let i = 0; i < queue.length; i++) {
        for (const row of children.get(queue[i] as number) ?? []) {
          if (known.has(row.pid)) continue;
          if (platform === "win32") {
            const creator = known.get(row.parent) ?? rootStarted;
            const earliest = creator ? BigInt(creator) : BigInt(spawnedAt) * 10_000n + EPOCH_TICKS;
            // ParentProcessId can refer to a recycled PID: older orphans are not our descendants.
            if (BigInt(row.started) < earliest) continue;
            // Nor are children started after the root ended, by whatever reused its PID.
            if (row.parent === root && rootEnded !== undefined && BigInt(row.started) > rootEnded)
              continue;
          }
          known.set(row.pid, row.started);
          queue.push(row.pid);
        }
      }
      return rows.filter((row) => known.get(row.pid) === row.started);
    },
  };
}

/** Keep detached descendants after reparenting; one command owns this monitor and disposes it. */
export function trackProcessTree(
  root: number,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  onFailure: (error: unknown) => void,
  spawnedAt = Date.now(),
) {
  const state = createTreeState(root, platform, spawnedAt);
  let latest: ProcessRow[] = [];
  let scanning: Promise<ProcessRow[]> | undefined;
  let disposed = false;
  let pollFailures = 0;
  let lastSuccess = Date.now();
  let monitorFailed = false;
  const scan = () => {
    if (disposed) return Promise.reject(new ExecError("closed"));
    scanning ??= snapshot(env, platform)
      .then((rows) => {
        if (disposed) throw new ExecError("closed");
        latest = state.update(rows);
        return latest;
      })
      .finally(() => {
        scanning = undefined;
      });
    return scanning;
  };
  // A scan already running may have read the table before the exit or kill it must confirm.
  const fresh = async () => {
    await scanning?.catch(() => {});
    return scan();
  };
  // Only the kill paths below are hard errors: they cannot afford to guess without a snapshot.
  const poll = () =>
    void scan().then(
      () => {
        pollFailures = 0;
        lastSuccess = Date.now();
      },
      (error: unknown) => {
        if (disposed || monitorFailed) return;
        pollFailures += 1;
        // Silent retries hid just how long Windows was going without snapshots; one line per
        // failed attempt makes the blind window visible without judging the command.
        const reason = error instanceof ExecError ? (error.reason ?? error.code) : "unknown";
        process.emitWarning(
          `process snapshot failed (${reason}, attempt ${pollFailures}/${POLL_FAILURE_LIMIT})`,
          "PibotProcessMonitor",
        );
        if (pollFailures >= POLL_FAILURE_LIMIT || Date.now() - lastSuccess >= POLL_BLIND_MS) {
          monitorFailed = true;
          // The command may still be alive and even finish; only the monitor is lost. Wrap the
          // reason so the desktop does not read this as "the command already ran" (W6-1 review).
          onFailure(new ExecError("command_failed", "process_monitor_failed"));
        }
      },
    );
  const timer = setInterval(
    poll,
    platform === "win32" ? POLL_INTERVAL_MS.win32 : POLL_INTERVAL_MS.default,
  );
  poll();
  return {
    /** `fresh`: only a snapshot started after this call counts (proof that something ended). */
    members: (requireFresh = false) => (requireFresh ? fresh() : scan()),
    record: () => ({
      group: root,
      processes: latest.map(({ pid, started }) => ({ pid, started })),
    }),
    async signal(signal: NodeJS.Signals, cancellation?: AbortSignal): Promise<boolean> {
      const rows = await scan();
      for (const row of rows) {
        cancellation?.throwIfAborted();
        try {
          process.kill(row.pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      return rows.length > 0;
    },
    async dispose() {
      disposed = true;
      clearInterval(timer);
      // The result is already decided when dispose runs, so a rejected snapshot must not change it
      // (or invite a duplicate command). Consume the rejection, and leave cleanup reporting to
      // process.ts's own members() check, which runs before the result is fixed (W6-1 review 2).
      await scanning?.catch(() => {});
    },
  };
}
