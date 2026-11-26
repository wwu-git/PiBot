// Development harness for the phone offline acceptance (apps/mobile `probe --offline`): a real brain
// (brain-app capabilities, remote capability, memory, policy, audit) on a temporary data
// directory, a custom OpenAI-compatible provider pointing at the scripted fake model, and the
// in-memory development link. The phone side calls the fake model itself while "offline". No
// relay, encryption, keychain, network or real key.
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { createPeer, Events, Methods, type Port } from "@pibot/protocol";
import { startFakeLlm } from "../../../tools/fake-llm/index.ts";
import type { Reply } from "../../../tools/fake-llm/scenario.ts";
import { startBrain } from "../../brain-app/src/index.ts";
import { createMemoryRemoteLink, memoryPorts } from "./transport/memory.ts";

export const OFFLINE_MODEL = "offline-phone";
const OFFLINE_ALT_MODEL = "offline-phone-alt";
export const PERSONA_MARKER = "Sign every reply as Teal Fox";
export const MEMORY_MARKER = "The user's cat is called Miso";

async function until<T>(read: () => Promise<T> | T, accept: (v: T) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await wait(25);
  }
  throw new Error("offline_probe_wait_timeout");
}
export interface ModelRequest {
  model: string;
  body: string;
  tools: string[];
}

export async function startOfflineDesktop(script: Reply[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-a53-offline-")));
  const dataDir = join(root, "data");
  const requests: ModelRequest[] = [];
  const model = await startFakeLlm({
    port: 0,
    logDirectory: join(root, "llm"),
    scenario: { replies: [{ text: "desktop reply" }], routes: { [OFFLINE_MODEL]: script } },
    observe(body) {
      requests.push({
        model: String(body.model),
        body: JSON.stringify(body.messages ?? []),
        tools: Array.isArray(body.tools)
          ? body.tools.map((tool) =>
              String((tool as { function?: { name?: unknown } }).function?.name),
            )
          : [],
      });
    },
  });
  const memory = createMemoryRemoteLink();
  const wire = memoryPorts();
  const brain = await startBrain({
    port: wire.a as Port,
    dataDir,
    version: "a53-offline-probe",
    platform: process.platform,
    dev: true,
    remote: { link: memory.link },
    host: {
      secrets: {
        isAvailable: async () => true,
        encrypt: async (plain) => Buffer.from(plain),
        decrypt: async (bytes) => Buffer.from(bytes).toString(),
      },
      env: {
        detect: async () => [],
        read: async () => {
          throw Error("no_host_credentials");
        },
      },
      pickFolder: async () => root,
      attachments: {
        image: async (image) => ({ image, width: 640, height: 480 }),
        pdf: async () => {
          throw new Error("probe_pdf_unavailable");
        },
        open: async () => undefined,
      },
    },
  });
  const desktop = createPeer(wire.b as Port, { methods: Methods, events: Events });
  await desktop.call("settings.set", { language: "en" });
  const bot = (await desktop.call("bots.list", {})).find((v) => v.isMain);
  if (!bot) throw new Error("offline_probe_main_bot_missing");
  const provider = await desktop.call("customProviders.upsert", {
    name: "Offline fake model",
    baseUrl: `${model.url}/v1`,
    api: "openai-completions",
    apiKey: "synthetic-offline-key",
    models: [
      { id: OFFLINE_MODEL, contextWindow: 65536, maxTokens: 1024, input: ["text", "image"] },
      { id: OFFLINE_ALT_MODEL, contextWindow: 65536, maxTokens: 1024, input: ["text"] },
    ],
  });
  // The phone receives models used by active Bots. A catalog entry alone stays on the computer.
  await desktop.call("bots.create", {
    name: "Offline alternate Bot",
    description: "Uses the alternate model for offline selection",
    systemPrompt: "You are a synthetic test Bot.",
    model: { provider: provider.id, id: OFFLINE_ALT_MODEL },
    thinkingLevel: "off",
  });
  await desktop.call("bots.update", {
    botId: bot.id,
    modelProvider: provider.id,
    modelId: OFFLINE_MODEL,
    thinkingLevel: "off",
    systemPrompt: `You are Pi, a careful helper on the user's devices. ${PERSONA_MARKER}. You explain results plainly.`,
  });
  await desktop.call("memory.manage", {
    scope: "user",
    ownerId: "user",
    confirmed: true,
    change: { action: "import", text: MEMORY_MARKER, category: "about_you" },
  });
  await desktop.call("remote.settings.set", {
    expectedVersion: 0,
    disclosureAccepted: true,
    patch: { enabled: true },
  });
  const pairing = await desktop.call("devices.pairStart", undefined);
  const publicKey = `development-phone-${randomUUID()}`;
  const [pending] = await until(memory.pendingPairings, (ids) => ids.length > 0);
  memory.completePair(pending as string, {
    publicKey,
    name: "Probe phone",
    room: `development-room-${randomUUID()}`,
    roomSecret: `development-room-secret-${randomUUID()}`,
    securityCode: "123456",
  });
  const status = await until(
    () => desktop.call("devices.pairStatus", { id: pairing.id }),
    (v) => v.status === "paired",
  );
  const db = new DatabaseSync(join(dataDir, "pibot.db"), { readOnly: true });
  const desktopId = String(
    (db.prepare("SELECT desktop_id FROM remote_settings").get() as { desktop_id: string })
      .desktop_id,
  );
  const phonePort = await until(
    () => {
      try {
        return memory.phone(publicKey);
      } catch {
        return undefined;
      }
    },
    (port) => !!port,
  );
  return {
    botId: bot.id,
    providerId: provider.id,
    desktopId,
    deviceId: status.deviceId as string,
    dataDir,
    desktop,
    requests,
    db,
    phonePort: phonePort as Port,
    disconnectPhone: () => memory.disconnectPhone(publicKey),
    reconnectPhone: () => memory.phone(publicKey),
    async stop() {
      desktop.dispose();
      await brain.stop();
      db.close();
      await model.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type OfflineDesktop = Awaited<ReturnType<typeof startOfflineDesktop>>;
