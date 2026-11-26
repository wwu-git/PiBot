import { existsSync, realpathSync, statSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserBlocked,
  type BrowserRules,
  browserPrivateNetworkHost,
  LocalBrowserDocumentExtensionSchema,
  localServiceTarget,
  privateNetworkOrigin,
} from "@pibot/browser-contract/full";
import type { AddressPolicy, Session } from "./platform.ts";

const PASS_SCHEMES = new Set(["data:", "blob:", "about:"]);
const NAVIGATION = new Set(["mainFrame", "subFrame"]);
const CACHE_MS = 60_000;
const fakeIp = new BlockList();
fakeIp.addSubnet("198.18.0.0", 15);
const isLoopbackPeer = (ip: string) => {
  const value = ip.toLowerCase();
  return value === "::1" || /^(?:::ffff:)?127\./.test(value);
};

export interface SessionHooks {
  rules(): BrowserRules | undefined;
  /** Exact approved origin must have a live preconnection checked session transport. */
  privateRoute?(rules: BrowserRules, url: URL): Promise<boolean>;
  /** Bot-driven requests ask the guard; the user's own takeover browsing does not. */
  takeover(): boolean;
  site(domain: string, url: string): boolean;
  submit(domain: string, url: string): boolean;
  blocked(entry: BrowserBlocked, webContentsId: number | undefined, mainFrame: boolean): void;
  /**
   * A page load cancelled with nothing to tell the Bot (no rules pushed yet, rules replaced
   * mid-check, a scheme that never loads). The tab is left on Chromium's blank error page, so
   * this is the only trace of why.
   */
  dropped?(reason: "no_rules" | "rules_changed" | "scheme"): void;
}

const hostOf = (url: URL) =>
  url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

/**
 * "Only listed sites": an entry covers itself and its subdomains on a label boundary, so
 * `example.com` lets `a.b.example.com` through but not `evil-example.com` or
 * `example.com.evil.net`. IP literals match exactly (a dotted suffix of an address is no domain).
 */
export function listedHost(list: readonly string[], host: string): boolean {
  if (isIP(host) !== 0) return list.includes(host);
  return list.some((entry) => host === entry || (isIP(entry) === 0 && host.endsWith(`.${entry}`)));
}

/**
 * A page of this Bot's own background command — `localServiceTarget` (same definition as
 * policy) on a loopback port the Bot's commands listen on right now. Everything else local or
 * private stays blocked.
 */
export function ownLocalService(rules: BrowserRules | undefined, url: string): boolean {
  const target = localServiceTarget(url);
  return !!target && !!rules?.localPorts?.includes(target.port);
}

/**
 * Maintainers 2026-11-14: a local-network origin the user allowed for this run (policy's
 * `privateNetworkOrigin` spelling: scheme, bare lowercase host, explicit port; ws(s) belong to
 * the page's http(s) origin). Only these exact origins pass the private-address block.
 */
export function approvedPrivateOrigin(rules: BrowserRules | undefined, url: URL): boolean {
  if (!rules?.privateOrigins?.length) return false;
  const origin = privateNetworkOrigin(url.href);
  return origin !== undefined && rules.privateOrigins.includes(origin);
}

export function localWorkplaceFileInfo(
  rules: BrowserRules | undefined,
  url: URL,
):
  | {
      path: string;
      relativePath: string;
      extension: (typeof LocalBrowserDocumentExtensionSchema.options)[number];
    }
  | undefined {
  if (!rules || url.protocol !== "file:" || url.hostname) return undefined;
  let target: string;
  try {
    target = fileURLToPath(url);
  } catch {
    return undefined;
  }
  const extension = LocalBrowserDocumentExtensionSchema.safeParse(extname(target).toLowerCase());
  if (!extension.success) return undefined;
  if (!isAbsolute(target) || !existsSync(target)) return undefined;
  let actual: string;
  try {
    actual = realpathSync.native(target);
    if (!statSync(actual).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const blocked = rules.blockedReadRoots ?? [];
  if (
    blocked.some((root) => {
      let blockedPath: string;
      try {
        blockedPath = realpathSync.native(resolve(root));
      } catch {
        blockedPath = resolve(root);
      }
      const rest = relative(blockedPath, actual);
      return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
    })
  )
    return undefined;
  for (const root of rules.readRoots) {
    const rootPath = (() => {
      try {
        return realpathSync.native(resolve(root));
      } catch {
        return resolve(root);
      }
    })();
    const rest = relative(rootPath, actual);
    if (rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)))
      return { path: actual, relativePath: rest, extension: extension.data };
  }
  return undefined;
}

