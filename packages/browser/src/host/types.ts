import type {
  BrowserBlocked,
  BrowserRecordEvent,
  BrowserRules,
} from "@pibot/browser-contract/full";
import type { Logger } from "@pibot/observability";
import type { BrowserPlatform } from "./platform.ts";

/**
 * Decision port. The kernel never prompts: a `false` answer blocks the request
 * and reports it as `blocked` in the next action result and through `onBlocked`, so the approval
 * flow (T5/T6) can ask the user and reconfigure. Answers must not wait for a person.
 */
export interface BrowserGuard {
  /** A Bot-driven top-level navigation to `domain` (not asked during takeover). */
  site(botId: string, request: { domain: string; url: string }, rules: BrowserRules): boolean;
  /** Form submission or non-GET top-level navigation on `domain`. */
  submit(botId: string, request: { domain: string; url: string }, rules: BrowserRules): boolean;
  /** Paths already resolved inside the run's read roots; brain asks per upload. */
  upload(botId: string, request: { paths: string[] }, rules: BrowserRules): boolean;
}

/** What every Bot session presents to sites: plain Chromium, the system's languages. */
export interface BrowserIdentity {
  userAgent: string;
  /** Comma-separated, most preferred first; Chromium adds the q-values. */
  acceptLanguages: string;
}

export interface BrowserFrame {
  tab: string;
  documentId: string;
  version: number;
  /** JPEG bytes. */
  data: Buffer;
  width: number;
  height: number;
  /** Page CSS pixels per frame pixel, for mapping overlay input back to the page. */
  scale: number;
  scrollX: number;
  scrollY: number;
}

export interface BotBrowserOptions {
  platform: BrowserPlatform;
  /** Host-only seam for isolated transport acceptance; production uses checked literal sockets. */
  privateNetworkDial?: import("./private-network/destination.ts").PrivateNetworkDial;
  /** `<data>/bots/<id>/browser`. */
  profileDir(botId: string, groupId?: string): string;
  groupProfilesDir?(groupId: string): string;
  /** `<data>/bots/<id>/teach/<recordingId>`, where recording keyframes are written. */
  keyframesDir?(botId: string, recordingId: string): string;
  guard: BrowserGuard;
  logger: Logger;
  redact?(text: string): string;
  registerSecret?(value: string, handle?: string): void;
  /** Idle time before page processes close (session data stays). Default 10 minutes. */
  idleMs?: number;
  onBlocked?(botId: string, entry: BrowserBlocked): void;
  onRecord?(botId: string, event: BrowserRecordEvent): void;
  /** Each new tab, once open (login capture world); must not throw for a working tab. */
  onTab?(
    browser: import("./bot-browser.ts").BotBrowser,
    tab: import("./tab.ts").BotTab,
  ): Promise<void>;
  /** Pages opened or all closed; T6 keeps brain awake while any Bot browser is open. */
  onActivity?(botId: string, open: boolean): void;
}
