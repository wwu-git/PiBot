// Development harness for the settings probe (apps/mobile `probe --settings`): a real
// brain on a temporary data directory, and the real phone gateway, settings guard and audit facts
// on an in-memory wire. No relay, encryption, model, keychain or network is involved.
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startBrain } from "@pibot/brain";
import { createPeer, Events, InboxItemSchema, Methods, type Port } from "@pibot/protocol";
import { capabilities, productCapabilityTools } from "../../brain-app/src/index.ts";
import { createOrchestrationFactory } from "../../orchestration/src/index.ts";
import { SkillsRepo } from "../../skills/src/store/index.ts";
import { PhoneBrowser } from "../src/brain/browser/phone-browser.ts";
import { PhoneEventBuffer } from "../src/brain/rpc/event-buffer.ts";
import { phoneGateway } from "../src/brain/rpc/gateway.ts";
import { remoteKernelBridge } from "../src/brain/rpc/kernel-bridge.ts";
import { type PhoneWriteFacts, settingsWriteFacts } from "../src/brain/rpc/settings-allowlist.ts";
import { phoneSettingsGuard } from "../src/brain/rpc/settings-gate.ts";
import { RemoteReceiptsRepo } from "../src/store/index.ts";
import { memoryPorts } from "./transport/memory.ts";

export interface PhoneAudit {
  method: string;
  outcome: string;
  facts?: PhoneWriteFacts;
}
export async function startSettingsDesktop() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-settings-probe-")));
  const dataDir = join(root, "data");
  const external = memoryPorts();
  const bridge = remoteKernelBridge(external.a);
  const brain = await startBrain({
    orchestration: createOrchestrationFactory(),
    port: bridge.port,
    dataDir,
    version: "a8-settings-probe",
    platform: process.platform,
    dev: true,
    capabilities: capabilities({
      remoteKernel: bridge.kernel,
      isPhoneRequest: bridge.isPhoneRequest,
    }),
    composition: {
      methods: Methods,
      events: Events,
      tools: productCapabilityTools,
      inboxItemSchema: InboxItemSchema,
    },
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
    },
  });
  // Stands in for the desktop window: it must see the phone's changes as ordinary brain events.
  const desktop = createPeer(external.b, { methods: Methods, events: Events });
  const desktopEvents: string[] = [];
  for (const method of [
    "bots.changed",
    "skills.changed",
    "permissions.changed",
    "groups.changed",
  ] as const)
    desktop.on(method, () => desktopEvents.push(method));
  const main = (await desktop.call("bots.list", {})).find((bot) => bot.isMain);
  if (!main) throw new Error("settings_probe_main_bot_missing");
  // Two more Bots, so the phone can create a group and change its members.
  const helpers = [
    await desktop.call("bots.create", { name: "Probe helper", description: "Probe helper" }),
    await desktop.call("bots.create", { name: "Probe reviewer", description: "Probe reviewer" }),
  ];
  // A second connection only seeds one skill row; the brain owns every later write.
  const db = new DatabaseSync(join(dataDir, "pibot.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const skill = new SkillsRepo(db).create({
    botId: main.id,
    name: "probe-skill",
    description: "Settings probe skill",
    source: "taught",
    path: "skills/probe-skill",
  });
  const receipts = new RemoteReceiptsRepo(db);
  const audits: PhoneAudit[] = [];
  const deviceId = randomUUID(),
    desktopId = randomUUID();
  const sessions = new Set<() => Promise<void>>();
  return {
    botId: main.id,
    helperIds: helpers.map((bot) => bot.id),
    skillId: skill.id,
    desktopId,
    desktopEvents,
    audits,
    /** One phone session through the real gateway; returns the phone end of the wire. */
    connect(): Port {
      const wire = memoryPorts();
      const lifetime = new AbortController();
      const audit = (method: string, outcome: string, facts?: PhoneWriteFacts) =>
        audits.push({ method, outcome, ...(facts ? { facts } : {}) });
      const gateway = phoneGateway({
        deviceId,
        port: wire.a,
        kernel: bridge.kernel,
        buffer: new PhoneEventBuffer(),
        receipts,
        signal: lifetime.signal,
        active: () => lifetime.signal.throwIfAborted(),
        self: () => ({ desktopId, desktopName: "Pi Bot", deviceId, deviceName: "Probe phone" }),
        update: async () => ({ ok: true as const }),
        // The settings probe never opens the Bot browser; no browser port is registered.
        browser: new PhoneBrowser({
          deviceId,
          ports: { get: () => undefined },
          audit: (method, outcome) => audit(method, outcome),
          warn: () => undefined,
        }),
        guard: phoneSettingsGuard({
          kernel: bridge.kernel,
          deviceId,
          signal: lifetime.signal,
          audit,
        }),
        audit: (method, outcome, params) =>
          audit(method, outcome, settingsWriteFacts(method, params)),
      });
      const off = bridge.kernel.subscribe((event) =>
        gateway.emit(event.method, event.payload, true),
      );
      sessions.add(async () => {
        off();
        lifetime.abort();
        await gateway.close();
      });
      return wire.b;
    },
    async stop() {
      for (const close of sessions) await close();
      desktop.dispose();
      await brain.stop();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type SettingsDesktop = Awaited<ReturnType<typeof startSettingsDesktop>>;
