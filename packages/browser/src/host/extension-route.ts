import {
  type BrowserBlocked,
  type BrowserRules,
  browserPrivateNetworkHost,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import type { Logger } from "@pibot/observability";
import { approvedPrivateOrigin } from "./network.ts";
import type { BrowserGuard } from "./types.ts";

export type UserBrowserId = "chrome" | "edge" | "brave" | "chromium" | "firefox";

/** What the desktop provides for the user's own browser. */
export interface UserBrowser {
  browserId?(): UserBrowserId | undefined;
  record?(input: {
    botId: string;
    runId?: string;
    browser: UserBrowserId | "unknown";
    action: string;
    domain: string;
  }): Promise<void>;
  /** The connected extension, if one said hello. */
  extension():
    | { call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> }
    | undefined;
  /** The system default browser is one the extension supports. */
  supported(): boolean;
  ensureConnected?(signal?: AbortSignal): Promise<boolean>;
  /** `createNavigationCheck` bound to this machine's address policy. */
  navigation(
    rules: BrowserRules,
    href: string,
    request: {
      submit: boolean;
      site(domain: string): boolean;
      allowSubmit(domain: string): boolean;
    },
  ): Promise<BrowserBlocked | undefined>;
  /** The extension went away mid-run: one grey line in the topic, then the Bot browser. */
  fallback(botId: string, runId?: string): void;
  /** The user pressed stop on the toolbar for this Bot (consumed once). */
  takeStop?(botId: string): boolean;
  status(): Promise<{
    defaultBrowser: {
      id: "chrome" | "edge" | "brave" | "chromium" | "firefox" | "safari" | "other";
      name: string;
    } | null;
    supported: boolean;
    extension: "connected" | "installed" | "not_installed" | "unsupported";
    registration?: "separate_data_dir" | "other_instance";
  }>;
  register(enabled: boolean, options?: { explicit?: boolean; takeOver?: boolean }): Promise<void>;
}

type Page = {
  tab: string;
  url: string;
  title: string;
  loading: boolean;
  blocked: BrowserBlocked[];
};
const ROUTED = new Set([
  "open",
  "snapshot",
  "click",
  "type",
  "select",
  "scroll",
  "back",
  "tabs",
  "close",
  "screenshot",
  "wait",
  "sleeping",
]);
const NAVIGATING = new Set(["open", "click", "type", "select", "back"]);
const hostOf = (href: string) => {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * Routes a Bot's page action to the user's browser when the run's rules ask for it and the
 * extension is there. The user's browser cannot be intercepted like the Bot browser's session, so
 * the same verdicts are asked up front: the address before opening it, the link before following
 * it, the form before submitting it; a page that still lands somewhere not allowed is left again.
 * Returns `undefined` to let the Bot browser handle the call.
 */
export function createExtensionRoute(user: UserBrowser, guard: BrowserGuard, logger: Logger) {
  const privateLanes = new Map<string, string>();
  return async (
    method: string,
    params: Record<string, unknown>,
    rules: BrowserRules | undefined,
    signal?: AbortSignal,
  ): Promise<{ value: unknown } | undefined> => {
    const name = method.replace(/^host\.browser\./, "");
    if (!ROUTED.has(name) || !rules?.userBrowser || !user.supported()) return undefined;
    // An explicit open chooses its backend. A private grant alone must not move an existing
    // public extension tab or replay its refs/forms in a different browser.
    const lane = JSON.stringify([params.groupId ?? null, params.botId]);
    const run = typeof params.runId === "string" ? params.runId : "";
    if (privateLanes.has(lane) && privateLanes.get(lane) !== run) privateLanes.delete(lane);
    if (name === "open") {
      let privateOpen = false;
      try {
        privateOpen = !!browserPrivateNetworkHost(new URL(String(params.url)).hostname);
      } catch {
        /* The ordinary URL boundary reports malformed input. */
      }
      if (privateOpen) {
        if (privateLanes.size >= 256) privateLanes.delete(privateLanes.keys().next().value ?? "");
        privateLanes.set(lane, run);
        return undefined;
      }
      privateLanes.delete(lane);
    } else if (privateLanes.get(lane) === run) return undefined;
    if (!user.extension() && !(await user.ensureConnected?.(signal))) {
      // No extension reached us: the Bot browser takes this action, and the run's topic shows the
      // install card once (the brain keeps one notice per conversation).
      user.fallback(
        String(params.botId),
        typeof params.runId === "string" ? params.runId : undefined,
      );
      return undefined;
    }
    const extension = user.extension();
    if (!extension) return undefined;
    const botId = String(params.botId);
    if (user.takeStop?.(botId))
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_user_stopped");
    // Taking over, temporary reads and logins stay in the Bot browser (their own windows).
    if ("screenshotId" in params)
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_click_ref_required");
    const verdict = (href: string, submit: boolean) =>
      user.navigation(rules, href, {
        submit,
        site: (domain) => guard.site(botId, { domain, url: href }, rules),
        allowSubmit: (domain) => guard.submit(botId, { domain, url: href }, rules),
      });
    const call = (inner: string, input: unknown) => extension.call(inner, input, signal);
    const current = async (): Promise<Page> => {
      const { tabs } = (await call("tabs", { botId })) as {
        tabs: { tab: string; url: string; title: string; active: boolean }[];
      };
      const tab = tabs.find((item) => item.active) ?? tabs.at(-1);
      return {
        tab: tab?.tab ?? "t1",
        url: tab?.url ?? "",
        title: tab?.title ?? "",
        loading: false,
        blocked: [],
      };
    };
    const refused = async (entry: BrowserBlocked) => {
      // The first refusal can ask for the target's run grant. After approval, require a new
      // explicit open; a click/ref or form from the extension cannot be replayed safely here.
      if (entry.kind === "private" && approvedPrivateOrigin(rules, new URL(entry.url)))
        throw new RpcError(RpcErrorCodes.unsupported, "browser_private_open_required");
      logger.info(
        JSON.stringify({ module: "browser-extension", event: "blocked", kind: entry.kind, botId }),
      );
      const page = await current();
      return {
        value:
          name === "wait"
            ? { page: { ...page, blocked: [entry] }, matched: false }
            : { ...page, blocked: [entry] },
      };
    };
    try {
      if (name === "sleeping") {
        const page = await current();
        return { value: { url: page.url || null } };
      }
      if (name === "open") {
        const entry = await verdict(String(params.url), false);
        if (entry) return refused(entry);
      }
      if ((name === "click" || (name === "type" && params.submit === true)) && params.ref) {
        const target = (await call("inspect", {
          botId,
          ref: params.ref,
          ...(params.tab ? { tab: params.tab } : {}),
        })) as {
          href: string | null;
          submits: boolean;
          formAction: string | null;
          pageUrl: string;
        };
        if (name === "click" && target.href) {
          const entry = await verdict(target.href, false);
          if (entry) return refused(entry);
        }
        if (target.submits && target.formAction) {
          const entry = await verdict(target.formAction, true);
          if (entry) return refused(entry);
        }
      }
      const before = NAVIGATING.has(name) ? (await current()).url : "";
      const value = await call(name, params);
      if (name === "open" || NAVIGATING.has(name)) {
        const target = value as { url?: unknown };
        const domain = typeof target.url === "string" ? hostOf(target.url) : "";
        await user
          .record?.({
            botId,
            ...(typeof params.runId === "string" ? { runId: params.runId } : {}),
            browser: user.browserId?.() ?? "unknown",
            action: name,
            domain,
          })
          .catch((error) =>
            logger.warn(
              `browser.user_browser_record_failed botId=${botId} error=${error instanceof Error ? error.name : "unknown"}`,
            ),
          );
      }
      if (!NAVIGATING.has(name)) return { value };
      // A script redirect or a click the inspection could not foresee: leave a page that our
      // rules would not have let the Bot browser open, and say so like the Bot browser does.
      const page = value as Page;
      if (page?.url && hostOf(page.url) !== hostOf(before)) {
        const entry = await verdict(page.url, false);
        if (entry) {
          await call("back", { botId }).catch(() => undefined);
          return refused(entry);
        }
      }
      return { value };
    } catch (error) {
      if (error instanceof RpcError && error.message === "browser_extension_disconnected") {
        user.fallback(botId, typeof params.runId === "string" ? params.runId : undefined);
        return undefined;
      }
      throw error;
    }
  };
}
