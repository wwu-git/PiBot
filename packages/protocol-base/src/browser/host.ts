import { z } from "zod";
import { ProxyAddressSchema } from "../app/network-proxy.ts";
import { ImageContentSchema } from "../chat/attachments.ts";
import { AbsolutePathSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import { LocalPortSchema } from "../execution/background-commands.ts";
import { DomainSchema } from "../permissions/settings.ts";
import { BrowserDebugHostMethods, BrowserViewportSchema } from "./debug.ts";
import { BrowserNetworkHostMethods } from "./network.ts";

// brain → background host methods for the per-Bot browser. Screencast frames and
// takeover input never use this table; they go over a dedicated port.
const count = z.number().int().nonnegative().safe();
const text = (max: number) => z.string().max(max);
export const LocalBrowserDocumentExtensionSchema = z.enum([
  ".html",
  ".htm",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".pdf",
]);
export const LocalBrowserFileReceiptSchema = z.strictObject({
  relativePath: text(8192).refine(
    (value) => !/^(?:[/\\]|[a-z]:)/i.test(value) && !value.split(/[/\\]/).includes(".."),
    "Expected a workplace-relative file path",
  ),
  extension: LocalBrowserDocumentExtensionSchema,
});
export const HostBrowserTabIdSchema = z.string().regex(/^t[1-9][0-9]{0,5}$/);
export const BrowserRefSchema = z.string().regex(/^e[1-9][0-9]{0,6}$/);
const clickRef = z.strictObject({ ref: BrowserRefSchema, tab: HostBrowserTabIdSchema.optional() });
const clickPoint = z.strictObject({
  screenshotId: IdSchema,
  x: z.number().finite().min(0).max(12_000),
  y: z.number().finite().min(0).max(12_000),
  tab: HostBrowserTabIdSchema.optional(),
});
/** Coordinates refer to pixels in a host-issued viewport screenshot, never desktop pixels. */
const clickTarget = z.union([clickRef, clickPoint]);
export type BrowserClick = z.infer<typeof clickTarget>;
// Keep a root object for model vendors that reject a root anyOf as a tool's parameter schema.
export const BrowserClickSchema = z
  .strictObject({
    ref: BrowserRefSchema.optional(),
    screenshotId: IdSchema.optional(),
    x: clickPoint.shape.x.optional(),
    y: clickPoint.shape.y.optional(),
    tab: HostBrowserTabIdSchema.optional(),
  })
  // A model sometimes sends a snapshot ref together with placeholder coordinates (video dry run
  // 2026-11-20: ref "e1" plus an all-zero screenshotId and 0,0, rejected three times until the
  // step stopped). The ref names the element, so it wins and the coordinates are ignored.
  .transform((value) =>
    value.ref ? { ref: value.ref, ...(value.tab ? { tab: value.tab } : {}) } : value,
  )
  .refine((value) => clickTarget.safeParse(value).success, "Choose ref or screenshotId/x/y")
  .transform((value) => clickTarget.parse(value));
const SitesSchema = z.union([z.literal("all"), z.array(DomainSchema).max(1000)]);

/** Decisions brain has already made through policy; the host enforces, never asks. */
export const BrowserRulesSchema = z.strictObject({
  runId: IdSchema.optional(),
  /** null = any public site; a list = the "only listed sites" mode, enforced for every request. */
  allowList: z.array(DomainSchema).max(200).nullable(),
  /** Sites the Bot may navigate to without a new approval (always level, remembered, this run). */
  sites: SitesSchema,
  /** Sites where form submission and non-GET top-level navigation are already approved. */
  submitSites: SitesSchema,
  /** Manual proxy including credentials; null = direct. System proxy is never read. */
  proxy: z.strictObject({ url: ProxyAddressSchema }).nullable(),
  /** Read roots of the current run; uploads must resolve inside one of them. */
  readRoots: z.array(AbsolutePathSchema).max(202),
  /** Sensitive read roots from the same execution boundary as read_file; local pages never load from them. */
  blockedReadRoots: z.array(AbsolutePathSchema).max(202).optional(),
  /** `<primary writable root>/downloads`, already gated like write_file; null disables downloads. */
  downloadsDir: AbsolutePathSchema.nullable(),
  /**
   * Loopback ports this Bot's own background commands listen on right now. Only
   * `localServiceTarget` URLs on these ports pass; every other local / LAN address stays blocked.
   */
  localPorts: z.array(LocalPortSchema).max(48).optional(),
  /**
   * Maintainers 2026-11-14: local-network origins (`http://192.168.1.1:80`) a person allowed for this
   * run through a card asked each time. Exactly these origins pass, bypass the user's proxy and
   * may answer from a private address; loopback answers stay refused.
   */
  privateOrigins: z
    .array(
      z
        .string()
        .max(300)
        .regex(/^https?:\/\/[^/\s]+:\d{1,5}$/),
    )
    .max(64)
    .optional(),
  /**
   * Google compatibility mode of this Bot (user's own switch, off by default): on Google's
   * sign-in and account hosts the browser presents itself as Firefox. Absent = off.
   */
  googleCompat: z.boolean().optional(),
  /**
   * The user prefers their own browser (setting "user"). The host uses the extension only
   * when it is connected and the default browser is supported; otherwise this Bot browser.
   */
  userBrowser: z.boolean().optional(),
});
export const BrowserBlockedSchema = z.strictObject({
  kind: z.enum(["site", "not_listed", "private", "submit", "upload", "download"]),
  url: text(4096),
  domain: text(253).optional(),
});
/**
 * A page that is the site itself refusing this browser, not something our rules blocked.
 * `google_embedded_signin`: Google's sign-in answers an embedded (Electron) browser with "This
 * browser or app may not be secure"; nothing about the account, the password or a retry changes
 * that (measured in Google sign-in tests).
 */
export const BrowserBlockedReasonSchema = z.enum(["google_embedded_signin"]);
export type BrowserBlockedReason = z.infer<typeof BrowserBlockedReasonSchema>;

// `/v3/signin/rejected` was observed (2026-10); the older `/signin/rejected` and
// `/signin/v2/rejected` forms are matched too.
const GOOGLE_REJECTED_PATH = /^\/(?:v\d+\/)?signin\/(?:v\d+\/)?rejected(?:\/|$)/;

/** By address only (no page script): host and renderer apply the same rule. */
export function browserBlockedReason(url: string): BrowserBlockedReason | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return parsed.protocol === "https:" &&
    parsed.hostname === "accounts.google.com" &&
    GOOGLE_REJECTED_PATH.test(parsed.pathname)
    ? "google_embedded_signin"
    : undefined;
}

