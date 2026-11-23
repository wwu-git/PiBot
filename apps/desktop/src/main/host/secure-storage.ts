import type { Logger } from "@pibot/observability";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";

export interface StorageCipher {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  getSelectedStorageBackend?(): string;
  encryptStringAsync(plain: string): Promise<Buffer>;
  decryptStringAsync(cipher: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/** Owner-side keyring health. `ready` is consulted only until the first native initialization. */
export interface StorageHealth {
  ready(): boolean;
  failed(): void;
  healthy(): void;
}

const PROBE = "pibot-keyring-readiness-v1";

/** Serialize native work; timed-out entries retain their bounded slot until native settlement. */
export function createSecureStorage(
  storage: StorageCipher,
  logger: Pick<Logger, "info">,
  options: { platform: NodeJS.Platform; health?: StorageHealth },
) {
  const { health } = options;
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  let pending = 0;
  // Writes whose native call started and has not settled; reads die harmlessly with the process.
  let nativeWrites = 0;
  let tail: Promise<void> = Promise.resolve();
  let sequence = 0;
  let validated = false;
  const counts = new Map<string, number>();
  // Linux async providers can fall back independently of the selected legacy backend; v10 there
  // is the hardcoded POSIX key. macOS and Windows legitimately write v10, so only Linux refuses it.
  const insecure = (cipher: Buffer) =>
    options.platform === "linux" && cipher.subarray(0, 3).toString() === "v10";
  // The session gate protects the provider's first key fetch, which Chromium caches. Once that
  // fetch succeeded, a locked screen or a resigned session must not refuse encryption: the
  // keychain still serves an already-authorized app, and night routines depend on it.
  const gated = () => !!health && !validated && !health.ready();
  async function run<T>(
    method: string,
    effect: "read" | "write",
    action: () => Promise<T>,
  ): Promise<T> {
    if (gated())
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secure_storage_session_pending");
    if (signal.aborted || pending >= 16)
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secure_storage_busy");
    pending++;
    const requestId = ++sequence;
    const count = (counts.get(method) ?? 0) + 1;
    counts.set(method, Math.min(count, 4));
    const queuedAt = performance.now();
    const trace = (stage: string) => {
      if (count > 3 && stage !== "timeout" && performance.now() - queuedAt < 1000) return;
      logger.info(
        JSON.stringify({
          module: "host",
          event: "secure_storage_timing",
          method,
          requestId,
          stage,
          durationMs: Math.round(performance.now() - queuedAt),
        }),
      );
    };
    trace("queued");
    let expired = false;
    const operation = tail.then(() => {
      signal.throwIfAborted();
      if (expired) throw new RpcError(RpcErrorCodes.secretsUnavailable, "secure_storage_timeout");
      if (gated())
        throw new RpcError(RpcErrorCodes.secretsUnavailable, "secure_storage_session_pending");
      trace("native_started");
      if (effect === "read") return action();
      nativeWrites++;
      const native = action();
      const settled = () => {
        nativeWrites--;
      };
      void native.then(settled, settled);
      return native;
    });
    tail = operation.then(
      () => {
        pending--;
      },
      () => {
        pending--;
      },
    );
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        expired = true;
        cleanup();
        reject(new RpcError(RpcErrorCodes.closed, "secure_storage_closed"));
      };
      const timer = setTimeout(() => {
        expired = true;
        trace("timeout");
        cleanup();
        // A native call that never settles never reaches the action's catch. Before the first
        // initialization succeeded, this timeout is the only signal that recovery must start.
        if (health && !validated) health.failed();
        reject(new RpcError(RpcErrorCodes.secretsUnavailable, "secure_storage_timeout"));
      }, 8000);
      signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => {
          trace("native_finished");
          cleanup();
          resolve(value);
        },
        (error) => {
          trace("failed");
          cleanup();
          reject(error);
        },
      );
    });
  }
  let availability: Promise<boolean> | undefined;
  function isAsyncEncryptionAvailable(): Promise<boolean> {
    if (availability) return availability;
    const probe = run("available", "read", async () => {
      // Available can be true even when the cached provider has no encryption key.
      try {
        const available = await storage.isAsyncEncryptionAvailable();
        signal.throwIfAborted();
        if (!available) {
          health?.failed();
          return false;
        }
        if (health && !validated) {
          // Runs on even after the caller's eight seconds expired: a user who took longer to
          // approve the keychain prompt got a working provider, not a fault to restart for.
          const probe = await storage.encryptStringAsync(PROBE);
          signal.throwIfAborted();
          if (insecure(probe))
            throw new RpcError(RpcErrorCodes.secretsUnavailable, "secure_storage_insecure_backend");
          validated = true;
          health.healthy();
        }
        return true;
      } catch (error) {
        // An insecure Linux backend is configuration, which no restart repairs.
        const configuration =
          error instanceof RpcError && error.message === "secure_storage_insecure_backend";
        if (!signal.aborted && !configuration) health?.failed();
        throw error;
      }
    });
    availability = probe.finally(() => {
      availability = undefined;
    });
    return availability;
  }

  return {
    isAsyncEncryptionAvailable,
    ...(storage.getSelectedStorageBackend
      ? {
          getSelectedStorageBackend: () => storage.getSelectedStorageBackend?.() ?? "unknown",
        }
      : {}),
    encryptStringAsync: (plain: string) =>
      run("encrypt", "write", async () => {
        const cipher = await storage.encryptStringAsync(plain);
        // Never let fallback-key bytes reach persistent storage.
        if (insecure(cipher))
          throw new RpcError(RpcErrorCodes.secretsUnavailable, "secure_storage_insecure_backend");
        return cipher;
      }),
    decryptStringAsync: (cipher: Buffer) =>
      run("decrypt", "read", () => storage.decryptStringAsync(cipher)),
    dispose: () => lifetime.abort(),
    /** Exiting is safe for recovery while no native write is in flight; reads are just dropped. */
    restartable: () => nativeWrites === 0,
  };
}
