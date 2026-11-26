// Own the headless brain and its exclusive data-directory claim.
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { startBrain } from "@pibot/brain-app";
import type { ExecutionTarget } from "@pibot/execution";
import { sameFile } from "@pibot/execution/file-identity";
import type { ExecutionLocationTarget } from "@pibot/protocol";
import { createPeer, Events, Methods, type Peer } from "@pibot/protocol";
import { appDataDirReason } from "./data-dir-guard.ts";
import { cliHost } from "./host.ts";
import { portPair } from "./port-pair.ts";

export class HeadlessError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A stale or unknown claim is retained for inspection, never guessed safe from a PID alone. */
async function claimDirectory(dataDir: string) {
  if (appDataDirReason(dataDir)) throw new HeadlessError("app_data_dir");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const root = await realpath(dataDir);
  try {
    await lstat(join(root, "background-runtime", "owner.json"));
    throw new HeadlessError("app_data_dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const path = join(root, "headless-owner.lock");
  const file = await open(path, "wx", 0o600).catch(() => {
    throw new HeadlessError("data_dir_busy");
  });
  const identity = await (async () => {
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, version: 1 }));
      await file.sync();
      return await file.stat({ bigint: true });
    } finally {
      await file.close();
    }
  })();
  const release = async () => {
    const current = await lstat(path, { bigint: true });
    if (!sameFile(current, identity) || !current.isFile())
      throw new HeadlessError("data_dir_claim_changed");
    await unlink(path);
  };
  return { root, release };
}

/** The client Peer's method table is too large for TypeScript to serialize as an inferred type. */
export interface Headless {
  client: Peer<typeof Methods, typeof Events>;
  ready: Promise<void>;
  readonly closed: boolean;
  stop(): Promise<void>;
}

/** Shared headless host and port lifecycle; only a certified brain stop releases the writer claim. */
export function createHeadless(
  dataDir: string,
  options?: {
    pickFolder?: ReturnType<typeof cliHost>["pickFolder"];
    modelRequest?: Parameters<typeof startBrain>[0]["modelRequest"];
    executionTarget?: ExecutionTarget;
    executionLocation?: {
      target: ExecutionLocationTarget;
      platform: "darwin" | "linux" | "win32";
    };
  },
): Headless {
  const [brainPort, clientPort] = portPair();
  const client = createPeer(clientPort, { methods: Methods, events: Events });
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined;
  let release: (() => Promise<void>) | undefined;
  let stopped: Promise<void> | undefined;
  let closing = false;
  const ready = (async () => {
    const claimed = await claimDirectory(resolve(dataDir));
    release = claimed.release;
    if (closing) return;
    const { startBrain } = await import("@pibot/brain-app");
    if (closing) return;
    brain = await startBrain({
      port: brainPort,
      modelRequest: options?.modelRequest,
      host: cliHost({ pickFolder: options?.pickFolder }),
      executionTarget: options?.executionTarget,
      executionLocation: options?.executionLocation,
      // pi returns canonical session filenames; a symlink spelling here would fail its stored
      // relative-path check (notably /tmp and /var on macOS).
      dataDir: claimed.root,
      version: "cli",
      platform: process.platform,
    });
  })();
  // An MCP client can disconnect before its first tool awaits startup.
  void ready.catch(() => undefined);
  return {
    client,
    ready,
    get closed() {
      return closing;
    },
    stop() {
      closing = true;
      stopped ??= (async () => {
        try {
          await ready.catch((error) => {
            // No claim means startup never acquired a writer. A failed brain startup after
            // acquisition remains uncertain and must retain its claim instead.
            if (release) throw error;
          });
          await brain?.stop();
          await release?.();
        } finally {
          client.dispose();
        }
      })();
      return stopped;
    },
  };
}
