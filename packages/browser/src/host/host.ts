import { AsyncLocalStorage } from "node:async_hooks";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
  type BrowserHostMethods,
  type BrowserRules,
  type Params,
  type Result,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import type { Logger } from "@pibot/observability";
import type { BotBrowser } from "./bot-browser.ts";
import { inspectNode } from "./debug/debug-inspect.ts";
import { screenshotViewport } from "./debug/debug-viewport.ts";
import { captureSecret, networkMetadata, pageRequest } from "./debug/network-actions.ts";
import { consumeSecretUses, describeSecretUses } from "./debug/secret-handles.ts";
import { createExtensionRoute, type UserBrowser } from "./extension-route.ts";
import type { BotBrowsers } from "./index.ts";
import { localWorkplaceFileInfo } from "./network.ts";
import {
  clickPoint,
  clickRef,
  pageHasText,
  refVisible,
  scrollPage,
  selectRef,
  typeRef,
  uploadRef,
} from "./page/actions.ts";
import { captureClickViewport } from "./page/click-capture.ts";
import { actionPhases } from "./page/phases.ts";
import { snapshotPage } from "./page/snapshot.ts";
import type { BrowserGuard } from "./types.ts";

type M = typeof BrowserHostMethods;
type Handle = <K extends keyof M>(
  method: K,
  action: (params: Params<M, K>, signal?: AbortSignal) => Promise<Result<M, K>>,
) => void;

const listed = (sites: BrowserRules["sites"], domain: string) =>
  sites === "all" || sites.includes(domain);

/**
 * Default guard: answers only from what brain already decided through policy and pushed with
 * `host.browser.configure`. Everything else is blocked and reported for brain to ask.
 */
export const rulesGuard: BrowserGuard = {
  site: (_botId, { domain }, rules) => listed(rules.sites, domain),
  submit: (_botId, { domain }, rules) => listed(rules.submitSites, domain),
  // brain's policy gate asked for this upload; the host only enforces the read roots.
  upload: () => true,
};