export function localWorkplaceFile(rules: BrowserRules | undefined, url: URL): boolean {
  return localWorkplaceFileInfo(rules, url) !== undefined;
}

/**
 * Same address rules as web_fetch (exec/web-address): no local or private targets, Clash fake-IP
 * only as a DNS answer, and through a proxy only DNS answers that are private are refused.
 */
function createAddressCheck({ checkedUrl, checkProxyTarget, publicAddresses }: AddressPolicy) {
  const cache = new Map<string, { at: number; ok: Promise<boolean> }>();
  return (url: URL, proxied: boolean) => {
    const key = `${proxied ? "p" : "d"}:${url.protocol}//${url.host}`;
    const hit = cache.get(key);
    if (hit && performance.now() - hit.at < CACHE_MS) return hit.ok;
    const probe = new URL(
      `${url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol}//${url.host}/`,
    );
    const ok = (async () => {
      try {
        const checked = checkedUrl(probe.href);
        const signal = AbortSignal.timeout(5000);
        if (proxied) await checkProxyTarget(checked, signal);
        else await publicAddresses(checked, signal);
        return true;
      } catch (error) {
        // Only an address verdict blocks. A lookup that merely failed is Chromium's to report
        // (ERR_NAME_NOT_RESOLVED); a different answer it gets is caught at response start.
        return (error as { code?: unknown }).code !== "web_blocked";
      }
    })();
    cache.set(key, { at: performance.now(), ok });
    if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
    return ok;
  };
}

/**
 * The same verdict `installSessionRules` gives a Bot-driven top-level request, for a browser
 * whose requests we cannot intercept (the user's own, through the extension). It is asked before
 * the page is opened, a link is followed or a form is submitted; `undefined` lets it through.
 */
export function createNavigationCheck(address: AddressPolicy) {
  const addressOk = createAddressCheck(address);
  return async (
    rules: BrowserRules,
    href: string,
    request: {
      submit: boolean;
      site(domain: string): boolean;
      allowSubmit(domain: string): boolean;
    },
  ): Promise<BrowserBlocked | undefined> => {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return { kind: "site", url: href.slice(0, 4096) };
    }
    const host = hostOf(url);
    const entry = (kind: BrowserBlocked["kind"]) => ({
      kind,
      url: href.slice(0, 4096),
      domain: host,
    });
    // The user's browser never opens local files or other schemes for a Bot.
    if (url.protocol !== "http:" && url.protocol !== "https:") return entry("site");
    if (ownLocalService(rules, href)) return undefined;
    // An extension cannot constrain the actual socket; private browsing stays in the Bot session.
    if (browserPrivateNetworkHost(host)) return entry("private");
    if (rules.allowList && !listedHost(rules.allowList, host)) return entry("not_listed");
    if (!(await addressOk(url, rules.proxy !== null))) return entry("private");
    if (!request.site(host)) return entry("site");
    if (request.submit && !request.allowSubmit(host)) return entry("submit");
    return undefined;
  };
}

