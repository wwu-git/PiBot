import type { Logger } from "@pibot/observability";
import type { CapabilityHandle } from "../../core/capability.ts";

/** Diagnostics never gate readiness; their owners must still drain before capability disposal. */
export function deferredMaintenance(
  logger: Logger,
  warmSdk?: () => Promise<void>,
  mark?: (phase: string) => void,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  return {
    start(handles: readonly CapabilityHandle[]) {
      // First-screen RPCs follow ready by about 0.3 s; let them finish before CPU-heavy imports.
      timer = setTimeout(() => {
        timer = undefined;
        if (controller.signal.aborted) return;
        const jobs = handles.flatMap((handle) =>
          handle.afterReady ? [(signal: AbortSignal) => handle.afterReady?.(signal)] : [],
        );
        // The SDK's compile cache is filled on a worker thread while the app is idle, so the
        // first model operation reads compiled code instead of compiling on this thread.
        if (warmSdk)
          jobs.push(async (signal) => {
            try {
              // Shutdown and the job deadline do not wait for the worker; it ends with the process.
              await Promise.race([
                warmSdk(),
                new Promise<void>((resolve) => {
                  if (signal.aborted) resolve();
                  else signal.addEventListener("abort", () => resolve(), { once: true });
                }),
              ]);
            } catch (error) {
              logger.warn(
                JSON.stringify({
                  module: "agent",
                  event: "pi_sdk_warmup_failed",
                  code:
                    error instanceof Error ? error.message : "pi_sdk_compile_cache_worker_error",
                }),
              );
            }
          });
        work = Promise.all(
          jobs.map(async (run, index) => {
            if (controller.signal.aborted) return;
            const start = performance.now();
            mark?.(`maintenance.${index}`);
            try {
              // A deadline bounds cooperative hooks; shutdown still waits for them to drain.
              await run(AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
            } catch {
              if (!controller.signal.aborted)
                logger.warn(
                  JSON.stringify({
                    module: "startup",
                    event: "deferred_maintenance_failed",
                    index,
                  }),
                );
            } finally {
              if (!controller.signal.aborted)
                logger.info(
                  JSON.stringify({
                    module: "startup",
                    event: "deferred_maintenance_settled",
                    index,
                    durationMs: Math.round(performance.now() - start),
                  }),
                );
            }
          }),
        ).then(() => {});
      }, 2000);
      timer.unref();
    },
    async stop() {
      controller.abort();
      clearTimeout(timer);
      // Clearing the timer prevents new work while in-flight capability hooks drain.
      await work;
    },
  };
}
