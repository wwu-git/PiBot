import {
  type BrowserPage,
  type BrowserRules,
  browserBlockedReason,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import type { BotBrowserOperations } from "../bot-browser.ts";
import {
  googleRetryUrl,
  isGoogleCompatHost,
  readUserAgentMetadata,
} from "../login/google-compat.ts";
import {
  approvedPrivateOrigin,
  listedHost,
  localWorkplaceFile,
  ownLocalService,
} from "../network.ts";
import type { Mark } from "../page/phases.ts";
import { writeSleep } from "../sleep.ts";
import type { BotTab } from "../tab.ts";
import { busy, domainOf } from "./bot-browser-shared.ts";

/** Firefox on Google's hosts while the user's switch is on, else the ordinary Chromium identity. */
export function userAgentForStep(this: BotBrowserOperations, url: string) {
  return this.rules?.googleCompat && isGoogleCompatHost(url)
    ? this.firefox
    : this.identity.userAgent;
}

/**
 * Reads the engine's client hints once, from a secure page, while the switch is on, so a
 * popup opened later has them at hand synchronously. Nothing is read with the switch off.
 */
export function learnUserAgentMetadataStep(this: BotBrowserOperations, tab: BotTab, url: string) {
  if (this.userAgentMetadata || this.readingMetadata) return;
  if (!this.rules?.googleCompat || !/^https:/i.test(url) || !tab.ownClientHints) return;
  this.readingMetadata = true;
  void Promise.resolve()
    .then(() => readUserAgentMetadata(tab.control))
    .then(
      (metadata) => {
        this.userAgentMetadata ??= metadata;
      },
      () => {
        // Navigated away or closed mid-read; the next secure page tries again.
      },
    )
    .finally(() => {
      this.readingMetadata = false;
    });
}

/**
 * The switch changed while pages are open. Tabs on Google load again under the new
 * identity at once; a tab on the refusal page goes back into the sign-in it came from.
 */
export function reloadGoogleTabsStep(this: BotBrowserOperations) {
  for (const tab of this.tabs.values()) {
    const url = tab.url;
    if (!isGoogleCompatHost(url)) continue;
    const target = browserBlockedReason(url) ? googleRetryUrl(url) : url;
    // The user's own action (they turned the switch on), like their address bar: no
    // site question, which would otherwise refuse Google pages the Bot never opened itself.
    const domain = domainOf(target);
    this.opened.add(domain);
    this.options.logger.info(
      `audit browser.user_navigate botId=${this.botId} action=reload reason=google_compat domain=${domain}`,
    );
    void tab.navigate(target, 20_000).catch(() => {
      this.options.logger.warn(`browser google compat reload failed botId=${this.botId}`);
    });
  }
}

export async function configureStep(
  this: BotBrowserOperations,
  rules: BrowserRules,
  runId?: string,
) {
  this.assertRun(runId);
  if (rules.runId !== runId) throw busy("browser_resource_busy");
  await this.serial(async () => {
    this.assertRun(runId);
    await this.configureRules(rules);
  });
}

export async function configureRulesStep(this: BotBrowserOperations, rules: BrowserRules) {
  const compatChanged = (this.rules?.googleCompat ?? false) !== (rules.googleCompat ?? false);
  this.rules = rules;
  if (compatChanged) this.reloadGoogleTabs();
  if (rules.googleCompat)
    for (const tab of this.tabs.values()) this.learnUserAgentMetadata(tab, tab.url);
  // Grant removal and run handoff must also retire authenticated tunnels, even in direct mode.
  const key = JSON.stringify([rules.runId, rules.proxy, rules.localPorts, rules.privateOrigins]);
  if (key !== this.proxyKey) {
    await this.privateTransport.configure(rules);
    this.proxyKey = key;
  } else {
    // A new rules object still owns the same run's route; refresh the transport's rule binding.
    this.privateTransport.rebind(rules);
  }
}

/**
 * Reopens the remembered tabs in their order, the remembered current one active again. They
 * load under the current rules like any page: private / unlisted addresses stay refused and
 * show the notice page. Only an explicit user wake consents to restoring the remembered sites;
 * an agent's first action in a new run must use that run's site approvals.
 */
export async function restoreStep(this: BotBrowserOperations, userInitiated = false) {
  const sleep = this.sleep;
  if (!sleep || this.tabs.size) return;
  const opened: { tab: BotTab; url: string }[] = [];
  let active: string | undefined;
  for (const entry of sleep.tabs) {
    const domain = domainOf(entry.url);
    if (userInitiated && domain) this.opened.add(domain);
    // The first page may be refused (page limit): the list then stays for later.
    const tab = await this.newTab();
    if (this.sleep === sleep) {
      this.sleep = undefined;
      writeSleep(this.dir, undefined);
    }
    opened.push({ tab, url: entry.url });
    if (entry.id === sleep.active) active = tab.id;
  }
  if (active && this.tabs.has(active)) {
    this.active = active;
    this.viewed = undefined;
    this.recast();
  }
  // In parallel: one slow site should not hold the others.
  await Promise.all(opened.map(({ tab, url }) => tab.navigate(url, 15_000).catch(() => {})));
}

export async function openUrlStep(
  this: BotBrowserOperations,
  url: string,
  newTab: boolean,
  mark?: Mark,
) {
  const domain = domainOf(url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RpcError(RpcErrorCodes.invalidParams, "browser_unsupported_url");
  }
  const localFile = localWorkplaceFile(this.rules, parsed);
  if ((!/^https?:\/\//i.test(url) && !localFile) || (!domain && !localFile))
    throw new RpcError(RpcErrorCodes.invalidParams, "browser_unsupported_url");
  if (domain) this.opened.add(domain);
  // Opening an address is the Bot's own new course after a user close.
  this.activeClosedByUser = false;
  this.allClosedByUser = false;
  const tab = newTab || !this.active ? await this.newTab() : this.tab();
  mark?.("tab");
  this.acting?.add(tab.id);
  if (this.active !== tab.id) {
    this.active = tab.id;
    this.recast();
  }
  await tab.navigate(url, undefined, mark);
  return tab;
}

export function userOpenStep(this: BotBrowserOperations, url: string): Promise<BrowserPage> {
  if (this.disposed) throw new RpcError(RpcErrorCodes.closed, "browser_closed");
  return this.serial(async () => {
    if (!this.rules) throw busy("browser_resource_busy");
    return this.page(await this.openUrl(url, true));
  });
}

export function allowNavigationStep(this: BotBrowserOperations, url: string, tabId?: string) {
  const domain = domainOf(url);
  if (!domain || !/^https?:/i.test(url) || !this.rules) return true; // webRequest decides.
  if (ownLocalService(this.rules, url)) return true; // Own local service, same rule as webRequest.
  // An allowed local-network origin was approved by its own card (maintainers 2026-11-14).
  if (approvedPrivateOrigin(this.rules, new URL(url))) return true;
  const entry = { url: url.slice(0, 4096), domain };
  const report: BotBrowserOperations["report"] = (blocked) => {
    if (tabId && this.temporaryTabs.has(tabId)) this.temporaryBlocked.set(tabId, [blocked]);
    else this.report(blocked);
  };
  if (this.rules.allowList && !listedHost(this.rules.allowList, domain)) {
    report({ kind: "not_listed", ...entry });
    return false;
  }
  // Same as the session rules: a recording is the user's browsing (see installBrowserRules).
  if (this.takeover || this.recording.active || this.opened.has(domain)) return true;
  if (this.options.guard.site(this.botId, { domain, url }, this.rules)) return true;
  report({ kind: "site", ...entry });
  return false;
}

/** Allows form submission on the current page only when policy already approved its site. */
export async function armSubmitStep(this: BotBrowserOperations, tab: BotTab) {
  const domain = domainOf(tab.url);
  // The Bot's own loopback service is approved for visits and submissions alike (network
  // and navigation already pass it); without this its forms stayed blocked even for the Bot.
  const allow =
    this.takeover ||
    (!!this.rules && ownLocalService(this.rules, tab.url)) ||
    (!!domain &&
      !!this.rules &&
      this.options.guard.submit(this.botId, { domain, url: tab.url }, this.rules));
  await tab.setSubmitMode(allow).catch(() => {
    // about:blank and error pages have no guard world; nothing can be submitted there.
  });
}

export function pageStep(this: BotBrowserOperations, tab: BotTab): BrowserPage {
  const blocked = this.blocked;
  this.blocked = [];
  const blockedReason = browserBlockedReason(tab.url);
  return {
    tab: tab.id,
    url: tab.url.slice(0, 8192),
    title: tab.title.slice(0, 1000),
    loading: tab.loading,
    ...(tab.lastError ? { error: tab.lastError } : {}),
    blocked,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export function tabListStep(this: BotBrowserOperations) {
  return [...this.tabs.values()]
    .filter((tab) => !this.temporaryTabs.has(tab.id))
    .map((tab) => ({
      tab: tab.id,
      url: tab.url.slice(0, 8192),
      title: tab.title.slice(0, 1000),
      active: tab.id === this.active,
    }));
}

export function downloadListStep(this: BotBrowserOperations) {
  return this.downloads.list();
}