async function uploadPaths(paths: string[], roots: string[]) {
  const realRoots = (
    await Promise.all(roots.map((root) => realpath(root).catch(() => null)))
  ).filter((root): root is string => root !== null);
  const files: string[] = [];
  for (const path of paths) {
    let real: string;
    try {
      real = await realpath(path);
      if (!(await stat(real)).isFile()) throw new Error("not_file");
    } catch {
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_upload_not_found");
    }
    // Symlinks resolve first, so a link inside a root cannot reach a file outside it.
    const inside = realRoots.some((root) => {
      const rel = relative(root, real);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!inside) throw new RpcError(RpcErrorCodes.invalidParams, "browser_upload_outside_roots");
    files.push(real);
  }
  return files;
}

async function poll(deadline: number, check: () => Promise<boolean>) {
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** host.browser.* on the brain host port; every handler runs inside host-rpc's wrapper. */
export function registerBrowserHost(
  register: Handle,
  host:
    | {
        browsers: BotBrowsers;
        guard: BrowserGuard;
        /** The user's own browser through the extension, when the desktop provides it. */
        userBrowser?: UserBrowser;
      }
    | undefined,
  logger: Logger,
) {
  const requestScope = new AsyncLocalStorage<string | undefined>();
  const route = host?.userBrowser
    ? createExtensionRoute(host.userBrowser, host.guard, logger)
    : undefined;
  const handle: Handle = (method, action) =>
    register(method, (params, signal) => {
      const groupId =
        "groupId" in (params ?? {}) ? (params as { groupId?: string }).groupId : undefined;
      return requestScope.run(groupId, async () => {
        if (route && host && params && typeof params === "object" && "botId" in params) {
          const input = params as Record<string, unknown>;
          // The run's rules (pushed by brain with configure) say whether the user prefers their
          // own browser; without rules nothing is routed and the Bot browser refuses as before.
          const rules = host.browsers.find(String(input.botId), groupId)?.rules;
          const routed = await route(method, input, rules, signal);
          if (routed) return routed.value as Awaited<ReturnType<typeof action>>;
        }
        return action(params, signal);
      });
    });
  const need = () => {
    if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    return {
      ...host.browsers,
      get: (botId: string) => host.browsers.get(botId, requestScope.getStore()),
      find: (botId: string) => host.browsers.find(botId, requestScope.getStore()),
      peek: (botId: string) => host.browsers.peek(botId, requestScope.getStore()),
    };
  };
  const act = <T>(
    botId: string,
    runId: string | undefined,
    action: (browser: BotBrowser) => Promise<T>,
  ) => {
    const browser = need().get(botId);
    return browser.run(() => action(browser), runId);
  };
  handle(
    "host.browser.extensionStatus",
    async () =>
      (await host?.userBrowser?.status()) ?? {
        defaultBrowser: null,
        supported: false,
        extension: "unsupported" as const,
      },
  );
  handle("host.browser.extensionRegister", async ({ enabled, explicit, takeOver }) => {
    await host?.userBrowser?.register(enabled, { explicit, takeOver });
    return null;
  });
  handle("host.browser.configure", async ({ botId, runId, rules }) => {
    await need().get(botId).configure(rules, runId);
    return null;
  });
  handle("host.browser.userOpen", ({ botId, url }) => need().get(botId).userOpen(url));
  handle("host.browser.readTemporary", ({ botId, ...input }) =>
    need().get(botId).readTemporary(input),
  );
  handle("host.browser.cancelTemporary", async ({ botId, runId, operationId }) => {
    need().peek(botId)?.cancelTemporary(runId, operationId);
    return null;
  });
  handle("host.browser.open", ({ botId, runId, url, newTab }) =>
    act(botId, runId, async (browser) => {
      const timing = actionPhases();
      const tab = await browser.openUrl(url, newTab === true, timing.mark);
      timing.report(logger, "open", { loading: tab.loading });
      const parsed = new URL(url);
      const local = localWorkplaceFileInfo(browser.rules, parsed);
      logger.info(
        local
          ? `audit browser.open botId=${botId} path=${local.relativePath} extension=${local.extension}`
          : `audit browser.open botId=${botId} domain=${parsed.hostname}`,
      );
      const page = browser.page(tab);
      return {
        ...page,
        ...(local && !page.error && !page.blockedReason && !page.blocked.length
          ? { localFile: { relativePath: local.relativePath, extension: local.extension } }
          : {}),
      };
    }),
  );
  handle("host.browser.snapshot", ({ botId, runId, tab, maxChars }, signal) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(tab);
      const timing = actionPhases();
      // A page that navigates while being read (a redirect, the user during takeover)
      // gets one fresh read here instead of a failed tool call the model has to repeat.
      for (let attempt = 0; ; attempt++) {
        const documentId = target.documentId;
        const snapshot = await snapshotPage(
          target.control,
          target.refs,
          maxChars ?? 20_000,
          signal,
          timing.mark,
        );
        if (target.documentId === documentId) {
          timing.report(logger, "snapshot", { loading: target.loading, attempts: attempt + 1 });
          return { page: browser.page(target), ...snapshot };
        }
        if (attempt >= 1) throw new RpcError(RpcErrorCodes.invalidParams, "browser_snapshot_stale");
        await target.settle(0, 3000);
      }
    }),
  );
  handle("host.browser.click", ({ botId, runId, ...input }, signal) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(input.tab);
      await browser.armSubmit(target);
      signal?.throwIfAborted();
      if ("ref" in input) {
        target.clickCapture.clear();
        await clickRef(target.control, target.refs, input.ref);
      } else {
        if (target.loading || target.viewportBusy)
          throw new RpcError(RpcErrorCodes.invalidParams, "browser_screenshot_stale");
        const point = await target.clickCapture.consume(
          target.control,
          () => target,
          runId,
          input,
          signal,
        );
        signal?.throwIfAborted();
        await clickPoint(target.control, point);
      }
      await target.settle();
      return browser.page(target);
    }),
  );
  handle("host.browser.type", ({ botId, runId, tab, ref, text, submit }) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(tab);
      target.clickCapture.clear();
      await browser.armSubmit(target);
      await typeRef(target.control, target.refs, ref, text, submit === true);
      if (submit) await target.settle();
      return browser.page(target);
    }),
  );
  handle("host.browser.select", ({ botId, runId, tab, ref, value }) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(tab);
      target.clickCapture.clear();
      await browser.armSubmit(target);
      await selectRef(target.control, target.refs, ref, value);
      await target.settle(200);
      return browser.page(target);
    }),
  );
  handle("host.browser.upload", ({ botId, runId, tab, ref, paths }) =>
    act(botId, runId, async (browser) => {
      const rules = browser.rules as BrowserRules;
      const files = await uploadPaths(paths, rules.readRoots);
      if (!host?.guard.upload(botId, { paths: files }, rules))
        throw new RpcError(RpcErrorCodes.invalidParams, "browser_upload_denied");
      const target = browser.tab(tab);
      await uploadRef(target.control, target.refs, ref, files);
      target.clickCapture.clear();
      logger.info(`audit browser.upload botId=${botId} files=${files.length}`);
      return browser.page(target);
    }),
  );
  handle("host.browser.scroll", ({ botId, runId, tab, direction, amount }) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(tab);
      target.clickCapture.clear();
      await scrollPage(target.control, direction, amount);
      return browser.page(target);
    }),
  );
  handle("host.browser.back", ({ botId, runId, tab }) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(tab);
      target.clickCapture.clear();
      const history = target.contents.navigationHistory;
      if (history.canGoBack()) {
        history.goBack();
        await target.settle(200);
      }
      return browser.page(target);
    }),
  );
  handle("host.browser.tabs", async ({ botId, runId }) => {
    const browser = need().peek(botId);
    browser?.assertRun(runId);
    // Listing tabs is a use too; sleeping ones come back (as a Bot action, after rules).
    if (browser?.sleeping) return act(botId, runId, async (open) => ({ tabs: open.tabList() }));
    return { tabs: browser?.tabList() ?? [] };
  });
  handle("host.browser.close", ({ botId, runId, tab }) =>
    act(botId, runId, async (browser) => {
      browser.tab(tab);
      browser.closeTab(tab);
      return { tabs: browser.tabList() };
    }),
  );
  handle("host.browser.network", ({ botId, runId, tab, after, limit }, signal) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(tab);
      const documentId = target.documentId;
      const storage = await networkMetadata(target, signal);
      return { documentId, ...target.network(after, limit), storage };
    }),
  );
  handle("host.browser.request", ({ botId, runId, ...input }, signal) =>
    act(botId, runId, (browser) => pageRequest(browser.tab(input.tab), input, signal)),
  );
  handle("host.browser.secret", ({ botId, runId, ...input }, signal) =>
    act(botId, runId, (browser) => captureSecret(browser.tab(input.tab), input, signal)),
  );
  // Handles belong to the Bot, not to the run that owns the page: approval preparation and a
  // run_command env happen in runs that never configured the browser (browser_not_configured, seen
  // in e2e). These are in-memory lookups bound to tab/document/capture generation, never page
  // actions,
  // so they skip the run lease but still refuse while the user has taken over.
  const secrets = <T>(botId: string, action: (browser: BotBrowser) => T) => {
    const browser = need().get(botId);
    if (browser.takeover)
      return Promise.reject(new RpcError(RpcErrorCodes.busy, "browser_takeover"));
    return Promise.resolve(action(browser));
  };
  handle("host.browser.secretUses", ({ botId, runId: _runId, ...input }) =>
    secrets(botId, (browser) => describeSecretUses(browser, input)),
  );
  handle("host.browser.consumeSecrets", ({ botId, uses }) =>
    secrets(botId, (browser) => consumeSecretUses(browser, uses)),
  );
  handle("host.browser.diagnostics", ({ botId, runId, tab, after, limit }) =>
    act(botId, runId, (browser) => browser.tab(tab).debug(after, limit)),
  );
  handle("host.browser.inspect", ({ botId, runId, tab, ref, documentId }) =>
    act(botId, runId, (browser) => {
      const target = browser.tab(tab);
      const node = target.refs.node(ref);
      if (!node) throw new RpcError(RpcErrorCodes.invalidParams, "browser_ref_not_found");
      return inspectNode(target, node, documentId ?? target.documentId);
    }),
  );
  handle("host.browser.screenshot", ({ botId, runId, tab, fullPage, viewport }, signal) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(tab);
      target.clickCapture.clear();
      const identity = { documentId: target.documentId, viewVersion: target.viewVersion };
      // Full-page and emulated images do not describe the page's current input viewport.
      const interactive =
        !!runId && !fullPage && !viewport && target.debugSupported && !target.loading;
      const timing = actionPhases();
      const before = interactive ? await captureClickViewport(target.control, signal) : undefined;
      const shot = await screenshotViewport(
        target,
        fullPage === true,
        viewport,
        () => browser.closeTab(target.id),
        timing.mark,
        signal,
      );
      timing.report(logger, "screenshot", { fullPage: fullPage === true, emulated: !!viewport });
      signal?.throwIfAborted();
      const after = before ? await captureClickViewport(target.control, signal) : undefined;
      const screenshotId =
        before &&
        after &&
        runId &&
        !target.loading &&
        identity.documentId === target.documentId &&
        identity.viewVersion === target.viewVersion
          ? target.clickCapture.remember(identity, runId, shot, before, after)
          : undefined;
      return { ...shot, ...(screenshotId ? { screenshotId } : {}) };
    }),
  );
  handle("host.browser.wait", ({ botId, runId, tab, for: kind, value, timeoutMs }) =>
    act(botId, runId, async (browser) => {
      const target = browser.tab(tab);
      const deadline = Date.now() + (timeoutMs ?? 10_000);
      if (kind !== "load" && !value)
        throw new RpcError(RpcErrorCodes.invalidParams, "browser_wait_value_required");
      const matched = await poll(deadline, async () => {
        if (kind === "load") return !target.loading;
        if (kind === "text") return pageHasText(target.control, value as string);
        return refVisible(target.control, target.refs, value as string);
      });
      return { page: browser.page(target), matched };
    }),
  );
  handle("host.browser.downloads", async ({ botId, runId }) => {
    const browser = need().find(botId);
    browser?.assertRun(runId);
    return { downloads: browser?.downloadList() ?? [] };
  });
  handle("host.browser.release", async ({ botId }) => {
    await need().find(botId)?.release();
    return null;
  });
  handle("host.browser.handoff", async ({ botId, runId, temporary }) => {
    await need().get(botId).handoff(runId, temporary);
    return null;
  });
  handle("host.browser.quiesce", async ({ botId, runId }) => {
    await need().find(botId)?.quiesce(runId);
    return null;
  });
  handle("host.browser.sleeping", async ({ botId, runId }) => {
    const browser = need().peek(botId);
    browser?.assertRun(runId);
    return { url: browser?.sleepingUrl ?? null };
  });
  handle("host.browser.status", async () => ({ bots: need().status() }));
  handle("host.browser.record.start", async ({ botId, recordingId }) => {
    await need().get(botId).startRecording(recordingId);
    logger.info(`audit browser.record.start botId=${botId}`);
    return null;
  });
  handle("host.browser.record.stop", async ({ botId }) => ({
    events: (await need().find(botId)?.stopRecording()) ?? [],
  }));
  handle("host.browser.record.read", async ({ botId, after }) => {
    const browser = need().find(botId);
    return browser ? browser.readRecording(after) : { events: [], active: false, paused: false };
  });
  handle("host.browser.record.pause", async ({ botId, paused }) => {
    need().find(botId)?.pauseRecording(paused);
    // Facts only: whether recording paused, never what happened meanwhile.
    logger.info(`audit browser.record.pause botId=${botId} paused=${paused}`);
    return null;
  });
}