export const BrowserPageSchema = z.strictObject({
  tab: HostBrowserTabIdSchema,
  url: text(8192),
  title: text(1000),
  loading: z.boolean(),
  /** Chromium network error of the last navigation (e.g. "ERR_NAME_NOT_RESOLVED"). */
  error: z
    .string()
    .regex(/^ERR_[A-Z0-9_]{1,80}$/)
    .optional(),
  /** Requests the host refused since the previous result; brain asks the user and reconfigures. */
  blocked: z.array(BrowserBlockedSchema).max(50),
  /** The site refused this browser (see BrowserBlockedReasonSchema); retrying does not help. */
  blockedReason: BrowserBlockedReasonSchema.optional(),
});
/** What settings shows about the user's own browser (the preference comes from settings). */
export const BrowserExtensionStatusSchema = z.strictObject({
  defaultBrowser: z
    .strictObject({
      id: z.enum(["chrome", "edge", "brave", "chromium", "firefox", "safari", "other"]),
      name: z.string().max(100),
    })
    .nullable(),
  supported: z.boolean(),
  extension: z.enum(["connected", "installed", "not_installed", "unsupported"]),
  preference: z.enum(["user", "bot"]),
  /**
   * Why this instance did not register the extension's native host: it runs on a separate data
   * folder (a test or second copy) and was not asked to, or the manifests point at another Pi Bot
   * whose data folder still exists. Either way only an explicit "connect here" takes it over.
   */
  registration: z.enum(["separate_data_dir", "other_instance"]).optional(),
});
export const HostBrowserTabSchema = z.strictObject({
  tab: HostBrowserTabIdSchema,
  url: text(8192),
  title: text(1000),
  active: z.boolean(),
});
export const BrowserDownloadSchema = z.strictObject({
  id: IdSchema,
  filename: text(255),
  path: AbsolutePathSchema.nullable(),
  state: z.enum(["progressing", "completed", "cancelled", "interrupted"]),
  receivedBytes: count,
  totalBytes: count,
  startedAt: z.iso.datetime(),
});
const RecordTargetSchema = z.strictObject({
  tag: text(64),
  type: text(64).optional(),
  role: text(64).optional(),
  name: text(256).optional(),
  label: text(256).optional(),
  /** Kept apart from `label`: pages rotate suggestions through it, so it is a last resort. */
  placeholder: text(256).optional(),
  selector: text(1024).optional(),
  secret: z.boolean().optional(),
});
/** Raw recorder events; secret fields carry only their type, never a value. */
export const BrowserRecordEventSchema = z.strictObject({
  kind: z.enum(["navigate", "click", "input", "select", "check", "submit", "download"]),
  tab: HostBrowserTabIdSchema,
  at: count,
  url: text(8192).optional(),
  target: RecordTargetSchema.optional(),
  value: text(10_000).optional(),
  text: text(1000).optional(),
  checked: z.boolean().optional(),
  method: text(16).optional(),
  action: text(8192).optional(),
  href: text(8192).optional(),
  filename: text(255).optional(),
});
const point = z.number().finite().min(-100_000).max(100_000);
const modifiers = z.number().int().min(0).max(15).optional();
/** Takeover input, already mapped to page CSS pixels by the overlay. */
export const HostBrowserInputEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("mouse"),
    action: z.enum(["move", "down", "up"]),
    x: point,
    y: point,
    button: z.enum(["none", "left", "middle", "right"]).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    modifiers,
  }),
  z.strictObject({ type: z.literal("wheel"), x: point, y: point, deltaX: point, deltaY: point }),
  z.strictObject({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: text(32),
    code: text(32),
    text: text(8).optional(),
    keyCode: z.number().int().min(0).max(255).optional(),
    modifiers,
  }),
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(2000) }),
]);

