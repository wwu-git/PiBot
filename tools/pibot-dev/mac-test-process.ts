// Identifies and drains only processes belonging to a disposable macOS app copy.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "./windows/command.ts";

const escapedPattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export interface OwnedMacProcess {
  pid: number;
  stamp: string;
  executable: string;
}
async function observe(pid: number, signal: AbortSignal): Promise<OwnedMacProcess | undefined> {
  const result = await command("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
    signal,
    timeoutMs: 3000,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (!result.drained || result.errorCode || result.signal || result.stopped)
    throw new Error("mac_test_process_unknown");
  if (result.code === 1) return;
  const match = /^(.{24})\s+([^\r\n]+)\s*$/.exec(result.out.trim());
  if (result.code !== 0 || !match) throw new Error("mac_test_process_unknown");
  return { pid, stamp: match[1] as string, executable: match[2] as string };
}
export async function ownedMacProcesses(app: string, signal: AbortSignal) {
  const result = await command("/usr/bin/pgrep", ["-f", `${escapedPattern(app)}/Contents/`], {
    signal,
    timeoutMs: 3000,
  });
  if (
    !result.drained ||
    result.errorCode ||
    result.signal ||
    result.stopped ||
    ![0, 1].includes(result.code ?? -1)
  )
    throw new Error("mac_test_process_unknown");
  if (result.code === 1) return [];
  const ids = result.out.trim().split(/\s+/);
  if (ids.length > 1000 || ids.some((id) => !/^[1-9]\d*$/.test(id)))
    throw new Error("mac_test_process_unknown");
  const owned: OwnedMacProcess[] = [];
  for (const id of ids) {
    const row = await observe(Number(id), signal);
    if (row?.executable.startsWith(`${app}/Contents/`)) owned.push(row);
  }
  return owned;
}
/** Only the private bundle this attempt created; a PID snapshot is rechecked before each signal. */
export async function stopMacCopy(app: string, signal: AbortSignal) {
  for (const kind of ["SIGTERM", "SIGKILL"] as const) {
    for (const row of await ownedMacProcesses(app, signal)) {
      const current = await observe(row.pid, signal);
      if (current?.stamp !== row.stamp || current.executable !== row.executable) continue;
      try {
        process.kill(row.pid, kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          throw new Error("mac_test_stop_failed");
      }
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await ownedMacProcesses(app, signal)).length) return;
      await delay(100, undefined, { signal });
    }
  }
  throw new Error("mac_test_cleanup_unconfirmed");
}

/** Direct launch gives us the GUI PID, unlike LaunchServices' short-lived `open` process. */
export async function launchMacCopy(
  executable: string,
  args: string[],
  dataDir: string,
  signal: AbortSignal,
  options: { env?: NodeJS.ProcessEnv; networkProfile?: string } = {},
) {
  signal.throwIfAborted();
  const child = spawn(
    options.networkProfile ? "/usr/bin/sandbox-exec" : executable,
    options.networkProfile ? ["-f", options.networkProfile, executable, ...args] : args,
    {
      env: { ...(options.env ?? process.env), PIBOT_DATA_DIR: dataDir },
      stdio: "ignore",
      detached: true,
    },
  );
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("mac_test_launch_failed")));
  });
  if (!child.pid) throw new Error("mac_test_launch_failed");
  return {
    pid: child.pid,
    ended: exit.then(() => {}),
    exit,
    requestQuit: () => child.kill("SIGTERM"),
  };
}
