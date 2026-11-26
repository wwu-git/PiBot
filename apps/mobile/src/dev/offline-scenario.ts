import { streamPortable } from "@pibot/agent/portable";
import type { MethodParams, MethodResults, Port } from "@pibot/protocol";
import { writePhoneDataPrefs } from "../features/phone-data/prefs.ts";
import type { PhoneMediaSource } from "../features/phone-data/serve.ts";
import { OfflineEngine } from "../offline/engine.ts";
import { fromBase64 } from "../offline/jpeg.ts";
import { uploadParts } from "../offline/sync.ts";
import { memoryVault } from "../offline/vault.ts";
import { MobileRuntime } from "../runtime/runtime.ts";
import { storeKeys } from "../storage/phone-store.ts";
import type { Computer, MobileLink } from "../transport/link-port.ts";
import { portConnection } from "../transport/port-connection.ts";
import { fakeJpeg, MEDIA, memoryShare, memoryStorage, waitFor } from "./phone-data-scenario.ts";

/** The desktop side the probe injects (packages/remote/dev/offline-desktop.ts). */
export interface OfflineDesktop {
  botId: string;
  providerId: string;
  desktopId: string;
  deviceId: string;
  dataDir: string;
  phonePort: Port;
  requests: { model: string; body: string; tools: string[] }[];
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
  desktop: {
    call<K extends keyof MethodParams>(
      method: K,
      params: MethodParams[K],
    ): Promise<MethodResults[K]>;
  };
  disconnectPhone(): void;
  reconnectPhone(): void;
}
export const OFFLINE_MODEL = "offline-phone";
const OFFLINE_ALT_MODEL = "offline-phone-alt";
export const PERSONA_MARKER = "Sign every reply as Teal Fox";
export const MEMORY_MARKER = "The user's cat is called Miso";
/** The fake model's replies to the phone, in order (route `offline-phone`). */
export const OFFLINE_SCRIPT = [
  // Turn 1: list photos, view one, propose a memory, answer (streamed).
  { toolCalls: [{ name: "phone_media", arguments: { limit: 1 } }] },
  { toolCalls: [{ name: "phone_media_get", arguments: { id: "asset-1" } }] },
  {
    toolCalls: [
      { name: "memory_add", arguments: { text: "The user prefers teal", category: "about_you" } },
    ],
  },
  {
    text: "Here is your newest photo, taken on 20 October. I noted that you prefer teal for when the computer is back. — Teal Fox",
  },
  // Turn 2: the user wants a command; the phone has no such tool.
  { toolCalls: [{ name: "run_command", arguments: { command: "ls" } }] },
  {
    text: "Running commands has to wait until your computer is reachable again; I cannot do it from the phone. — Teal Fox",
  },
  // Proposal 6: a later offline chat continues the topic the phone last showed.
  { text: "Same topic as before, answered on the phone. — Teal Fox" },
];

export const media: PhoneMediaSource = {
  permission: async () => "granted",
  list: async (query) => ({ items: MEDIA.slice(0, query.limit ?? 50), nextAfter: null }),
  async prepare(id) {
    const item = MEDIA.find((m) => m.id === id);
    return item ? { item, width: 1600, height: 1200, base64: fakeJpeg(1600, 1200) } : undefined;
  },
};

/** The app's real link adapter over the in-memory session; `down` makes the computer unreachable. */
export function switchableLink(desktop: OfflineDesktop, computer: Computer) {
  let up = true;
  let current: AbortController | undefined;
  const link: MobileLink = {
    async pair() {
      return {
        computer,
        credential: JSON.stringify({
          version: 1,
          seed: "A".repeat(43),
          roomKey: "A".repeat(43),
          publicKey: "A".repeat(43),
          relay: computer.relay,
        }),
      };
    },
    async connect(_computer, _credential, signal) {
      signal.throwIfAborted();
      if (!up) throw new Error("remote_room_empty");
      const closed = new AbortController();
      current = closed;
      return portConnection({
        port: desktop.phonePort,
        closed: closed.signal,
        close: async () => closed.abort(),
      });
    },
  };
  return {
    link,
    down() {
      up = false;
      desktop.disconnectPhone();
      current?.abort();
    },
    up() {
      up = true;
      desktop.reconnectPhone();
    },
  };
}

