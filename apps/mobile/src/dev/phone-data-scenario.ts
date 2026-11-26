import { toolSummaryLabel } from "@pibot/client-core";
import {
  createPeer,
  Methods,
  PHONE_CALL_ID_PREFIX,
  type PhoneMediaItem,
  type Port,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { writePhoneDataPrefs } from "../features/phone-data/prefs.ts";
import type { PhoneMediaSource, PhoneSmsSource } from "../features/phone-data/serve.ts";
import type { ShareFiles } from "../features/share/upload.ts";
import { MobileRuntime, type PhoneDataNative } from "../runtime/runtime.ts";
import { toBase64 } from "../storage/base64.ts";
import { memoryBlobFiles } from "../storage/file-cache.ts";
import { MobileStorage } from "../storage/state.ts";
import type { LocalData, SecretData } from "../storage/types.ts";
import type { Computer, MobileLink } from "../transport/link-port.ts";
import { portConnection } from "../transport/port-connection.ts";

/**
 * The desktop side the dev probe injects (packages/remote/dev/phone-data-desktop.ts): a real
 * brain with the remote capability, the phone tools, policy, audit and a scripted model. The app
 * never imports it.
 */
export interface PhoneDataDesktop {
  botId: string;
  desktopId: string;
  deviceId: string;
  phonePort: Port;
  turns: { tools: string[]; body: string }[];
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
  desktop: {
    call(
      method: "devices.list",
      params: object,
    ): Promise<{ items: { phoneData?: unknown; online?: boolean }[] }>;
    call(method: "chat.history", params: object): Promise<unknown[]>;
    call(
      method: "endpoints.capability.set",
      params: {
        endpointId: string;
        capabilityId: string;
        enabled: boolean;
        scope: { botIds: null; groupIds: null };
      },
    ): Promise<unknown>;
  };
  chat(text: string): Promise<{ assistantMessageId: string }>;
  disconnectPhone(): void;
  reconnectPhone(): void;
  /** Waits until the Bot has no run in progress. */
  settled(): Promise<void>;
}

const CODE = "482913";
const PHONE = "+15551234567";
/** A structurally valid JPEG carrying an EXIF block with location text the computer must drop. */
export function fakeJpeg(width: number, height: number) {
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const segment = (marker: number, body: number[]) => [
    0xff,
    marker,
    ...u16(body.length + 2),
    ...body,
  ];
  const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
  const bytes = [
    0xff,
    0xd8,
    ...segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [
      ...ascii("Exif"),
      0,
      0,
      ...ascii("GPSLatitude=31.2304N;GPSLongitude=121.4737E"),
    ]),
    ...segment(0xc0, [8, ...u16(height), ...u16(width), 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0x56,
    0xff,
    0xd9,
  ];
  return toBase64(Uint8Array.from(bytes));
}
export const MEDIA: PhoneMediaItem[] = [
  {
    id: "asset-1",
    kind: "photo",
    takenAt: "2026-10-20T08:00:00.000Z",
    width: 4032,
    height: 3024,
    hasLocation: true,
  },
  {
    id: "asset-2",
    kind: "photo",
    takenAt: "2026-10-19T08:00:00.000Z",
    width: 3024,
    height: 4032,
    hasLocation: false,
  },
  {
    id: "asset-video",
    kind: "video",
    takenAt: "2026-10-18T08:00:00.000Z",
    width: 1920,
    height: 1080,
    durationMs: 12_000,
    hasLocation: true,
  },
];
/** The scripted model's tool calls, run by run (the probe entry hands them to the fake model). */
export const PHONE_DATA_SCRIPT = [
  // 1: every switch off on the phone.
  { toolCalls: [{ name: "phone_media", arguments: { limit: 3 } }] },
  { toolCalls: [{ name: "phone_sms_code", arguments: { waitSeconds: 5 } }] },
  { text: "Switches are off." },
  // 2: switches on; photos, a video cover and one allowed SMS.
  { toolCalls: [{ name: "phone_media", arguments: { limit: 3 } }] },
  { toolCalls: [{ name: "phone_media_get", arguments: { id: "asset-1" } }] },
  { toolCalls: [{ name: "phone_media_get", arguments: { id: "asset-video" } }] },
  { toolCalls: [{ name: "phone_sms_code", arguments: { senderHint: PHONE, waitSeconds: 20 } }] },
  { text: "Read them." },
  // 3: the owner declines the consent sheet.
  { toolCalls: [{ name: "phone_sms_code", arguments: { waitSeconds: 20 } }] },
  { text: "Declined." },
  // 4: an iPhone answers.
  { toolCalls: [{ name: "phone_sms_code", arguments: { waitSeconds: 5 } }] },
  { toolCalls: [{ name: "phone_media", arguments: { limit: 1 } }] },
  { text: "iPhone." },
  // 5: the phone went offline.
  { toolCalls: [{ name: "phone_media", arguments: {} }] },
  { text: "Offline." },
  // 6: the reply to the message shared from the phone.
  { text: "Got the shared file." },
];

export function memoryStorage(share: ShareFiles) {
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
  return new MobileStorage(data, secure, memoryBlobFiles(), share);
}
export function memoryShare() {
  const blobs = new Map<string, Uint8Array>();
  const files: ShareFiles & { add(bytes: Uint8Array): string; blobs: Map<string, Uint8Array> } = {
    blobs,
    add(bytes) {
      const blob = crypto.randomUUID();
      blobs.set(blob, bytes);
      return blob;
    },
    async read(blob, offset, length) {
      const bytes = blobs.get(blob);
      if (!bytes) throw new Error("share_blob_missing");
      return toBase64(bytes.subarray(offset, offset + length));
    },
    remove(blob) {
      blobs.delete(blob);
    },
  };
  return files;
}
const fakeMedia: PhoneMediaSource = {
  permission: async () => "granted",
  list: async (query) => ({ items: MEDIA.slice(0, query.limit ?? 50), nextAfter: null }),
  async prepare(id) {
    const item = MEDIA.find((m) => m.id === id);
    if (!item) return undefined;
    const [width, height] = item.kind === "video" ? [1280, 720] : [1600, 1200];
    return { item, width, height, base64: fakeJpeg(width, height) };
  },
};
function fakeSms(log: string[]): PhoneSmsSource {
  let consents = 0;
  return {
    capabilities: async () => ({ consent: true, readSms: "undeclared" }),
    async waitConsent(senderHint) {
      consents++;
      log.push(`consent:${consents}`);
      // First sheet: the owner allows; second: the owner declines.
      if (consents > 1) throw new RpcError(RpcErrorCodes.unsupported, "phone_consent_denied");
      return { code: CODE, senderLast4: senderHint ? senderHint.slice(-4) : null };
    },
    scanRecent: async () => {
      throw new RpcError(RpcErrorCodes.unsupported, "phone_sms_timeout");
    },
  };
}
/** The phone app's real link adapter (port-connection.ts) over the in-memory session port. */
export function sessionLink(
  desktop: Pick<PhoneDataDesktop, "phonePort">,
  computer: Computer,
): MobileLink {
  return {
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
      const closed = new AbortController();
      return portConnection({
        port: desktop.phonePort,
        closed: closed.signal,
        close: async () => closed.abort(),
      });
    },
  };
}
export function waitFor(read: () => boolean, label: string, ms = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const until = Date.now() + ms;
    const tick = () => {
      if (read()) return resolve();
      if (Date.now() > until) return reject(new Error(`phone_data_timeout_${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}
export async function outcome(work: () => Promise<unknown>) {
  try {
    await work();
    return "accepted";
  } catch (error) {
    return error instanceof RpcError ? `${error.code}:${error.message}` : String(error);
  }
}

/**
 * Phone data end to end: the scripted Bot calls the phone tools through policy and the real remote
 * capability, the phone answers with the app's real handler (fake photo library and SMS module),
 * then a file is shared from the phone. Reports each tool's outcome, what the model saw (untrusted
 * marking, image without EXIF), the audit rows (no codes) and the attachment restrictions.
 */
export async function runPhoneDataScenario(desktop: PhoneDataDesktop) {
  let checks = 0;
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(`phone_data_check_${label}`);
    checks++;
  };
  const computer: Computer = {
    id: desktop.desktopId,
    name: "Probe computer",
    relay: "wss://development.invalid",
    publicKey: "development-public-key",
    safetyCode: "123456",
  };
  const share = memoryShare();
  const smsLog: string[] = [];
  const start = async (phone: PhoneDataNative) => {
    const storage = memoryStorage(share);
    const runtime = new MobileRuntime(storage, sessionLink(desktop, computer), 0, phone);
    await runtime.initialize();
    await runtime.preparePair("development-qr", "Probe phone");
    await runtime.savePair();
    await waitFor(() => runtime.getSnapshot().status === "online", "online");
    return { runtime, storage };
  };
  const turnsSince = (from: number) =>
    desktop.turns
      .slice(from)
      .map((turn) => turn.body)
      .join("\n");
  const run = async (text: string) => {
    const from = desktop.turns.length;
    await desktop.chat(text);
    return turnsSince(from);
  };
  const report: Record<string, unknown> = {};

  // 1. Everything off.
  const android = await start({ platform: "android", media: fakeMedia, sms: fakeSms(smsLog) });
  let seen = await run("Switches off");
  check(
    seen.includes("phone_media") || desktop.turns.some((t) => t.tools.includes("phone_media")),
    "tools_offered",
  );
  // Private capabilities stay off before the local data handler can run.
  const off = desktop.db
    .prepare("SELECT state, availability FROM endpoint_capabilities WHERE endpoint_id = ?")
    .all(desktop.deviceId) as { state: string; availability: string }[];
  check(
    off.length === 6 &&
      off.every((row) => row.state === "off") &&
      off.filter((row) => row.availability === "local_switch_off").length === 2 &&
      off.filter((row) => row.availability === "unsupported").length === 4,
    "category_off",
  );
  report.switchOff = { phone_media: "capability_off", phone_sms_code: "capability_off" };

  // 2. Switches on (per computer, on the phone).
  await writePhoneDataPrefs(android.storage.data, computer.id, {
    media: true,
    smsCode: true,
    smsFallback: false,
  });
  android.runtime.phoneDataChanged(computer.id);
  await waitFor(() => true, "noop");
  let listed: { phoneData?: unknown } | undefined;
  const shown = JSON.stringify({ platform: "android", media: true, smsCode: true });
  // Step 1 already left a phoneData row, so wait for the switched state itself (slow hosts lag).
  for (
    const until = Date.now() + 10_000;
    Date.now() < until && JSON.stringify(listed?.phoneData) !== shown;
  ) {
    listed = (await desktop.desktop.call("devices.list", {})).items[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  check(
    JSON.stringify(listed?.phoneData) ===
      JSON.stringify({ platform: "android", media: true, smsCode: true }),
    "desktop_shows_categories",
  );
  report.desktopSettingsShows = listed?.phoneData;
  // Explicit control-plane consent is independent of the phone's local switches.
  for (const capabilityId of ["phone.media", "phone.sms"]) {
    await desktop.desktop.call("endpoints.capability.set", {
      endpointId: desktop.deviceId,
      capabilityId,
      enabled: true,
      scope: { botIds: null, groupIds: null },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const beforeAllowedRun = desktop.turns.length;
  const allowedRun = await desktop.chat("Switches on");
  seen = turnsSince(beforeAllowedRun);
  const marker = "以下是手机上的外部内容";
  check((seen.match(new RegExp(marker, "g")) ?? []).length >= 4, "untrusted_marked");
  check(
    seen.includes('\\"hasLocation\\":true') &&
      !/latitude|longitude|31\.23|121\.47/i.test(seen.replace(/GPSLatitude|GPSLongitude/g, "")),
    "no_coordinates",
  );
  check(
    seen.includes(`\\"code\\":\\"${CODE}\\"`) && seen.includes('\\"senderLast4\\":\\"4567\\"'),
    "sms_code_returned",
  );
  const images = [...seen.matchAll(/\/9j\/[A-Za-z0-9+/=]{20,}/g)].map((m) => atob(m[0]));
  check(images.length >= 2, "images_attached");
  check(
    images.every(
      (bytes) =>
        bytes.charCodeAt(0) === 0xff &&
        bytes.charCodeAt(1) === 0xd8 &&
        !bytes.includes("GPSLatitude"),
    ),
    "exif_stripped",
  );
  report.allowed = {
    phone_media: "3 items, hasLocation only",
    phone_media_get: `${new Set(images).size} distinct JPEGs to the model, EXIF/GPS stripped`,
    phone_sms_code: "code + sender last 4",
  };

  const messages = await android.runtime.call("chat.history", {
    botId: desktop.botId,
    topicId: await currentTopic(android.runtime, desktop.botId),
    limit: 2,
  });
  const steps = messages.find((message) => message.id === allowedRun.assistantMessageId)?.tools;
  const label = (name: string) => {
    const step = steps?.find((tool) => tool.tool === name && tool.status === "done");
    return step ? toolSummaryLabel(step) : undefined;
  };
  check(
    /^(?:读取了手机照片 3 张|Read 3 phone photos)$/.test(label("phone_media") ?? "") &&
      /^(?:收到短信验证码|Received an SMS verification code)$/.test(label("phone_sms_code") ?? ""),
    "run_card_summary",
  );

  // 3. The owner declines the system consent sheet.
  seen = await run("Consent declined");
  check(seen.includes("declined on the phone"), "consent_denied");
  report.consentDenied = { phone_sms_code: "phone_consent_denied" };
  await android.runtime.dispose();

  // 4. An iPhone (same pairing): no SMS interface; photos still work.
  const ios = await start({ platform: "ios", media: fakeMedia });
  await writePhoneDataPrefs(ios.storage.data, computer.id, {
    media: true,
    smsCode: true,
    smsFallback: false,
  });
  ios.runtime.phoneDataChanged(computer.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  seen = await run("iPhone");
  const iosSms = desktop.db
    .prepare(
      "SELECT availability FROM endpoint_capabilities WHERE endpoint_id = ? AND capability_id = ?",
    )
    .all(desktop.deviceId, "phone.sms") as { availability: string }[];
  check(iosSms[0]?.availability === "unsupported", "ios_unsupported");
  check(seen.includes(marker), "ios_media_allowed");
  report.iPhone = { phone_sms_code: "unsupported_platform", phone_media: "allowed" };

  // 5. The phone leaves (relay presence off): the computer answers for it.
  desktop.disconnectPhone();
  seen = await run("Offline");
  check((await desktop.desktop.call("devices.list", {})).items[0]?.online === false, "offline");
  report.offline = { phone_media: "phone_offline" };
  desktop.reconnectPhone();
  await new Promise((r) => setTimeout(r, 100));

  // 6. Share to Pi Bot: a text file through the outbox, uploaded in slices, then chat.send.
  const content = new TextEncoder().encode("shared notes line\n".repeat(60_000)); // ~1 MB: two slices
  const blob = share.add(content);
  await ios.runtime.send(
    { botId: desktop.botId, topicId: await currentTopic(ios.runtime, desktop.botId) },
    "From my phone",
    undefined,
    [{ kind: "file", name: "notes.txt", mimeType: "text/plain", blob, bytes: content.length }],
  );
  await waitFor(() => ios.runtime.getSnapshot().pending === 0, "share_sent", 30_000);
  check(!share.blobs.has(blob), "share_copy_removed");
  const history = JSON.stringify(
    await desktop.desktop.call("chat.history", { botId: desktop.botId, limit: 10 }),
  );
  check(history.includes("notes.txt") && history.includes("From my phone"), "attachment_stored");
  await desktop.settled();
  report.share = {
    slices: Math.ceil(content.length / 589_824),
    stored: "notes.txt attached to the message",
  };

  // Attachment restrictions, straight at the gateway (a raw client on the same session).
  const raw = createPeer(
    {
      post: (m) => desktop.phonePort.post(m),
      onMessage: (fn) =>
        desktop.phonePort.onMessage((m) => {
          const id = (m as { id?: unknown } | null)?.id;
          if (
            !(
              typeof id === "string" &&
              id.startsWith(PHONE_CALL_ID_PREFIX) &&
              "method" in (m as object)
            )
          )
            fn(m);
        }),
    },
    { methods: Methods, events: {} },
  );
  const topicId = await currentTopic(ios.runtime, desktop.botId);
  report.restrictions = {
    foreignAttachmentId: await outcome(() =>
      raw.call("chat.send", {
        botId: desktop.botId,
        topicId,
        text: "x",
        attachmentIds: [crypto.randomUUID()],
        clientMessageId: crypto.randomUUID(),
      } as never),
    ),
    inlineAttachments: await outcome(() =>
      raw.call("chat.send", {
        botId: desktop.botId,
        topicId,
        text: "x",
        attachments: [{ kind: "file", name: "a.txt", mimeType: "text/plain", data: "eA==" }],
        clientMessageId: crypto.randomUUID(),
      } as never),
    ),
    disallowedType: await outcome(() =>
      raw.call("remote.share.upload", {
        kind: "file",
        name: "run.exe",
        mimeType: "application/octet-stream",
        total: 4,
        offset: 0,
        chunk: "TVqQ",
      }),
    ),
    imageTooLarge: await outcome(() =>
      raw.call("remote.share.upload", {
        kind: "image",
        name: "big.png",
        mimeType: "image/png",
        total: 20_000_000,
        offset: 0,
        chunk: "iVBO",
      }),
    ),
  };
  raw.dispose();
  const r = report.restrictions as Record<string, string>;
  check(
    r.foreignAttachmentId === `${RpcErrorCodes.invalidParams}:remote_attachment_unavailable`,
    "foreign_id_refused",
  );
  check(
    r.inlineAttachments === `${RpcErrorCodes.invalidParams}:remote_parameter_unavailable`,
    "inline_refused",
  );
  check(
    r.disallowedType === `${RpcErrorCodes.attachmentInvalid}:remote_share_type`,
    "type_refused",
  );
  check(r.imageTooLarge?.startsWith(`${RpcErrorCodes.invalidParams}:`), "image_limit_refused");

  // Audit: Bot, category, count and outcome; never a code or content.
  const audits = desktop.db
    .prepare("SELECT detail FROM audit_log WHERE kind = 'phone.data_read' ORDER BY at")
    .all() as { detail: string }[];
  check(
    new Set(audits.map((row) => (JSON.parse(row.detail) as { toolName: string }).toolName)).size >=
      3,
    "audit_rows",
  );
  check(
    audits.every((row) => !row.detail.includes(CODE) && !row.detail.includes("GPS")),
    "audit_no_content",
  );
  report.audit = audits.map((row) => {
    const d = JSON.parse(row.detail) as Record<string, unknown>;
    return `${d.toolName}:${d.reasonCode}${d.itemCount !== undefined ? `:${d.itemCount}` : ""}`;
  });
  const uploads = desktop.db
    .prepare(
      "SELECT detail FROM audit_log WHERE kind = 'remote.request' AND detail LIKE '%remote.share.upload%'",
    )
    .all() as { detail: string }[];
  check(uploads.length >= 1, "share_audited");
  report.shareAudit = uploads.map(
    (row) => (JSON.parse(row.detail) as { reasonCode: string }).reasonCode,
  );
  report.smsConsentSheets = smsLog.length;
  await ios.runtime.dispose();
  return { checks, ...report };
}
async function currentTopic(runtime: MobileRuntime, botId: string) {
  const topics = await runtime.call("topics.list", { botId, limit: 5 });
  const topic = topics.find((t) => t.isCurrent) ?? topics[0];
  if (!topic) throw new Error("phone_data_no_topic");
  return topic.id;
}
