// Compose and start the platform-independent brain kernel.
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentRuntime,
  createAgentRuntime,
  installAgentNetwork,
  sanitizeBrainEnv,
} from "@pibot/agent";
import { type AliasFileSystem, fetchImage } from "@pibot/execution";
import {
  type BackgroundPreferences,
  BaseInboxItemSchema,
  type BrainWakeControl,
  type BrainWakeResult,
  type BrowserHostMethods,
  type CapabilityToolRegistry,
  type CredentialHostMethods,
  createPeer,
  type EventTable,
  type HostComputerGuardMethods,
  type HostComputerMethods,
  type InboxItemEnvelope,
  KernelEvents,
  type KernelHostParams,
  type KernelHostResults,
  type KernelMethodParams,
  type KernelMethodResults,
  KernelMethods,
  type MethodTable,
  type Peer,
  type Port,
  RpcError,
  RpcErrorCodes,
  type TeamTemplate,
  type UiNavigation,
} from "@pibot/protocol-base";
import type { SecretCipher } from "@pibot/secrets";
import {
  AuditRepo,
  BackgroundPreferencesRepo,
  BrainWakeRepo,
  type InboxSource,
  KEPT_QUEUED,
  LiveActivityRepo,
  openDatabase,
  RunEventsRepo,
  RunsRepo,
  runMigrationsYielding,
} from "@pibot/storage";
import type { z } from "zod";
import type { AttachmentHost } from "./conversations/attachments/attachment-types.ts";
import { registerPreviewRpc } from "./conversations/attachments/file-preview-rpc.ts";
import { registerBotRpc } from "./conversations/bots/bot-rpc.ts";
import { BotService } from "./conversations/bots/bot-service.ts";
import { registerPersonalTodoRpc } from "./conversations/bots/personal-todos.ts";
import { ChatService } from "./conversations/chat/chat.ts";
import { registerChatCompaction } from "./conversations/chat/chat-compaction.ts";
import { ChatNoticeService, registerChatNoticeRpc } from "./conversations/chat/chat-notices.ts";
import { ContextHintService, registerChatContextHint } from "./conversations/chat/context-hint.ts";
import { registerConversationRetry } from "./conversations/chat/conversation-retry.ts";
import { registerMessageActions } from "./conversations/chat/message-actions.ts";
import { registerNavigationRpc } from "./conversations/chat/navigation-service.ts";
import { abortable } from "./core/abort.ts";
import {
  type BrainCapability,
  type CapabilityHandle,
  type SleepParticipant,
  stopCapabilities,
  type UnattendedRunOwner,
} from "./core/capability.ts";
import type { HostCall } from "./core/host-call.ts";
import type { LocalDependencies } from "./core/local-types.ts";
import type { GroupOrchestrationPort, OrchestrationFactory } from "./core/orchestration.ts";
import { redactRpcImage } from "./core/rpc-image-redaction.ts";
import { registerSearchRpc } from "./integrations/search/search-rpc.ts";
import { SearchService } from "./integrations/search/search-service.ts";
import { NetworkProxyService } from "./integrations/system/network-proxy.ts";
import { LocalService } from "./local-service.ts";
import { registerBackgroundRpc } from "./runtime/background/background-rpc.ts";
import type { BrowserViewHost } from "./runtime/browser/port.ts";
import { logRunFinished, registerDiagnosticsRpc } from "./runtime/diagnostics.ts";
import { RunRetention } from "./runtime/history/run-retention.ts";
import { notifyCompletedRun, registerBotHooksRpc } from "./runtime/hooks/bot-hooks.ts";
import type { ModelProvidersPort } from "./runtime/models/port.ts";
import { registerUserQuestionRpc } from "./runtime/questions/user-questions.ts";
import { createActiveRunStatus } from "./runtime/queue/active-runs.ts";
import { resumeApproval } from "./runtime/queue/approval-resume.ts";
import { BrainSleep } from "./runtime/queue/brain-sleep.ts";
import { createLiveActivity } from "./runtime/queue/live-activity.ts";
import { reconcileSessionTails, snapshotSessionTails } from "./runtime/queue/session-tail.ts";
import { registerReceiptRpc } from "./runtime/receipts/run-receipt.ts";
import { registerAgentReviewRpc } from "./runtime/review/agent-review-rpc.ts";
import { registerBusinessRpc } from "./runtime/startup/business-rpc.ts";
import { startChatSearchBackfill } from "./runtime/startup/chat-search-backfill.ts";
import { gateAgentContent } from "./runtime/startup/content-readiness.ts";
import { createBrainController } from "./runtime/startup/create-brain-controller.ts";
import { createKernelStorage } from "./runtime/startup/create-kernel-storage.ts";
import { deferredMaintenance } from "./runtime/startup/deferred-maintenance.ts";
import { firstRpcDiagnostics } from "./runtime/startup/first-rpcs.ts";
import { watchBrainLoop } from "./runtime/startup/loop-stall-watch.ts";
import { registerAcpRpc } from "./runtime/startup/register-acp-rpc.ts";
import { registerAppRpc } from "./runtime/startup/register-app-rpc.ts";
import { registerCapabilities } from "./runtime/startup/register-capabilities.ts";
import { registerChatRpc } from "./runtime/startup/register-chat-rpc.ts";
import { registerHealthRpc } from "./runtime/startup/register-health-rpc.ts";
import { sdkIdlePreload } from "./runtime/startup/sdk-idle-preload.ts";
import { createStartupProgress } from "./runtime/startup/startup-progress.ts";
import { createStartupTiming } from "./runtime/startup/startup-timing.ts";
import { registerCapabilityRpc } from "./runtime/tools/capabilities/capability-rpc.ts";
import { registerLocalRpc } from "./runtime/tools/local-rpc.ts";
import { workspaceResources } from "./runtime/workspaces/gateway.ts";
import type { ManagedResourcesPort } from "./runtime/workspaces/port.ts";

