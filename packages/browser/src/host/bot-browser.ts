import {
  allowNavigationStep,
  armSubmitStep,
  configureRulesStep,
  configureStep,
  downloadListStep,
  learnUserAgentMetadataStep,
  openUrlStep,
  pageStep,
  reloadGoogleTabsStep,
  restoreStep,
  tabListStep,
  userAgentForStep,
  userOpenStep,
} from "./bot-browser/bot-browser-navigation.ts";
import {
  clearDataStep,
  closePagesStep,
  disposeStep,
  handoffStep,
  muteRecordingStep,
  pauseRecordingStep,
  quiesceStep,
  readRecordingStep,
  releaseStep,
  reportStep,
  startRecordingStep,
  stopRecordingStep,
  touchStep,
} from "./bot-browser/bot-browser-recording.ts";
import {
  installBrowserDownloads,
  installBrowserHeaders,
  installBrowserRules,
} from "./bot-browser/bot-browser-session.ts";
import {
  type BrowserPool,
  busy,
  closedByUser,
  type fitDisplay,
} from "./bot-browser/bot-browser-shared.ts";
import {
  adoptPopupStep,
  closeTabStep,
  createTabStep,
  newTabStep,
  showNewTabStep,
  startTabStep,
  tabEventsStep,
  tabStep,
  userCloseTabStep,
  windowOpenStep,
} from "./bot-browser/bot-browser-tabs.ts";
import {
  dropInputStep,
  inputStep,
  recastStep,
  setDisplayStep,
  setTakeoverStep,
  showWindowStep,
  startScreencastStep,
  switchViewStep,
  syncWindowStep,
  userNavigateStep,
  userNewTabStep,
  viewTabsStep,
} from "./bot-browser/bot-browser-view.ts";
import { type TemporaryRead, temporaryReadStep } from "./bot-browser/temporary-read.ts";
import type { Mark } from "./page/phases.ts";

export type { BrowserPool } from "./bot-browser/bot-browser-shared.ts";
export { fitDisplay } from "./bot-browser/bot-browser-shared.ts";
export type BotBrowserOperations = ReturnType<BotBrowser["operationContext"]>;

