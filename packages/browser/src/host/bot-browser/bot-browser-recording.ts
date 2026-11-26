import type { BrowserBlocked } from "@pibot/browser-contract/full";
import type { BotBrowserOperations } from "../bot-browser.ts";
import { Keyframes } from "../page/keyframes.ts";
import { isRestorable, writeSleep } from "../sleep.ts";
import { busy, MAX_BLOCKED } from "./bot-browser-shared.ts";

export async function startRecordingStep(this: BotBrowserOperations, recordingId?: string) {
  for (const read of this.temporaryReads.values()) read.controller.abort();
  // Only a new teach start calls this, so one still running is a leftover the brain no longer
  // tracks; reusing it would put its old events (an old error page's clicks) into the new one.
  if (this.recording.active) {
    this.options.logger.warn(`browser recording restarted botId=${this.botId}`);
    this.keyframes?.dispose();
    this.keyframes = undefined;
    this.recording.stop();
  }
  this.recording.start();
  // Teaching runs in the app's view (takeover windows are for ordinary takeovers); a takeover
  // window
  // left from before would cover the app and hide the pane's frames.
  this.windowed = false;
  this.syncWindow();
  for (const tab of this.tabs.values()) tab.resetDebug();
  const dir = recordingId && this.options.keyframesDir?.(this.botId, recordingId);
  if (dir)
    this.keyframes = new Keyframes(
      dir,
      () => {
        const shown = this.shownTab;
        try {
          return shown ? this.tabs.get(shown)?.control : undefined;
        } catch {
          return undefined; // Closed between the event and the shot.
        }
      },
      (data, width, quality) => this.options.platform.thumbnail(data, width, quality),
      (message) => this.options.logger.warn(`${message} botId=${this.botId}`),
    );
  for (const tab of this.tabs.values()) await tab.startRecording();
}

export async function stopRecordingStep(this: BotBrowserOperations) {
  const keyframes = this.keyframes;
  this.keyframes = undefined;
  await keyframes?.finish();
  const events = this.recording.stop();
  for (const tab of this.tabs.values()) await tab.stopRecording();
  this.touch();
  return events;
}

/** The live step list and the sign-in pause. */
export function readRecordingStep(this: BotBrowserOperations, after: number) {
  return {
    events: this.recording.read(after),
    active: this.recording.active,
    paused: this.recording.paused,
  };
}

export function pauseRecordingStep(this: BotBrowserOperations, paused: boolean) {
  if (!this.recording.active) return;
  this.recording.paused = paused;
  if (paused) this.keyframes?.drop();
}

/** An automatic login fill is never part of a recording. */
export function muteRecordingStep(this: BotBrowserOperations) {
  return this.recording.mute();
}

export function reportStep(this: BotBrowserOperations, entry: BrowserBlocked): void {
  // What the user ran into during a takeover is theirs (nothing from a takeover goes
  // to the model); it used to surface in the Bot's next action result.
  if (!this.takeover) {
    this.blocked.push(entry);
    if (this.blocked.length > MAX_BLOCKED) this.blocked.shift();
  }
  this.options.logger.info(
    `audit browser.blocked botId=${this.botId} kind=${entry.kind} domain=${entry.domain ?? "-"}`,
  );
  this.options.onBlocked?.(this.botId, entry);
}

/** Idle close: page processes go after the idle window; session data stays on disk. */
export function touchStep(this: BotBrowserOperations): void {
  this.lastUsed = performance.now();
  clearTimeout(this.idleTimer);
  if (this.disposed || !this.tabs.size) return;
  this.idleTimer = setTimeout(() => {
    this.idleTimer = undefined;
    if (this.busy) this.touch();
    else void this.serial(async () => this.closePages("remember"));
  }, this.options.idleMs ?? 600_000);
}

/**
 * Wipes this Bot's profile: cookies, local storage, IndexedDB, cache, HTTP auth. Pages close
 * first, after any in-flight Bot action; the session object and proxy settings stay.
 */
