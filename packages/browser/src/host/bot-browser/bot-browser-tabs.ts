import { RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { BotBrowserOperations } from "../bot-browser.ts";
import { proxyCredentials } from "../network.ts";
import { noticePage } from "../page/notice-page.ts";
import type { BrowserWindow } from "../platform.ts";
import { writeSleep } from "../sleep.ts";
import { BotTab, type TabEvents } from "../tab.ts";
import { busy, closedByUser, domainOf, MAX_TABS, MAX_USER_CLOSED } from "./bot-browser-shared.ts";

export function tabStep(this: BotBrowserOperations, id?: string) {
  if (id !== undefined && this.userClosed.has(id)) throw closedByUser();
  if (id === undefined && this.activeClosedByUser) {
    // Once: acting on whichever tab became active would hit refs from another page.
    this.activeClosedByUser = false;
    throw closedByUser();
  }
  if (!this.tabs.size) {
    if (this.allClosedByUser) throw closedByUser();
    // Pages closed for idleness or for another Bot: the session is intact, open again.
    throw new RpcError(RpcErrorCodes.invalidParams, "browser_pages_closed_open_again");
  }
  const tab = this.tabs.get(id ?? this.active ?? "");
  if (!tab) throw new RpcError(RpcErrorCodes.invalidParams, "browser_tab_not_found");
  this.acting?.add(tab.id);
  return tab;
}

export async function newTabStep(this: BotBrowserOperations, options: { user?: boolean } = {}) {
  if (this.tabs.size >= MAX_TABS) throw busy("browser_tab_limit");
  // Synchronous up to tabs.set below, so two Bots opening at once both see each other.
  if (!this.tabs.size) this.pool.opening(this.owner);
  const tab = this.createTab();
  await this.startTab(tab, tab.open());
  this.showNewTab(tab.id, options.user === true);
  return tab;
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
export function windowOpenStep(this: BotBrowserOperations, url: string, opener: boolean) {
  const web = /^https?:/i.test(url);
  if (opener && (web || url === "about:blank") && !this.disposed && this.rules) {
    if (this.tabs.size < MAX_TABS) return true;
    this.options.logger.warn(`browser popup over tab limit botId=${this.botId}`);
  }
  if (web)
    void this.serial(async () => {
      const opened = await this.newTab();
      await opened.navigate(url, 10_000);
    }).catch(() => this.options.logger.warn(`browser popup tab failed botId=${this.botId}`));
  return false;
}

/** The popup windowOpen allowed: a tab like any other, remembering which tab opened it. */
export function adoptPopupStep(
  this: BotBrowserOperations,
  window: BrowserWindow,
  openerId: string,
  url: string,
) {
  // Created synchronously after windowOpen checked the room, unless the pages closed meanwhile.
  if (this.disposed || !this.tabs.has(openerId) || this.tabs.size >= MAX_TABS) {
    window.destroy();
    return;
  }
  const tab = this.createTab(openerId);
  void this.startTab(tab, tab.adopt(window, url)).then(
    () => {
      // Closed by its page while the debugger attached: nothing left to show.
      if (this.tabs.get(tab.id) === tab) this.showNewTab(tab.id, false);
    },
    () => this.options.logger.warn(`browser popup adopt failed botId=${this.botId}`),
  );
}

export function createTabStep(this: BotBrowserOperations, openerId?: string) {
  const id = `t${this.nextTab++}`;
  const tab: BotTab = new BotTab(
    this.options.platform,
    id,
    this.session,
    this.identity.userAgent,
    this.tabEvents(id, () => tab),
    openerId,
    {
      enabled: () => !!this.rules?.runId && !this.takeover && !this.recording.active,
      userEnabled: () => !this.recording.active,
      registerSecret: (value, handle) => this.options.registerSecret?.(value, handle),
      redact: (text) => this.options.redact?.(text) ?? "[redaction unavailable]",
    },
  );
  this.tabs.set(id, tab);
  return tab;
}

/**
 * The rest of a tab's setup; `opening` is open() / adopt() already called, whose window and
 * handlers exist synchronously, so the proxy login handler is there before the first request.
 */
export async function startTabStep(
  this: BotBrowserOperations,
  tab: BotTab,
  opening: Promise<void>,
): Promise<void> {
  try {
    tab.contents.on("login", (event, _details, authInfo, callback) => {
      event.preventDefault();
      const credentials =
        this.privateTransport.credentialsFor(authInfo) ??
        proxyCredentials(this.rules?.proxy ?? null);
      // Only our own proxy gets credentials; site HTTP auth is cancelled (logins via takeover).
      if (
        authInfo.isProxy &&
        credentials &&
        authInfo.host === credentials.host &&
        authInfo.port ===
          Number(credentials.port || (this.rules?.proxy?.url.startsWith("https:") ? 443 : 80))
      )
        callback(credentials.username, credentials.password);
      else callback();
    });
    tab.contents.on("render-process-gone", () => this.closeTab(tab.id));
    await opening;
    // Login capture world (only kept during takeover); see login.ts.
    await this.options.onTab?.(this.owner, tab);
    if (this.recording.active) await tab.startRecording();
  } catch (error) {
    this.closeTab(tab.id);
    throw error;
  }
  if (this.display) tab.setViewportHeight(this.display.viewportHeight);
}

export function showNewTabStep(this: BotBrowserOperations, id: string, user: boolean): void {
  if (user && this.running > 0) {
    // The user's tab while the Bot acts: shown, without moving the Bot off its tab.
    this.viewed = id;
  } else {
    this.active = id;
    // A tab the Bot opens is what the user wants to watch next.
    this.viewed = undefined;
  }
  this.recast();
  if (!this.announced) {
    this.announced = true;
    this.options.onActivity?.(this.botId, true);
  }
}

export function tabEventsStep(
  this: BotBrowserOperations,
  id: string,
  tab: () => BotTab,
): TabEvents {
  return {
    windowOpen: (url, opener) =>
      this.temporaryTabs.has(id) ? false : this.windowOpen(url, opener),
    popupCreated: (window, url) => this.adoptPopup(window, id, url),
    // The page closed its own window (an OAuth popup after posting to its opener).
    closed: () => this.closeTab(id),
    allowNavigation: (url) => this.allowNavigation(url, id),
    submitBlocked: ({ action }) =>
      this.report({
        kind: "submit",
        url: action.slice(0, 4096),
        domain: domainOf(action) || undefined,
      }),
    fileChooser: () => this.report({ kind: "upload", url: tab().url.slice(0, 4096) }),
    record: (payload) => this.recording.raw(id, payload),
    // An address that did not load leaves a blank error page; say so instead.
    loadFailed: (url, error, code) => {
      // Error name and site only: what to check on the user's machine (network, proxy, our own
      // refusal) without the address or anything from the page.
      this.options.logger.warn(
        `browser load failed botId=${this.botId} tab=${id} code=${code} error=${error} domain=${domainOf(url) || "-"} takeover=${this.takeover} recording=${this.recording.active} rules=${!!this.rules}`,
      );
      // -20 ERR_BLOCKED_BY_CLIENT is our own refusal; the blocked report explains it instead.
      if (code === -20 || !/^https?:/i.test(url)) return;
      void tab()
        .showNotice(noticePage("failed", { host: domainOf(url), error }))
        .catch(() => {
          this.options.logger.warn(`browser notice page failed botId=${this.botId} tab=${id}`);
        });
    },
    navigated: (url) => {
      this.learnUserAgentMetadata(tab(), url);
      this.recording.add({ kind: "navigate", tab: id, at: Date.now(), url: url.slice(0, 8192) });
      // A document loaded during takeover starts with its guard in "block"; the user's own
      // form posts (logins included) must go through like on the page they took over.
      if (this.takeover) void this.armSubmit(tab());
    },
    windowClosing: () => {
      if (this.pool.quitting()) return false;
      // The takeover goes on in the app's view; "show window" there brings it back.
      this.windowed = false;
      this.syncWindow();
      return true;
    },
    userAgentFor: (url) => this.userAgentFor(url),
    userAgentMetadata: () => this.userAgentMetadata,
  };
}

export function closeTabStep(this: BotBrowserOperations, id: string) {
  const tab = this.tabs.get(id);
  if (!tab) return;
  const shown = this.shownTab === id;
  this.tabs.delete(id);
  if (this.active === id)
    // A closed popup returns to the page that opened it, as in a browser.
    this.active =
      tab.openerId && this.tabs.has(tab.openerId)
        ? tab.openerId
        : [...this.tabs.keys()].filter((key) => !this.temporaryTabs.has(key)).at(-1);
  if (this.viewed === id) this.viewed = undefined;
  if (this.presented === id) {
    this.presented = undefined;
    // The next takeover window opens where this one was (the page may have closed it itself).
    this.handover = tab.windowBounds;
  }
  tab.close();
  if (shown) this.recast();
  if (!this.tabs.size && this.announced) {
    this.announced = false;
    this.options.onActivity?.(this.botId, false);
  }
}

/**
 * The user closed a tab from the strip, any time and without waiting for the Bot's
 * queue (the in-flight action fails, see serial()). The last tab closes the Bot's pages. While
 * teaching, the last tab stays: the recording has nowhere else to go, so the user ends the
 * recording first (the overlay says so).
 */
export function userCloseTabStep(this: BotBrowserOperations, id: string) {
  // A sleeping tab the user closes is not reopened.
  if (this.sleeping && this.sleep?.tabs.some((tab) => tab.id === id)) {
    const tabs = this.sleep.tabs.filter((tab) => tab.id !== id);
    this.sleep = tabs.length
      ? {
          ...this.sleep,
          tabs,
          active: this.sleep.active === id ? (tabs.at(-1)?.id ?? null) : this.sleep.active,
        }
      : undefined;
    writeSleep(this.dir, this.sleep);
    return;
  }
  if (!this.tabs.has(id)) throw new RpcError(RpcErrorCodes.invalidParams, "browser_tab_not_found");
  if (this.recording.active && this.tabs.size === 1) throw busy("browser_recording_last_tab");
  if (this.tabs.size === 1) {
    this.closePages("forget");
    this.allClosedByUser = true;
  } else {
    if (this.active === id) this.activeClosedByUser = true;
    this.closeTab(id);
  }
  this.userClosed.add(id);
  if (this.userClosed.size > MAX_USER_CLOSED)
    this.userClosed.delete(this.userClosed.values().next().value as string);
  this.touch();
}
