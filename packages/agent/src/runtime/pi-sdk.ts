import { getCompileCacheDir } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * pi-coding-agent is the single largest module graph on the brain's startup path
 * (≈1 s idle, 3–5 s under load), yet nothing before the first model operation needs it. It is
 * loaded on first use, or by the background preload after the brain reports ready. The patched
 * `./sdk` entry skips the interactive modes but core still imports some theme/TUI dependencies.
 *
 * Callers must sanitize the process environment first (`sanitizeBrainEnv`): the SDK captures
 * auxiliary directories and ambient provider keys at import time.
 */
let sdkEvaluated = false;
export function loadPiSdk() {
  // ESM owns module caching; the flag only records that the graph has been evaluated, so an
  // idle preload can tell it would be a no-op.
  return import("@earendil-works/pi-coding-agent/sdk").then((sdk) => {
    sdkEvaluated = true;
    return sdk;
  });
}

/** The SDK's module graph has been evaluated in this process. */
export function piSdkLoaded() {
  return sdkEvaluated;
}

const PI_SDK_SPECIFIER = "@earendil-works/pi-coding-agent/sdk";
let compileCacheWarmup: Promise<void> | undefined;

/**
 * Warm Node's on-disk module compile cache away from the brain event loop before the first SDK
 * operation. The worker never receives credentials, paths, prompts, or runtime state.
 */
export function warmPiSdkCompileCache(): Promise<void> {
  compileCacheWarmup ??= new Promise<void>((resolve, reject) => {
    // `enableCompileCache()` in the brain's main thread does not reach worker threads (checked on
    // Node 26: a worker importing the SDK wrote no cache entries), so the worker enables the same
    // directory itself and flushes before it reports. Without a cache there is nothing to warm.
    const cacheDir = getCompileCacheDir();
    if (!cacheDir) {
      resolve();
      return;
    }
    // Resolve here, not in the worker: an eval worker resolves bare specifiers from the process
    // working directory, which in the packaged app is not the app folder, so the import would fail
    // and the warm-up would silently do nothing.
    // A variable, not a literal: the package check treats any call whose first argument is the SDK
    // specifier, other than import(), as a static import of the SDK into the startup bundle.
    const sdk = import.meta.resolve(PI_SDK_SPECIFIER);
    const worker = new Worker(
      'const { parentPort, workerData } = require("node:worker_threads"); const m = require("node:module"); m.enableCompileCache(workerData.cacheDir); import(workerData.sdk).then(() => { m.flushCompileCache(); parentPort.postMessage("ready"); }, () => parentPort.postMessage("failed"));',
      // The worker needs nothing else: no credentials, paths beyond the cache, or runtime state.
      { eval: true, workerData: { sdk, cacheDir } },
    );
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("pi_sdk_compile_cache_timeout"));
    }, 30_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      worker.removeAllListeners();
      void worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    worker.once("message", (message: unknown) => {
      finish(message === "ready" ? undefined : new Error("pi_sdk_compile_cache_failed"));
    });
    worker.once("error", (error: unknown) =>
      finish(error instanceof Error ? error : new Error("pi_sdk_compile_cache_worker_error")),
    );
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error("pi_sdk_compile_cache_worker_exit"));
    });
  }).catch((error) => {
    compileCacheWarmup = undefined;
    throw error;
  });
  return compileCacheWarmup;
}

const WARMUP_CODES = new Set([
  "pi_sdk_compile_cache_timeout",
  "pi_sdk_compile_cache_failed",
  "pi_sdk_compile_cache_worker_error",
  "pi_sdk_compile_cache_worker_exit",
]);

/** A fixed reason code for logs; worker errors can carry paths and are never logged as text. */
export function sdkWarmupCode(error: unknown) {
  return error instanceof Error && WARMUP_CODES.has(error.message)
    ? error.message
    : "pi_sdk_compile_cache_worker_error";
}