export type {
  BrainCapability,
  CapabilityContext,
  CapabilityHandle,
  CapabilityPorts,
} from "./core/capability.ts";

export type { BrowserViewHost } from "./runtime/browser/port.ts";
/** The role engine writes a role's `autoCheck` default when it creates a Bot. */
export { defaultAutoCheckForNewBot } from "./runtime/checks/auto-check.ts";

export interface BrainHost {
  office?: {
    render?(
      params: KernelHostParams["host.office.render"],
      signal: AbortSignal,
    ): Promise<KernelHostResults["host.office.render"]>;
    apps(
      params: KernelHostParams["host.officeApps"],
      signal: AbortSignal,
    ): Promise<KernelHostResults["host.officeApps"]>;
    open(params: KernelHostParams["host.officeOpen"], signal: AbortSignal): Promise<void>;
  };
  connectorImports?: import("@pibot/protocol-base").ConnectorImportHost;
  confirmConnectorCommand?(
    input: import("@pibot/protocol-base").ConnectorCommandConfirmation,
    signal?: AbortSignal,
  ): Promise<{ approved: boolean }>;
  teams?: {
    pickFile(signal: AbortSignal): Promise<string | null>;
    /** The picked file's raw bytes, base64. */
    read(file: string, signal: AbortSignal): Promise<string>;
    save(
      payload: { template: TeamTemplate } | { archive: string; defaultName?: string },
      signal: AbortSignal,
    ): Promise<{ saved: boolean }>;
    cancel(): Promise<void>;
  };
  updateProxy?(url: string | null | undefined): Promise<void>;
  openExternal?(url: string, signal: AbortSignal): Promise<void>;
  /** `create` lets the user make a new folder in the dialog and pick it. */
  pickFolder?(
    signal?: AbortSignal,
    options?: { create?: boolean; defaultPath?: string },
  ): Promise<string | null>;
  /** Generic document picker used by contract workflow inputs. */
  pickFile?(signal?: AbortSignal, options?: { defaultPath?: string }): Promise<string | null>;
  /**
   * A read-only look at whether this computer already has Obsidian / Notion, so the
   * Knowledge tab can offer what is here. Absent where no host scan exists (server brain, tests),
   * which the caller treats as "nothing found".
   */
  knowledge?: {
    detect(signal: AbortSignal): Promise<KernelHostResults["host.knowledge.detect"]>;
    /**
     * Open one note the brain has already verified. The host re-checks the identities,
     * calls `confirm` once after its slow configuration read and before the system open, and
     * rebuilds the `obsidian://` URI itself. Absent where no desktop host exists, and the click
     * then answers "unsupported" instead of trying a file path or a command.
     */
    openNote?(
      params: KernelHostParams["host.knowledge.openNote"],
      signal: AbortSignal,
      confirm: () => Promise<void>,
    ): Promise<KernelHostResults["host.knowledge.openNote"]>;
  };
  /** Skill import picker: a SKILL.md or a .zip; null when the user cancels. */
  skills?: { pickFile(signal: AbortSignal): Promise<string | null> };
  memoryDreamActivity?(signal: AbortSignal): Promise<KernelHostResults["host.memoryDreamActivity"]>;
  notify?(
    params: KernelHostParams["host.notify"],
    signal?: AbortSignal,
  ): Promise<KernelHostResults["host.notify"]>;
  openPath?(params: { path: string; allowedRoots: string[] }, signal?: AbortSignal): Promise<void>;
  revealPath?(
    params: { path: string; allowedRoots: string[] },
    signal?: AbortSignal,
  ): Promise<void>;
  attachments?: AttachmentHost;
  /** Bot browser overlay controls; absent where no browser host runs. */
  browserView?: BrowserViewHost;
  /** Operating the computer in the background process; unset on hosts without it. */
  computer?: HostCall<typeof HostComputerMethods>;
  /** The per-Bot browser in the background process; unset on hosts without it. */
  browser?: HostCall<typeof BrowserHostMethods>;
  secrets: SecretCipher;
  env: { detect(): Promise<string[]>; read(name: string): Promise<string | undefined> };
  /** Indicator, stop shortcut, Automation warm-up and blocklist mirror. */
  computerGuard?: HostCall<typeof HostComputerGuardMethods>;
  /**
   * Login fill / takeover capture in the Bot browser and system authentication before a
   * saved password is shown. The password crosses this port only for one fill or one save.
   */
  credentials?: HostCall<typeof CredentialHostMethods>;
}

