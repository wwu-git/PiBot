import { enableCompileCache } from "node:module";
import { join } from "node:path";
import { bundleIdentity } from "../shared/bundle-identity.ts";
import { guardConsoleStreams } from "../shared/console-guard.ts";

// The brain inherits the desktop's console pipes; a closed one must not end the brain.
guardConsoleStreams([process.stdout, process.stderr]);

const entryAtMs = Math.round(performance.now());
const parent = process.parentPort;
if (!parent) throw new Error("Brain entry requires a utilityProcess parent");
// An early fork can prepare code while the owner imports its role. It cannot open
// SQLite or host resources until the full bootstrap supplies all five trusted ports.
const bootstrapTimer = setTimeout(() => process.exit(1), 180_000);
parent.once("message", (first) => {
  const prepare = first.data as { type?: unknown; dataDir?: unknown; version?: unknown } | null;
  const warming = prepare?.type === "prepare";
  if (warming && (typeof prepare.dataDir !== "string" || typeof prepare.version !== "string"))
    process.exit(1);
  let bootstrap: typeof first | undefined = warming ? undefined : first;
  let resolveBootstrap: () => void = () => {};
  const bootstrapped = new Promise<void>((resolve) => {
    resolveBootstrap = resolve;
  });
  if (bootstrap) resolveBootstrap();
  const started = performance.now();
  const pending: { data: unknown }[] = [];
  const buffer = (incoming: typeof first) => {
    if (!bootstrap) {
      bootstrap = incoming;
      resolveBootstrap();
      return;
    }
    if (pending.length >= 64) process.exit(1);
    pending.push(incoming);
  };
  parent.on("message", buffer);
  void (async () => {
    // Only the owner can send this bootstrap. The full protocol is validated by process-entry.
    const data = first.data as { dataDir?: unknown; version?: unknown } | null;
    let status = 2;
    let cacheRoot: string | undefined;
    let key: string | undefined;
    try {
      if (typeof data?.dataDir === "string" && typeof data.version === "string") {
        key = await bundleIdentity(import.meta.url, data.version);
        cacheRoot = join(data.dataDir, "compile-cache");
        status = enableCompileCache(join(cacheRoot, key)).status;
      }
    } catch {
      // Cache availability is diagnostic only, never a requirement for starting the brain.
    }
    const cacheMs = Math.round(performance.now() - started);
    const importStarted = performance.now();
    const preparedRuntime: {
      pending: Promise<typeof import("./runtime.ts")>;
      startedAt: number;
      completedAt?: number;
    } = {
      startedAt: importStarted,
      pending: import("./runtime.ts").then((module) => {
        preparedRuntime.completedAt = performance.now();
        return module;
      }),
    };
    // Preparation can fail before bootstrap arrives; the eventual startup still observes it.
    void preparedRuntime.pending.catch(() => {});
    const { startBrainProcess } = await import("./process-entry.ts");
    const importedAtMs = Math.round(performance.now());
    const entryImportMs = Math.round(performance.now() - importStarted);
    await bootstrapped;
    const bootstrapAtMs = Math.round(performance.now());
    clearTimeout(bootstrapTimer);
    parent.off("message", buffer);
    if (!bootstrap) process.exit(1);
    // A prepare message is not bootstrap authority. Verify its cache identity against
    // the real owner receipt before passing it to the fully validated entry.
    const final = bootstrap.data as { dataDir?: unknown; version?: unknown } | null;
    if (warming && (final?.dataDir !== data?.dataDir || final?.version !== data?.version))
      process.exit(1);
    startBrainProcess(
      bootstrap,
      bootstrapAtMs,
      {
        status,
        stages: {
          processStartupMs: entryAtMs,
          bootstrapWaitMs: Math.round(started - entryAtMs),
          bootstrapLoadMs: cacheMs,
          entryImportMs,
          importedAtMs,
        },
        durationMs: cacheMs,
        root: cacheRoot,
        key,
      },
      pending,
      preparedRuntime,
    );
  })().catch(() => {
    // Never echo import errors (they may include arbitrary module or user paths).
    process.exit(1);
  });
});
