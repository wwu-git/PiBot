// Keeps browser extension settings and owner reports on the brain RPC boundary.
import type { CapabilityContext } from "@pibot/brain/kit";
import {
  type BrowserExtensionStatusSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import {
  ChatNoticesRepo,
  DEFAULT_BROWSER_EXTENSION_PREFERENCE,
  RunsRepo,
  SettingsRepo,
} from "@pibot/storage";
import type { z } from "zod";

type Status = z.infer<typeof BrowserExtensionStatusSchema>;
const unsupported = { defaultBrowser: null, supported: false, extension: "unsupported" } as const;

/**
 * The user's own browser in settings. The preference lives in settings (absent = "user");
 * whether it is used for a run is decided per run from it (BrowserRules.userBrowser), and the
 * native messaging manifests exist only while it is "user".
 */
export function registerExtensionRpc(
  handle: CapabilityContext["rpc"]["handle"],
  ctx: Pick<CapabilityContext, "db" | "peer" | "logger" | "host" | "local">,
) {
  const settings = new SettingsRepo(ctx.db);
  const preference = () =>
    settings.get().browserExtensionPreference ?? DEFAULT_BROWSER_EXTENSION_PREFERENCE;
  const status = async (signal: AbortSignal): Promise<Status> => {
    const host = ctx.host.browser;
    const desktop = host
      ? await host.call("host.browser.extensionStatus", {}, signal).catch(() => unsupported)
      : unsupported;
    return { ...desktop, preference: preference() };
  };
  handle("browserExtension.status", (_params, { signal }) => status(signal));
  handle("browserExtension.setPreference", async ({ preference: next, takeOver }, { signal }) => {
    const saved = settings.set({ browserExtensionPreference: next });
    ctx.peer.emit("settings.changed", saved);
    // A choice made in this instance's settings is explicit; only "connect here" takes over.
    await ctx.host.browser?.call(
      "host.browser.extensionRegister",
      { enabled: next === "user", explicit: true, ...(takeOver ? { takeOver: true } : {}) },
      signal,
    );
    const value = await status(signal);
    ctx.peer.emit("browserExtension.changed", value);
    return value;
  });
  handle("browserExtension.fallback", async ({ botId, runId }, { signal }) => {
    const run = new RunsRepo(ctx.db).get(runId);
    if (!run || run.botId !== botId)
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_extension_unknown_run");
    const notice = new ChatNoticesRepo(ctx.db).addBrowserExtension({
      conversationId: run.conversationId,
      botId,
    });
    if (notice) {
      ctx.peer.emit("chat.notice", notice);
    } else {
      // A topic reuses its install card, so refresh it if the extension went away again.
      const value = await status(AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
      if (!signal.aborted) ctx.peer.emit("browserExtension.changed", value);
    }
    return { ok: true as const };
  });
  handle("browserExtension.record", async ({ botId, runId, browser, action, domain }) => {
    if (runId) {
      const run = new RunsRepo(ctx.db).get(runId);
      if (!run || run.botId !== botId)
        throw new RpcError(RpcErrorCodes.invalidParams, "browser_extension_unknown_run");
    }
    ctx.local.approvals.audit.append({
      botId,
      runId: runId ?? null,
      kind: "browser.user_browser",
      summary: "Used the user's browser / 使用用户浏览器",
      detail: { browser, browserAction: action, domain },
    });
    return { ok: true as const };
  });
  /** Startup: the manifests follow the saved preference (written once, unchanged ones skipped). */
  return async (signal: AbortSignal) => {
    await ctx.host.browser
      ?.call("host.browser.extensionRegister", { enabled: preference() === "user" }, signal)
      .catch(() =>
        ctx.logger.warn(JSON.stringify({ module: "browser-extension", event: "register_failed" })),
      );
  };
}
