import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AgentSessionEvent,
  CreateModelRuntimeOptions,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;

// This is an SDK investigation, not the T7 production adapter. Keep all state disposable.
const temporaryRoot = fs.mkdtempSync(join(tmpdir(), "pibot-t2-"));
const temporaryHome = join(temporaryRoot, "home");
const dataDir = join(temporaryRoot, "data");
const botHome = join(dataDir, "bots", "probe", "home");
const agentDir = join(dataDir, "pi");
const sessionDir = join(dataDir, "bots", "probe", "sessions");
const previousEnv = { ...process.env };
const restorers: Array<() => void> = [];
let networkAttempts = 0;
let commandAttempts = 0;

function replace(target: object, name: string, replacement: unknown): void {
  const original = Reflect.get(target, name);
  Reflect.set(target, name, replacement);
  restorers.push(() => {
    Reflect.set(target, name, original);
  });
}

function denyNetwork(): never {
  networkAttempts++;
  throw new Error("The T2 probe must not access the network");
}

function denyCommand(): never {
  commandAttempts++;
  throw new Error("The T2 probe must not execute subprocesses");
}

function literalCredentials(): CredentialStore {
  const entries = new Map<string, Credential>();
  return {
    async read(id) {
      return entries.get(id);
    },
    async list() {
      return [...entries].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(id, update) {
      const next = await update(entries.get(id));
      if (next !== undefined) entries.set(id, next);
      return entries.get(id);
    },
    async delete(id) {
      entries.delete(id);
    },
  };
}

// Compile-time confirmation of the actual delta event; no inference from CLI output.
function textDelta(event: AgentSessionEvent): string | undefined {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return event.assistantMessageEvent.delta;
  }
  return undefined;
}

