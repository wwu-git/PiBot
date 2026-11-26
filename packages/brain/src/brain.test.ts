import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as waitForIO } from "node:timers/promises";
import type { AgentRuntime, AgentRuntimeDeps, BotSession, OpenSessionOptions } from "@pibot/agent";
import { AgentError, PI_VERSION } from "@pibot/agent";
import {
  BaseInboxItemSchema,
  createEventEnvelopeSchema,
  createPeer,
  KernelEvents,
  KernelMethods,
  type Port,
} from "@pibot/protocol-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { credentialsCapability } from "../../credentials/src/brain/index.ts";
import {
  CredentialEvents,
  CredentialMethods,
  GoogleCompatEvents,
  GoogleCompatMethods,
  UserSecretEvents,
  UserSecretMethods,
} from "../../credentials-contract/src/index.ts";
import { memoryCapability } from "../../memory/src/brain/index.ts";
import { providersCapability } from "../../models/src/brain/index.ts";
import { ModelProviderEvents, ModelProviderMethods } from "../../models-contract/src/index.ts";
import { createOrchestrationFactory } from "../../orchestration/src/index.ts";
import { workspacesCapability } from "../../workspaces/src/brain/index.ts";
import {
  ChangesEvents,
  ChangesMethods,
  FileCheckpointMethods,
  ManagedWorktreeMethods,
} from "../../workspaces-contract/src/index.ts";
import { type BrainHost, startBrain } from "./index.ts";

const factory = vi.hoisted(() => vi.fn());
const TestEvents = {
  ...KernelEvents,
  ...ModelProviderEvents,
  ...CredentialEvents,
  ...GoogleCompatEvents,
  ...UserSecretEvents,
  ...ChangesEvents,
} as const;
const TestMethods = {
  ...KernelMethods,
  ...ModelProviderMethods,
  ...CredentialMethods,
  ...GoogleCompatMethods,
  ...UserSecretMethods,
  ...ChangesMethods,
  ...FileCheckpointMethods,
  ...ManagedWorktreeMethods,
  "events.resume": {
    params: KernelMethods["events.resume"].params,
    result: z.array(createEventEnvelopeSchema(TestEvents)),
  },
} as const;
const testComposition = {
  methods: TestMethods,
  events: TestEvents,
  tools: { specs: {}, groups: [] },
  inboxItemSchema: BaseInboxItemSchema,
} as const;
vi.mock("@pibot/agent", async (original) => ({
  ...(await original<typeof import("@pibot/agent")>()),
  createAgentRuntime: factory,
}));

function ports() {
  const listeners = [new Set<(value: unknown) => void>(), new Set<(value: unknown) => void>()];
  const wire: unknown[] = [];
  const pair = [0, 1].map(
    (i): Port => ({
      post(value) {
        wire.push(structuredClone(value));
        queueMicrotask(() => {
          for (const listener of listeners[1 - i] ?? []) listener(value);
        });
      },
      onMessage(listener) {
        listeners[i]?.add(listener);
        return () => {
          listeners[i]?.delete(listener);
        };
      },
    }),
  );
  return { server: pair[0] as Port, client: pair[1] as Port, wire };
}