import { mkdirSync } from "node:fs";
import {
  type BrowserBlocked,
  type BrowserPage,
  type BrowserRules,
  type HostBrowserInputEvent,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import type { installDownloads } from "./downloads.ts";
import { firefoxUserAgent, type UserAgentMetadata } from "./login/google-compat.ts";
import type { Keyframes } from "./page/keyframes.ts";
import { Recording } from "./page/recording.ts";
import type { BrowserWindow, Rectangle, Session } from "./platform.ts";
import { PrivateNetworkTransport } from "./private-network/transport.ts";
import { readSleep, type Sleep } from "./sleep.ts";
import type { BotTab, TabEvents } from "./tab.ts";
import type { BotBrowserOptions, BrowserFrame, BrowserIdentity } from "./types.ts";

/**
 * One Bot's browser: persistent session `<data>/bots/<id>/browser` opened only in this process,
 * hidden tab windows, serialized Bot actions. Owns: session filters, download listener, tab
 * windows + debuggers, idle timer, screencast; `dispose()` releases all of them.
 */
export class BotBrowser {
  rules: BrowserRules | undefined;
  private activeRunId?: string;
  takeover = false;
  /**
   * This takeover shows the driven tab as a real window (not while teaching, whose steps
   * sit next to the picture in the app; false again once the user closes the window).
   */
  private windowed = false;
  /** The tab currently shown as the takeover window. */
  private presented: string | undefined;
  /** Where the takeover window of a tab that just closed was; taken by the next one. */
  private handover: Rectangle | undefined;
  private readonly session: Session;
  private readonly tabs = new Map<string, BotTab>();
  private readonly temporaryTabs = new Set<string>();
  private readonly temporaryBlocked = new Map<string, BrowserBlocked[]>();
  private readonly temporaryReads = new Map<string, TemporaryRead>();
  private active: string | undefined;
  private nextTab = 1;
  private blocked: BrowserBlocked[] = [];
  /** Sites the brain explicitly opened after its own policy check. */
  private readonly opened = new Set<string>();
  private readonly recording: Recording;
  /** Step pictures while recording with a folder; see keyframes.ts. */
  private keyframes: Keyframes | undefined;
  /** Whether onActivity(true) was announced and not yet withdrawn. */
  private announced = false;
  /** Overlay stream: follows the shown tab and outlives page closes until stopped. */
  private cast: { onFrame: (frame: BrowserFrame) => void; stopTab?: () => void } | undefined;
  /** Tab the user picked in the overlay; undefined follows the Bot's active tab. */
  private viewed: string | undefined;
  /** Viewport height and screencast size fitted to the overlay box; undefined = default. */
  private display: ReturnType<typeof fitDisplay> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private proxyKey: string | undefined;
  private readonly privateTransport: PrivateNetworkTransport;
  private readonly removeRules: () => void;
  private readonly removeHeaders: () => void;
  /** The Firefox identity used on Google's hosts while the Bot's switch is on. */
  private readonly firefox = firefoxUserAgent(process.platform);
  /** The engine's client hints a popup's Firefox identity carries (see BotTab.adopt). */
  private userAgentMetadata: UserAgentMetadata | undefined;
  private readingMetadata = false;
  /** The last tab whose late takeover input was dropped (logged once per tab). */
  private droppedInputTab: string | undefined;
  private readonly downloads: ReturnType<typeof installDownloads>;
  private disposed = false;
  /** Actions started and not finished; a Bot mid-action is never the one evicted. */
  private running = 0;
  /** Tabs the user closed from the tab strip. */
  private readonly userClosed = new Set<string>();
  /** The user closed the Bot's active tab; its next tab-less action is told so once. */
  private activeClosedByUser = false;
  /** The user closed the last tab; actions say so until the Bot opens a page again. */
  private allClosedByUser = false;
  /** Tabs the running Bot action resolved (actions are serial, so one set at a time). */
  private acting: Set<string> | undefined;
  /** The tabs to reopen after the pages were closed to save memory. */
  private sleep: Sleep | undefined;
  private readonly dir: string;
  /** Last Bot action, input or overlay change (performance.now()), for least-recently-used. */
  lastUsed = performance.now();

  constructor(
    readonly botId: string,
    private readonly options: BotBrowserOptions,
    private readonly identity: BrowserIdentity,
    private readonly pool: BrowserPool,
    readonly groupId?: string,
  ) {
    const dir = options.profileDir(botId, groupId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    this.sleep = readSleep(dir);
    this.session = options.platform.sessionFromPath(dir);
    this.session.setUserAgent(identity.userAgent, identity.acceptLanguages);
    this.privateTransport = new PrivateNetworkTransport(this.session, options.privateNetworkDial);
    this.recording = new Recording(
      (event) => options.onRecord?.(botId, event),
      (index) => this.keyframes?.note(index),
    );
    this.removeHeaders = installBrowserHeaders.call(this.operationContext());
    this.removeRules = installBrowserRules.call(this.operationContext());
    this.downloads = installBrowserDownloads.call(this.operationContext());
  }

  get open() {
    return this.tabs.size > 0;
  }
  /** Pages closed to save memory, with tabs to reopen on the next use. */
  get sleeping() {
    return !this.tabs.size && !!this.sleep;
  }
  /** The remembered current tab's address (else the first), the page a Bot action resumes. */
  get sleepingUrl() {
    const sleep = this.sleeping ? this.sleep : undefined;
    if (!sleep) return undefined;
    return (sleep.tabs.find((tab) => tab.id === sleep.active) ?? sleep.tabs[0])?.url;
  }
  get busy() {
    return !!this.cast || this.takeover || this.recording.active;
  }
  get viewing() {
    return !!this.cast;
  }
  get recordingActive() {
    return this.recording.active;
  }
  /** The tab the overlay shows and takeover input goes to. */
  get shownTab() {
    return this.viewed && this.tabs.has(this.viewed) ? this.viewed : this.active;
  }
  get tabCount() {
    return this.tabs.size;
  }
  /** Pages can be closed for another Bot without breaking anything the user or Bot is doing. */
  get evictable() {
    return this.tabs.size > 0 && this.running === 0 && !this.busy;
  }

  /** Firefox on Google's hosts while the user's switch is on, else the ordinary Chromium identity. */
  userAgentFor(url: string) {
    return userAgentForStep.call(this.operationContext(), url);
  }

  /**
   * Reads the engine's client hints once, from a secure page, while the switch is on, so a
   * popup opened later has them at hand synchronously. Nothing is read with the switch off.
   */
  private learnUserAgentMetadata(tab: BotTab, url: string) {
    return learnUserAgentMetadataStep.call(this.operationContext(), tab, url);
  }

  /**
   * The switch changed while pages are open. Tabs on Google load again under the new
   * identity at once; a tab on the refusal page goes back into the sign-in it came from.
   */
  private reloadGoogleTabs() {
    return reloadGoogleTabsStep.call(this.operationContext());
  }

  assertRun(runId?: string) {
    if (runId !== this.activeRunId) throw busy("browser_resource_busy");
  }
  configure(rules: BrowserRules, runId?: string) {
    return configureStep.call(this.operationContext(), rules, runId);
  }
  private configureRules(rules: BrowserRules) {
    return configureRulesStep.call(this.operationContext(), rules);
  }

  /** Serialized Bot action; refused during user takeover (the Bot waits for hand-back). */
  run<T>(action: () => Promise<T>, runId?: string): Promise<T> {
    this.assertRun(runId);
    if (this.disposed) return Promise.reject(new RpcError(RpcErrorCodes.closed, "browser_closed"));
    if (this.takeover) return Promise.reject(busy("browser_takeover"));
    if (!this.rules)
      return Promise.reject(new RpcError(RpcErrorCodes.invalidParams, "browser_not_configured"));
    // A Bot action on sleeping pages reopens them first and carries on, instead of
    // asking the model to open its pages again. Not into a recording: teaching starts from the
    // address the user typed, and the old pages would become its first steps.
    return this.serial(async () => {
      this.assertRun(runId);
      if (this.sleeping && !this.recording.active) await this.restore();
      this.assertRun(runId);
      return action();
    });
  }

  readTemporary(input: { runId: string; operationId: string; url: string; maxChars: number }) {
    return temporaryReadStep.call(this.operationContext(), input);
  }

  cancelTemporary(runId: string, operationId: string) {
    this.assertRun(runId);
    const read = this.temporaryReads.get(operationId);
    if (read?.runId === runId)
      read.controller.abort(new RpcError(RpcErrorCodes.closed, "browser_cancelled"));
  }

  /** The user clicked the sleeping view, a sleeping tab or took over. */
  async wake() {
    if (!this.sleeping) return;
    if (!this.rules) throw new RpcError(RpcErrorCodes.invalidParams, "browser_not_configured");
    await this.serial(() => this.restore(true));
  }

  /**
   * Reopens the remembered tabs in their order, the remembered current one active again. They
   * load under the current rules like any page: private / unlisted addresses stay refused and
   * show the notice page. Only an explicit user wake consents to restoring the remembered sites;
   * an agent's first action in a new run must use that run's site approvals.
   */
  private restore(userInitiated = false) {
    return restoreStep.call(this.operationContext(), userInitiated);
  }

  userDebug<T>(action: () => Promise<T>, options: { readOnly?: boolean } = {}) {
    return this.serial(async () => {
      // Reading buffered diagnostics does not interact with the user's takeover window.
      if ((this.takeover && !options.readOnly) || this.recording.active)
        throw busy("browser_takeover");
      return action();
    });
  }

  /** User explicitly requested a saved account fill; no Bot run authorization is enlarged. */
  userCredentialFill<T>(action: () => Promise<T>) {
    return this.serial(async () => {
      if (!this.takeover || this.recording.active) throw busy("browser_not_taken_over");
      return action();
    });
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.running++;
      this.touch();
      const acting = new Set<string>();
      this.acting = acting;
      // Whatever the action's own error (or result), a tab the user closed under it is
      // the cause the Bot needs to hear, so it changes course instead of retrying blindly.
      const closedUnder = () => {
        if (![...acting].some((id) => this.userClosed.has(id))) return false;
        // Told now; the next action should not hear about the same close again.
        this.activeClosedByUser = false;
        return true;
      };
      try {
        const result = await action();
        if (closedUnder()) throw closedByUser();
        return result;
      } catch (error) {
        throw closedUnder() ? closedByUser() : error;
      } finally {
        this.acting = undefined;
        this.running--;
      }
    });
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next.finally(() => this.touch());
  }

  tab(id?: string) {
    return tabStep.call(this.operationContext(), id);
  }

  newTab(options: { user?: boolean } = {}): Promise<BotTab> {
    return newTabStep.call(this.operationContext(), options);
  }

  /**
   * A page asks for a new window (window.open, target=_blank). One that keeps its opener becomes a
   * real popup, adopted as a tab in popupCreated, so `window.opener.postMessage` and the popup's
   * own `window.close()` work (OAuth sign-in popups depend on both). Also `about:blank`, which
   * sign-in libraries open first and point at the provider once they know the address. A popup
   * that gave up its opener, and any popup once the tab limit is reached, opens as before: a new
   * tab loading the address (none for other schemes). The site rules apply either way: the
   * popup's first navigation passes will-navigate and the session's webRequest like any other.
   */
  private windowOpen(url: string, opener: boolean) {
    return windowOpenStep.call(this.operationContext(), url, opener);
  }

  /** The popup windowOpen allowed: a tab like any other, remembering which tab opened it. */
  private adoptPopup(window: BrowserWindow, openerId: string, url: string) {
    return adoptPopupStep.call(this.operationContext(), window, openerId, url);
  }

  private createTab(openerId?: string): BotTab {
    return createTabStep.call(this.operationContext(), openerId);
  }

  /**
   * The rest of a tab's setup; `opening` is open() / adopt() already called, whose window and
   * handlers exist synchronously, so the proxy login handler is there before the first request.
   */
  private startTab(tab: BotTab, opening: Promise<void>): Promise<void> {
    return startTabStep.call(this.operationContext(), tab, opening);
  }

  private showNewTab(id: string, user: boolean): void {
    showNewTabStep.call(this.operationContext(), id, user);
  }

  private tabEvents(id: string, tab: () => BotTab): TabEvents {
    return tabEventsStep.call(this.operationContext(), id, tab);
  }

  openUrl(url: string, newTab: boolean, mark?: Mark): Promise<BotTab> {
    return openUrlStep.call(this.operationContext(), url, newTab, mark);
  }

  userOpen(url: string): Promise<BrowserPage> {
    return userOpenStep.call(this.operationContext(), url);
  }

  closeTab(id: string) {
    return closeTabStep.call(this.operationContext(), id);
  }

  /**
   * The user closed a tab from the strip, any time and without waiting for the Bot's
   * queue (the in-flight action fails, see serial()). The last tab closes the Bot's pages. While
   * teaching, the last tab stays: the recording has nowhere else to go, so the user ends the
   * recording first (the overlay says so).
   */
  userCloseTab(id: string) {
    return userCloseTabStep.call(this.operationContext(), id);
  }

  private allowNavigation(url: string, tabId?: string) {
    return allowNavigationStep.call(this.operationContext(), url, tabId);
  }

  /** Allows form submission on the current page only when policy already approved its site. */
  armSubmit(tab: BotTab) {
    return armSubmitStep.call(this.operationContext(), tab);
  }

  page(tab: BotTab): BrowserPage {
    return pageStep.call(this.operationContext(), tab);
  }

  tabList() {
    return tabListStep.call(this.operationContext());
  }

  downloadList() {
    return downloadListStep.call(this.operationContext());
  }

  /** `window: false` keeps the page hidden instead of the takeover window. */
  setTakeover(on: boolean, window = true) {
    return setTakeoverStep.call(this.operationContext(), on, window);
  }

  /** "show window" in the app during a takeover; brings the window back to the front. */
  showWindow() {
    return showWindowStep.call(this.operationContext());
  }

  /**
   * During a takeover the shown tab is a real desktop window and follows tab switches like
   * the overlay stream does; otherwise every tab is a hidden background window. The next window
   * opens before the previous one hides, so focus moves between them instead of leaving the app.
   */
  private syncWindow(): void {
    syncWindowStep.call(this.operationContext());
  }

  /**
   * Overlay input; only while the user has taken over (teaching runs under takeover too),
   * and only to the tab the overlay shows. Input still on its way to a tab that went away or
   * stopped being shown (a sign-in popup closing itself, a tab switch) is dropped, never sent to
   * whatever tab is shown now: its coordinates and keys were meant for the other page. The
   * overlay moves to the shown tab on its next frame. Returns false when dropped.
   */
  input(tabId: string, event: HostBrowserInputEvent) {
    return inputStep.call(this.operationContext(), tabId, event);
  }

  private dropInput(tabId: string, reason: "tab_closed" | "tab_not_shown"): void {
    dropInputStep.call(this.operationContext(), tabId, reason);
  }

  /** Overlay tab strip. Outside takeover only the view changes, not the Bot's active tab. */
  switchView(id: string): void {
    switchViewStep.call(this.operationContext(), id);
  }

  /**
   * The address bar, back, forward and reload (during takeover and at any other time).
   * The user's own address is not asked about (it is theirs, like takeover) but the host rules
   * still apply: private addresses and the only-allowed list are refused with the notice page.
   * While the Bot is acting on that tab, a typed address opens in a new tab instead of pulling
   * the page away. Returns the tab the page opens in.
   */
  userNavigate(tabId: string, action: "url" | "back" | "forward" | "reload", url?: string) {
    return userNavigateStep.call(this.operationContext(), tabId, action, url);
  }

  /** "+" in the tab strip; a blank page the user then types an address into. */
  userNewTab() {
    return userNewTabStep.call(this.operationContext());
  }

  viewTabs() {
    return viewTabsStep.call(this.operationContext());
  }

  /**
   * Overlay frames. The stream follows the shown tab across Bot tab changes and pauses
   * while no page is open (it resumes with the next one); only the returned stop ends it.
   */
  startScreencast(onFrame: (frame: BrowserFrame) => void) {
    return startScreencastStep.call(this.operationContext(), onFrame);
  }

  /**
   * Fits the page to the overlay box: the viewport keeps its desktop width and takes the
   * box's aspect ratio as height (bounded), so the frame fills the box instead of leaving bands;
   * the screencast resolution follows the box's device pixels within a per-frame pixel budget.
   */
  setDisplay(box: Parameters<typeof fitDisplay>[0] | undefined): void {
    setDisplayStep.call(this.operationContext(), box);
  }

  private recast(): void {
    recastStep.call(this.operationContext());
  }

  /** An automatic login fill is never part of a recording. */
  muteRecording() {
    return muteRecordingStep.call(this.operationContext());
  }

  startRecording(recordingId?: string) {
    return startRecordingStep.call(this.operationContext(), recordingId);
  }

  stopRecording() {
    return stopRecordingStep.call(this.operationContext());
  }

  /** The live step list and the sign-in pause. */
  readRecording(after: number) {
    return readRecordingStep.call(this.operationContext(), after);
  }
  pauseRecording(paused: boolean) {
    return pauseRecordingStep.call(this.operationContext(), paused);
  }

  private report(entry: BrowserBlocked): void {
    reportStep.call(this.operationContext(), entry);
  }

  /** Idle close: page processes go after the idle window; session data stays on disk. */
  private touch(): void {
    touchStep.call(this.operationContext());
  }

  /**
   * Wipes this Bot's profile: cookies, local storage, IndexedDB, cache, HTTP auth. Pages close
   * first, after any in-flight Bot action; the session object and proxy settings stay.
   */
  clearData(): Promise<void> {
    return clearDataStep.call(this.operationContext());
  }

  /** A different run cannot inherit requests/downloads started with the old run's rules. */
  handoff(runId: string, temporary = false): Promise<void> {
    for (const read of this.temporaryReads.values()) read.controller.abort();
    return handoffStep.call(this.operationContext(), runId, temporary);
  }
  quiesce(runId: string): Promise<void> {
    for (const read of this.temporaryReads.values())
      if (read.runId === runId) read.controller.abort();
    return quiesceStep.call(this.operationContext(), runId);
  }

  /** Closes pages after any in-flight action (brain-requested release). */
  release(): Promise<void> {
    return releaseStep.call(this.operationContext());
  }

  /**
   * `remember` (idle, page-limit eviction, brain gone) keeps the tab list to reopen;
   * `forget` (the user closed them, data cleared) drops it; `keep` leaves a saved list alone.
   */
  closePages(mode: "remember" | "forget" | "keep" = "keep"): void {
    closePagesStep.call(this.operationContext(), mode);
  }

  /** `remember`: the brain went away (standby, restart), so the pages come back on next use. */
  dispose(mode: "remember" | "keep" = "keep"): void {
    for (const read of this.temporaryReads.values()) read.controller.abort();
    disposeStep.call(this.operationContext(), mode);
  }

  // Keep live access to private state: an awaited step must observe later cancellation and scope changes.
  private operationContext() {
    const owner = this;
    return {
      owner,
      temporaryTabs: owner.temporaryTabs,
      temporaryBlocked: owner.temporaryBlocked,
      temporaryReads: owner.temporaryReads,
      get acting() {
        return owner.acting;
      },
      set acting(value: BotBrowser["acting"]) {
        owner.acting = value;
      },
      get active() {
        return owner.active;
      },
      set active(value: BotBrowser["active"]) {
        owner.active = value;
      },
      get activeClosedByUser() {
        return owner.activeClosedByUser;
      },
      set activeClosedByUser(value: BotBrowser["activeClosedByUser"]) {
        owner.activeClosedByUser = value;
      },
      get activeRunId() {
        return owner.activeRunId;
      },
      set activeRunId(value: BotBrowser["activeRunId"]) {
        owner.activeRunId = value;
      },
      adoptPopup: owner.adoptPopup.bind(owner),
      get allClosedByUser() {
        return owner.allClosedByUser;
      },
      set allClosedByUser(value: BotBrowser["allClosedByUser"]) {
        owner.allClosedByUser = value;
      },
      allowNavigation: owner.allowNavigation.bind(owner),
      get announced() {
        return owner.announced;
      },
      set announced(value: BotBrowser["announced"]) {
        owner.announced = value;
      },
      armSubmit: owner.armSubmit.bind(owner),
      get blocked() {
        return owner.blocked;
      },
      set blocked(value: BotBrowser["blocked"]) {
        owner.blocked = value;
      },
      get botId() {
        return owner.botId;
      },
      get busy() {
        return owner.busy;
      },
      get cast() {
        return owner.cast;
      },
      set cast(value: BotBrowser["cast"]) {
        owner.cast = value;
      },
      closePages: owner.closePages.bind(owner),
      closeTab: owner.closeTab.bind(owner),
      createTab: owner.createTab.bind(owner),
      get dir() {
        return owner.dir;
      },
      get display() {
        return owner.display;
      },
      set display(value: BotBrowser["display"]) {
        owner.display = value;
      },
      get disposed() {
        return owner.disposed;
      },
      set disposed(value: BotBrowser["disposed"]) {
        owner.disposed = value;
      },
      get downloads() {
        return owner.downloads;
      },
      dropInput: owner.dropInput.bind(owner),
      get droppedInputTab() {
        return owner.droppedInputTab;
      },
      set droppedInputTab(value: BotBrowser["droppedInputTab"]) {
        owner.droppedInputTab = value;
      },
      get handover() {
        return owner.handover;
      },
      set handover(value: BotBrowser["handover"]) {
        owner.handover = value;
      },
      get identity() {
        return owner.identity;
      },
      get idleTimer() {
        return owner.idleTimer;
      },
      set idleTimer(value: BotBrowser["idleTimer"]) {
        owner.idleTimer = value;
      },
      get keyframes() {
        return owner.keyframes;
      },
      set keyframes(value: BotBrowser["keyframes"]) {
        owner.keyframes = value;
      },
      get lastUsed() {
        return owner.lastUsed;
      },
      set lastUsed(value: BotBrowser["lastUsed"]) {
        owner.lastUsed = value;
      },
      learnUserAgentMetadata: owner.learnUserAgentMetadata.bind(owner),
      newTab: owner.newTab.bind(owner),
      get nextTab() {
        return owner.nextTab;
      },
      set nextTab(value: BotBrowser["nextTab"]) {
        owner.nextTab = value;
      },
      get opened() {
        return owner.opened;
      },
      get options() {
        return owner.options;
      },
      get pool() {
        return owner.pool;
      },
      get presented() {
        return owner.presented;
      },
      set presented(value: BotBrowser["presented"]) {
        owner.presented = value;
      },
      recast: owner.recast.bind(owner),
      get recording() {
        return owner.recording;
      },
      get removeHeaders() {
        return owner.removeHeaders;
      },
      get removeRules() {
        return owner.removeRules;
      },
      report: owner.report.bind(owner),
      get rules() {
        return owner.rules;
      },
      set rules(value: BotBrowser["rules"]) {
        owner.rules = value;
      },
      get running() {
        return owner.running;
      },
      set running(value: BotBrowser["running"]) {
        owner.running = value;
      },
      serial: owner.serial.bind(owner),
      get privateTransport() {
        return owner.privateTransport;
      },
      get session() {
        return owner.session;
      },
      setDisplay: owner.setDisplay.bind(owner),
      showNewTab: owner.showNewTab.bind(owner),
      get shownTab() {
        return owner.shownTab;
      },
      get sleep() {
        return owner.sleep;
      },
      set sleep(value: BotBrowser["sleep"]) {
        owner.sleep = value;
      },
      get sleeping() {
        return owner.sleeping;
      },
      startTab: owner.startTab.bind(owner),
      syncWindow: owner.syncWindow.bind(owner),
      tab: owner.tab.bind(owner),
      tabEvents: owner.tabEvents.bind(owner),
      get tabs() {
        return owner.tabs;
      },
      get takeover() {
        return owner.takeover;
      },
      set takeover(value: BotBrowser["takeover"]) {
        owner.takeover = value;
      },
      touch: owner.touch.bind(owner),
      userAgentFor: owner.userAgentFor.bind(owner),
      get userAgentMetadata() {
        return owner.userAgentMetadata;
      },
      set userAgentMetadata(value: BotBrowser["userAgentMetadata"]) {
        owner.userAgentMetadata = value;
      },
      get userClosed() {
        return owner.userClosed;
      },
      get viewed() {
        return owner.viewed;
      },
      set viewed(value: BotBrowser["viewed"]) {
        owner.viewed = value;
      },
      windowOpen: owner.windowOpen.bind(owner),
      get windowed() {
        return owner.windowed;
      },
      set windowed(value: BotBrowser["windowed"]) {
        owner.windowed = value;
      },
      get firefox() {
        return owner.firefox;
      },
      get readingMetadata() {
        return owner.readingMetadata;
      },
      set readingMetadata(value: BotBrowser["readingMetadata"]) {
        owner.readingMetadata = value;
      },
      assertRun: owner.assertRun.bind(owner),
      configureRules: owner.configureRules.bind(owner),
      reloadGoogleTabs: owner.reloadGoogleTabs.bind(owner),
      get proxyKey() {
        return owner.proxyKey;
      },
      set proxyKey(value: BotBrowser["proxyKey"]) {
        owner.proxyKey = value;
      },
      page: owner.page.bind(owner),
      openUrl: owner.openUrl.bind(owner),
    };
  }
}
