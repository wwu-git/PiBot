import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import {
  type BrainHost,
  type RoutineHostAdapter,
  startBrain,
} from "../../../packages/brain-app/src/index.ts";
import {
  createPeer,
  Events,
  Methods,
  type Port,
  type RoutineDevControl,
} from "../../../packages/protocol/src/index.ts";
import { createRoutineDevControl } from "../../../packages/routines/src/brain/dev/dev.ts";
import type { RoutineService } from "../../../packages/routines/src/brain/service.ts";
import { createPowerLease } from "../../../packages/routines/src/host/power/lease.ts";
import { startFakeLlm } from "../../../tools/fake-llm/index.ts";
import { loadScenario, type Reply, type Scenario } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { until } from "../chat/harness.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";

// Trusted construction captures the real service for fixture-only timing and persisted-state setup.
// Nothing is registered on renderer RPC, and no SDK model/exec port is replaced.
export async function m3Fixture(temporaryRoot: string, reuse?: { root: string; provider: string }) {
  const root = await realpath(reuse?.root ?? (await mkdtemp(join(temporaryRoot, "m3-"))));
  const primary = join(root, "primary"),
    monitor = join(primary, "readonly"),
    output = join(primary, "output");
  await Promise.all([mkdir(monitor, { recursive: true }), mkdir(output, { recursive: true })]);
  // MCP executes inside the permissions sandbox. A development checkout can itself be under a
  // protected AI-config directory, so give subprocesses only the synthetic scripts they need.
  const githubServer = join(root, "fake-github-mcp.mjs");
  const echoServer = join(root, "fake-echo-mcp.mjs");
  await Promise.all([
    copyFile(new URL("../../fixtures/fake-github-mcp.mjs", import.meta.url), githubServer),
    copyFile(new URL("../../../tools/e2e/fixtures/mcp-echo/server.mjs", import.meta.url), echoServer),
  ]);
  const scenario: Scenario = await loadScenario("routines");
  const requests: { model: string; body: Record<string, unknown> }[] = [];
  const server = await startFakeLlm({
    port: 0,
    scenario,
    logDirectory: join(root, "http"),
    observe(body, _route, _index) {
      assert(requests.length < 256);
      requests.push({ model: String(body.model), body });
    },
  });
  let blocked = 0;
  const originalFetch = globalThis.fetch,
    originalConnect = Socket.prototype.connect;
  globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== server.url) {
      blocked++;
      return Promise.reject(new Error("Non-fixture network blocked"));
    }
    return originalFetch(input, { ...init, redirect: "error" });
  };
  // Covers clients with their own fetch/Undici implementation, including raw socket attempts.
  Socket.prototype.connect = function (this: Socket, ...args: Parameters<Socket["connect"]>) {
    const first = args[0] as unknown;
    const value = Array.isArray(first) ? first[0] : first;
    const options =
      typeof value === "object" && value !== null
        ? (value as { host?: string; port?: number; path?: string })
        : { port: value, host: args[1] };
    if (options.host !== "127.0.0.1" || Number(options.port) !== Number(new URL(server.url).port)) {
      blocked++;
      throw new Error("Non-fixture socket blocked");
    }
    return originalConnect.apply(this, args);
  } as Socket["connect"];
  let service: RoutineService | undefined,
    selected = primary;
  let control: Parameters<NonNullable<RoutineHostAdapter>["onControl"]>[0] | undefined;
  let development: ((input: RoutineDevControl) => Promise<void>) | undefined;
  const notifications: Parameters<NonNullable<BrainHost["notify"]>>[0][] = [];
  const tray: Parameters<NonNullable<RoutineHostAdapter>["updateTray"]>[0][] = [];
  let blockers = 0,
    maxBlockers = 0;
  const lease = createPowerLease({
    blocker: {
      start() {
        blockers++;
        maxBlockers = Math.max(maxBlockers, blockers);
        return 1;
      },
      stop() {
        blockers--;
      },
    },
    changed() {},
    warn() {
      throw new Error("Fake blocker failure");
    },
  });
  lease.begin(1);
  lease.supply("ac");
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined;
  let db: RoutineService["deps"]["db"] | undefined;
  let client: ReturnType<typeof createPeer<typeof Methods, typeof Events>> | undefined;
  const boot = async (focusAt?: string, dev = true) => {
    service = undefined;
    const subscriptions = [
      new Set<(value: unknown) => void>(),
      new Set<(value: unknown) => void>(),
    ];
    const ports = [0, 1].map(
      (i): Port => ({
        post(value) {
          const copy = structuredClone(value);
          queueMicrotask(() => {
            for (const listener of subscriptions[1 - i] ?? []) listener(copy);
          });
        },
        onMessage(listener) {
          subscriptions[i]?.add(listener);
          return () => {
            subscriptions[i]?.delete(listener);
          };
        },
      }),
    );
    client = createPeer(ports[1] as Port, { methods: Methods, events: Events });
    brain = await startBrain({
      port: ports[0] as Port,
      dataDir: join(root, "data"),
      version: "routines-isolated",
      platform: process.platform,
      dev,
      routineDev(real) {
        service = real;
        return createRoutineDevControl(real);
      },
      host: {
        // Only the synthetic echo server may answer the Windows stdio isolation prompt.
        confirmConnectorCommand:
          process.platform === "win32"
            ? async (input) => ({
                approved:
                  input.command === process.execPath &&
                  input.args.length === 1 &&
                  input.args[0] === echoServer &&
                  input.networkDomains.length === 0,
              })
            : undefined,
        secrets: {
          isAvailable: async () => true,
          encrypt: async (plain) => Buffer.from(plain),
          decrypt: async (cipher) => Buffer.from(cipher).toString(),
        },
        env: {
          detect: async () => [],
          read: async () => {
            throw new Error("No host credentials");
          },
        },
        pickFolder: async () => selected,
        notify: async (input) => {
          notifications.push(input);
          return { shown: true };
        },
      },
      routineHost: {
        keepAwake: async (input) => lease.request(1, input),
        updateTray: async (input) => {
          tray.push(input);
        },
        backgroundState: async () => ({
          state: "ready",
          startedAt: new Date().toISOString(),
          uptimeMs: 1,
          restartCount: 0,
          at: new Date().toISOString(),
        }),
        onControl(listener) {
          control = listener;
          if (focusAt) void listener({ type: "ui-active", at: focusAt });
          return () => {
            control = undefined;
          };
        },
        onDevControl(listener) {
          development = listener;
          return () => {
            development = undefined;
          };
        },
      },
    });
    const captured = service as RoutineService | undefined;
    db = captured?.deps.db;
  };
  const stop = async () => {
    await brain?.stop();
    brain = undefined;
    db = undefined;
    client?.dispose();
    client = undefined;
  };
  const cleanup = async () => {
    await stop();
    lease.end();
    assert.equal(blockers, 0);
    await server.stop();
    globalThis.fetch = originalFetch;
    Socket.prototype.connect = originalConnect;
  };
  try {
    await boot();
    assert(client);
    const rpc = client;
    // Written for "ask before writing"; in-workplace writes now default to "always" (owner
    // 2026-10-23, covered by the fewer-approvals probe), so the approval scenarios pin "ask".
    await rpc.call("permissions.set", { levels: { write_file: "ask" } });
    const bot = (await rpc.call("bots.list", {})).find((b) => b.isMain);
    assert(bot);
    const other = reuse
      ? (await rpc.call("bots.list", {})).find((b) => !b.isMain)
      : await rpc.call("bots.create", { description: "合成第二Bot" });
    assert(other);
    const { id: provider } = await rpc.call("customProviders.upsert", {
      ...(reuse ? { id: reuse.provider } : {}),
      name: "routines loopback",
      baseUrl: `${server.url}/v1`,
      api: "openai-completions",
      apiKey: "synthetic-routines-key-only",
      models: ["coordinator", "researcher", "writer"].map((id) => ({
        id,
        contextWindow: 32768,
        maxTokens: 2048,
      })),
    });
    for (const b of reuse ? [] : [bot, other]) {
      await rpc.call("bots.update", {
        botId: b.id,
        modelProvider: provider,
        modelId: "coordinator",
        thinkingLevel: "off",
      });
      const places = await rpc.call("workplaces.add", { botId: b.id });
      const folder = places.folders.find((f) => f.path === primary);
      assert(folder);
      await rpc.call("workplaces.setCurrent", { botId: b.id, folderId: folder.id });
    }
    assert(development);
    await development({
      type: "dev-routine-timing",
      patch: {
        // These are harness defaults, not production policy. Keep enough wall-clock budget for a
        // cold worker and SQLite queue to make progress when other verifies saturate the machine.
        approvalWaitMs: 300000,
        queueWaitMs: 300000,
        resumeGraceMs: 100,
        awayCheckMs: 1000,
        waitingKeepAwakeMs: 1000,
      },
    });
    return {
      root,
      primary,
      monitor,
      output,
      githubServer,
      echoServer,
      bot,
      other,
      provider,
      requests,
      notifications,
      tray,
      cleanup,
      stop,
      boot,
      get rpc() {
        assert(client);
        return client;
      },
      get db() {
        assert(db);
        return db;
      },
      get service() {
        assert(service);
        return service;
      },
      pick(path: string) {
        selected = path;
      },
      blocked: () => blocked,
      devRegistered: () => development !== undefined,
      maxBlockers: () => maxBlockers,
      control: async (input: Parameters<NonNullable<typeof control>>[0]) => {
        assert(control);
        await control(input);
      },
      dev: async (input: RoutineDevControl) => {
        assert(development);
        await development(input);
      },
      async replies(replies: Reply[], model = "researcher", botId = bot.id) {
        scenario.routes ??= {};
        scenario.routes[model] = [];
        const consumed = server.counts()[model] ?? 0;
        scenario.routes[model] = [
          ...Array.from({ length: consumed }, () => ({ text: "already consumed" })),
          ...withToolDiscovery(replies, toolLoadGroup),
        ];
        assert(client);
        await client.call("bots.update", { botId, modelId: model });
      },
      counts: () => ({ default: Object.values(server.counts()).reduce((a, b) => a + b, 0) }),
      async idle(runId: string) {
        return until(
          "SDK实际终态",
          () => {
            assert(client);
            return client.call("chat.runs", { botId: bot.id, limit: 200 });
          },
          (runs) =>
            runs.some((r) => r.id === runId && ["done", "error", "aborted"].includes(r.status)),
        );
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export type M3Fixture = Awaited<ReturnType<typeof m3Fixture>>;