const model = {
  provider: "openai",
  id: "test",
  name: "Test",
  contextWindow: 8192,
  input: ["text"] as ["text"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const testKey = "test-private-credential-ABCD";

describe("T8 brain", () => {
  let dir: string;
  let brain: Awaited<ReturnType<typeof startBrain>>;
  let peer: ReturnType<typeof createPeer<typeof TestMethods, typeof TestEvents>>;
  let wire: unknown[];
  let guardedFetch: typeof globalThis.fetch;
  let deps: AgentRuntimeDeps;
  let runtime: AgentRuntime;
  let prompt: BotSession["prompt"];
  let abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let detect: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
  let read: ReturnType<typeof vi.fn<(name: string) => Promise<string | undefined>>>;
  let botId: string;
  let opened: OpenSessionOptions[];
  let finish: ((value: { stopReason: string; usage?: unknown }) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  let delta: ((event: { type: "delta"; text: string }) => void) | undefined;
  let env: NodeJS.ProcessEnv;
  let host: BrainHost;

  async function configure() {
    await peer.call("providers.setApiKey", { providerId: "openai", apiKey: testKey });
    await peer.call("bots.update", { botId, modelProvider: "openai", modelId: "test" });
  }
  async function waitPrompt() {
    // Workspace identity checks now complete real filesystem IO before opening the SDK.
    for (let turn = 0; turn < 200 && !delta; turn++) await waitForIO(5);
    expect(delta).toBeDefined();
  }
  async function history() {
    return peer.call("chat.history", { botId });
  }

  beforeEach(async () => {
    env = { ...process.env };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Real network prohibited");
      }),
    );
    guardedFetch = globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), "pibot-brain-test-"));
    const pair = ports();
    wire = pair.wire;
    opened = [];
    finish = undefined;
    reject = undefined;
    delta = undefined;
    prompt = vi.fn<BotSession["prompt"]>(async (_text, onEvent) => {
      delta = onEvent;
      return new Promise<{ stopReason: string; usage?: unknown }>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      });
    });
    abort = vi.fn(async () => {
      reject?.(new AgentError("aborted"));
    });
    detect = vi.fn(async () => ["OPENAI_API_KEY"]);
    read = vi.fn(async () => testKey);
    runtime = {
      generatePersona: vi.fn(async () => {
        throw new AgentError("provider_error");
      }),
      listModels: vi.fn(async ({ availableOnly } = {}) =>
        !availableOnly || deps.hasApiKey("openai") ? [model] : [],
      ),
      testProvider: vi.fn(async () => ({ ok: true, modelCount: 1 })),
      fetchCustomModels: vi.fn(async () => [{ id: "found" }]),
      resolveCustomModels: vi.fn<AgentRuntime["resolveCustomModels"]>(async (models) =>
        models.map((model) => ({
          ...model,
          capabilities: {
            reasoning: model.reasoning ?? false,
            input: model.input ?? ["text"],
            contextWindow: model.contextWindow ?? 32768,
            maxTokens: model.maxTokens ?? 4096,
            thinkingLevels: ["off"],
          },
        })),
      ),
      openSession: vi.fn<AgentRuntime["openSession"]>(async (opts) => {
        opened.push({
          ...opts,
          systemPrompt:
            typeof opts.systemPrompt === "function"
              ? opts.systemPrompt(model, "OpenAI")
              : opts.systemPrompt,
        });
        return {
          sessionFile: opts.sessionFile as string,
          prompt: (...args) => prompt(...args),
          abort,
          dispose: vi.fn(),
        };
      }),
    };
    factory.mockImplementation((input: AgentRuntimeDeps) => {
      deps = input;
      return runtime;
    });
    host = {
      secrets: {
        isAvailable: async () => true,
        encrypt: async (value) => Uint8Array.from(Buffer.from(value), (byte) => byte ^ 0xa5),
        decrypt: async (value) => Buffer.from(value.map((byte) => byte ^ 0xa5)).toString(),
      },
      env: { detect, read },
    };
    const dateTimeFormat = vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ locale: "en-US" }),
    } as Intl.DateTimeFormat);
    try {
      brain = await startBrain({
        orchestration: createOrchestrationFactory(),
        capabilities: [
          providersCapability(),
          memoryCapability(),
          credentialsCapability(),
          workspacesCapability(),
        ],
        port: pair.server,
        dataDir: dir,
        version: "0.0.0",
        platform: "darwin",
        host,
        composition: testComposition,
      });
    } finally {
      dateTimeFormat.mockRestore();
    }
    peer = createPeer(pair.client, { methods: TestMethods, events: TestEvents });
    botId = (await peer.call("bots.list", undefined))[0]?.id as string;
  });

  afterEach(async () => {
    finish?.({ stopReason: "stop" });
    await brain?.stop();
    peer?.dispose();
    await rm(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects no_model before inserting any messages, using available models", async () => {
    const errors: unknown[] = [];
    peer.on("chat.error", (value) => errors.push(value));
    await expect(peer.call("chat.send", { botId, text: "Hi" })).rejects.toMatchObject({
      message: "no_model",
    });
    expect(errors).toEqual([expect.objectContaining({ code: "no_model" })]);
    expect(await history()).toEqual([]);
    expect(runtime.openSession).not.toHaveBeenCalled();
    expect(runtime.listModels).toHaveBeenCalledWith({ availableOnly: true });
  });

  it("streams, checkpoints at 500 ms, persists usage/stopReason, and reopens one DM session", async () => {
    await configure();
    const deltas: string[] = [];
    peer.on("chat.delta", ({ text }) => deltas.push(text));
    vi.useFakeTimers();
    const sent = await peer.call("chat.send", { botId, text: "Hi" });
    await waitPrompt();
    expect((await history()).map((m) => [m.role, m.status, m.content])).toEqual([
      ["user", "done", "Hi"],
      ["assistant", "streaming", ""],
    ]);
    delta?.({ type: "delta", text: "Hello" });
    await vi.advanceTimersByTimeAsync(499);
    expect((await history())[1]?.content).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect((await history())[1]?.content).toBe("Hello");
    finish?.({ stopReason: "stop", usage: { input: 2, output: 3 } });
    await vi.waitFor(async () => expect((await history())[1]?.status).toBe("done"));
    expect(deltas.join("")).toBe("Hello");
    expect((await history())[1]).toMatchObject({
      id: sent.assistantMessageId,
      usage: { input: 2, output: 3, stopReason: "stop" },
    });
    delta = undefined;
    await peer.call("chat.send", { botId, text: "Again" });
    await waitPrompt();
    expect(opened[1]?.sessionFile).toBe(opened[0]?.sessionFile);
    expect(opened[0]?.homeDir).toBe(join(dir, "bots", botId, "home"));
    expect(opened[0]?.systemPrompt).toContain("Commands: ask");
    expect(opened[0]?.systemPrompt).toContain("Files and commands obey workplace boundaries");
  });

  it("abort preserves partial output and releases the Bot", async () => {
    await configure();
    const sent = await peer.call("chat.send", { botId, text: "Hi" });
    await waitPrompt();
    delta?.({ type: "delta", text: "partial" });
    await peer.call("chat.abort", { runId: sent.runId });
    expect(abort).toHaveBeenCalledOnce();
    expect((await history())[1]).toMatchObject({
      content: "partial",
      status: "aborted",
      errorCode: "aborted",
    });
    await expect(peer.call("chat.abort", { runId: sent.runId })).resolves.toEqual({ ok: true });
    delta = undefined;
    await peer.call("chat.send", { botId, text: "Next" });
    await waitPrompt();
  });

  it.each([
    [401, "auth_failed"],
    [403, "auth_failed"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ] as const)("maps status %s without returning raw SDK diagnostics", async (status, code) => {
    await configure();
    await peer.call("chat.send", { botId, text: "Hi" });
    await waitPrompt();
    reject?.({ status, message: `Request failed ${testKey}` });
    await vi.waitFor(async () => expect((await history())[1]?.errorCode).toBe(code));
    expect((await history())[1]?.status).toBe("error");
    expect(
      JSON.stringify(
        wire.filter(
          (v) =>
            (v as { result?: unknown; method?: string }).result !== undefined ||
            (v as { id?: string }).id === undefined,
        ),
      ),
    ).not.toContain(testKey);
    const logs = await readdir(join(dir, "logs"));
    for (const log of logs)
      expect(await readFile(join(dir, "logs", log), "utf8")).not.toContain(testKey);
  });

  it("keeps the upstream reason in the failed chat message and out of log exports", async () => {
    await configure();
    const { runId } = await peer.call("chat.send", { botId, text: "Hi" });
    await waitPrompt();
    const detail = "Unexpected message role.";
    reject?.(new AgentError("provider_error", 200, detail));
    await vi.waitFor(async () =>
      expect((await history())[1]).toMatchObject({
        status: "error",
        errorCode: "provider_error",
        usage: { providerFailure: { status: 200, detail } },
      }),
    );
    const logsDir = join(dir, "logs");
    const logs = await Promise.all(
      (await readdir(logsDir)).map((name) => readFile(join(logsDir, name), "utf8")),
    );
    const logText = logs.join("\n");
    expect(logText).toContain(`Chat ${runId} provider_error status=200`);
    expect(logText).not.toContain(detail);
    const snapshot = await peer.call("diagnostics.snapshot", undefined);
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({ runId, errorCode: "provider_error" }),
    );
    expect(JSON.stringify(snapshot)).not.toContain(detail);
  });

  it("rejects concurrent sends even during async availability preflight", async () => {
    await configure();
    const original = runtime.listModels;
    let release!: () => void;
    vi.mocked(runtime.listModels).mockImplementationOnce(async (opts) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return original(opts);
    });
    const first = peer.call("chat.send", { botId, text: "One" });
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(peer.call("chat.send", { botId, text: "Two" })).rejects.toMatchObject({
      code: -32011,
    });
    release();
    await first;
    await waitPrompt();
    const queued = await peer.call("chat.send", { botId, text: "Three" });
    expect(await history()).toHaveLength(4);
    await peer.call("chat.abort", { runId: queued.runId });
  });

  it("broadcasts settings with increasing seq and supports events.resume", async () => {
    const seen: number[] = [];
    peer.on("settings.changed", (_, meta) => seen.push(meta.seq));
    const value = await peer.call("settings.set", { language: "zh", theme: "dark" });
    expect(value).toMatchObject({ language: "zh", theme: "dark" });
    await peer.call("providers.setApiKey", { providerId: "openai", apiKey: testKey });
    await peer.call("settings.set", { theme: "light" });
    const replay = await peer.call("events.resume", { afterSeq: 0 });
    expect(replay.map((e) => e.params.seq)).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([2, 4]);
    expect(await peer.call("events.resume", { afterSeq: 3 })).toEqual([replay[3]]);
    await peer.call("chat.send", { botId, text: "No model" }).catch(() => {});
    expect((await peer.call("events.resume", { afterSeq: 4 }))[0]?.method).toBe("chat.error");
  });

  it("rejects ! keys on the wire and never returns keys; env detection only reads names", async () => {
    await expect(
      peer.call("providers.setApiKey", { providerId: "openai", apiKey: "!command" }),
    ).rejects.toMatchObject({ code: -32602 });
    await configure();
    const catalog = await peer.call("providers.list", undefined);
    expect(read).not.toHaveBeenCalled();
    expect(detect).toHaveBeenCalledOnce();
    expect(catalog.find((p) => p.id === "openai")).toMatchObject({
      configured: true,
      keyHint: "ABCD",
      envVarName: "OPENAI_API_KEY",
      envDetected: true,
    });
    expect(
      catalog.filter((p) => p.id === "anthropic").map((p) => [p.auth, p.available, p.configured]),
    ).toEqual([["apiKey", true, false]]);
    expect(
      catalog.every(
        (p) =>
          p.available ===
          (p.auth !== "oauth" ||
            ["github-copilot", "openai-chatgpt", "chatgpt-codex"].includes(p.id)),
      ),
    ).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain(testKey);
    await peer.call("providers.importFromEnv", { providerId: "openai" });
    expect(read).toHaveBeenCalledExactlyOnceWith("OPENAI_API_KEY");
    expect(await deps.getApiKey("openai")).toBe(testKey);
    await peer.call("providers.remove", { providerId: "openai" });
    expect(await deps.getApiKey("openai")).toBeUndefined();
  });

  it("encrypts all custom headers and keys, restores config in memory and forbids builtin replacement", async () => {
    const header = "secret-proxy-header-XYZ";
    await peer.call("customProviders.upsert", {
      id: "proxy",
      name: "Proxy",
      api: "openai-completions",
      baseUrl: "http://localhost:9000/v1",
      models: [{ id: "local" }],
      apiKey: testKey,
      headers: { Authorization: `Bearer ${testKey}`, "X-Company-Key": header },
    });
    expect(await deps.getApiKey("proxy")).toBe(testKey);
    expect(deps.customProviders()[0]?.headers).toEqual({
      Authorization: `Bearer ${testKey}`,
      "X-Company-Key": header,
    });
    const db = new DatabaseSync(join(dir, "pibot.db"));
    const stored = db.prepare("SELECT config FROM providers WHERE id = 'proxy'").get();
    expect(String(stored?.config)).not.toContain(testKey);
    expect(String(stored?.config)).not.toContain(header);
    expect(String(stored?.config)).not.toContain("headers");
    expect(
      db.prepare("SELECT name FROM secrets WHERE scope = 'provider:proxy'").all(),
    ).toHaveLength(2);
    db.close();
    expect(JSON.stringify(await peer.call("providers.list", undefined))).not.toContain(header);
    await expect(
      peer.call("customProviders.upsert", {
        id: "openai",
        name: "Bad",
        api: "openai-completions",
        baseUrl: "http://localhost",
        models: [{ id: "x" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await peer.call("providers.remove", { providerId: "proxy" });
    expect(deps.customProviders()).toEqual([]);
  });

  it("detects Ollama with fake fetch and registers only upon selection", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ models: [{ name: "qwen3:0.6b" }] })),
    );
    vi.stubGlobal("fetch", fetch);
    const detected = await peer.call("local.detectOllama", undefined);
    expect(detected).toEqual({
      running: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "qwen3:0.6b" }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal), redirect: "error" }),
    );
    expect(deps.customProviders()).toEqual([]);
    await peer.call("customProviders.upsert", {
      id: "ollama",
      name: "Ollama",
      baseUrl: detected.baseUrl,
      api: "openai-completions",
      models: detected.models,
    });
    expect(deps.customProviders()[0]).toMatchObject({
      id: "ollama",
      baseUrl: detected.baseUrl,
      api: "openai-completions",
      compat: { supportsDeveloperRole: false },
    });
  });

  it("stops Ollama detection at 1.5 seconds, including a nonresponsive fake fetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const pending = peer.call("local.detectOllama", undefined);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toMatchObject({ running: false, models: [] });
  });

  it("masks a stored key split over streaming deltas and all returned history", async () => {
    await configure();
    const values: string[] = [];
    peer.on("chat.delta", ({ text }) => values.push(text));
    await peer.call("chat.send", { botId, text: "Hi" });
    await waitPrompt();
    delta?.({ type: "delta", text: testKey.slice(0, 9) });
    delta?.({ type: "delta", text: testKey.slice(9) });
    finish?.({ stopReason: "stop" });
    await vi.waitFor(async () => expect((await history())[1]?.status).toBe("done"));
    expect(values.join("")).not.toContain(testKey);
    expect(JSON.stringify(await history())).not.toContain(testKey);
  });

  it("routes the remaining methods and never calls real fetch", async () => {
    expect(await peer.call("app.getInfo", undefined)).toEqual({
      version: "0.0.0",
      platform: "darwin",
      dataDir: dir,
      piVersion: PI_VERSION,
    });
    expect(await peer.call("settings.get", undefined)).toMatchObject({
      language: "system",
      onboardingCompleted: false,
    });
    expect(await peer.call("models.list", {})).toEqual([model]);
    expect(await peer.call("providers.test", { providerId: "openai" })).toEqual({
      ok: true,
      modelCount: 1,
    });
    const config = {
      baseUrl: "http://localhost:9000/v1",
      api: "openai-completions" as const,
      apiKey: testKey,
    };
    expect(await peer.call("customProviders.fetchModels", config)).toEqual({
      models: [{ id: "found" }],
    });
    expect(runtime.fetchCustomModels).toHaveBeenCalledWith(config);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("refuses unavailable encryption and preserves the prior custom provider if encryption fails", async () => {
    const input = {
      id: "proxy",
      name: "Proxy",
      baseUrl: "http://localhost:9000/v1",
      api: "openai-completions" as const,
      apiKey: testKey,
      models: [{ id: "first" }],
    };
    await peer.call("customProviders.upsert", input);
    host.secrets.encrypt = async () => {
      throw new Error(`cipher failed ${testKey}`);
    };
    await expect(
      peer.call("customProviders.upsert", {
        ...input,
        name: "Replacement",
        models: [{ id: "second" }],
      }),
    ).rejects.toMatchObject({ message: "internal" });
    expect(deps.customProviders()[0]?.name).toBe("Proxy");
    expect(await deps.getApiKey("proxy")).toBe(testKey);
    host.secrets.isAvailable = async () => false;
    await expect(
      peer.call("providers.setApiKey", { providerId: "openai", apiKey: testKey }),
    ).rejects.toMatchObject({ code: -32012, message: "secrets_unavailable" });
    const db = new DatabaseSync(join(dir, "pibot.db"));
    expect(
      db.prepare("SELECT id FROM secrets WHERE scope = 'provider:openai'").get(),
    ).toBeUndefined();
    db.close();
  });

  it("persists settings, keys, custom headers and chat across brain restart", async () => {
    await configure();
    await peer.call("settings.set", { language: "zh" });
    await peer.call("customProviders.upsert", {
      id: "proxy",
      name: "Proxy",
      baseUrl: "http://localhost:9000/v1",
      api: "openai-completions",
      models: [{ id: "local" }],
      headers: { Authorization: "Bearer company-private-value" },
    });
    await peer.call("chat.send", { botId, text: "Hi" });
    await waitPrompt();
    expect(opened[0]?.systemPrompt).toContain("命令: 询问");
    delta?.({ type: "delta", text: "saved partial" });
    await brain.stop();
    peer.dispose();
    const pair = ports();
    brain = await startBrain({
      orchestration: createOrchestrationFactory(),
      capabilities: [
        providersCapability(),
        memoryCapability(),
        credentialsCapability(),
        workspacesCapability(),
      ],
      port: pair.server,
      dataDir: dir,
      host,
      version: "0.0.0",
      platform: "darwin",
      composition: testComposition,
    });
    peer = createPeer(pair.client, { methods: TestMethods, events: TestEvents });
    expect((await peer.call("bots.list", undefined))[0]?.id).toBe(botId);
    expect(await peer.call("settings.get", undefined)).toMatchObject({ language: "zh" });
    expect(await deps.getApiKey("openai")).toBe(testKey);
    await peer.call("providers.test", { providerId: "proxy" });
    expect(deps.customProviders()[0]?.headers).toEqual({
      Authorization: "Bearer company-private-value",
    });
    expect((await history())[1]).toMatchObject({ status: "aborted", content: "saved partial" });
    expect(JSON.stringify(await peer.call("providers.list", undefined))).not.toContain(
      "company-private-value",
    );
  });

  it("abort during session opening prevents prompting and retains both inserted messages", async () => {
    await configure();
    let release!: () => void;
    const original = runtime.openSession;
    vi.mocked(runtime.openSession).mockImplementationOnce(async (opts) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(opts);
    });
    const run = await peer.call("chat.send", { botId, text: "Hi" });
    for (let turn = 0; turn < 200 && !release; turn++) await waitForIO(5);
    const stopped = peer.call("chat.abort", { runId: run.runId });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    release();
    await stopped;
    expect(prompt).not.toHaveBeenCalled();
    expect((await history())[1]).toMatchObject({ status: "aborted", content: "" });
  });
});
