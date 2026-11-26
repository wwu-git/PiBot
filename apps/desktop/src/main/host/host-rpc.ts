import type {
  BotBrowsers,
  BrowserFrames,
  BrowserGuard,
  BrowserLogins,
  UserBrowser,
} from "@pibot/browser/host";
import { registerBrowserHost, registerBrowserViewHost } from "@pibot/browser/host";
import type { ComputerGuard } from "@pibot/computer-use/host";
import type { Logger } from "@pibot/observability";
import type { createConnectorImportHost } from "@pibot/plugins/host";
import {
  createPeer,
  HostComputerGuardMethods,
  HostComputerMethods,
  HostMethods,
  type HostParams,
  type HostResults,
  type Params,
  type Port,
  type Result,
  RpcError,
  RpcErrorCodes,
  TeamTemplateSchema,
} from "@pibot/protocol";
import { assertSafeSecretValue, type Redactor, secretStorageReason } from "@pibot/secrets";
import { registerCredentialHost } from "../browser-adapter/login-host.ts";
import type { ComputerHost } from "../computer/computer-host.ts";
import { openExternalUrl } from "../window/external-url.ts";
import type { createHostCapabilities } from "./host-capabilities.ts";
import type { StorageCipher } from "./secure-storage.ts";

/** The answer a host without knowledge detection gives, so the tab can always render. */
const NO_KNOWLEDGE_DETECTION: HostResults["host.knowledge.detect"] = {
  obsidian: { installed: false, vaults: [] },
  notion: { installed: false },
};