/**
 * Items 1, 2 and 4 (and 3 at the end) with a fake model: the computer delivers a model and
 * makes its Bot usable offline; the computer goes away; the phone answers with streaming, the
 * persona and a curated memory in the request, a photo read through its own handler, and a
 * refused command; the computer comes back and imports the chat (new topic, source mark, usage,
 * audit, memory proposal, model history); a repeated upload imports nothing; un-checking the
 * model clears the key on the phone.
 */
export async function runOfflineScenario(desktop: OfflineDesktop) {
  let checks = 0;
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(`offline_check_${label}`);
    checks++;
  };
  const report: Record<string, unknown> = {};
  const computer: Computer = {
    id: desktop.desktopId,
    name: "Probe computer",
    relay: "wss://development.invalid",
    publicKey: "development-public-key",
    safetyCode: "123456",
  };
  const storage = memoryStorage(memoryShare());
  const wire = switchableLink(desktop, computer);
  const runtime = new MobileRuntime(storage, wire.link, 0, { platform: "android", media });
  await runtime.initialize();
  await runtime.preparePair("development-qr", "Probe phone");
  await runtime.savePair();
  await waitFor(() => runtime.getSnapshot().status === "online", "online");
  await writePhoneDataPrefs(storage.data, computer.id, {
    media: true,
    smsCode: false,
    smsFallback: false,
  });
  runtime.phoneDataChanged(computer.id);
  // The computer side switch for photos, for every Bot.
  await waitFor(() => true, "noop");
  for (let tries = 0; tries < 100; tries++) {
    try {
      await desktop.desktop.call("endpoints.capability.set", {
        endpointId: desktop.deviceId,
        capabilityId: "phone.media",
        enabled: true,
        scope: { botIds: null, groupIds: null },
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const vault = memoryVault();
  const engine = new OfflineEngine({
    host: {
      getSnapshot: runtime.getSnapshot,
      subscribe: runtime.subscribe,
      call: (method, params, signal, timeoutMs) => runtime.call(method, params, signal, timeoutMs),
      updateBot: async (botId, providerId, modelId, signal) => {
        await runtime.call("bots.update", { botId, modelProvider: providerId, modelId }, signal);
      },
      getBot: async (botId, signal) => (await runtime.call("bots.profile", { botId }, signal)).bot,
    },
    data: storage.data,
    vault,
    phone: runtime.phone,
    stream: streamPortable,
  });
  engine.start();

  // Maintainers 2026-11-12 (自动同步): the Bot's model and key sync without any click; the Bot is
  // on offline by default.
  const view = await desktop.desktop.call("remote.offline.get", { deviceId: desktop.deviceId });
  check(
    view.models.some((m) => m.modelId === OFFLINE_MODEL && !m.unavailable && m.delivered),
    "model_synced",
  );
  check(new Set(view.models.map((m) => m.providerId)).has(desktop.providerId), "provider_synced");
  check(
    view.models.some((m) => m.providerId === desktop.providerId && m.modelId === OFFLINE_MODEL),
    "provider_catalog",
  );
  check(view.bots.find((b) => b.botId === desktop.botId)?.offline, "bot_on_by_default");
  await engine.sync();
  await waitFor(() => engine.getSnapshot().ready.includes(desktop.botId), "ready", 15_000);
  const snapshot = await engine.store.snapshot(computer.id, desktop.botId);
  const tools: string[] = snapshot?.tools.map((t) => t.name) ?? [];
  check(vault.size() === 1, "key_in_vault");
  check(snapshot?.systemPrompt.includes(PERSONA_MARKER), "persona_in_snapshot");
  check(snapshot?.systemPrompt.includes("replying directly on the user's phone"), "phone_rule");
  check(snapshot?.reference.includes(MEMORY_MARKER), "memory_in_snapshot");
  check(tools.includes("phone_media") && tools.includes("phone_media_get"), "phone_tools");
  check(tools.includes("ask_user") && tools.includes("memory_add"), "card_and_memory_tools");
  check(!tools.includes("run_command") && !tools.includes("read_file"), "no_computer_tools");
  const keyRows = desktop.db
    .prepare(
      "SELECT detail FROM audit_log WHERE kind='remote.changed' AND json_extract(detail,'$.reasonCode')='key_sent'",
    )
    .all() as { detail: string }[];
  check(keyRows.length === 1 && !keyRows[0]?.detail.includes("synthetic-offline-key"), "key_audit");
  report.sync = { tools, keyAudits: keyRows.length };

  // The computer goes away; the phone replies itself.
  check(!engine.canReply(desktop.botId), "online_not_local");
  wire.down();
  // The simulated relay confirms the computer is absent before replies move to the phone.
  await waitFor(() => engine.getSnapshot().unreachable, "unreachable", 45_000);
  check(engine.canReply(desktop.botId), "offline_ready");
  const offlineModel = engine
    .getSnapshot()
    .manifest?.models.find((m) => m.delivered && m.modelId === OFFLINE_MODEL);
  if (!offlineModel) throw new Error("offline_probe_model_missing");
  await engine.selectModel(desktop.botId, offlineModel.providerId, offlineModel.modelId);
  check(
    engine.getSnapshot().choices.some((c) => c.botId === desktop.botId),
    "offline_model_choice_queued",
  );
  const alternate = engine
    .getSnapshot()
    .manifest?.models.find((m) => m.delivered && m.modelId === OFFLINE_ALT_MODEL);
  if (!alternate) throw new Error("offline_probe_alternate_model_missing");
  check(alternate.grantId === offlineModel.grantId, "offline_provider_grant_shared");
  await engine.selectModel(desktop.botId, alternate.providerId, alternate.modelId);
  const switched = engine.getSnapshot().manifest?.bots.find((b) => b.id === desktop.botId);
  check(
    switched?.grantId === alternate.grantId && switched.modelId === alternate.modelId,
    "offline_model_switched",
  );
  await engine.selectModel(desktop.botId, offlineModel.providerId, offlineModel.modelId);
  const before = desktop.requests.length;
  const texts: string[] = [];
  const off = engine.subscribe(() => {
    const live = engine.getSnapshot().live;
    if (live?.text && texts.at(-1) !== live.text) texts.push(live.text);
  });
  const first = await engine.send(
    desktop.botId,
    "Show me my newest photo, and remember I like teal.",
  );
  check(first.status === "done" && first.content.includes("Teal Fox"), "reply_done");
  check(texts.length >= 3, "streamed_incrementally");
  const turn = desktop.requests.slice(before);
  check(turn.length === 4 && turn.every((r) => r.model === OFFLINE_MODEL), "four_model_calls");
  check(turn[0]?.body.includes(PERSONA_MARKER), "persona_sent");
  check(turn[0]?.body.includes(MEMORY_MARKER), "memory_sent");
  check(
    turn[0]?.tools.every((name) => tools.includes(name)),
    "tools_sent",
  );
  const image = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(turn[2]?.body ?? "")?.[1];
  const bytes = image ? fromBase64(image) : undefined;
  const ascii = bytes ? Array.from(bytes, (b) => String.fromCharCode(b)).join("") : "";
  check(bytes && !ascii.includes("GPSLatitude"), "photo_sent_without_exif");
  const second = await engine.send(desktop.botId, "Run ls on my computer.");
  off();
  check(
    second.status === "done" && second.content.includes("computer is reachable"),
    "refused_reply",
  );
  const refused = desktop.requests.at(-1)?.body ?? "";
  check(
    refused.includes("Not available on the phone while the computer is offline"),
    "refusal_text",
  );
  const topic = engine.getSnapshot().topics[desktop.botId];
  check(topic?.messages.length === 4, "local_topic");
  check(
    topic?.audit.some((a) => a.tool === "phone_media_get" && a.decision === "allow") &&
      topic.audit.some((a) => a.tool === "run_command" && a.decision === "deny"),
    "local_audit",
  );
  check(topic?.memory.length === 1 && topic.egress.length === 6, "local_records");
  check(engine.getSnapshot().ledger.length === 6, "phone_ledger");
  report.offline = {
    streamedUpdates: texts.length,
    modelCalls: turn.length + 2,
    audit: topic?.audit.map((a) => `${a.tool}:${a.decision}:${a.outcome}`),
  };

  // The computer is back; the phone hands the topic over.
  const localTopic = topic as NonNullable<typeof topic>;
  wire.up();
  void runtime.networkChanged();
  await waitFor(() => runtime.getSnapshot().status === "online", "back_online", 15_000);
  await waitFor(
    () => engine.getSnapshot().choices.length === 0,
    "offline_model_choice_uploaded",
    15_000,
  );
  const updatedBot = await desktop.desktop.call("bots.profile", { botId: desktop.botId });
  check(updatedBot.bot.modelId === OFFLINE_MODEL, "offline_model_written_back");
  await waitFor(
    () => engine.getSnapshot().waiting === 0 && !Object.keys(engine.getSnapshot().topics).length,
    "uploaded",
    15_000,
  );
  await engine.sync();
  check(!engine.canReply(desktop.botId), "online_again_not_local");
  const conversations = desktop.db
    .prepare(
      "SELECT id,title FROM conversations WHERE bot_id=? AND title LIKE 'Phone offline chat%'",
    )
    .all(desktop.botId) as { id: string; title: string }[];
  check(conversations.length === 1, "new_topic");
  const conversationId = conversations[0]?.id as string;
  const rows = desktop.db
    .prepare(
      "SELECT role,content,created_at,usage FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
    )
    .all(conversationId) as {
    role: string;
    content: string;
    created_at: string;
    usage: string | null;
  }[];
  check(
    rows.length === 4 && rows[0]?.created_at === localTopic.messages[0]?.createdAt,
    "messages_kept_time",
  );
  const usage = JSON.parse(rows[1]?.usage ?? "{}");
  check(
    usage.source?.kind === "phone_local" &&
      usage.source.deviceId === desktop.deviceId &&
      usage.runModel?.id === OFFLINE_MODEL &&
      usage.requests === 4,
    "usage_source_mark",
  );
  const audits = desktop.db
    .prepare("SELECT kind,detail FROM audit_log WHERE json_extract(detail,'$.conversationId')=?")
    .all(conversationId) as { kind: string; detail: string }[];
  check(
    audits.some((a) => a.kind === "phone.data_read" && JSON.parse(a.detail).actor === "phone"),
    "audit_phone_read",
  );
  check(
    audits.filter((a) => JSON.parse(a.detail).target === "offline.model_request").length === 6,
    "audit_egress",
  );
  const proposals = desktop.db
    .prepare("SELECT text,status FROM scoped_memory_proposals WHERE status='pending'")
    .all() as { text: string; status: string }[];
  check(
    proposals.some((p) => p.text === "The user prefers teal"),
    "memory_proposal_pending",
  );
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const session = await readFile(
    join(desktop.dataDir, "bots", desktop.botId, "sessions", `${conversationId}.jsonl`),
    "utf8",
  );
  check(
    session.includes("Show me my newest photo") && session.includes("Teal Fox"),
    "history_seeded",
  );
  report.import = { title: conversations[0]?.title, messages: rows.length, audits: audits.length };

  // The same topic uploaded again imports nothing.
  const counts = () => ({
    messages: (desktop.db.prepare("SELECT count(*) AS n FROM messages").all() as { n: number }[])[0]
      ?.n,
    // The gateway's own record of each upload request is expected; the imported rows are not.
    audit: (
      desktop.db
        .prepare(
          "SELECT count(*) AS n FROM audit_log WHERE COALESCE(json_extract(detail,'$.target'),'')<>'remote.offline.upload'",
        )
        .all() as { n: number }[]
    )[0]?.n,
    proposals: (
      desktop.db.prepare("SELECT count(*) AS n FROM scoped_memory_proposals").all() as {
        n: number;
      }[]
    )[0]?.n,
  });
  const beforeRepeat = counts();
  let duplicates = 0;
  for (const part of uploadParts({ ...localTopic, state: "closed" })) {
    const receipt = await runtime.call("remote.offline.upload", part);
    duplicates += receipt.duplicates;
    check(receipt.imported === 0 && receipt.topicId === conversationId, "repeat_no_import");
  }
  const afterRepeat = counts();
  check(duplicates === 4, "repeat_duplicates");
  check(JSON.stringify(beforeRepeat) === JSON.stringify(afterRepeat), "repeat_no_rows");
  report.repeat = { duplicates, before: beforeRepeat, after: afterRepeat };

  // Proposal 6: the phone's copy names the Bot's current topic (here the imported one, which has
  // a model session already); the next offline chat joins it instead of opening another topic.
  const computerId = runtime.getSnapshot().selectedId as string;
  await runtime.storage.store.write(storeKeys.topics(computerId, "bot", desktop.botId), {
    current: conversationId,
    topics: [],
  });
  wire.down();
  await waitFor(() => engine.getSnapshot().unreachable, "join_unreachable", 45_000);
  const joinedReply = await engine.send(desktop.botId, "Is this still the same topic?");
  check(joinedReply.status === "done", "join_reply_done");
  check(
    engine.getSnapshot().topics[desktop.botId]?.joinTopicId === conversationId,
    "join_topic_named",
  );
  wire.up();
  void runtime.networkChanged();
  await waitFor(() => runtime.getSnapshot().status === "online", "join_back_online", 15_000);
  await waitFor(
    () => engine.getSnapshot().waiting === 0 && !Object.keys(engine.getSnapshot().topics).length,
    "join_uploaded",
    15_000,
  );
  const joinedTopics = desktop.db
    .prepare("SELECT id,title FROM conversations WHERE bot_id=? AND title LIKE 'Phone offline%'")
    .all(desktop.botId) as { id: string; title: string }[];
  check(
    joinedTopics.length === 1 && joinedTopics[0]?.title === conversations[0]?.title,
    "join_no_new_topic",
  );
  const joinedRows = desktop.db
    .prepare(
      "SELECT role,content,usage FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
    )
    .all(conversationId) as { role: string; content: string; usage: string | null }[];
  check(
    joinedRows.length === 6 &&
      joinedRows[4]?.content === "Is this still the same topic?" &&
      JSON.parse(joinedRows[5]?.usage ?? "{}").source?.kind === "phone_local",
    "join_messages_in_order",
  );
  // The model history is written with the last part; an upload the reconnect cut short (its
  // messages already imported) is sent again on the next sync, as the app does.
  const sessionFile = join(
    desktop.dataDir,
    "bots",
    desktop.botId,
    "sessions",
    `${conversationId}.jsonl`,
  );
  let appended = await readFile(sessionFile, "utf8");
  for (let round = 0; round < 5 && !appended.includes("Same topic as before"); round++) {
    await engine.sync();
    appended = await readFile(sessionFile, "utf8");
  }
  check(
    appended.includes("Show me my newest photo") &&
      appended.includes("Is this still the same topic?") &&
      appended.includes("Same topic as before"),
    "join_history_appended",
  );
  report.join = { messages: joinedRows.length };

  // Maintainers 2026-11-12: a provider follows the phone whole; a Bot's switch only decides
  // whether that Bot may answer offline. Off → it is no longer ready here, the key stays.
  await desktop.desktop.call("remote.offline.set", {
    deviceId: desktop.deviceId,
    bot: { botId: desktop.botId, offline: false },
  });
  await waitFor(() => !engine.getSnapshot().ready.includes(desktop.botId), "bot_off", 15_000);
  check(vault.size() === 1, "provider_key_kept");
  // Revoking the phone withdraws every provider; the computer records each cleared key.
  await desktop.desktop.call("devices.revoke", { id: desktop.deviceId });
  const cleared = desktop.db
    .prepare(
      "SELECT count(*) AS n FROM audit_log WHERE kind='remote.changed' AND json_extract(detail,'$.reasonCode')='key_cleared'",
    )
    .all() as { n: number }[];
  check((cleared[0]?.n ?? 0) >= 1, "clear_audit");
  report.cleared = { vault: vault.size(), ready: engine.getSnapshot().ready.length };

  await engine.stop();
  await runtime.dispose();
  return { checks, ...report };
}