try {
  for (const dir of [temporaryHome, botHome, agentDir]) fs.mkdirSync(dir, { recursive: true });
  // Set HOME before importing pi: imports can capture paths or environment values.
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, {
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    APPDATA: join(temporaryHome, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(temporaryHome, ".config"),
    PIBOT_DATA_DIR: dataDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
  assert.equal(homedir(), temporaryHome);
  replace(globalThis, "fetch", denyNetwork);
  replace(net.Socket.prototype, "connect", denyNetwork);
  for (const api of [http, https]) {
    replace(api, "request", denyNetwork);
    replace(api, "get", denyNetwork);
  }
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    replace(childProcess, name, denyCommand);
  }
  syncBuiltinESMExports();

  const pi = await import("@earendil-works/pi-coding-agent");
  assert.equal(pi.VERSION, "1.6.0");
  assert.equal("AuthStorage" in pi, false);
  assert.equal("inMemory" in pi.ModelRegistry, false);
  const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const aiDist = join(piDist, "..", "..", "pi-ai", "dist");
  // Internal files are inspected only here; they are not supported production imports.
  const authModule = (await import(
    pathToFileURL(join(piDist, "core", "auth-storage.js")).href
  )) as {
    AuthStorage: { inMemory(data?: Record<string, Credential>): CredentialStore };
  };
  const telemetry = (await import(pathToFileURL(join(piDist, "core", "telemetry.js")).href)) as {
    isInstallTelemetryEnabled(settings: ReturnType<typeof pi.SettingsManager.inMemory>): boolean;
  };
  const versionCheck = (await import(
    pathToFileURL(join(piDist, "utils", "version-check.js")).href
  )) as {
    checkForNewPiVersion(version: string): Promise<unknown>;
    getLatestPiRelease(version: string): Promise<unknown>;
  };
  const aiCompat = (await import(pathToFileURL(join(aiDist, "compat.js")).href)) as {
    findEnvKeys(provider: string, env: Record<string, string>): string[] | undefined;
  };

  const settings = pi.SettingsManager.inMemory({
    enableInstallTelemetry: false,
    cacheWarming: "off",
    compaction: { enabled: false },
  });
  assert.equal(settings.getEnableInstallTelemetry(), false);
  assert.equal(telemetry.isInstallTelemetryEnabled(settings), false);
  assert.equal(await versionCheck.checkForNewPiVersion(pi.VERSION), undefined);
  assert.equal(await versionCheck.getLatestPiRelease(pi.VERSION), undefined);

  const credentials = literalCredentials();
  const runtime = await pi.ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const registry = new pi.ModelRegistry(runtime);
  assert(registry.getAll().length > 0);
  assert.equal(registry.getAvailable().length, 0);
  assert.deepEqual(runtime.getProviderAuthStatus("openai"), { configured: false });
  const openai = registry.getAll().find((model) => model.provider === "openai");
  assert(openai);
  assert.equal(registry.find("openai", openai.id)?.id, openai.id);

  const providerEnv: Record<string, string[]> = {};
  const syntheticEnv = new Proxy<Record<string, string>>({}, { get: () => "fake-probe" });
  for (const provider of runtime.getProviders()) {
    const names = new Set(aiCompat.findEnvKeys(provider.id, syntheticEnv));
    await provider.auth.apiKey?.resolve({
      ctx: {
        async env(name) {
          names.add(name);
          return undefined;
        },
        async fileExists() {
          return false;
        },
      },
      signal: new AbortController().signal,
    });
    providerEnv[provider.id] = [...names].sort();
  }
  // Short-circuit branches and SDK request-time configuration need a source-audited supplement.
  const supplementalEnv = [
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_WORKSPACE_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_DEFAULT_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  ];
  const envNames = [...new Set([...Object.values(providerEnv).flat(), ...supplementalEnv])].sort();
  const oauthProviders = runtime
    .getProviders()
    .filter((provider) => provider.auth.oauth)
    .map((provider) => ({
      id: provider.id,
      name: provider.auth.oauth?.name,
      subscription: provider.auth.oauth?.isSubscription === true,
    }));

  // AuthStorage has no getApiKey/set/getAuthStatus in 1.1.0; read still resolves $ templates.
  process.env.OPENAI_API_KEY = "fake-env";
  const unsafeMemory = authModule.AuthStorage.inMemory({
    openai: { type: "api_key", key: "$OPENAI_API_KEY" },
  });
  assert.equal((await unsafeMemory.read("openai"))?.type, "api_key");
  assert.deepEqual(await unsafeMemory.read("openai"), { type: "api_key", key: "fake-env" });
  const bareNameMemory = authModule.AuthStorage.inMemory({
    openai: { type: "api_key", key: "OPENAI_API_KEY" },
  });
  assert.deepEqual(await bareNameMemory.read("openai"), {
    type: "api_key",
    key: "OPENAI_API_KEY",
  });
  assert.equal("set" in unsafeMemory, false);
  assert.equal("getApiKey" in unsafeMemory, false);
  assert.equal("getAuthStatus" in unsafeMemory, false);
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getProviderAuthStatus("openai").source, "environment");
  assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "fake-env");
  await credentials.modify("openai", async () => ({ type: "api_key", key: "fake-stored" }));
  await runtime.refresh({ allowNetwork: false });
  assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "fake-stored");
  await runtime.setRuntimeApiKey("openai", "fake-runtime");
  assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "fake-runtime");
  assert.equal(
    (await runtime.getAuth("openai", { apiKey: "fake-request" }))?.auth.apiKey,
    "fake-request",
  );
  await runtime.removeRuntimeApiKey("openai");
  await credentials.delete("openai");
  for (const name of envNames) delete process.env[name];
  await runtime.refresh({ allowNetwork: false });
  assert.equal(registry.getAvailable().length, 0);

  const modelConfig = {
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions" as const,
    models: [
      {
        id: "probe-model",
        name: "Probe",
        input: ["text" as const],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 32,
      },
    ],
  };
  registry.registerProvider("probe-custom", {
    ...modelConfig,
    apiKey: "$PIBOT_PROBE_VALUE",
    headers: { "X-Probe": "$PIBOT_PROBE_VALUE" },
  });
  process.env.PIBOT_PROBE_VALUE = "fake-config";
  const customModel = registry.find("probe-custom", "probe-model");
  assert(customModel);
  assert.equal((await runtime.getAuth(customModel))?.auth.apiKey, "fake-config");
  assert.equal((await runtime.getAuth(customModel))?.auth.headers?.["X-Probe"], "fake-config");
  registry.unregisterProvider("probe-custom");
  delete process.env.PIBOT_PROBE_VALUE;
  registry.registerProvider("probe-custom", {
    ...modelConfig,
    headers: { "X-Probe": "$$literal-header" },
  });
  await runtime.setRuntimeApiKey("probe-custom", "$literal-key");
  assert.equal((await runtime.getAuth("probe-custom"))?.auth.apiKey, "$literal-key");
  const literalModel = registry.find("probe-custom", "probe-model");
  assert(literalModel);
  assert.equal((await runtime.getAuth(literalModel))?.auth.headers?.["X-Probe"], "$literal-header");
  assert.equal(registry.getRegisteredProviderConfig("probe-custom")?.apiKey, undefined);
  assert((await runtime.getAvailable()).every((model) => model.provider === "probe-custom"));
  await runtime.removeRuntimeApiKey("probe-custom");
  registry.unregisterProvider("probe-custom");

  // Do not execute a ! value even in a probe: confirm its code path from the installed source.
  const resolverSource = fs.readFileSync(join(piDist, "core", "resolve-config-value.js"), "utf8");
  const composerSource = fs.readFileSync(join(piDist, "core", "provider-composer.js"), "utf8");
  assert(resolverSource.includes('config.startsWith("!")'));
  assert(resolverSource.includes("execSync(command"));
  assert(composerSource.includes("resolveConfigValueOrThrow(rawKey"));

  const defaultLoader = new pi.DefaultResourceLoader({
    cwd: botHome,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Pi Bot probe",
  });
  await defaultLoader.reload();
  assert.equal(defaultLoader.getSystemPrompt(), "Pi Bot probe");
  assert.deepEqual(defaultLoader.getExtensions().extensions, []);
  assert.deepEqual(defaultLoader.getSkills().skills, []);
  assert.deepEqual(defaultLoader.getPrompts().prompts, []);
  assert.deepEqual(defaultLoader.getThemes().themes, []);
  assert.deepEqual(defaultLoader.getAgentsFiles().agentsFiles, []);

  // no* suppresses loading, but reload still discovers resources. A static loader does neither.
  const emptyExtensions = { extensions: [], errors: [], runtime: pi.createExtensionRuntime() };
  const loader: ResourceLoader = {
    getExtensions: () => emptyExtensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Pi Bot probe",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  async function openMemorySession() {
    const { session } = await pi.createAgentSession({
      cwd: botHome,
      agentDir,
      modelRuntime: runtime,
      settingsManager: settings,
      sessionManager: pi.SessionManager.inMemory(botHome),
      resourceLoader: loader,
      noTools: "all",
    });
    try {
      assert.deepEqual(session.getActiveToolNames(), []);
      assert.equal(session.agent.state.tools.length, 0);
      const unsubscribe = session.subscribe(textDelta);
      assert.equal(typeof session.prompt, "function");
      assert.equal(session.model?.provider, "unknown");
      await assert.rejects(session.prompt("Probe without a configured model"), /no API key/i);
      await session.abort();
      unsubscribe();
    } finally {
      session.dispose();
    }
  }
  await openMemorySession();
  assert.equal(fs.existsSync(join(temporaryHome, ".pi")), false);
  assert.deepEqual(fs.readdirSync(agentDir), []);

  // Also reproduce the spec's pre-existing foreign auth.json fixture without modifying it.
  const foreignAgent = join(temporaryHome, ".pi", "agent");
  fs.mkdirSync(foreignAgent, { recursive: true });
  const foreignAuth = join(foreignAgent, "auth.json");
  const fixture = JSON.stringify({ openai: { type: "api_key", key: "fake-foreign" } });
  fs.writeFileSync(foreignAuth, fixture);
  const fixtureMtime = fs.statSync(foreignAuth).mtimeMs;
  let foreignReadAttempts = 0;
  const readFileSync = fs.readFileSync;
  const readFile = fs.promises.readFile;
  function isForeignPath(value: unknown): boolean {
    return typeof value === "string" && value.startsWith(join(temporaryHome, ".pi"));
  }
  replace(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (isForeignPath(args[0])) {
      foreignReadAttempts++;
      throw new Error("Foreign pi files must not be read");
    }
    return Reflect.apply(readFileSync, fs, args);
  });
  replace(fs.promises, "readFile", (...args: Parameters<typeof fs.promises.readFile>) => {
    if (isForeignPath(args[0])) {
      foreignReadAttempts++;
      throw new Error("Foreign pi files must not be read");
    }
    return Reflect.apply(readFile, fs.promises, args);
  });
  syncBuiltinESMExports();
  process.env.OPENAI_API_KEY = "fake-env";
  for (const name of envNames) delete process.env[name];
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual(runtime.getProviderAuthStatus("openai"), { configured: false });
  assert.equal(
    (await runtime.getAvailable()).some((model) => model.provider === "openai"),
    false,
  );
  await openMemorySession();
  assert.deepEqual(fs.readdirSync(join(temporaryHome, ".pi")), ["agent"]);
  assert.deepEqual(fs.readdirSync(foreignAgent), ["auth.json"]);
  assert.equal(readFileSync(foreignAuth, "utf8"), fixture);
  assert.equal(fs.statSync(foreignAuth).mtimeMs, fixtureMtime);

  const diskSession = pi.SessionManager.create(botHome, sessionDir);
  const sessionFile = diskSession.getSessionFile();
  assert(sessionFile);
  assert.equal(dirname(sessionFile), sessionDir);
  // create is lazy: use a local JSONL header to confirm open without any model request.
  fs.writeFileSync(sessionFile, `${JSON.stringify(diskSession.getHeader())}\n`);
  const reopened = pi.SessionManager.open(sessionFile, sessionDir);
  assert.equal(reopened.getSessionFile(), sessionFile);
  assert.equal(reopened.getSessionDir(), sessionDir);
  assert.equal(reopened.getCwd(), botHome);
  assert.deepEqual(fs.readdirSync(foreignAgent), ["auth.json"]);
  assert.equal(readFileSync(foreignAuth, "utf8"), fixture);
  assert.equal(fs.statSync(foreignAuth).mtimeMs, fixtureMtime);
  assert.deepEqual(fs.readdirSync(agentDir), []);
  assert.equal(networkAttempts, 0);
  assert.equal(commandAttempts, 0);
  assert.equal(foreignReadAttempts, 0);
  console.log(
    JSON.stringify(
      {
        version: pi.VERSION,
        providers: runtime.getProviders().length,
        chatModels: registry.getAll().length,
        providerEnv,
        envNames,
        oauthProviders,
        checks: {
          freshHomeHasNoPi: true,
          foreignAuthUnchanged: true,
          openaiUnconfigured: true,
          agentDirEmpty: true,
          noTools: true,
          networkAttempts,
          commandAttempts,
          foreignReadAttempts,
        },
      },
      null,
      2,
    ),
  );
} finally {
  for (const restore of restorers.reverse()) restore();
  syncBuiltinESMExports();
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, previousEnv);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
