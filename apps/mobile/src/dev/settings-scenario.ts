import { type Port, RpcError } from "@pibot/protocol";
import {
  addMember,
  createGroup,
  readBotSettings,
  readGroupSettings,
  setPermissions,
  setSkillEnabled,
  updateBot,
  updateGroup,
} from "../features/settings/calls.ts";
import { MobileRuntime } from "../runtime/runtime.ts";
import { memoryBlobFiles } from "../storage/file-cache.ts";
import { MobileStorage } from "../storage/state.ts";
import type { LocalData, SecretData } from "../storage/types.ts";
import type { Computer, MobileLink } from "../transport/link-port.ts";

/**
 * The desktop side the dev probe injects (packages/remote/dev/settings-desktop.ts): a real brain
 * behind the real phone gateway. The app never imports it.
 */
export interface SettingsDesktop {
  botId: string;
  helperIds: string[];
  skillId: string;
  desktopId: string;
  desktopEvents: string[];
  audits: { method: string; outcome: string; facts?: { fields: string[]; botId?: string } }[];
  connect(): Port;
}
function memoryStorage() {
  const values = new Map<string, unknown>(),
    secrets = new Map<string, string>();
  const data: LocalData = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => void values.set(key, structuredClone(value)),
    removePrefix: async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
    close: async () => undefined,
  };
  const secure: SecretData = {
    get: async (id) => secrets.get(id) ?? null,
    set: async (id, value) => void secrets.set(id, value),
    remove: async (id) => void secrets.delete(id),
  };
  return new MobileStorage(data, secure, memoryBlobFiles());
}
/** A link whose every connection is a fresh session on the injected desktop gateway. */
function gatewayLink(desktop: SettingsDesktop): MobileLink {
  const computer: Computer = {
    id: desktop.desktopId,
    name: "Probe computer",
    relay: "wss://invalid.example",
    publicKey: "A".repeat(43),
    safetyCode: "123456",
  };
  return {
    async pair(_qr, name) {
      return {
        computer: { ...computer, name },
        credential: JSON.stringify({
          version: 1,
          seed: "A".repeat(43),
          roomKey: "A".repeat(43),
          publicKey: computer.publicKey,
          relay: computer.relay,
        }),
      };
    },
    async connect(_computer, _credential, signal) {
      signal.throwIfAborted();
      const port = desktop.connect();
      const listeners = new Set<() => void>();
      return {
        port,
        onClose(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        async close() {
          for (const fn of listeners) fn();
          listeners.clear();
        },
        async self() {
          return { id: computer.id, name: computer.name };
        },
        send: async () => {
          throw new Error("settings_probe_no_chat");
        },
        setPushToken: async () => undefined,
        uploadChunk: async () => {
          throw new Error("settings_probe_no_share");
        },
        reportPhoneData: async () => undefined,
        serve: () => () => undefined,
      };
    },
  };
}
async function outcome(work: () => Promise<unknown>) {
  try {
    await work();
    return "accepted";
  } catch (error) {
    return error instanceof RpcError ? `${error.code}:${error.message}` : String(error);
  }
}
function waitFor(read: () => boolean, label: string) {
  return new Promise<void>((resolve, reject) => {
    const until = Date.now() + 5000;
    const tick = () => {
      if (read()) return resolve();
      if (Date.now() > until) return reject(new Error(`settings_timeout_${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}
/**
 * Bot and group settings through the phone's own settings calls, the real phone gateway and a real brain: a
 * rename and a skill toggle reach the brain and come back as change events on both the phone and
 * the desktop; methods and widenings outside the whitelist are refused; the audit names fields.
 */
export async function runSettingsScenario(desktop: SettingsDesktop) {
  let checks = 0;
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(`settings_check_${label}`);
    checks++;
  };
  const runtime = new MobileRuntime(memoryStorage(), gatewayLink(desktop), 0);
  try {
    await runtime.initialize();
    await runtime.preparePair("development-qr", "Probe phone");
    await runtime.savePair();
    await waitFor(() => runtime.getSnapshot().status === "online", "online");
    const peer = runtime.getSnapshot().peer;
    check(peer, "peer");
    const phoneEvents: string[] = [];
    for (const method of [
      "bots.changed",
      "skills.changed",
      "permissions.changed",
      "groups.changed",
    ] as const)
      peer?.on(method, () => phoneEvents.push(method));
    const { botId, skillId } = desktop;

    const before = await readBotSettings(runtime, botId, undefined, "skills");
    check(
      before.skills?.some((skill) => skill.id === skillId && skill.enabled),
      "skill_listed",
    );
    const renamed = await updateBot(runtime, botId, { name: "Phone renamed" });
    check(renamed.name === "Phone renamed", "renamed");
    await waitFor(() => phoneEvents.includes("bots.changed"), "phone_bots_changed");
    await waitFor(() => desktop.desktopEvents.includes("bots.changed"), "desktop_bots_changed");
    const toggled = await setSkillEnabled(runtime, skillId, false);
    check(!toggled.enabled, "skill_disabled");
    await waitFor(() => phoneEvents.includes("skills.changed"), "phone_skills_changed");
    await waitFor(() => desktop.desktopEvents.includes("skills.changed"), "desktop_skills_changed");
    const after = await readBotSettings(runtime, botId, undefined, "skills");
    check(after.profile.bot.name === "Phone renamed", "brain_name");
    check(after.skills?.find((skill) => skill.id === skillId)?.enabled === false, "brain_skill");

    // Group settings: create with two Bots, rename, add the third member.
    const [helper, reviewer] = desktop.helperIds as [string, string];
    const group = await createGroup(runtime, "Phone group", [botId, helper]);
    await updateGroup(runtime, group.id, { name: "Phone group renamed", autoRoundLimit: 3 });
    await addMember(runtime, group.id, reviewer);
    const settings = await readGroupSettings(runtime, group.id);
    check(
      settings.group.name === "Phone group renamed" &&
        settings.group.members.some((member) => member.botId === reviewer),
      "group_settings",
    );
    await waitFor(() => desktop.desktopEvents.includes("groups.changed"), "desktop_groups");
    const folderless = await outcome(() =>
      runtime.call("groups.update", {
        groupId: group.id,
        workplace: { kind: "coordinator" },
      }),
    );
    check(folderless !== "accepted", "group_workplace_refused");

    // Outside the whitelist, or carrying a field the phone may not send.
    const refused = {
      "secrets.list": await outcome(() => runtime.call("secrets.list", {})),
      "bots.archive": await outcome(() => runtime.call("bots.archive", { botId })),
      "bots.update+avatarImage": await outcome(() =>
        runtime.call("bots.update", { botId, avatarImage: null }),
      ),
      "models.list(all)": await outcome(() => runtime.call("models.list", {})),
      "permissions.set(global)": await outcome(() =>
        runtime.call("permissions.set", { levels: { run_command: "always" } }),
      ),
    };
    check(
      Object.values(refused).every((value) => value !== "accepted"),
      "refused",
    );

    // Widening without the unlock mark: the phone's unlock callback is the only way through.
    const plain = await outcome(() =>
      runtime.call("permissions.set", { botId, levels: { run_command: "always" } }),
    );
    check(plain.endsWith("remote_unlock_required"), "widen_refused");
    let unlocks = 0;
    const deny = async () => {
      unlocks++;
      throw new Error("unlock_denied");
    };
    const denied = await outcome(() =>
      setPermissions(runtime, botId, { levels: { run_command: "always" } }, deny),
    );
    check(denied.includes("unlock_denied") && unlocks === 1, "widen_unlock_denied");
    const tightened = await setPermissions(runtime, botId, { levels: { web: "never" } }, deny);
    check(tightened.effective?.levels.web === "never" && unlocks === 1, "tighten_no_unlock");
    const widened = await setPermissions(
      runtime,
      botId,
      { levels: { run_command: "always" } },
      async () => {
        unlocks++;
      },
    );
    check(widened.effective?.levels.run_command === "always" && unlocks === 2, "widen_unlocked");
    await waitFor(() => phoneEvents.includes("permissions.changed"), "phone_permissions_changed");

    const audit = desktop.audits;
    const rename = audit.find((a) => a.method === "bots.update" && a.outcome === "allowed");
    check(rename?.facts?.fields.join() === "name" && rename.facts.botId === botId, "audit_fields");
    check(
      audit.some((a) => a.method === "permissions.set" && a.outcome === "permission_widened"),
      "audit_widened",
    );
    check(
      audit.some((a) => a.method === "unavailable_method" && a.outcome === "refused"),
      "audit_refused",
    );
    check(!JSON.stringify(audit).includes("Phone renamed"), "audit_no_values");
    return {
      checks,
      refused,
      widenWithoutUnlock: plain,
      phoneEvents: [...new Set(phoneEvents)],
      desktopEvents: [...new Set(desktop.desktopEvents)],
      audit: audit
        .filter((a) => a.outcome !== "started" && a.method !== "events.resume")
        .map(
          (a) => `${a.method}:${a.outcome}${a.facts?.fields.length ? `[${a.facts.fields}]` : ""}`,
        ),
      networkRequests: 0,
    };
  } finally {
    await runtime.dispose();
  }
}