export async function clearDataStep(this: BotBrowserOperations): Promise<void> {
  if (this.takeover) throw busy("browser_takeover");
  if (this.recording.active) throw busy("browser_recording");
  await this.serial(async () => {
    this.closePages("forget");
    await this.session.clearStorageData();
    await this.session.clearCache();
    await this.session.clearAuthCache();
  });
}

/** A different run cannot inherit requests/downloads started with the old run's rules. */
export async function handoffStep(
  this: BotBrowserOperations,
  runId: string,
  temporary = false,
): Promise<void> {
  if (this.takeover) throw busy("browser_takeover");
  if (this.recording.active) throw busy("browser_recording");
  await this.serial(async () => {
    if (this.takeover) throw busy("browser_takeover");
    if (this.recording.active) throw busy("browser_recording");
    // A derived fetch must not discard another run's pages or wake its sleeping tabs.
    if (temporary && (this.tabs.size || this.sleeping)) throw busy("browser_resource_busy");
    this.rules = undefined;
    await this.privateTransport.revoke();
    this.proxyKey = undefined;
    this.closePages("remember");
    await this.downloads.cancelActive();
    await this.session.closeAllConnections();
    this.activeRunId = runId;
    for (const tab of this.tabs.values()) tab.resetDebug();
  });
}

export async function quiesceStep(this: BotBrowserOperations, runId: string): Promise<void> {
  let owned = this.activeRunId === runId;
  const retire = () => {
    this.activeRunId = undefined;
    void this.privateTransport.revoke();
    this.proxyKey = undefined;
    if (this.rules)
      this.rules = {
        ...this.rules,
        runId: undefined,
        readRoots: [],
        downloadsDir: null,
        privateOrigins: [],
      };
  };
  if (owned) retire();
  await this.serial(async () => {
    // A timed-out handoff may still have been ahead of us in this lane.
    if (this.activeRunId === runId) {
      owned = true;
      retire();
    }
    if (!owned) return;
    if (this.activeRunId) throw busy("browser_resource_busy");
    await this.downloads.cancelActive();
  });
}

/** Closes pages after any in-flight action (brain-requested release). */
export function releaseStep(this: BotBrowserOperations): Promise<void> {
  return this.serial(async () => this.closePages("remember"));
}

/**
 * `remember` (idle, page-limit eviction, brain gone) keeps the tab list to reopen;
 * `forget` (the user closed them, data cleared) drops it; `keep` leaves a saved list alone.
 */
export function closePagesStep(
  this: BotBrowserOperations,
  mode: "remember" | "forget" | "keep" = "keep",
): void {
  if (mode === "forget") this.sleep = undefined;
  else if (mode === "remember" && this.tabs.size) {
    const tabs = [...this.tabs.values()]
      .filter((tab) => !this.temporaryTabs.has(tab.id) && isRestorable(tab.url))
      .map((tab) => ({
        id: tab.id,
        url: tab.url.slice(0, 8192),
        title: tab.title.slice(0, 1000),
      }));
    this.sleep = tabs.length
      ? {
          tabs,
          active: this.active && tabs.some((tab) => tab.id === this.active) ? this.active : null,
          savedAt: Date.now(),
        }
      : undefined;
  }
  if (mode !== "keep") writeSleep(this.dir, this.sleep);
  this.activeClosedByUser = false;
  this.allClosedByUser = false;
  for (const id of [...this.tabs.keys()]) this.closeTab(id);
  this.opened.clear();
  clearTimeout(this.idleTimer);
  this.idleTimer = undefined;
  this.session.flushStorageData();
}

/** `remember`: the brain went away (standby, restart), so the pages come back on next use. */
export function disposeStep(this: BotBrowserOperations, mode: "remember" | "keep" = "keep"): void {
  if (this.disposed) return;
  void this.privateTransport.revoke();
  this.keyframes?.dispose();
  this.keyframes = undefined;
  this.recording.stop();
  this.takeover = false;
  this.windowed = false;
  this.cast = undefined;
  this.closePages(mode);
  this.disposed = true;
  this.removeRules();
  this.removeHeaders();
  this.downloads.dispose();
}
