import type { Logger } from "@pibot/observability";

/**
 * Evaluating the pi SDK's module graph blocks the brain's only thread for about a second even
 * with a warm compile cache; done by the first model operation, that stall landed in the user's
 * first message. This loads it once while the app is idle instead: a few seconds after ready,
 * only when no user request reached the brain for `quietMs` (otherwise it waits and tries again),
 * never twice, and not at all once a model operation has loaded it.
 */
export function sdkIdlePreload(options: {
  logger: Pick<Logger, "info" | "warn">;
  /** The compile-cache warm-up on the worker; awaited so the main thread reads compiled code. */
  warm?: () => Promise<void>;
  /** Loads the SDK on this thread; "already_loaded" when a model operation got there first. */
  load?: () => Promise<"loaded" | "already_loaded">;
  /** performance.now() of the last user-originated request. */
  lastUserActivity: () => number;
  /** Requests still in flight that a stall would hold up. */
  busy: () => boolean;
  delayMs?: number;
  quietMs?: number;
  mark?: (phase: string) => void;
}) {
  const { logger, warm, load } = options;
  const quietMs = options.quietMs ?? 2_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let done = false;
  let deferrals = 0;
  const schedule = (delay: number) => {
    if (stopped || done) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
    timer.unref?.();
  };
  const run = async () => {
    if (stopped || done || !load) return;
    // A failed warm-up is logged by its own job; the import below still works without it.
    await warm?.().catch(() => undefined);
    if (stopped) return;
    const quietFor = performance.now() - options.lastUserActivity();
    if (quietFor < quietMs || options.busy()) {
      deferrals++;
      schedule(Math.max(250, quietMs - quietFor) + 100);
      return;
    }
    done = true;
    options.mark?.("sdk.preload");
    const started = performance.now();
    try {
      const outcome = await load();
      logger.info(
        JSON.stringify({
          module: "agent",
          event: "pi_sdk_preload",
          outcome,
          durationMs: Math.round(performance.now() - started),
          deferrals,
        }),
      );
    } catch {
      // The first model operation loads it again and reports its own error.
      logger.warn(
        JSON.stringify({
          module: "agent",
          event: "pi_sdk_preload",
          outcome: "failed",
          durationMs: Math.round(performance.now() - started),
          deferrals,
        }),
      );
    }
  };
  return {
    start() {
      schedule(options.delayMs ?? 4_000);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