const bot = { botId: IdSchema, groupId: IdSchema.optional(), runId: IdSchema.optional() };
const tab = { tab: HostBrowserTabIdSchema.optional() };
const page = BrowserPageSchema;
export const BrowserHostMethods = {
  ...BrowserDebugHostMethods,
  ...BrowserNetworkHostMethods,
  /** Trusted user click only; agent tools always use the run-bound open method below. */
  "host.browser.userOpen": {
    params: z.strictObject({
      botId: IdSchema,
      groupId: IdSchema.optional(),
      url: z.string().min(1).max(8192),
    }),
    result: page,
  },
  "host.browser.configure": {
    params: z.strictObject({ ...bot, rules: BrowserRulesSchema }),
    result: z.null(),
  },
  /** The default browser and the extension's connection, which only the desktop knows. */
  "host.browser.extensionStatus": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: BrowserExtensionStatusSchema.omit({ preference: true }),
  },
  /** Writes (enabled) or removes the native messaging manifests of installed browsers. */
  "host.browser.extensionRegister": {
    params: z.strictObject({
      enabled: z.boolean(),
      /** The user turned it on in this instance; a separate data folder registers only then. */
      explicit: z.boolean().optional(),
      /** The user confirmed taking the manifests over from another Pi Bot. */
      takeOver: z.boolean().optional(),
    }),
    result: z.null(),
  },
  "host.browser.open": {
    params: z.strictObject({
      ...bot,
      url: z.string().min(1).max(8192),
      newTab: z.boolean().optional(),
    }),
    result: page.extend({ localFile: LocalBrowserFileReceiptSchema.optional() }),
  },
  "host.browser.snapshot": {
    params: z.strictObject({
      ...bot,
      ...tab,
      maxChars: z.number().int().min(1000).max(100_000).optional(),
    }),
    result: z.strictObject({
      page,
      tree: text(200_000),
      text: text(200_000),
      truncated: z.boolean(),
      refs: count,
    }),
  },
  "host.browser.readTemporary": {
    params: z.strictObject({
      ...bot,
      runId: IdSchema,
      operationId: IdSchema,
      url: z.url().max(8192),
      maxChars: z.number().int().min(1000).max(100_000),
    }),
    result: z.strictObject({ page, text: text(200_000), truncated: z.boolean() }),
  },
  "host.browser.cancelTemporary": {
    params: z.strictObject({ ...bot, runId: IdSchema, operationId: IdSchema }),
    result: z.null(),
  },
  "host.browser.click": {
    params: z.union([clickRef.extend(bot), clickPoint.extend(bot)]),
    result: page,
  },
  "host.browser.type": {
    params: z.strictObject({
      ...bot,
      ...tab,
      ref: BrowserRefSchema,
      text: z.string().max(10_000),
      submit: z.boolean().optional(),
    }),
    result: page,
  },
  "host.browser.select": {
    params: z.strictObject({ ...bot, ...tab, ref: BrowserRefSchema, value: z.string().max(1000) }),
    result: page,
  },
  "host.browser.upload": {
    params: z.strictObject({
      ...bot,
      ...tab,
      ref: BrowserRefSchema,
      paths: z.array(AbsolutePathSchema).min(1).max(10),
    }),
    result: page,
  },
  "host.browser.scroll": {
    params: z.strictObject({
      ...bot,
      ...tab,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(10_000).optional(),
    }),
    result: page,
  },
  "host.browser.back": { params: z.strictObject({ ...bot, ...tab }), result: page },
  "host.browser.tabs": {
    params: z.strictObject(bot),
    result: z.strictObject({ tabs: z.array(HostBrowserTabSchema).max(16) }),
  },
  "host.browser.close": {
    params: z.strictObject({ ...bot, tab: HostBrowserTabIdSchema }),
    result: z.strictObject({ tabs: z.array(HostBrowserTabSchema).max(16) }),
  },
  "host.browser.screenshot": {
    params: z.strictObject({
      ...bot,
      ...tab,
      fullPage: z.boolean().optional(),
      viewport: BrowserViewportSchema.optional(),
    }),
    result: z.strictObject({
      image: ImageContentSchema,
      width: count.positive(),
      height: count.positive(),
      screenshotId: IdSchema.optional(),
    }),
  },
  "host.browser.wait": {
    params: z.strictObject({
      ...bot,
      ...tab,
      for: z.enum(["load", "text", "ref"]),
      value: z.string().min(1).max(1000).optional(),
      timeoutMs: z.number().int().min(100).max(25_000).optional(),
    }),
    result: z.strictObject({ page, matched: z.boolean() }),
  },
  "host.browser.downloads": {
    params: z.strictObject(bot),
    result: z.strictObject({ downloads: z.array(BrowserDownloadSchema).max(100) }),
  },
  /** Closes the Bot's pages now (session data stays); idle close does the same after 10 min. */
  "host.browser.release": { params: z.strictObject(bot), result: z.null() },
  /** Run lease transfer: preserve sleep tabs/cookies, cancel old IO; refuse user takeover. */
  "host.browser.handoff": {
    params: z.strictObject({
      botId: IdSchema,
      groupId: IdSchema.optional(),
      runId: IdSchema,
      temporary: z.boolean().optional(),
    }),
    result: z.null(),
  },
  "host.browser.quiesce": {
    params: z.strictObject({ botId: IdSchema, groupId: IdSchema.optional(), runId: IdSchema }),
    result: z.null(),
  },
  /**
   * The address of the remembered current tab while the Bot's pages sleep (null when
   * awake or nothing is remembered). Read-only, it does not reopen anything: brain judges a page
   * action against it before the action itself reopens the tabs.
   */
  "host.browser.sleeping": {
    params: z.strictObject(bot),
    result: z.strictObject({ url: z.string().max(8192).nullable() }),
  },
  "host.browser.status": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: z.strictObject({
      bots: z.array(z.strictObject({ ...bot, tabs: count, busy: z.boolean() })).max(1000),
    }),
  },
  /**
   * With `recordingId` the host also saves small page keyframes as
   * `<data>/bots/<botId>/teach/<recordingId>/e<event index>.jpg`; they never cross RPC.
   */
  "host.browser.record.start": {
    params: z.strictObject({ ...bot, recordingId: IdSchema.optional() }),
    result: z.null(),
  },
  "host.browser.record.stop": {
    params: z.strictObject(bot),
    result: z.strictObject({ events: z.array(BrowserRecordEventSchema).max(5000) }),
  },
  /** Events from index `after` on, for the live step list while recording. */
  "host.browser.record.read": {
    params: z.strictObject({ ...bot, after: count.max(5000) }),
    result: z.strictObject({
      events: z.array(BrowserRecordEventSchema).max(5000),
      active: z.boolean(),
      paused: z.boolean(),
    }),
  },
  /** Paused (e.g. while the user signs in) the recorder drops everything. */
  "host.browser.record.pause": {
    params: z.strictObject({ ...bot, paused: z.boolean() }),
    result: z.null(),
  },
} as const;
export type BrowserRules = z.infer<typeof BrowserRulesSchema>;
export type BrowserBlocked = z.infer<typeof BrowserBlockedSchema>;
export type BrowserPage = z.infer<typeof BrowserPageSchema>;
export type HostBrowserTab = z.infer<typeof HostBrowserTabSchema>;
export type BrowserDownload = z.infer<typeof BrowserDownloadSchema>;
export type BrowserRecordEvent = z.infer<typeof BrowserRecordEventSchema>;
export type HostBrowserInputEvent = z.infer<typeof HostBrowserInputEventSchema>;