export async function startBrain(opts: {
  aliasFileSystem?: AliasFileSystem;
  executionTarget?: import("@pibot/execution").ExecutionTarget;
  executionLocation?: {
    target: import("@pibot/protocol-base").ExecutionLocationTarget;
    platform: "darwin" | "linux" | "win32";
  };
  port: Port;
  /** Source is supplied by the trusted composition root, never decoded from RPC JSON. */
  requestSource?: () => "acp" | "desktop-main" | undefined;
  /** True while the paired phone's own request is being handled (the remote kernel bridge). */
  isPhoneRequest?: () => boolean;
  acp?: import("@pibot/protocol-base").AcpAttachmentPort;
  host: BrainHost;
  dataDir: string;
  resourcesDir?: string;
  version: string;
  platform: NodeJS.Platform;
  /** Trusted, sanitized login-shell PATH supplied by the desktop host. */
  terminalPath?: readonly string[];
  /**
   * Evaluation only: names the model must not be offered, so one commit can be measured
   * with and without the code-navigation tools. Removing a tool never grants another one.
   */
  hiddenTools?: readonly string[];
  /** Optional content-free model receipts for the headless evaluation host. */
  modelRequest?: LocalDependencies["modelRequest"];
  dev?: boolean;
  interactiveAttached?: boolean;
  backgroundControlIdle?: () => boolean;
  /** L4 implementation supplied by the product composition root. */
  orchestration: OrchestrationFactory;
  /** Enabled capability packages, in start order (passed by `@pibot/brain-app`). */
  capabilities?: readonly BrainCapability[];
  /** Product-owned protocol and capability data; defaults keep kernel-only probes self-contained. */
  composition?: {
    methods: MethodTable;
    events: EventTable;
    tools: CapabilityToolRegistry;
    inboxItemSchema: z.ZodType<InboxItemEnvelope>;
  };
  /** Acceptance probes only: serve stubbed pages through the real web_fetch path. */
  pageFetch?: LocalDependencies["fetchPage"];
  /** Acceptance probes only: a shorter image generation cap so a timeout can be exercised. */
  imageGenerationTimeoutMs?: number;
  /**
   * The owner's startup watchdog sees only host RPC, so a phase that calls no host
   * method (session-tail recovery can take tens of seconds on a real data directory) looked
   * dead. Reporting a phase is a liveness signal, never authorization or readiness.
   */
  startupProgress?(phase: string): void;
}): Promise<{
  /** The login-shell PATH read after startup; commands use it from their next run. */
  updateTerminalPath(path: readonly string[]): void;
  navigate(target: UiNavigation): void;
  desktopClient(connected: boolean): Promise<void>;
  backgroundPreferences(value?: BackgroundPreferences): BackgroundPreferences;
  backgroundSleep(input: BrainWakeControl): Promise<BrainWakeResult>;
  backgroundActivity(): boolean;
  /** Milliseconds since the last user-side request, for work that should wait for a quiet moment. */
  quietForMs(): number;
  /** Names a phase for the event-loop stall log (fixed identifiers only). */
  markPhase(phase: string): void;
  stop(): Promise<void>;
}> {
  const timingRaw = createStartupTiming();
  // The owner's watchdog only counted host RPC, so a phase that talks to no host (the
  // session-tail recovery below can take tens of seconds on a real data directory) looked dead and
  // the child was killed mid-startup, over and over. A beat names the phase whose last unit of work
  // finished, and nothing is sent while nothing finishes: an unconditional beat would keep renewing
  // the watchdog window for a hung await, which is the failure the watchdog exists to catch.
  const progress = opts.startupProgress ? createStartupProgress(opts.startupProgress) : undefined;
  const timing: ReturnType<typeof createStartupTiming> = {
    ...timingRaw,
    mark(name) {
      timingRaw.mark(name);
      progress?.advance(timingRaw.lastPhase());
    },
  };
  const composition = opts.composition ?? {
    methods: KernelMethods,
    events: KernelEvents,
    tools: { specs: {}, groups: [] },
    inboxItemSchema: BaseInboxItemSchema,
  };
  const dataDir = resolve(opts.dataDir);
  const executionEnv = { ...process.env };
  const baseExecutionPath = executionEnv.PATH ?? "";
  const updateTerminalPath = (path: readonly string[]) => {
    executionEnv.PATH = [...path, baseExecutionPath].filter(Boolean).join(":");
  };
  if (opts.terminalPath?.length) {
    updateTerminalPath(opts.terminalPath);
  }
  const userHome = homedir();
  const tempDir = tmpdir();
  sanitizeBrainEnv(process.env, dataDir);
  if (!["darwin", "win32", "linux"].includes(opts.platform))
    throw new Error("Unsupported platform");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  timing.mark("data_dir");
  const db = openDatabase(join(dataDir, "pibot.db"));
  timing.mark("db_open");
  let cleanup: (() => void) | undefined;
  let local: LocalService | undefined;
  let managedResources: ManagedResourcesPort | undefined;
  let unsubscribeCheckpoints: (() => void) | undefined;
  let botService: BotService | undefined;
  let groupService: GroupOrchestrationPort | undefined;
  let chatService: ChatService | undefined;
  let networkCleanup: (() => Promise<void>) | undefined;
  let modelPort: ModelProvidersPort | undefined;
  let runRetention: RunRetention | undefined;
  let startupDiagnostics: ReturnType<typeof firstRpcDiagnostics> | undefined;
  let loopWatch: ReturnType<typeof watchBrainLoop> | undefined;
  let sdkPreload: ReturnType<typeof sdkIdlePreload> | undefined;
  let lastUserActivity = 0;
  let maintenance: ReturnType<typeof deferredMaintenance> | undefined;
  const sessionTailController = new AbortController();
  let sessionTailReconciliation: Promise<void> | undefined;
  let resolveSessionGate = () => {};
  let rejectSessionGate = (_error: unknown) => {};
  const sessionGate = new Promise<void>((resolve, reject) => {
    resolveSessionGate = resolve;
    rejectSessionGate = reject;
  });
  // An initialization failure may reject the gate before any run is waiting on it.
  void sessionGate.catch(() => {});
  let sessionTailsReady = false;
  async function stopSessionRecovery() {
    sessionTailController.abort();
    if (sessionTailReconciliation) await Promise.allSettled([sessionTailReconciliation]);
  }
  const models = () => {
    if (!modelPort) throw new RpcError(RpcErrorCodes.unsupported, "model_providers_unavailable");
    return modelPort;
  };
  let capabilityHandles: CapabilityHandle[] = [];
  try {
    // Each finished migration is a unit of startup work: yielding lets the progress beat reach
    // the host, whose watchdog otherwise sees a silent, idle process during a fresh install.
    await runMigrationsYielding(db, async () => {
      progress?.advance("migrations");
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    timing.mark("migrations");
    for (const capability of opts.capabilities ?? []) capability.recover?.(db);
    timing.mark("capability_recover");
    const startup: Parameters<typeof createKernelStorage>[0] &
      Parameters<typeof registerBusinessRpc>[0] &
      Parameters<typeof registerAppRpc>[0] &
      Parameters<typeof registerChatRpc>[0] &
      Parameters<typeof registerHealthRpc>[0] &
      Parameters<typeof registerCapabilities>[0] &
      Parameters<typeof createBrainController>[0] = {
      get db() {
        return db;
      },
      updateTerminalPath,
      get dataDir() {
        return dataDir;
      },
      get opts() {
        return opts;
      },
      get stopping() {
        return stopping;
      },
      set stopping(value) {
        stopping = value;
      },
      get sleep() {
        return sleep;
      },
      set sleep(value) {
        sleep = value;
      },
      get interactiveAttached() {
        return interactiveAttached;
      },
      set interactiveAttached(value) {
        interactiveAttached = value;
      },
      stopSessionRecovery,
      get loopWatch() {
        return loopWatch;
      },
      noteUserActivity: () => {
        lastUserActivity = performance.now();
      },
      quietForMs: () => performance.now() - lastUserActivity,
      markPhase: (phase: string) => loopWatch?.mark(phase),
      get startupDiagnostics() {
        return startupDiagnostics;
      },
      stopStartupMaintenance: async () => {
        startupDiagnostics?.stop();
        sdkPreload?.stop();
        await maintenance?.stop();
      },
      waitForSessionRecovery,
      waitForContent,
      get offlineAllowed() {
        return offlineAllowed;
      },
      get requests() {
        return requests;
      },
      get backgroundPrefixes() {
        return backgroundPrefixes;
      },
      get interactiveRequests() {
        return interactiveRequests;
      },
      get logger() {
        return logger;
      },
      get peer() {
        return peer;
      },
      get network() {
        return network;
      },
      get capabilities() {
        return capabilities;
      },
      get handle() {
        return handle;
      },
      get networkChanged() {
        return networkChanged;
      },
      set networkChanged(value) {
        networkChanged = value;
      },
      get search() {
        return search;
      },
      get providerTests() {
        return providerTests;
      },
      set providerTests(value) {
        providerTests = value;
      },
      get settings() {
        return settings;
      },
      get models() {
        return models;
      },
      get audit() {
        return audit;
      },
      get bots() {
        return bots;
      },
      dependencyManifest: new URL("../third-party-dependencies.json", import.meta.url),
      timing,
      get groups() {
        return groups;
      },
      get chat() {
        return chat;
      },
      get local() {
        return local;
      },
      set local(value) {
        local = value;
      },
      get interactiveDrainHealthy() {
        return interactiveDrainHealthy;
      },
      set interactiveDrainHealthy(value) {
        interactiveDrainHealthy = value;
      },
      get modelPort() {
        return modelPort;
      },
      set modelPort(value) {
        modelPort = value;
      },
      get clientChange() {
        return clientChange;
      },
      set clientChange(value) {
        clientChange = value;
      },
      get redactor() {
        return redactor;
      },
      get agent() {
        return agent;
      },
      get botBusiness() {
        return botBusiness;
      },
      get claimUnattended() {
        return claimUnattended;
      },
      get secrets() {
        return secrets;
      },
      get chatNotices() {
        return chatNotices;
      },
      get resources() {
        return resources;
      },
      get inboxSources() {
        return inboxSources;
      },
      get sleepParticipants() {
        return sleepParticipants;
      },
      get sleepService() {
        return sleepService;
      },
      get capabilityHandles() {
        return capabilityHandles;
      },
      set capabilityHandles(value) {
        capabilityHandles = value;
      },
      get backgroundPreferences() {
        return backgroundPreferences;
      },
      get unsubscribeCheckpoints() {
        return unsubscribeCheckpoints;
      },
      set unsubscribeCheckpoints(value) {
        unsubscribeCheckpoints = value;
      },
      get networkCleanup() {
        return networkCleanup;
      },
      set networkCleanup(value) {
        networkCleanup = value;
      },
      get runRetention() {
        if (!runRetention) throw new Error("Run retention unavailable");
        return runRetention;
      },
    };
    const { settings, bots, redactor, logger, secrets } = createKernelStorage(startup);
    startupDiagnostics = firstRpcDiagnostics(logger);
    loopWatch = watchBrainLoop(logger);
    const recoveryEvents = new RunEventsRepo(db);
    const recoveryRunRowId = recoveryEvents.latestRunRowId();
    timing.mark("kernel_storage");
    const sessionTails = snapshotSessionTails(recoveryEvents, sessionTailController.signal, () =>
      progress?.advance("session_tail_snapshot"),
    );
    timing.mark("session_tail_snapshot");
    logger.info(
      JSON.stringify({
        module: "startup",
        event: "session_tail_snapshot_ready",
        legacyMs: sessionTails.legacyMs,
        candidateScanMs: sessionTails.candidateScanMs,
      }),
    );

    const audit = new AuditRepo(db, redactor);
    runRetention = new RunRetention(db, dataDir, logger);
    let networkChanged = (_value: KernelMethodResults["network.getConfig"]) => {};
    const network = new NetworkProxyService(
      db,
      opts.host.secrets,
      redactor,
      (value) => {
        networkChanged(value);
        void syncUpdateProxy();
      },
      (action, address) =>
        audit.append({
          botId: bots.getMain()?.id ?? "",
          kind: "network.changed",
          summary: `Proxy ${action}`,
          detail: {
            actor: "user",
            reasonCode: `proxy_${action}`,
            ...(address ? { target: address.slice(0, 200) } : {}),
          },
        }),
    );
    networkCleanup = () => network.stop();
    const syncUpdateProxy = async () => {
      try {
        let url: string | null | undefined;
        try {
          url = network.proxy()?.url ?? null;
        } catch {
          // Enabled but locked credentials must never silently fall back to a direct update.
          url = undefined;
        }
        await opts.host.updateProxy?.(url);
      } catch {
        logger.warn("Update proxy synchronization unavailable");
      }
    };
    await network.initialize();
    await syncUpdateProxy();
    timing.mark("network");
    const agentNetwork = installAgentNetwork(
      network.transport.fetch,
      () => network.get().enabled,
      () => network.proxy()?.url,
    );
    networkCleanup = async () => {
      await network.stop();
      agentNetwork.dispose();
    };
    const search = new SearchService(
      db,
      opts.host.secrets,
      redactor,
      () => models().changed(),
      undefined,
      undefined,
      undefined,
      undefined,
      () => network.proxy(),
    );
    const sdk = createAgentRuntime({
      dataDir,
      network: agentNetwork,
      // An image service's result link: the user chose the service, not each CDN host it links,
      // so the Bot's website list does not apply; address, redirect and size rules still do.
      fetchImageUrl: async ({ url, signal }) => ({
        data: (
          await fetchImage({
            url,
            signal,
            proxy: network.proxy(),
            allowDomain: () => true,
            redirects: 3,
            binary: true,
          })
        ).data,
      }),
      hasApiKey: (id) => models().hasApiKey(id),
      getApiKey: (id) => models().getApiKey(id),
      customProviders: () => models().customProviders(),
      addedModels: () => models().addedModels?.() ?? {},
      onCustomModelLimit: (providerId, modelId, limits) =>
        models().updateCustomModelLimits?.(providerId, modelId, limits),
      auxiliaryModel: () => settings.get().auxiliaryModel,
      auxiliaryModelFallback: (purpose, code) =>
        logger.warn(
          JSON.stringify({ module: "agent", event: "auxiliary_model_fallback", purpose, code }),
        ),
      sdkWarmupFailed: (code) =>
        logger.warn(JSON.stringify({ module: "agent", event: "pi_sdk_warmup_failed", code })),
      get auth() {
        return models().auth;
      },
    });
    sdk.deferSdk?.(2000);
    async function waitForContent(signal?: AbortSignal) {
      await local?.readyForContent(signal ?? sessionTailController.signal);
    }
    async function waitForSessionRecovery(signal?: AbortSignal) {
      signal?.throwIfAborted();
      sessionTailController.signal.throwIfAborted();
      if (sessionTailsReady) return;
      try {
        await abortable(
          sessionGate,
          AbortSignal.any([
            sessionTailController.signal,
            AbortSignal.timeout(20_000),
            ...(signal ? [signal] : []),
          ]),
        );
        signal?.throwIfAborted();
        sessionTailController.signal.throwIfAborted();
      } catch {
        signal?.throwIfAborted();
        sessionTailController.signal.throwIfAborted();
        throw new RpcError(RpcErrorCodes.busy, "session_recovery_unavailable");
      }
    }
    // All queue entry points, including unattended runs, share the SDK boundary. Attaching
    // the GUI only changes admission; it cannot bypass reconciliation or the terminal seal.
    const contentRuntime = gateAgentContent(sdk, waitForContent, redactor);
    const compactHistory = contentRuntime.compactHistory;
    const agent: AgentRuntime = {
      ...contentRuntime,
      async openSession(input) {
        loopWatch?.mark("open.start");
        const openedAt = performance.now();
        await waitForSessionRecovery(input.signal);
        const session = await contentRuntime.openSession({
          ...input,
          phase: (name) => loopWatch?.mark(`open.${name}`),
          phaseTiming: (phase, elapsedMs) =>
            logger.info(
              JSON.stringify({
                module: "brain",
                event: "session_open_phase",
                phase,
                elapsedMs,
              }),
            ),
        });
        loopWatch?.mark("open.done");
        logger.info(
          JSON.stringify({
            module: "brain",
            event: "session_open_total",
            elapsedMs: Math.round(performance.now() - openedAt),
          }),
        );
        return session;
      },
      ...(compactHistory && {
        async compactHistory(input) {
          await waitForSessionRecovery(input.signal);
          return compactHistory(input);
        },
      }),
    };
    const rpcPeer = createPeer(
      {
        ...opts.port,
        post: (message) => {
          opts.port.post(redactRpcImage(message, redactor));
        },
        onMessage: (listener) => opts.port.onMessage(listener),
      },
      {
        methods: composition.methods as typeof KernelMethods,
        events: composition.events as typeof KernelEvents,
        onError: ({ method, stage, issues }) => {
          if (stage !== "params" && stage !== "result") return;
          // The field paths (never values) say which field a strict schema refused; a bare
          // "Result validation failed" left the failing field unknown.
          logger.error(
            JSON.stringify({
              module: "rpc",
              event: "validation_failed",
              method,
              stage,
              issues: (issues ?? []).slice(0, 20),
            }),
          );
        },
      },
    );
    const activeRuns = createActiveRunStatus(new RunsRepo(db), (count) =>
      rpcPeer.emit("runtime.activeRuns", { count }),
    );
    const liveActivity = createLiveActivity(
      new LiveActivityRepo(db),
      (value) => rpcPeer.emit("runtime.liveActivity", value),
      () => logger.warn(JSON.stringify({ module: "live-island", event: "read_failed" })),
    );
    const offActiveRuns = opts.port.onClose?.(() => {
      activeRuns.dispose();
      liveActivity.dispose();
    });
    const peer: typeof rpcPeer = {
      ...rpcPeer,
      emit(event, payload) {
        rpcPeer.emit(event, payload);
        activeRuns.changed(event);
        liveActivity.changed(event);
      },
      dispose() {
        activeRuns.dispose();
        liveActivity.dispose();
        offActiveRuns?.();
        rpcPeer.dispose();
      },
    };
    cleanup = () => peer.dispose();
    timing.mark("agent_runtime");
    local = new LocalService({
      aliasFileSystem: opts.aliasFileSystem,
      executionTarget: opts.executionTarget,
      executionLocation: opts.executionLocation,
      capabilityTools: composition.tools,
      orchestration: opts.orchestration,
      db,
      dataDir,
      resourcesDir: opts.resourcesDir,
      platform: opts.platform as "darwin" | "linux" | "win32",
      hiddenTools: opts.hiddenTools,
      modelRequest: opts.modelRequest,
      env: executionEnv,
      userHome,
      tempDir,
      host: opts.host,
      peer: peer as Peer<MethodTable, EventTable>,
      redactor,
      logger,
      search,
      proxy: () => network.proxy(),
      downloadImage: (input) => fetchImage({ ...input, proxy: network.proxy() }),
      extractPage: agent.extractPage,
      fetchPage: opts.pageFetch,
      imageGenerationTimeoutMs: opts.imageGenerationTimeoutMs,
    });
    const capabilities = local;
    timing.mark("local_service");
    chatService = new ChatService(
      db,
      dataDir,
      agent,
      peer,
      logger,
      redactor,
      opts.host.attachments,
      capabilities,
      (id) => models().credentials(id),
    );
    const chat = chatService;
    const contextHints = new ContextHintService({ db, agent });
    timing.mark("chat_service");
    await chat.attachments.recover(
      bots.list().map((bot) => bot.id),
      AbortSignal.timeout(10_000),
    );
    // Background commands a previous brain left running have no owner any more.
    timing.mark("attachments_recover");
    await capabilities.background.recover(AbortSignal.timeout(15_000));
    timing.mark("background_recover");
    botService = new BotService({
      db,
      dataDir,
      agent,
      modelSettings: { updateBot: (...args) => models().settings.updateBot(...args) },
      chat,
      local: capabilities,
      peer,
      redactor,
      logger,
      requireCredentials: (id) => models().credentials(id),
    });
    const botBusiness = botService;
    botBusiness.start();
    timing.mark("bot_service");
    // A killed utilityProcess cannot resume an in-flight prompt; keep its checkpoint. A
    // workflow run the restart kept queued keeps its waiting bubble too (`chat.recoverQueued`).
    db.prepare(
      `UPDATE messages SET status = 'aborted', error_code = 'aborted' WHERE status = 'streaming' AND id NOT IN (SELECT e.message_id FROM runs e JOIN unattended_runs r ON r.run_id=e.id WHERE r.status IN ('waiting','scheduled') AND r.wait_checkpoint IS NOT NULL AND r.owner_token IS NULL) AND id NOT IN (SELECT r.message_id FROM runs r JOIN run_recovery x ON x.run_id=r.id WHERE r.status='queued' AND ${KEPT_QUEUED})`,
    ).run();
    timing.mark("abort_streaming");
    groupService = opts.orchestration.createGroups({
      db,
      dataDir,
      chat,
      agent,
      local: capabilities,
      peer,
      redactor,
      logger,
      requireCredentials: (id) => models().credentials(id),
    });
    const groups = groupService;
    capabilities.approvals.pausedResolve = (id, decision) => resumeApproval(groups, id, decision);
    timing.mark("group_service");
    const resources = workspaceResources(capabilities);
    managedResources = resources;
    registerConversationRetry(handle, chat, resources, {
      db,
      dataDir,
      redactor,
      peer,
      platform: opts.platform,
      waitForSessionRecovery,
    });
    unsubscribeCheckpoints = chat.queue.onDrained(async ({ record, context, signal }) => {
      logRunFinished(capabilities, record.id);
      await resources.captureDrained(context, record, signal);
      await notifyCompletedRun(capabilities, { record, context, signal });
    });
    let interactiveAttached = opts.interactiveAttached !== false;
    chat.admitInteractive(interactiveAttached);
    groups.admitInteractive(interactiveAttached);
    const backgroundPreferences = new BackgroundPreferencesRepo(db);
    let clientChange = Promise.resolve();
    let interactiveDrainHealthy = true;
    let stopping = false;
    let providerTests = new AbortController();
    let sleep: BrainSleep | undefined;
    const requests = new Set<Promise<unknown>>();
    const interactiveRequests = new Set<Promise<unknown>>();
    const offlineAllowed = new Set<string>(["settings.get", "settings.set"]);
    const backgroundPrefixes: string[] = [];
    function handle<K extends keyof typeof KernelMethods>(
      method: K,
      action: (
        params: KernelMethodParams[K],
        context: import("./core/business-rpc.ts").RpcRequestContext,
      ) => Promise<KernelMethodResults[K]>,
    ) {
      return registerBusinessRpc(startup, method, action);
    }
    registerLocalRpc(handle, capabilities);
    registerDiagnosticsRpc(handle, capabilities);
    registerCapabilityRpc(handle, capabilities);
    registerBotHooksRpc(handle, capabilities);
    registerPreviewRpc(handle, {
      logger,
      db,
      dataDir,
      host: opts.host,
      signal: capabilities.shutdown.signal,
      redactor,
      target: capabilities.target,
      changes: () => capabilities.changes,
    });

    opts.orchestration.registerLocalRpc(handle, capabilities);
    registerReceiptRpc(handle, capabilities);
    registerAgentReviewRpc(handle, capabilities, capabilities.reviews, capabilities.evidence);
    registerBackgroundRpc(handle, capabilities.background, capabilities.shutdown.signal);
    // Overlay ↔ tools: hand-back and cleared data reach the tools' session, page changes from
    // the tools reach the overlay's browser.state event.
    const chatNotices = new ChatNoticeService({ db, peer, logger });
    registerChatNoticeRpc(handle, chatNotices);
    registerBotRpc(handle, botBusiness, waitForSessionRecovery);
    opts.orchestration.registerGroupRpc(handle, groups, chat.queue.repo);
    registerChatContextHint(handle, contextHints);
    registerChatCompaction(handle, {
      db,
      chat,
      agent,
      redactor,
      changed: (botId, topicId, forked) => {
        peer.emit("sidebar.changed", {});
        // Only a handoff creates a topic to switch to. Navigating after an in-place compaction
        // opened the profile's topic list and remounted the chat, losing the result notice.
        if (forked) peer.emit("ui.navigate", { botId, tab: "topics", conversationId: topicId });
      },
    });
    registerMessageActions(handle, {
      db,
      chat,
      groups,
      agent,
      redactor,
      signal: local.shutdown.signal,
      report: (reason) => logger.warn(JSON.stringify({ module: "message-actions", event: reason })),
    });
    registerUserQuestionRpc(handle, capabilities, chat, groups);
    // Standby participants and the owner of unattended runs come from capabilities.
    const sleepParticipants: SleepParticipant[] = [];
    sleepParticipants.push({
      idle: () => runRetention?.idle() ?? true,
      pause: () => runRetention?.pause() ?? Promise.resolve(),
    });
    let unattendedOwner: UnattendedRunOwner | undefined;
    const sleepService = new BrainSleep({
      repo: new BrainWakeRepo(db),
      interactive: () => interactiveAttached,
      stopping: () => stopping,
      requests: () => requests.size + (opts.backgroundControlIdle?.() === false ? 1 : 0),
      workIdle: () =>
        chat.queue.isIdle() &&
        sleepParticipants.every((participant) => participant.idle()) &&
        capabilities.logs.isIdle() &&
        capabilities.externalImages.isIdle() &&
        // Bot pages still open in the background process keep brain out of standby.
        (capabilities.browserProvider?.isIdle() ?? true) &&
        // A live computer grant keeps brain and the owner awake (no standby).
        // A running background command (a server) is work in progress.
        capabilities.background.isIdle(),
      approvalsIdle: () => capabilities.approvals.isIdle(),
      pause: async (signal) => {
        const paused = await Promise.allSettled([
          ...sleepParticipants.map((participant) => participant.pause?.(signal)),
          botBusiness.pauseMaintenance(),
          groups.pauseMaintenance(),
          search.settled(),
        ]);
        signal.throwIfAborted();
        if (paused.some((result) => result.status === "rejected"))
          throw new Error("brain_sleep_drain_failed");
      },
      resume: async () => {
        if (stopping) return;
        botBusiness.resumeMaintenance();
        groups.resumeMaintenance();
        for (const participant of sleepParticipants) await participant.resume?.();
      },
      failed: () => logger.error("Brain sleep recovery failed; admission remains closed"),
    });
    sleep = sleepService;
    const claimUnattended = (owner: UnattendedRunOwner) => {
      // Two owners would each think they hold a topic's reserved slot and parked cards.
      if (unattendedOwner) throw new Error("Unattended runs already claimed");
      unattendedOwner = owner;
      capabilities.unattended = owner;
      capabilities.approvals.parkedResolve = (id, decision, remember, preauthorize) =>
        owner.resolveParked(id, decision, remember, preauthorize);
      chat.queue.beforeUser = (botId, conversationId) => owner.beforeUser(botId, conversationId);
      chat.queue.reservation = (record, input) => owner.admit(record, input);
      chat.abortRoutine = (id) => owner.abortRun(id);
    };
    capabilities.workplaces.beforeChange = (botId) => chat.queue.pauseBot(botId);
    // A card's "don't ask again" changed Pi's level; an open permissions tab follows it.
    capabilities.approvals.levelChanged = (botId) =>
      void capabilities.permissions
        .get(botId)
        .then((value) => peer.emit("permissions.changed", value))
        .catch(() => logger.warn(JSON.stringify({ module: "permissions", event: "emit_failed" })));
    // Capabilities add their inbox kinds at registration; the inbox reads this list per query.
    const inboxSources: InboxSource[] = [];
    registerNavigationRpc(handle, db, peer, chat, inboxSources, composition.inboxItemSchema);
    registerPersonalTodoRpc(handle, capabilities);
    registerSearchRpc(handle, search);
    registerAppRpc(startup);
    capabilityHandles.push(registerAcpRpc({ handle, peer, audit, bots, redactor, acp: opts.acp }));

    registerChatRpc(startup);

    registerHealthRpc(startup);
    timing.mark("kernel_rpc");

    await registerCapabilities(startup);
    capabilityHandles.push(
      startChatSearchBackfill(db, redactor, logger, (signal) =>
        capabilities.userSecrets.ready(signal),
      ),
    );
    chat.recoverQueued();

    // All startup recovery owners have now appended their run-scoped corrections. Only here may
    // an upgrade from a pre-seal version certify already-terminal runs as fully drained.
    const sealRecoveredRuns = () => {
      const runEvents = new RunEventsRepo(db);
      let sealAfter = "",
        sealedRuns = 0;
      for (;;) {
        const page = runEvents.sealTerminalPage(sealAfter, 200, recoveryRunRowId);
        sealedRuns += page.count;
        if (page.count < 200) break;
        sealAfter = page.last;
      }
      if (sealedRuns)
        logger.info(JSON.stringify({ module: "runs", event: "terminal_runs_sealed", sealedRuns }));
    };
    const reconciliation = reconcileSessionTails(
      recoveryEvents,
      dataDir,
      logger,
      sessionTailController.signal,
      sessionTails,
    )
      .then(() => {
        sessionTailController.signal.throwIfAborted();
        const sealAt = performance.now();
        sealRecoveredRuns();
        logger.info(
          JSON.stringify({
            module: "startup",
            event: "session_recovery_ready",
            sealMs: Math.round(performance.now() - sealAt),
            sinceProcessMs: Math.round(performance.now()),
          }),
        );
        sessionTailsReady = true;
        resolveSessionGate();
        runRetention?.start();
      })
      .catch((error) => {
        rejectSessionGate(error);
        if (!sessionTailController.signal.aborted)
          logger.warn(JSON.stringify({ module: "session", event: "tail_reconciliation_failed" }));
      })
      .finally(() => requests.delete(reconciliation));
    sessionTailReconciliation = reconciliation;
    requests.add(reconciliation);

    if (capabilities.workspaceServices) groups.startWorkspaceRouting();
    timing.mark("workspace_routing");
    sdk.deferSdk?.(2000);
    startupDiagnostics?.ready();
    activeRuns.refresh();
    liveActivity.refresh();
    logger.info("Brain ready");
    timing.report(logger);
    maintenance = deferredMaintenance(logger, sdk.preloadSdk, (phase) => loopWatch?.mark(phase));
    // A speculative SDK import blocks unrelated navigation while evaluating its module graph.
    // The agent still loads it on demand for model operations.
    maintenance.start(capabilityHandles);
    // The SDK's main-thread evaluation moves to an idle moment after the worker warm-up.
    sdkPreload = sdkIdlePreload({
      logger,
      warm: sdk.preloadSdk,
      load: sdk.loadSdkWhenIdle,
      lastUserActivity: () => lastUserActivity,
      busy: () => startup.interactiveRequests.size > 0,
      mark: (phase) => loopWatch?.mark(phase),
    });
    sdkPreload.start();
    progress?.stop();
    return createBrainController(startup);
  } catch (error) {
    progress?.stop();
    startupDiagnostics?.stop();
    loopWatch?.stop();
    sdkPreload?.stop();
    await maintenance?.stop();
    await stopSessionRecovery();
    let drained = false;
    try {
      await stopCapabilities(capabilityHandles);
      capabilityHandles = [];
      await runRetention?.stop();
      await groupService?.stop();
      await botService?.stop();
      await chatService?.stop();
      unsubscribeCheckpoints?.();
      await modelPort?.stop();
      await modelPort?.settled();
      await managedResources?.dispose();
      await local?.dispose();
      await networkCleanup?.();
      drained = true;
      cleanup?.();
    } finally {
      // Initialization can start watchers/control consumers before failing; they still own SQLite.
      if (drained) db.close();
    }
    // Preserve only this classified startup reason after the database and resources are closed.
    if (error instanceof Error && error.message === "database_newer_than_app")
      throw new Error("database_newer_than_app");
    throw new Error("Brain initialization failed");
  }
}