/** Installs request filtering on a Bot session; returns the remover. Proxy is applied separately. */
export function installSessionRules(session: Session, hooks: SessionHooks, address: AddressPolicy) {
  const { isPublicAddress } = address;
  const addressOk = createAddressCheck(address);
  session.webRequest.onBeforeRequest(async (details, callback) => {
    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      callback({ cancel: true });
      return;
    }
    if (PASS_SCHEMES.has(url.protocol)) {
      callback({});
      return;
    }
    const rules = hooks.rules();
    const navigation = NAVIGATION.has(details.resourceType);
    const report = (kind: BrowserBlocked["kind"], domain?: string) => {
      // Subresources (CDNs, trackers) are refused silently; only navigations are worth asking
      // about, and reporting each one would flood results and the audit log.
      if (navigation)
        hooks.blocked(
          { kind, url: details.url.slice(0, 4096), ...(domain ? { domain } : {}) },
          details.webContentsId,
          details.resourceType === "mainFrame",
        );
      callback({ cancel: true });
    };
    if (localWorkplaceFile(rules, url)) {
      callback({});
      return;
    }
    // chrome: and other schemes never load; nothing for the Bot to ask about.
    const mainFrame = details.resourceType === "mainFrame";
    if (!rules || !["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      if (mainFrame) hooks.dropped?.(rules ? "scheme" : "no_rules");
      callback({ cancel: true });
      return;
    }
    // The Bot's own loopback service needs no site approval or allow-list entry (policy
    // allows it the same way); it reaches nothing beyond a process the user approved.
    if (ownLocalService(rules, details.url)) {
      callback({});
      return;
    }
    const host = hostOf(url);
    // The user allowed exactly this local-network origin for the run (its own card, asked each
    // time); it is the user's own device, so neither the site list nor the address ban applies.
    const allowedPrivate = approvedPrivateOrigin(rules, url);
    if (allowedPrivate && !(await hooks.privateRoute?.(rules, url))) return report("private", host);
    // Tailnet and .local names must never slip through a public DNS answer or manual proxy.
    if (!allowedPrivate && browserPrivateNetworkHost(host)) return report("private", host);
    // Applies to subresources too: a site's CDN stays blocked until the user lists it.
    if (!allowedPrivate && rules.allowList && !listedHost(rules.allowList, host))
      return report("not_listed", host);
    if (!allowedPrivate && !(await addressOk(url, rules.proxy !== null)))
      return report("private", host);
    // DNS can finish after a run handed off. Never resume an old request under new rules.
    if (hooks.rules() !== rules) {
      if (mainFrame) hooks.dropped?.("rules_changed");
      callback({ cancel: true });
      return;
    }
    if (navigation && !hooks.takeover()) {
      // The allowed origin's card was its visit approval; a form post there is still asked.
      if (details.resourceType === "mainFrame" && !allowedPrivate && !hooks.site(host, details.url))
        return report("site", host);
      if (!["GET", "HEAD"].includes(details.method) && !hooks.submit(host, details.url))
        return report("submit", host);
    }
    callback({});
  });
  // DNS can change between our lookup and Chromium's (rebinding). Without a proxy the peer address
  // is known once the response starts; a private peer stops the page.
  session.webRequest.onResponseStarted((details) => {
    const rules = hooks.rules();
    // Electron's typings omit it, but Chromium reports the peer address here.
    const ip = (details as { ip?: unknown }).ip;
    if (!rules || rules.proxy || typeof ip !== "string" || isIP(ip) === 0) return;
    // This response's peer is the authenticated loopback proxy. The transport verified and
    // pinned the actual destination before sending bytes; post-response DNS checks cannot.
    try {
      if (hooks.privateRoute && approvedPrivateOrigin(rules, new URL(details.url))) return;
    } catch {
      // Malformed URLs fall through to the existing refusal below.
    }
    if (isPublicAddress(ip) || fakeIp.check(ip)) return;
    if (ownLocalService(rules, details.url) && isLoopbackPeer(ip)) return;
    let host: string | undefined;
    try {
      host = hostOf(new URL(details.url));
    } catch {
      // Unparseable URLs were already refused before the request; report without a domain.
    }
    hooks.blocked(
      { kind: "private", url: details.url.slice(0, 4096), ...(host ? { domain: host } : {}) },
      details.webContentsId ?? -1,
      details.resourceType === "mainFrame",
    );
  });
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  return () => {
    session.webRequest.onBeforeRequest(null);
    session.webRequest.onResponseStarted(null);
    session.setPermissionRequestHandler(null);
    session.setPermissionCheckHandler(null);
  };
}

/** Only the manually configured proxy, otherwise direct. Never the system proxy. */
export async function applyProxy(
  session: Session,
  proxy: BrowserRules["proxy"],
  localPorts: readonly number[] = [],
  /** Allowed local-network origins: the user's own devices are never sent to their proxy. */
  privateOrigins: readonly string[] = [],
) {
  if (!proxy) await session.setProxy({ mode: "direct" });
  else {
    const url = new URL(proxy.url);
    await session.setProxy({
      mode: "fixed_servers",
      proxyRules: `${url.protocol}//${url.host}`,
      // Remove Chromium's implicit loopback bypass; loopback targets are refused anyway, except
      // the Bot's own background ports, which must not be sent to the user's proxy.
      proxyBypassRules: [
        "<-loopback>",
        ...localPorts.flatMap((port) => [
          `127.0.0.1:${port}`,
          `localhost:${port}`,
          `[::1]:${port}`,
        ]),
        // `host:port` as the origin spells it (URL.host would drop a default port).
        ...privateOrigins.map((origin) => origin.replace(/^https?:\/\//, "")),
      ].join(";"),
    });
  }
  // Existing sockets would keep the old route.
  await session.closeAllConnections();
}

export function proxyCredentials(proxy: BrowserRules["proxy"]) {
  if (!proxy) return undefined;
  const url = new URL(proxy.url);
  if (!url.username && !url.password) return undefined;
  return {
    host: url.hostname,
    port: url.port,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
