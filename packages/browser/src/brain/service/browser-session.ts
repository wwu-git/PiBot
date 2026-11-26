import { join } from "node:path";
import type {
  BrowserActionInput,
  BrowserEnvironment,
  BrowserRuleInput,
  BrowserRunScope,
} from "@pibot/brain/kit";
import {
  type BrowserPage,
  type BrowserRules,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import type { PolicyResult } from "@pibot/policy";
import { recordPolicyStep } from "@pibot/policy";
import { browserAction } from "./browser-actions.ts";
import { BrowserLeases } from "./browser-lease.ts";

interface RunState {
  botId: string;
  /** Sites the user allowed during this run (first visit asked once). */
  sites: Set<string>;
  /** Sites where the user confirmed a form submission during this run. */
  submitSites: Set<string>;
  /** The user allowed downloads into the primary folder during this run. */
  downloads: boolean;
  writeAllowed?: boolean;
  /** Last rules pushed to the host; a change re-sends them before the next action. */
  pushed?: string;
}

const STATUS_POLL_MS = 60_000;

/**
 * Brain-side bookkeeping for the per-Bot browsers in the background process.
 * The host enforces rules and never asks; this service turns policy and the user's answers into
 * `host.browser.configure` rules, tracks each Bot's current page for policy, and keeps brain out
 * of standby while a Bot still has pages open. The kernel retains this port until
 * runs drain; `dispose` then stops and drains the status poll.
 */
export class BrowserService {
  action(botId: string, input: BrowserActionInput, signal: AbortSignal, runId?: string) {
    const host = this.host;
    if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    return browserAction(host, botId, input, signal, runId);
  }
  private readonly groupSessions = new Map<string, BrowserService>();
  forGroup(groupId: string): BrowserService {
    let value = this.groupSessions.get(groupId);
    if (!value) {
      value = new BrowserService(this.local, groupId);
      value.onChange = (botId) => this.onChange?.(botId, groupId);
      this.groupSessions.set(groupId, value);
    }
    return value;
  }
  forContext(context: BrowserRunScope) {
    const groupId = this.local.scope(context);
    return groupId && this.groupId !== groupId ? this.forGroup(groupId) : this;
  }
  private readonly pages = new Map<string, string>();
  private readonly runs = new Map<string, RunState>();
  /** Bots that may still have pages in the host (used since the last confirmed release). */
  private readonly active = new Set<string>();
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private refreshing?: Promise<void>;
  private readonly updates = new Set<Promise<unknown>>();
  private failures = 0;
  /** Rules the host holds for each Bot. */
  private readonly lastRules = new Map<string, BrowserRules>();
  /** Hand-backs (overlay) not yet mentioned to the Bot; value is the current URL. */
  private readonly handedBack = new Map<string, string>();
  /** Addresses the user opened, not yet mentioned to the Bot. */
  private readonly opened = new Map<string, string>();
  /** Page changes feed the overlay's `browser.state` (side pane, "browser in use"). */
  onChange?: (botId: string, groupId?: string) => void;
  /** A hand-back may come with a login to offer saving (CredentialService). */
  onHandBack?: (botId: string) => void;

  private readonly leases: BrowserLeases;
  private readonly finishing = new Map<string, Promise<void>>();
  constructor(
    private readonly local: BrowserEnvironment,
    readonly groupId?: string,
  ) {
    this.leases = new BrowserLeases(local, groupId);
  }
  acquireRun(context: BrowserRunScope, signal: AbortSignal, temporary = false) {
    return this.leases.acquire(context, signal, temporary);
  }
  assertRun(context: BrowserRunScope) {
    this.leases.assert(context);
  }
  async drainedRun(botId: string, runId: string) {
    await Promise.all(
      [...this.groupSessions.values()].map((value) => value.drainedRun(botId, runId)),
    );
    await this.finishing.get(runId);
    this.leases.drained({ botId, runId });
    this.finishing.delete(runId);
  }

  get host() {
    const host = this.local.deps.host.browser;
    if (!host || !this.groupId) return host;
    const scoped: typeof host = {
      call: (method, params, signal) =>
        host.call(
          method,
          method === "host.browser.status"
            ? params
            : ({ ...params, groupId: this.groupId } as never),
          signal,
        ),
    };
    return scoped;
  }

  /** The current http(s) page of the Bot's browser, judged by policy for page actions. */
  pageUrl(botId: string): string | undefined {
    const url = this.pages.get(botId);
    return url && (/^https?:/i.test(url) || /^file:/i.test(url)) ? url : undefined;
  }

  /**
   * The page a page action is judged against. Pages that went to sleep (idle close, brain
   * standby) are not "no page": the host reopens them for the action, so policy judges the
   * remembered current tab, and the action carries on there.
   */
  async resolvePage(
    botId: string,
    signal: AbortSignal,
    runId?: string,
  ): Promise<string | undefined> {
    const known = this.pageUrl(botId);
    const host = this.host;
    if (known || !host) return known;
    let url: string | null;
    try {
      ({ url } = await host.call(
        "host.browser.sleeping",
        { botId, runId },
        AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      ));
    } catch {
      signal.throwIfAborted();
      // Without an answer there is no page to judge: the tool says "open a page first".
      this.local.deps.logger.warn(`Browser sleeping tabs unknown botId=${botId}`);
      return undefined;
    }
    if (url) this.observe(botId, { url });
    return this.pageUrl(botId);
  }

  observe(botId: string, page: Pick<BrowserPage, "url">) {
    this.pages.set(botId, page.url);
    this.active.add(botId);
    this.onChange?.(botId);
  }

  forgetPage(botId: string) {
    this.pages.delete(botId);
    this.onChange?.(botId);
  }
  cleared() {
    this.pages.clear();
    this.active.clear();
    this.lastRules.clear();
    this.handedBack.clear();
    this.opened.clear();
    for (const state of this.runs.values()) state.pushed = undefined;
    this.stopWatch();
  }

  /** The user handed the browser back; policy now judges the page they left it on. */
  handBack(botId: string, url: string) {
    if (url) this.observe(botId, { url });
    this.handedBack.set(botId, url);
    this.onHandBack?.(botId);
  }

  /** The URL of a hand-back the Bot has not been told about yet (cleared on read). */
  takeHandBack(botId: string) {
    const url = this.handedBack.get(botId);
    this.handedBack.delete(botId);
    return url;
  }

  private state(context: BrowserRunScope): RunState {
    let state = this.runs.get(context.runId);
    if (!state) {
      state = {
        botId: context.botId,
        sites: new Set(),
        submitSites: new Set(),
        downloads: false,
      };
      this.runs.set(context.runId, state);
    }
    return state;
  }

  /** A site already allowed in this run is not asked again for each page action. */
  allowApprovedSite(context: BrowserRunScope, result: PolicyResult) {
    if (
      result.decision === "ask" &&
      result.domain &&
      this.runs.get(context.runId)?.sites.has(result.domain)
    ) {
      result.decision = "allow";
      result.reason = "browser_site_approved";
      recordPolicyStep(result, "grant", "browser_site_approved");
    }
  }

  approveSite(context: BrowserRunScope, domain: string) {
    this.state(context).sites.add(domain);
  }
  approveSubmit(context: BrowserRunScope, domain: string) {
    this.state(context).submitSites.add(domain);
  }
  approveDownloads(context: BrowserRunScope) {
    this.state(context).downloads = true;
  }
  /** Whether write_file is already allowed for `<primary>/downloads` (checked once per run). */
  writeAllowed(context: BrowserRunScope): boolean | undefined {
    return this.runs.get(context.runId)?.writeAllowed;
  }
  setWriteAllowed(context: BrowserRunScope, allowed: boolean) {
    this.state(context).writeAllowed = allowed;
  }

  /**
   * Rules for this run: the network allowlist and proxy as configured,
   * sites = always level or remembered / run-approved domains, read roots for uploads, and
   * `<primary>/downloads` only when writing there is already allowed.
   */
  rules(
    context: BrowserRunScope,
    prepared: BrowserRuleInput,
    writeRoot: string | undefined,
    downloadsAllowed: boolean,
  ): BrowserRules {
    const state = this.state(context);
    const settings = prepared.settings;
    const grants = this.local.grants(context.botId, context);
    const remembered = grants.flatMap((grant) =>
      grant.category === "web" && grant.scope.kind === "domain" ? [grant.scope.domain] : [],
    );
    // "Always allow" submissions go to the host as well, so they are not refused and
    // retried each run; a subdomain of a remembered site is still asked once and then matched.
    const submitGrants = grants.flatMap((grant) =>
      grant.category === "web" && grant.scope.kind === "submit" ? [grant.scope.domain] : [],
    );
    const proxy = this.local.deps.proxy?.();
    return {
      runId: context.runId,
      allowList: settings.network.allowAll ? null : settings.network.domains,
      sites:
        settings.levels.web === "always"
          ? "all"
          : [...new Set([...remembered, ...state.sites])].slice(0, 1000),
      submitSites: [...new Set([...submitGrants, ...state.submitSites])].slice(0, 1000),
      proxy: proxy ? { url: proxy.url } : null,
      readRoots: (prepared.boundary?.readRoots ?? prepared.roots).slice(0, 202),
      blockedReadRoots: prepared.sensitiveReadRoots?.slice(0, 202),
      downloadsDir:
        writeRoot && (downloadsAllowed || state.downloads) ? join(writeRoot, "downloads") : null,
      localPorts: this.local.background.ports(context.botId, this.groupId, true),
      // Maintainers 2026-11-14: the local-network origins the user allowed in this run (each by card).
      privateOrigins: this.local.privateNetwork.origins(context.runId),
      googleCompat: this.googleCompat(context.botId),
      userBrowser: this.local.userBrowser.preferred(),
    };
  }

  temporaryRules(context: BrowserRunScope, prepared: BrowserRuleInput): BrowserRules {
    const current = this.lastRules.get(context.botId);
    const fresh = this.rules(context, prepared, undefined, false);
    if (current?.runId !== context.runId) return fresh;
    // Preserve the run's path/download fields, including future sensitive/local-file boundaries.
    // Only the newly judged network/site facts are refreshed for this derived visit.
    return {
      ...fresh,
      ...current,
      sites: fresh.sites,
      submitSites: fresh.submitSites,
      allowList: fresh.allowList,
      proxy: fresh.proxy,
      localPorts: fresh.localPorts,
      privateOrigins: fresh.privateOrigins,
      googleCompat: fresh.googleCompat,
    };
  }

  /** The user's own per-Bot switch, read from the Bot row each time rules are built. */
  googleCompatibility(botId: string) {
    return this.googleCompat(botId);
  }
  private googleCompat(botId: string) {
    return this.local.googleCompat.enabled(this.groupId ? { groupId: this.groupId } : { botId });
  }
  async refreshGroupGoogleCompat(groupId: string, signal: AbortSignal) {
    const session = this.groupSessions.get(groupId);
    if (session)
      await Promise.all(
        [...session.lastRules.keys()].map((botId) => session.refreshGoogleCompat(botId, signal)),
      );
  }
  async refreshPermissions(
    botId: string | undefined,
    groupId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (groupId)
      return this.groupSessions.get(groupId)?.refreshPermissions(undefined, undefined, signal);
    if (!botId)
      await Promise.all(
        [...this.groupSessions.values()].map((value) =>
          value.refreshPermissions(undefined, undefined, signal),
        ),
      );
    for (const id of this.lastRules.keys()) {
      if (botId && id !== botId) continue;
      const settings = this.groupId
        ? this.local.permissions.effectiveGroup(this.groupId)
        : this.local.permissions.effective(id);
      const last = this.lastRules.get(id);
      if (!last || !this.host) continue;
      const rules = {
        ...last,
        allowList: settings.network.allowAll ? null : settings.network.domains,
        sites:
          settings.levels.web === "always"
            ? ("all" as const)
            : settings.levels.web === "never" || last.sites === "all"
              ? []
              : last.sites,
        submitSites: settings.levels.web === "never" ? [] : last.submitSites,
        downloadsDir: settings.levels.write_file === "never" ? null : last.downloadsDir,
      };
      await this.host.call(
        "host.browser.configure",
        { botId: id, runId: rules.runId, rules },
        signal,
      );
      this.lastRules.set(id, rules);
      for (const state of this.runs.values()) if (state.botId === id) state.pushed = undefined;
    }
  }

  /**
   * The switch changed. Pushed at once when the host already has rules for this Bot, so
   * an open page on Google switches identity without waiting for the Bot's next action.
   */
  async refreshGoogleCompat(botId: string, signal: AbortSignal) {
    const host = this.host;
    const last = this.lastRules.get(botId);
    if (!host || !last) return;
    const googleCompat = this.googleCompat(botId);
    if ((last.googleCompat ?? false) === googleCompat) return;
    const rules = { ...last, googleCompat };
    await host.call("host.browser.configure", { botId, runId: rules.runId, rules }, signal);
    this.lastRules.set(botId, rules);
  }

  /**
   * A background command of this Bot started or stopped listening. The host's rules change
   * right away (not at the Bot's next action), so a stopped server's port is refused at once.
   */
  refreshLocalPorts(botId: string) {
    for (const value of this.groupSessions.values()) value.refreshLocalPorts(botId);
    const host = this.host;
    const last = this.lastRules.get(botId);
    if (!host || !last || !this.active.has(botId)) return;
    const localPorts = this.local.background.ports(botId, this.groupId, true);
    if (JSON.stringify(localPorts) === JSON.stringify(last.localPorts ?? [])) return;
    const rules = { ...last, localPorts };
    this.lastRules.set(botId, rules);
    const update = host
      .call(
        "host.browser.configure",
        { botId, runId: rules.runId, rules },
        AbortSignal.any([this.local.shutdown.signal, AbortSignal.timeout(15_000)]),
      )
      .catch(() => {
        // Pages close when the host goes away; otherwise the next action re-sends the rules.
        this.local.deps.logger.warn(`Browser local ports not updated botId=${botId}`);
      });
    this.updates.add(update);
    void update.finally(() => this.updates.delete(update));
  }

  /**
   * Pages the user opens outside a run (local service, wake, address / new tab)
   * load under host rules, so the host must hold some. The last ones a run pushed are kept (with
   * the ports the Bot listens on now); before any run, the Bot's network settings with no
   * remembered sites, uploads or downloads. The user's own address skips the site question
   * on the host anyway; the Bot's later tool calls push their full rules as usual.
   */
  async ensureRules(botId: string, signal: AbortSignal) {
    const host = this.host;
    if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    const localPorts = this.local.background.ports(botId, this.groupId, true);
    const last = this.lastRules.get(botId);
    const googleCompat = this.googleCompat(botId);
    const network = (
      this.groupId
        ? this.local.permissions.effectiveGroup(this.groupId)
        : this.local.permissions.effective(botId)
    ).network;
    const allowList = network.allowAll ? null : network.domains;
    const configured = this.local.deps.proxy?.();
    // The proxy as set now: a run's remembered one may since have been turned off or changed,
    // and every page the user opens would then fail through a proxy that is no longer there.
    const proxy = configured ? { url: configured.url } : null;
    // A finished run's local-network approvals end with it; user-opened pages keep the ban.
    const privateOrigins =
      last?.runId && this.runs.has(last.runId) ? last.privateOrigins : undefined;
    if (
      last &&
      JSON.stringify(last.privateOrigins) === JSON.stringify(privateOrigins) &&
      JSON.stringify(last.localPorts ?? []) === JSON.stringify(localPorts) &&
      JSON.stringify(last.allowList) === JSON.stringify(allowList) &&
      JSON.stringify(last.proxy) === JSON.stringify(proxy) &&
      (last.googleCompat ?? false) === googleCompat
    )
      return;
    let rules: BrowserRules;
    if (last) rules = { ...last, localPorts, googleCompat, allowList, proxy, privateOrigins };
    else {
      rules = {
        allowList,
        sites: [],
        submitSites: [],
        proxy,
        readRoots: [],
        downloadsDir: null,
        localPorts,
        googleCompat,
      };
    }
    await host.call("host.browser.configure", { botId, runId: rules.runId, rules }, signal);
    this.lastRules.set(botId, rules);
    this.active.add(botId);
    // No run will end to start the status poll; the poll lifts the standby block later.
    this.watch();
  }

  /**
   * The user opens one of this Bot's own local services in a new tab of its browser; the
   * Bot's listening ports in the rules are what let the address through (an exception to the site
   * rules).
   */
  async openLocal(botId: string, url: string, signal: AbortSignal): Promise<BrowserPage> {
    const host = this.host;
    if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    await this.ensureRules(botId, signal);
    const page = await host.call("host.browser.userOpen", { botId, url }, signal);
    this.userOpened(botId, page.url || url);
    return page;
  }

  /**
   * The user opened this address in the Bot's browser. Policy judges that page from now on,
   * and the Bot hears it once with its next browser result (like a hand-back).
   */
  userOpened(botId: string, url: string) {
    if (url) this.observe(botId, { url });
    this.opened.set(botId, url);
  }

  /** The address the user opened that the Bot has not been told about yet (cleared on read). */
  takeUserOpened(botId: string) {
    const url = this.opened.get(botId);
    this.opened.delete(botId);
    return url;
  }

  /** Pushes rules when they differ from what this run last sent (or the host lost them). */
  async configure(
    context: BrowserRunScope,
    rules: BrowserRules,
    signal: AbortSignal,
    force = false,
  ) {
    const host = this.host;
    if (!host) return;
    await this.acquireRun(context, signal);
    this.assertRun(context);
    const state = this.state(context);
    const key = JSON.stringify(rules);
    if (!force && state.pushed === key) return;
    await host.call(
      "host.browser.configure",
      { botId: context.botId, runId: context.runId, rules },
      signal,
    );
    this.assertRun(context);
    state.pushed = key;
    this.lastRules.set(context.botId, rules);
    this.active.add(context.botId);
  }

  /**
   * End of a run. Pages stay open (the host closes them after 10 idle minutes
   * or when a fourth Bot needs pages), so a follow-up message can continue on the same page; the
   * status poll lifts the standby block once the host has closed them.
   */
  finishRun(context: BrowserRunScope): Promise<void> {
    const existing = this.finishing.get(context.runId);
    if (existing) return existing;
    const state = this.runs.get(context.runId);
    this.runs.delete(context.runId);
    const job = (async () => {
      await Promise.all([...this.groupSessions.values()].map((value) => value.finishRun(context)));
      if (this.leases.owns(context) && this.host) {
        await this.leases.handoffSent(context);
        await this.host.call(
          "host.browser.quiesce",
          { botId: context.botId, runId: context.runId },
          AbortSignal.any([this.local.shutdown.signal, AbortSignal.timeout(15_000)]),
        );
        const rules = this.lastRules.get(context.botId);
        if (rules?.runId === context.runId)
          this.lastRules.set(context.botId, {
            ...rules,
            runId: undefined,
            privateOrigins: [],
            readRoots: [],
            downloadsDir: null,
          });
      }
      if (state && this.host && this.active.has(context.botId)) this.watch();
    })();
    this.finishing.set(context.runId, job);
    return job;
  }

  /** No standby while any Bot may still have pages open. */
  isIdle(): boolean {
    return (
      this.active.size === 0 && [...this.groupSessions.values()].every((value) => value.isIdle())
    );
  }

  /** Busy pages close on the host's own schedule; poll until none of ours are listed. */
  private watch() {
    if (this.poll) return;
    this.poll = setInterval(() => {
      this.refreshing ??= this.refresh().finally(() => {
        this.refreshing = undefined;
      });
    }, STATUS_POLL_MS);
    this.poll.unref?.();
  }
  private async refresh() {
    const host = this.host;
    if (!host || this.polling) return;
    this.polling = true;
    try {
      const status = await host.call(
        "host.browser.status",
        {},
        AbortSignal.any([this.local.shutdown.signal, AbortSignal.timeout(15_000)]),
      );
      const open = new Set(
        status.bots.filter((bot) => bot.groupId === this.groupId).map((bot) => bot.botId),
      );
      for (const botId of [...this.active])
        if (!open.has(botId) && ![...this.runs.values()].some((run) => run.botId === botId)) {
          this.active.delete(botId);
          this.pages.delete(botId);
          this.lastRules.delete(botId);
        }
      this.failures = 0;
      if (!this.active.size) this.stopWatch();
    } catch {
      // The host closes every Bot page when this brain goes away, so a host that keeps failing
      // cannot be holding pages for us; stop blocking standby after a few attempts.
      this.local.deps.logger.warn("Browser status unavailable");
      if (++this.failures >= 3) {
        this.active.clear();
        this.stopWatch();
      }
    } finally {
      this.polling = false;
    }
  }
  private stopWatch() {
    clearInterval(this.poll);
    this.poll = undefined;
  }

  async dispose() {
    this.stopWatch();
    await Promise.all([...this.groupSessions.values()].map((session) => session.dispose()));
    await this.refreshing;
    await Promise.all([...this.updates, ...this.finishing.values()]);
    this.groupSessions.clear();
    this.leases.dispose();
    this.finishing.clear();
    this.stopWatch();
    this.runs.clear();
    this.active.clear();
    this.pages.clear();
    this.lastRules.clear();
    this.handedBack.clear();
    this.opened.clear();
  }
}
