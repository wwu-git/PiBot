import type { BotBrowserOperations } from "../bot-browser.ts";
import { installDownloads } from "../downloads.ts";
import { installGoogleCompatHeaders } from "../login/google-compat.ts";
import { installSessionRules } from "../network.ts";
import { noticePage } from "../page/notice-page.ts";
import { domainOf } from "./bot-browser-shared.ts";

export function installBrowserHeaders(this: BotBrowserOperations) {
  return installGoogleCompatHeaders(
    this.session,
    {
      forUrl: (url) => this.userAgentFor(url),
      ofContents: (id) => {
        for (const tab of this.tabs.values())
          if (tab.contentsId === id) return tab.presentedUserAgent;
        return undefined;
      },
    },
    this.firefox,
  );
}

export function installBrowserRules(this: BotBrowserOperations) {
  const { options, botId } = this;
  return installSessionRules(
    this.session,
    {
      rules: () => this.rules,
      privateRoute: (rules, url) => this.privateTransport.routes(rules, url),
      // A recording is the user's own browsing from its first page on (teach opens that page just
      // before taking over); a Bot cannot act meanwhile, handoff refuses while recording.
      takeover: () => this.takeover || this.recording.active,
      site: (domain, url) =>
        this.opened.has(domain) ||
        (!!this.rules && options.guard.site(botId, { domain, url }, this.rules)),
      submit: (domain, url) =>
        !!this.rules && options.guard.submit(botId, { domain, url }, this.rules),
      blocked: (entry, contentsId, mainFrame) => {
        const temporary = [...this.tabs.values()].find(
          (tab) => this.temporaryTabs.has(tab.id) && tab.contentsId === contentsId,
        );
        if (temporary) {
          // Child frames cannot consume another tab's report or fail an otherwise readable page.
          if (mainFrame) this.temporaryBlocked.set(temporary.id, [entry]);
        } else this.report(entry);
        if (contentsId === undefined || (temporary && !mainFrame)) return;
        // A private target unloads the page that reached it (also a private peer seen after DNS,
        // i.e. rebinding); a refused top-level page says why instead of staying blank.
        const kind =
          entry.kind === "private"
            ? "private"
            : entry.kind === "not_listed" && mainFrame
              ? "not_listed"
              : undefined;
        if (!kind) return;
        const html = noticePage(kind, { host: entry.domain ?? domainOf(entry.url) });
        for (const tab of this.tabs.values()) {
          try {
            if (tab.contents.id === contentsId) void tab.showNotice(html).catch(() => {});
          } catch {
            // A tab destroyed meanwhile has nothing left to unload.
          }
        }
      },
      dropped: (reason) =>
        options.logger.warn(
          `browser page load cancelled botId=${botId} reason=${reason} takeover=${this.takeover} recording=${this.recording.active}`,
        ),
    },
    options.platform.address,
  );
}

export function installBrowserDownloads(this: BotBrowserOperations) {
  const { options, botId } = this;
  return installDownloads(this.session, {
    rules: () => this.rules,
    ownsSource: (id) =>
      [...this.tabs.values()].some(
        (tab) => !this.temporaryTabs.has(tab.id) && tab.contentsId === id,
      ),
    blocked: (url) =>
      this.report({
        kind: "download",
        url: url.slice(0, 4096),
        domain: domainOf(url) || undefined,
      }),
    saved: (entry) => {
      options.logger.info(`audit browser.download botId=${botId} bytes=${entry.receivedBytes}`);
      this.recording.add({
        kind: "download",
        tab: this.active ?? "t1",
        at: Date.now(),
        filename: entry.filename,
      });
    },
    failed: () => options.logger.warn(`browser download setup failed botId=${botId}`),
  });
}
