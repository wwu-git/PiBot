// Owns the restart fixture worker and bounds each owner lifecycle without hiding a hung run.
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import type { M3Fixture } from "./fixture.ts";

type Checkpoint = { root: string; provider: string; run: string; card: string; session: string };
async function owner(input: Record<string, unknown>, park: boolean) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"])
    if (process.env[key]) env[key] = process.env[key];
  const worker = new Worker(new URL("./owner-worker.ts", import.meta.url), {
    workerData: input,
    execArgv: [],
    env,
    stdout: true,
    stderr: true,
  });
  worker.stdout?.resume();
  worker.stderr?.resume();
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  let message: unknown;
  try {
    message = await new Promise<unknown>((resolve, reject) => {
      // A fresh worker transpiles the whole module graph before its brain starts (~15 s on an idle
      // machine), so a fixed deadline failed while the owner was still working. The guard is an
      // idle deadline that every progress step resets: a hung owner is still caught, a slow one is
      // not. Steps come from owner-worker (bootstrap/imported) and owner-runner (fixture).
      let step = "spawn";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => reject(new Error(`Own brain worker idle deadline (last step: ${step})`)),
          step === "bootstrap" ? 180_000 : 120_000,
        );
      };
      const finish = (value: unknown) => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", failed);
        worker.off("exit", prematureExit);
        resolve(value);
      };
      const onMessage = (value: unknown) => {
        const progress = value as { status?: unknown; step?: unknown } | null;
        if (progress?.status === "progress") {
          step = String(progress.step ?? "");
          idle();
          return;
        }
        finish(value);
      };
      const failed = () => {
        clearTimeout(timer);
        reject(new Error("Own brain worker failed"));
      };
      const prematureExit = () => {
        clearTimeout(timer);
        reject(new Error("Own brain worker exited before receipt"));
      };
      worker.on("message", onMessage);
      worker.once("error", failed);
      worker.once("exit", prematureExit);
      // The worker reports bootstrap before importing owner-runner. That import is legitimate
      // transpilation work, measured at about 15 s on an idle Mac and observed to exceed 120 s
      // only when the suite shares the machine with other heavy jobs. Keep a larger bound for
      // that phase, then return to the 120 s hang detector for fixture and run progress.
      idle();
    });
    assert(
      message && typeof message === "object" && "status" in message && message.status === "ready",
    );
    if (!park) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        assert.equal(
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              // Cleanup after the receipt (brain stop, session files, DB close) also slows down on
              // a loaded machine; this only has to catch an owner that never exits.
              timer = setTimeout(() => reject(new Error("Owner exit unconfirmed")), 60_000);
            }),
          ]),
          0,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    // Never reopen the shared fixture DB or delete it before the prior real owner exits.
    await worker.terminate();
    await exited;
  }
  return message as { status: "ready"; checkpoint?: Checkpoint; attempts: number; blocked: number };
}

export async function exerciseOwnerRestart(f: M3Fixture) {
  // Parent brain has its own distinct DB; children own separate roots beneath this supervised root.
  for (const phase of ["held", "parked"] as const) {
    const first = await owner({ phase, temporaryRoot: f.root }, true);
    assert(first.checkpoint);
    assert.equal(first.blocked, 0);
    const second = await owner(
      { phase: "resume", original: phase, temporaryRoot: f.root, checkpoint: first.checkpoint },
      false,
    );
    assert.equal(second.blocked, 0);
    assert.equal(second.attempts, phase === "held" ? 1 : 2);
  }
}