export function registerHostRpc(
  port: Port,
  options: {
    storage: StorageCipher;
    connectorImports?: ReturnType<typeof createConnectorImportHost>;
    env: { detect(): string[]; read(name: string): string | undefined };
    redactor: Redactor;
    logger: Logger;
    updateProxy?(url: string | null | undefined): Promise<void>;
    openExternal(url: string): Promise<void>;
    setLoginItem(openAtLogin: boolean): Promise<void>;
    onBusyChange?(busy: boolean): void;
    memoryDreamActivity?(): HostResults["host.memoryDreamActivity"];
    remoteKeepAwake?(enabled: boolean): HostResults["host.remote.keepAwake"];
    routines?: {
      keepAwake(params: HostParams["host.keepAwake"]): Promise<HostResults["host.keepAwake"]>;
      updateTray(params: HostParams["tray.update"]): Promise<void>;
      backgroundState(): Promise<HostResults["host.backgroundState"]>;
    };
    capabilities?: Pick<
      ReturnType<typeof createHostCapabilities>,
      "pickFile" | "pickFolder" | "pickSkillFile" | "notify" | "openPath" | "teams" | "revealPath"
    >;
    officeRender?(
      params: HostParams["host.office.render"],
      signal: AbortSignal,
    ): Promise<HostResults["host.office.render"]>;
    attachments?: {
      image(
        params: HostParams["host.attachments.image"],
      ): Promise<HostResults["host.attachments.image"]>;
      pdf(params: HostParams["host.attachments.pdf"]): Promise<HostResults["host.attachments.pdf"]>;
      thumbnail(
        params: HostParams["host.attachments.thumbnail"],
      ): Promise<HostResults["host.attachments.thumbnail"]>;
      stepThumbnail(
        params: HostParams["host.attachments.stepThumbnail"],
      ): Promise<HostResults["host.attachments.stepThumbnail"]>;
      changeThumbnail(
        params: HostParams["host.attachments.changeThumbnail"],
      ): Promise<HostResults["host.attachments.changeThumbnail"]>;
      open(params: HostParams["host.attachments.open"]): Promise<void>;
    };
    /** Bot browser; absent where no browser host runs, methods then say unsupported. */
    browser?: {
      browsers: BotBrowsers;
      guard: BrowserGuard;
      frames?: BrowserFrames;
      /** Login fill / takeover capture. */
      logins?: BrowserLogins;
      /** The user's own browser through the extension. */
      userBrowser?: UserBrowser;
    };
    computer?: Pick<ComputerHost, "handle" | "officeApps" | "officeOpen">;
    /** Obsidian vault list / Notion app presence, read on this computer. */
    knowledge?: {
      detect(): Promise<HostResults["host.knowledge.detect"]>;
      /**
       * The brain verified the note; the host re-checks it, asks `confirm` once through
       * the same private peer and then opens the rebuilt `obsidian://` URI.
       */
      openNote(
        params: HostParams["host.knowledge.openNote"],
        signal: AbortSignal,
        confirm: (requestId: string) => Promise<void>,
      ): Promise<HostResults["host.knowledge.openNote"]>;
    };
    /** Indicator, stop shortcut, Automation warm-up, blocklist mirror. */
    computerGuard?: Pick<ComputerGuard, "handle">;
  },
) {
  const lifetime = new AbortController();
  const peer = createPeer(port, {
    methods: HostMethods,
    events: {},
    onError: ({ method, stage, issues }) => {
      if (stage !== "params" && stage !== "result") return;
      // A rejected result only reaches the caller as a bare internal error, so name the offending
      // fields here — paths, codes and refused keys only, never values.
      options.logger.error(
        JSON.stringify({
          module: "host",
          event: "rpc_validation_failed",
          method,
          stage,
          issues: issues ?? [],
        }),
      );
    },
  });
  let activeRequests = 0;
  let requestSequence = 0;
  const seenMethods = new Map<string, number>();
  function handle<K extends keyof typeof HostMethods>(
    method: K,
    action: (
      params: Params<typeof HostMethods, K>,
      signal: AbortSignal,
    ) => Promise<Result<typeof HostMethods, K>>,
  ) {
    peer.handle(method, async (params, context) => {
      const started = performance.now();
      const requestId = ++requestSequence;
      const count = (seenMethods.get(method) ?? 0) + 1;
      const trace = count <= 3;
      seenMethods.set(method, Math.min(4, count));
      const timing = (stage: string) =>
        options.logger.info(
          JSON.stringify({
            module: "host",
            event: "rpc_timing",
            method,
            requestId,
            stage,
            durationMs: Math.round(performance.now() - started),
          }),
        );
      if (trace) timing("started");
      if (++activeRequests === 1) options.onBusyChange?.(true);
      try {
        const result = await action(params, AbortSignal.any([lifetime.signal, context.signal]));
        if (trace) timing("action_finished");
        return result;
      } catch (error) {
        if (error instanceof RpcError) {
          const reason = method.startsWith("host.secrets.")
            ? ` reason=${secretStorageReason(error)}`
            : "";
          options.logger.warn(`host RPC ${method} code=${error.code}${reason}`);
        } else {
          // The type only (never the message, which may carry a page address or a path).
          options.logger.error(
            `host RPC ${method} error=${error instanceof Error ? error.name : typeof error}`,
          );
          if (method.startsWith("host.secrets."))
            throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
        }
        throw error;
      } finally {
        if (trace || performance.now() - started >= 1000) timing("finished");
        if (--activeRequests === 0) options.onBusyChange?.(false);
      }
    });
  }
  // Linux's basic_text backend reports available but does not provide a system keyring.
  // Keep this check inside request handlers: even probing safeStorage at startup can
  // prompt for macOS keychain access before the user needs any credentials.
  let storageProbed = false;
  const available = async () => {
    const trace = !storageProbed;
    storageProbed = true;
    const started = performance.now();
    let result: boolean | undefined;
    if (trace)
      options.logger.info(
        JSON.stringify({ module: "host", event: "secure_storage_probe", stage: "started" }),
      );
    try {
      result = await options.storage.isAsyncEncryptionAvailable();
      // The async API can fall back to an unprotected Linux provider. Refuse unknown/basic.
      if (options.storage.getSelectedStorageBackend) {
        const backend = options.storage.getSelectedStorageBackend();
        if (backend === "basic_text" || backend === "unknown") result = false;
      }
      return result;
    } finally {
      if (trace)
        options.logger.info(
          JSON.stringify({
            module: "host",
            event: "secure_storage_probe",
            stage: "finished",
            status: result === undefined ? "failed" : result ? "available" : "unavailable",
            durationMs: Math.round(performance.now() - started),
          }),
        );
    }
  };
  const requireStorage = async () => {
    if (!(await available()))
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
  };
  handle("host.secrets.isAvailable", async () => available());
  handle("host.secrets.encrypt", async ({ plain }) => {
    assertSafeSecretValue(plain);
    options.redactor.add(plain);
    await requireStorage();
    return new Uint8Array(await options.storage.encryptStringAsync(plain));
  });
  handle("host.secrets.decrypt", async ({ cipher }) => {
    await requireStorage();
    const { result: plain } = await options.storage.decryptStringAsync(Buffer.from(cipher));
    options.redactor.add(plain);
    return plain;
  });
  const imports = () => {
    if (!options.connectorImports)
      throw new RpcError(RpcErrorCodes.unsupported, "connector_import_unavailable");
    return options.connectorImports;
  };
  handle("host.pickConnectorImport", (params) => imports().pick(params));
  handle("host.adoptConnectorImport", (params) => {
    const host = imports();
    if (!host.adopt) throw new RpcError(RpcErrorCodes.unsupported, "connector_import_unavailable");
    return host.adopt(params);
  });
  handle("host.readConnectorImport", (params) => imports().read(params));
  handle("host.materializeConnectorImport", (params) => imports().materialize(params));
  handle("host.releaseConnectorImport", (params) => imports().release(params));
  handle("host.removeConnectorImport", (params) => imports().remove(params));
  handle("host.confirmConnectorCommand", (params, signal) => imports().confirm(params, signal));
  handle("host.env.detect", async () => options.env.detect());
  const capabilities = () => {
    if (!options.capabilities)
      throw new RpcError(RpcErrorCodes.internal, "host_capabilities_unavailable");
    return options.capabilities;
  };
  const routines = () => {
    if (!options.routines)
      throw new RpcError(RpcErrorCodes.unsupported, "routine_host_unavailable");
    return options.routines;
  };
  handle("host.remote.keepAwake", async ({ enabled }, signal) => {
    signal.throwIfAborted();
    return options.remoteKeepAwake?.(enabled) ?? "unsupported";
  });
  handle("host.memoryDreamActivity", async () => options.memoryDreamActivity?.() ?? null);
  handle("host.keepAwake", (params) => routines().keepAwake(params));
  handle("host.backgroundState", () => routines().backgroundState());
  handle("tray.update", async (params) => {
    await routines().updateTray(params);
    return null;
  });
  handle("host.pickFolder", async (params) => capabilities().pickFolder(params));
  // "Nothing installed" is the normal answer on an unsupported platform or a host without
  // the scan, so the Knowledge tab still gets a shape it can render instead of an error.
  handle("host.knowledge.detect", async () =>
    options.knowledge ? options.knowledge.detect() : NO_KNOWLEDGE_DETECTION,
  );
  // No host scan means no Obsidian to open, and the click says so instead of falling
  // back to a file path or a shell command.
  handle("host.knowledge.openNote", async (params, signal) => {
    const open = options.knowledge?.openNote;
    if (!open) throw new RpcError(RpcErrorCodes.unsupported, "knowledge_reference_unsupported");
    return open(params, signal, async (requestId) => {
      await peer.call("host.knowledge.confirmOpen", { requestId }, { timeoutMs: 10_000 });
    });
  });
  handle("host.pickFile", async (params) => capabilities().pickFile(params));
  handle("host.skills.pickFile", async () => capabilities().pickSkillFile());
  handle("host.teams.pickFile", async () => capabilities().teams.pickFile());
  handle("host.teams.read", async ({ file }) => capabilities().teams.read(file));
  handle("host.teams.save", async (params) =>
    "archive" in params
      ? capabilities().teams.saveArchive(params.archive, params.defaultName)
      : capabilities().teams.save(TeamTemplateSchema.parse(params.template)),
  );
  handle("host.teams.cancel", async () => {
    capabilities().teams.cancel();
    return null;
  });
  handle("host.notify", async (params) => capabilities().notify(params));
  handle("host.openPath", async (params) => {
    await capabilities().openPath(params);
    return null;
  });
  handle("host.revealPath", async (params) => {
    await capabilities().revealPath(params);
    return null;
  });
  handle("host.attachments.image", async (params) => {
    if (!options.attachments)
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_host_unavailable");
    return options.attachments.image(params);
  });
  handle("host.attachments.pdf", async (params) => {
    if (!options.attachments)
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_host_unavailable");
    return options.attachments.pdf(params);
  });
  handle("host.attachments.thumbnail", async (params) => {
    if (!options.attachments)
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_host_unavailable");
    return options.attachments.thumbnail(params);
  });
  handle("host.attachments.stepThumbnail", async (params) => {
    if (!options.attachments)
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_host_unavailable");
    return options.attachments.stepThumbnail(params);
  });
  handle("host.attachments.changeThumbnail", async (params) => {
    if (!options.attachments)
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_host_unavailable");
    return options.attachments.changeThumbnail(params);
  });
  handle("host.attachments.open", async (params) => {
    if (!options.attachments)
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_host_unavailable");
    await options.attachments.open(params);
    options.logger.info(`audit host.attachments.open botId=${params.botId}`);
    return null;
  });
  registerBrowserHost(handle, options.browser, options.logger);
  const frames = options.browser?.frames;
  const logins = options.browser?.logins;
  registerBrowserViewHost(
    handle,
    options.browser && frames
      ? { browsers: options.browser.browsers, frames, ...(logins ? { logins } : {}) }
      : undefined,
    options.logger,
  );
  registerCredentialHost(
    handle,
    options.browser && logins ? { browsers: options.browser.browsers, logins } : undefined,
    options.logger,
  );
  handle("host.office.render", async (params, signal) => {
    if (!options.officeRender)
      throw new RpcError(RpcErrorCodes.unsupported, "office_host_unavailable");
    return options.officeRender(params, signal);
  });
  handle("host.officeApps", async (params) => {
    if (!options.computer) throw new RpcError(RpcErrorCodes.unsupported, "office_host_unavailable");
    return options.computer.officeApps(params, lifetime.signal);
  });
  handle("host.officeOpen", async (params) => {
    if (!options.computer) throw new RpcError(RpcErrorCodes.unsupported, "office_host_unavailable");
    return options.computer.officeOpen(params, lifetime.signal);
  });
  // Operating the computer: every call goes through the same handle() wrapper; the
  // computer service checks the grant token and maps refusals to results itself.
  for (const method of Object.keys(HostComputerMethods) as (keyof typeof HostComputerMethods)[])
    handle(method, async (params, signal) => {
      if (!options.computer)
        throw new RpcError(RpcErrorCodes.unsupported, "computer_host_unavailable");
      return options.computer.handle(method, params, signal);
    });
  for (const method of Object.keys(
    HostComputerGuardMethods,
  ) as (keyof typeof HostComputerGuardMethods)[])
    handle(method, async (params) => {
      if (!options.computerGuard)
        throw new RpcError(RpcErrorCodes.unsupported, "computer_guard_unavailable");
      return options.computerGuard.handle(method, params);
    });
  handle("host.updates.proxy", async ({ url }) => {
    await options.updateProxy?.(url);
    return null;
  });
  handle("host.env.read", async ({ name }) => options.env.read(name) ?? null);
  handle("host.openExternal", async ({ url }) => {
    await openExternalUrl(url, options.openExternal, options.logger);
    return null;
  });
  handle("host.setLoginItem", async ({ openAtLogin }) => {
    await options.setLoginItem(openAtLogin);
    options.logger.info(`audit host.setLoginItem openAtLogin=${openAtLogin}`);
    return null;
  });
  return {
    ...peer,
    dispose() {
      lifetime.abort();
      peer.dispose();
    },
  };
}
