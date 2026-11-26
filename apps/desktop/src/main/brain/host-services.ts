/*
 * Everything the brain host builds once at startup and hands to the host RPC surface: secure
 * storage, attachments, office rendering, host capabilities, connector import, the Bot browsers
 * with their takeover toolbars, and the overlay frame transport. Kept out of `brain-host.ts` so
 * that file stays about the brain child's lifecycle.
 */
import { join } from "node:path";
import { BRAIN_AUTH_ENV_NAMES } from "@pibot/agent/env";
import {
  createBotBrowsers,
  createBrowserFrames,
  createBrowserLogins,
  rulesGuard,
} from "@pibot/browser/host";
import { createConnectorImportHost } from "@pibot/plugins/host";
import { Events, type Methods, type Peer, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { withNamedRedaction } from "@pibot/secrets";
import { dialog, safeStorage } from "electron";
import { browserPlatform } from "../browser-adapter/platform.ts";
import { createTakeoverToolbars } from "../browser-adapter/takeover-toolbar.ts";
import { connectorImportDialogs } from "../host/connector-import-dialogs.ts";
import { createHostCapabilities } from "../host/host-capabilities.ts";
import { createSecureStorage } from "../host/secure-storage.ts";
import { createAttachmentHost } from "./attachments.ts";
import { createEnvReader } from "./env-detect.ts";
import type { BrainHostOptions } from "./host-options.ts";
import { lazyOfficeRender } from "./lazy-office-render.ts";

export const toolbarEvents = {
  "settings.changed": Events["settings.changed"],
  "credentials.changed": Events["credentials.changed"],
  "bots.changed": Events["bots.changed"],
  "inbox.changed": Events["inbox.changed"],
  "runtime.activeRuns": Events["runtime.activeRuns"],
  "runtime.liveActivity": Events["runtime.liveActivity"],
};

/** The main-process peer of the current brain child; the host RPC surface and toolbars use it. */
export type MainPeer = Peer<typeof Methods, typeof toolbarEvents>;

export function createHostServices(
  options: BrainHostOptions,
  deps: {
    /** Throws while no brain child is connected. */
    requirePeer(): MainPeer;
    locale(): "zh" | "en";
  },
) {
  const storage =
    options.storage ??
    createSecureStorage(safeStorage, options.logger, { platform: process.platform });
  const env = createEnvReader(options.originalEnv, BRAIN_AUTH_ENV_NAMES, process.platform);
  const officeRender = lazyOfficeRender(
    {
      outputDir: options.outputDir,
      devUrl: options.dev ? options.originalEnv.ELECTRON_RENDERER_URL : undefined,
    },
    (durationMs) =>
      options.logger.info(
        JSON.stringify({
          module: "startup",
          event: "office_render_import",
          durationMs,
        }),
      ),
  );
  const attachments = createAttachmentHost({
    dataDir: options.dataDir,
    outputDir: options.outputDir,
    devUrl: options.dev ? options.originalEnv.ELECTRON_RENDERER_URL : undefined,
    partition: options.attachmentPartition,
    ...(options.gui
      ? {
          openPath: async (path: string) => {
            await options.gui?.call("gui.openPath", { path });
          },
        }
      : {}),
  });
  const capabilities = options.capabilities ?? createHostCapabilities(options);
  const connectorImports = createConnectorImportHost({
    dataDir: options.dataDir,
    dialog: connectorImportDialogs({
      dialogs: dialog,
      window: () => options.window,
      ...(options.gui ? { gui: options.gui } : {}),
    }),
    locale: () => deps.locale(),
  });
  // Bot browsers live in this process; pages close whenever the brain child goes away
  // (standby, restart, crash) so no page outlives the brain that drove it.
  // Saved-account fill and takeover capture; captured passwords live only in memory here.
  const logins = createBrowserLogins(options.logger);
  const toolbars = createTakeoverToolbars({
    outputDir: options.outputDir,
    devUrl: options.dev ? options.originalEnv.ELECTRON_RENDERER_URL : undefined,
    logger: options.logger,
    request: {
      accounts: (params, signal) =>
        deps.requirePeer().call("credentials.takeoverAccounts", params, { signal }),
      fill: (params, signal) =>
        deps.requirePeer().call("credentials.fillForTakeover", params, { signal }),
      handBack: async (params, signal) => {
        await deps.requirePeer().call("browser.takeover", { ...params, on: false }, { signal });
      },
      settings: (signal) => deps.requirePeer().call("settings.get", undefined, { signal }),
      botName: async (id, signal) => {
        let before: string | undefined;
        for (;;) {
          const page = await deps
            .requirePeer()
            .call("bots.list", { before, limit: 200 }, { signal });
          const bot = page.find((item) => item.id === id);
          if (bot) return bot.name;
          if (page.length < 200) throw new RpcError(RpcErrorCodes.invalidParams, "bot_not_found");
          before = page.at(-1)?.id;
        }
      },
    },
  });
  // Plain redaction skips short strings; browser OTPs must also protect console/diagnostic output.
  const browserRedactor = withNamedRedaction(options.redactor);
  const browserLogger = {
    info: (message: string) => options.logger.info(browserRedactor.redact(message)),
    warn: (message: string) => options.logger.warn(browserRedactor.redact(message)),
    error: (message: string) => options.logger.error(browserRedactor.redact(message)),
  };
  const browsers = createBotBrowsers({
    platform: browserPlatform(),
    profileDir: (botId, groupId) =>
      groupId
        ? join(options.dataDir, "groups", groupId, "browsers", botId)
        : join(options.dataDir, "bots", botId, "browser"),
    groupProfilesDir: (groupId) => join(options.dataDir, "groups", groupId, "browsers"),
    redact: browserRedactor.redact,
    registerSecret: (value: string, handle?: string) => {
      try {
        browserRedactor.addNamed("BROWSER_SECRET", value, handle);
      } catch {
        throw new RpcError(RpcErrorCodes.invalidParams, "secret_redaction_budget_exceeded");
      }
    },
    keyframesDir: (botId, recordingId) =>
      join(options.dataDir, "bots", botId, "teach", recordingId),
    guard: rulesGuard,
    logger: browserLogger,
    onTab: async (browser, tab) => {
      await logins.install(browser, tab);
      toolbars.attach(browser, tab);
    },
  });
  const frames = createBrowserFrames({
    browsers,
    transport: options.frames,
    logger: options.logger,
  });
  return {
    storage,
    env,
    officeRender,
    attachments,
    capabilities,
    connectorImports,
    logins,
    toolbars,
    browsers,
    frames,
  };
}
