// Owns the ports and shared runtime services of the local brain.
import { join } from "node:path";
import type { LocalToolCall, LocalToolPorts } from "@pibot/agent";
import {
  createLocalExecutionTarget,
  type ExecutionTarget,
  sensitiveReadBoundary,
  windowsSystemDrive,
  windowsSystemTrees,
} from "@pibot/execution";
import { createPolicy, type Policy, type PolicyRequest } from "@pibot/policy";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { BotsRepo, GroupsRepo, ToolCallsRepo } from "@pibot/storage";
import { ExternalImages } from "./conversations/attachments/external-images.ts";
import { DraftService } from "./conversations/drafts/drafts.ts";
import { abortable } from "./core/abort.ts";
import { ApprovalService } from "./core/approvals.ts";
import { defaultCapabilityResolver } from "./core/capability-resolver.ts";
import type { CollaborationPort, LocalDependencies, ToolRunContext } from "./core/local-types.ts";
import type {
  ExecutionCleanupPort,
  ExecutionPort,
  TaskAuthorityPort,
  TaskRuntimePort,
} from "./core/orchestration.ts";
import { PermissionService } from "./core/permissions.ts";
import { runPermissionScope } from "./core/run-permissions.ts";
import { StoredCapabilityResolver } from "./core/stored-capability-resolver.ts";
import { YoloService } from "./core/yolo.ts";
import { ExecutionTargets } from "./resources/workplaces/execution-targets.ts";
import { FolderWriteLocks } from "./resources/workplaces/folder-write-lock.ts";
import { WorkplaceService } from "./resources/workplaces/workplaces.ts";
import { assertWritableFolders } from "./resources/workplaces/writable-folders.ts";
import { BackgroundService } from "./runtime/background/background-service.ts";
import type { BrowserPort, BrowserRunScope, BrowserViewPort } from "./runtime/browser/port.ts";
import { PrivateNetworkApprovals } from "./runtime/browser/private-network-approvals.ts";
import { AutoCheckService } from "./runtime/checks/auto-check.ts";
import type {
  ComputerGrantPort,
  ComputerStepsPort,
  ComputerUsePort,
} from "./runtime/computer/port.ts";
import { unavailableComputer } from "./runtime/computer/unavailable.ts";
import { ContinuationBudget } from "./runtime/continuation/continuation-budget.ts";
import { ContinuationState } from "./runtime/continuation/continuation-state.ts";
import type { CredentialServices } from "./runtime/credentials/port.ts";
import type { MemoryPort } from "./runtime/memory/port.ts";
import { ProjectNotesCache } from "./runtime/notes/project-notes-cache.ts";
import { BudgetService } from "./runtime/queue/budget-service.ts";
import { RunLogs } from "./runtime/queue/run-logs.ts";
import { CodeMapIndex } from "./runtime/review/code-map-index.ts";
import { CodeMapTools } from "./runtime/review/code-map-tools.ts";
import { CodeNavigationService } from "./runtime/review/code-navigation.ts";
import { DeliveryEvidenceService } from "./runtime/review/delivery-evidence-service.ts";
import { ReviewExecutionService } from "./runtime/review/review-execution-service.ts";
import { createStartupTiming } from "./runtime/startup/startup-timing.ts";
import { ToolJournal } from "./runtime/tools/journal/journal.ts";
import { LocalRun } from "./runtime/tools/local-run.ts";
import type { SkillsPort } from "./runtime/tools/skills/port.ts";
import { createToolDefinitions } from "./runtime/tools/tools.ts";
import { UnattendedAuthorizationPort } from "./runtime/unattended/authorization-port.ts";
import type { WorkspaceServices } from "./runtime/workspaces/port.ts";

export class LocalService {
  endpoints?: import("@pibot/protocol-base").EndpointCapabilityPort;
  private definitions?: ReturnType<typeof createToolDefinitions>;
  get toolDefinitions() {
    // JSON schema conversion is only needed when a run actually exposes tools to the model.
    this.definitions ??= createToolDefinitions(this.deps.capabilityTools).filter(
      // Compares one commit with and without the code-navigation tools. Permission levels
      // are per category (code_navigate and code_map share read_file with search_text), so these
      // two names can only be removed where the tool list is built. A name here can only take a
      // tool away: everything left still goes through the ordinary policy decision.
      (tool) => !this.deps.hiddenTools?.includes(tool.name),
    );
    return this.definitions;
  }
  /** Persisted selection plus the default resolver; each model run freezes one resolved map. */
  readonly capabilities: StoredCapabilityResolver;
  readonly projectNotes = new ProjectNotesCache();
  /** Provided by the providers capability; runtime authentication stays behind this port. */
  models?: import("./runtime/models/port.ts").ModelProvidersPort;
  officeProvider?: import("./runtime/media/office-port.ts").OfficePort;
  imageProvider?: import("./runtime/media/images-port.ts").ImagesPort;
  externalAgentProvider?: import("./runtime/external-agents/port.ts").ExternalAgentsPort;
  get office() {
    if (!this.officeProvider) throw new RpcError(-32601, "office_unavailable");
    return this.officeProvider;
  }
  get images() {
    if (!this.imageProvider) throw new RpcError(-32601, "images_unavailable");
    return this.imageProvider;
  }
  /**
   * The libraries assigned to a Bot or group, for the one prompt line that tells the model
   * they exist. The kernel owns no knowledge data, so the capability that does provides this.
   */
  private knowledgeProvider?: (
    botId: string,
    groupId?: string,
  ) => readonly { name: string; kind: string }[];
  provideKnowledge(
    provider: (botId: string, groupId?: string) => readonly { name: string; kind: string }[],
  ) {
    this.knowledgeProvider = provider;
  }
  /**
   * Capability tools whose judging target is decided per call (several knowledge sources,
   * each behind its own connection) supply their policy requests here. Prepare evaluates every
   * one and the strictest decision wins, so a connection's confirmation mode is never skipped by
   * the capability's static declaration.
   */
  private toolPolicyProvider?: (
    context: ToolRunContext,
    call: LocalToolCall,
    tool: string,
    input: Record<string, unknown>,
  ) => { requests: PolicyRequest[]; prepared?: unknown };
  provideToolPolicy(
    provider: (
      context: ToolRunContext,
      call: LocalToolCall,
      tool: string,
      input: Record<string, unknown>,
    ) => { requests: PolicyRequest[]; prepared?: unknown },
  ) {
    this.toolPolicyProvider = provider;
  }
  toolPolicies(
    context: ToolRunContext,
    call: LocalToolCall,
    tool: string,
    input: Record<string, unknown>,
  ) {
    // No catch: letting prepare fail is the only safe answer. Returning nothing would let the
    // capability's static declaration pass where the connection's own rule had to be added.
    // `prepared` rides along with the call's own prepared data: a capability's executor must never
    // learn what another call judged from shared state.
    return this.toolPolicyProvider?.(context, call, tool, input) ?? { requests: [] };
  }
  knowledgeSources(botId: string, groupId?: string) {
    // Prompt building runs per model call; a provider that throws must not break the run.
    try {
      return this.knowledgeProvider?.(botId, groupId) ?? [];
    } catch {
      return [];
    }
  }
  private credentialServices?: CredentialServices;
  provideCredentials(services: CredentialServices) {
    if (this.credentialServices) throw new Error("Credentials already provided");
    this.credentialServices = services;
  }
  async readyForContent(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.credentialServices?.ready?.(signal);
    signal.throwIfAborted();
  }
  private requireCredentials() {
    if (!this.credentialServices)
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
    return this.credentialServices;
  }
  get userSecrets() {
    return this.requireCredentials().userSecrets;
  }
  get credentials() {
    return this.requireCredentials().credentials;
  }
  get googleCompat() {
    return this.requireCredentials().googleCompat;
  }
  /** Provided by the connectors capability; absent means connected apps are unavailable. */
  connectors?: import("./runtime/tools/connectors/port.ts").ConnectorsPort;
  readonly runCleanup: ExecutionCleanupPort;
  private readonly runContexts = new Map<string, ToolRunContext>();
  private readonly managedConfigurationSignals = new WeakMap<ToolRunContext, AbortSignal>();
  readonly execution: ExecutionPort;
  readonly budgets: BudgetService;
  /** One round ledger per root run, shared by TODO, parent resume and summary continuations. */
  readonly continuationBudget: ContinuationBudget;
  /** Durable continuation rows a restart reads; in-memory services write through to it. */
  readonly continuationState: ContinuationState;
  readonly tasks: TaskRuntimePort;
  /** Core permission and YOLO code sees only provenance/authority, never task management. */
  readonly taskAuthority: TaskAuthorityPort;
  readonly navigation: CodeNavigationService;
  /** Derived symbol index per working root; rebuilt from authorized reads only. */
  readonly codeMap: CodeMapIndex;
  /** The multi-language tools over that index (outline / symbols / map). */
  readonly codeMapTools: CodeMapTools;
  readonly reviews: ReviewExecutionService;
  readonly evidence: DeliveryEvidenceService;
  /**
   * Tool executors contributed by capabilities, by tool name. The tool's
   * schema, policy request and catalog entry are still kernel tables.
   */
  readonly toolExecutors = new Map<string, import("./core/capability.ts").ToolExecutor>();
  readonly toolCards = new Map<string, import("./core/capability.ts").ToolCardDescriber>();
  /** Owner of unattended runs; undefined when no capability claims it. */
  unattended?: import("./core/capability.ts").UnattendedRunOwner;
  /** Pre-authorization inside unattended runs; asks the owner capability and fails closed. */
  readonly unattendedAuthorization = new UnattendedAuthorizationPort(this);
  collaboration?: CollaborationPort;
  readonly externalImages: ExternalImages;
  readonly shutdown = new AbortController();
  readonly drafts: DraftService;
  /** Execution journal of non-read tool calls (write-ahead record, replay interception). */
  readonly toolJournal: ToolJournal;
  readonly approvals: ApprovalService;
  readonly permissions: PermissionService;
  readonly workplaces: WorkplaceService;
  readonly tools: ToolCallsRepo;
  private memoryProvider?: MemoryPort;
  provideMemory(port: MemoryPort) {
    if (this.memoryProvider) throw new Error("Memory port already provided");
    this.memoryProvider = port;
    return () => {
      if (this.memoryProvider === port) this.memoryProvider = undefined;
    };
  }
  get memoryExtraction() {
    return this.memoryProvider?.extraction;
  }
  get memoryImportDistillation() {
    return this.memoryProvider?.importDistillation;
  }
  get memory() {
    if (!this.memoryProvider) throw new RpcError(RpcErrorCodes.unsupported, "memory_unavailable");
    return this.memoryProvider.personal;
  }
  get groupMemory() {
    if (!this.memoryProvider) throw new RpcError(RpcErrorCodes.unsupported, "memory_unavailable");
    return this.memoryProvider.group;
  }
  /** Absent capabilities supply no skill context or exemptions. */
  skills?: SkillsPort;
  provideSkills(port: SkillsPort) {
    if (this.skills) throw new Error("Skills port already provided");
    this.skills = port;
  }
  readonly logs: RunLogs;
  readonly target: ExecutionTarget;
  readonly executionTargets = new ExecutionTargets();
  /** Primary folders whose pre-A55 outputs were already looked at in this process. */
  readonly outputMigrations = new Set<string>();
  /**
   * Tells the UI and the Records log that commands are paused, still paused or resumed. The state
   * is read back from the target rather than derived from the event, so a repeat report can never
   * show a pause that already cleared. Reporting must not affect the pause itself.
   */
  private reportCommandPause(
    event: { phase: "paused" | "stuck" | "recovered"; runId?: string },
    botId: string | undefined,
    jobRunId: string | null | undefined,
  ) {
    try {
      this.deps.peer.emit("runtime.commands", { paused: this.target.commandPause?.() ?? null });
      const owner = botId ?? new BotsRepo(this.deps.db).getMain()?.id;
      // Without any Bot the row has nowhere to be filed; the log line above still has the event.
      if (!owner) return;
      const runId = event.runId ?? jobRunId ?? undefined;
      this.approvals.audit.append({
        botId: owner,
        ...(runId ? { runId } : {}),
        kind: "runtime.commands_paused",
        summary:
          event.phase === "recovered"
            ? "Commands resumed / 命令已恢复"
            : "Commands paused / 命令已暂停",
        detail: { reasonCode: event.phase },
      });
    } catch {
      this.deps.logger.warn(JSON.stringify({ module: "exec", event: "command_pause_unreported" }));
    }
  }

  targetFor(location?: { target: string }): ExecutionTarget {
    return !location ||
      location.target === "local" ||
      location.target === this.deps.executionLocation?.target
      ? this.target
      : this.executionTargets.require(location.target).target;
  }
  workspaceServices?: WorkspaceServices;
  get changes() {
    if (!this.workspaceServices)
      throw new RpcError(RpcErrorCodes.unsupported, "workspaces_unavailable");
    return this.workspaceServices.changes;
  }
  /** Operating-the-computer gate (grants, card, foreground lock, indicator). */
  computerUse?: ComputerUsePort;
  get computerGrants(): ComputerGrantPort {
    return this.computerUse?.grants ?? unavailableComputer.grants;
  }
  get computerSteps(): ComputerStepsPort {
    return this.computerUse?.steps ?? unavailableComputer.steps;
  }
  browserProvider?: BrowserPort;
  browserView?: BrowserViewPort;
  get browser(): BrowserPort {
    if (!this.browserProvider) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    return this.browserProvider;
  }
  /** One writing run per folder at a time (shared by private chats and groups). */
  readonly writeLocks: FolderWriteLocks;
  /** Commands left running in the background (servers etc.), their ports and cleanup. */
  readonly background: BackgroundService;
  /** The per-conversation YOLO switch (`conversations.yolo.*`). */
  readonly yolo: YoloService;
  /** Maintainers 2026-11-14: local-network targets a person allowed for one run (ask each time). */
  readonly privateNetwork = new PrivateNetworkApprovals();
  /** Automatic check: per-Bot switch, per-folder commands, proposal cards. */
  readonly autoCheck: AutoCheckService;
  private policy?: Promise<Policy>;
  constructor(readonly deps: LocalDependencies) {
    const timing = createStartupTiming();
    this.externalImages = new ExternalImages(this, deps.downloadImage);
    this.target =
      deps.executionTarget ??
      createLocalExecutionTarget({
        files: {
          journalDir: join(deps.dataDir, "file-patches"),
          recovered: (count) =>
            deps.logger.info(JSON.stringify({ module: "file-patches", event: "recovered", count })),
        },
        command: {
          aliasFileSystem: deps.aliasFileSystem,
          onDiagnostic: (event) =>
            deps.logger.warn(
              JSON.stringify({
                module: "exec",
                event: "command.failed",
                botId: this.runContexts.get(event.runId)?.botId,
                ...event,
              }),
            ),
          onBackgroundDrain: (event) => {
            // The pause blocks every command, so its owner (the job's Bot and topic) has to be
            // in the log; without it 1,380 failures took 5.5 hours to trace.
            const row = event.jobId ? this.background.repo.get(event.jobId) : undefined;
            const botId =
              row?.botId ?? (event.runId ? this.runContexts.get(event.runId)?.botId : undefined);
            const fields = {
              module: "exec",
              event: `background.drain_${event.phase}`,
              ...event,
              ...(botId ? { botId } : {}),
              ...(row ? { conversationId: row.conversationId } : {}),
            };
            if (event.phase === "recovered") deps.logger.info(JSON.stringify(fields));
            else deps.logger.warn(JSON.stringify(fields));
            if (event.phase !== "retrying")
              this.reportCommandPause(
                { phase: event.phase, runId: event.runId },
                botId,
                row?.runId,
              );
          },
          platform: deps.platform,
          proxy: deps.proxy,
          env: deps.env,
          systemHome: deps.userHome,
          tempDir: deps.tempDir,
          resourcesDir: deps.resourcesDir,
          redactor: deps.redactor,
          placeholderLedger: join(deps.dataDir, "sandbox-placeholders.jsonl"),
        },
      });
    timing.mark("execution_target");
    this.approvals = new ApprovalService(deps, (context) =>
      this.collaboration?.publicWebTaskScope?.(this.tasks.source(context)),
    );
    this.tools = new ToolCallsRepo(deps.db);
    this.logs = new RunLogs(deps, this.tools, this.shutdown.signal);
    this.permissions = new PermissionService(
      deps.db,
      () =>
        abortable(
          this.target.isolationStatus(
            AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20_000)]),
          ),
          this.shutdown.signal,
        ),
      (value) => deps.peer.emit("permissions.changed", value),
      (fields, scope) =>
        this.approvals.audit.append({
          botId:
            scope?.botId ??
            (scope?.groupId
              ? new GroupsRepo(deps.db).get(scope.groupId)?.coordinatorBotId
              : undefined) ??
            new BotsRepo(deps.db).getMain()?.id ??
            "",
          kind: "permissions.changed",
          summary: "Permissions updated / 权限已修改",
          detail: {
            actor: "user",
            reasonCode: scope?.groupId
              ? "group_permissions_updated"
              : scope?.botId
                ? "bot_permissions_updated"
                : "global_permissions_updated",
            ...(scope?.groupId ? { groupId: scope.groupId } : {}),
            fields,
          },
        }),
    );
    timing.mark("approvals_permissions");
    this.capabilities = new StoredCapabilityResolver({
      db: deps.db,
      defaults: deps.capabilityResolver ?? defaultCapabilityResolver(),
      permissions: this.permissions,
      connectors: () => this.connectors,
    });
    this.workplaces = new WorkplaceService(
      deps.db,
      deps.dataDir,
      deps.host,
      this.shutdown.signal,
      deps.platform,
      deps.executionLocation,
      async (value, signal) => {
        if (!value.folders.length) return new Set();
        const boundary = await abortable(
          sensitiveReadBoundary(deps.platform, [deps.userHome], deps.env, {
            dataDir: deps.dataDir,
            botHome: value.home,
          }),
          signal,
        );
        return new Set(
          value.folders
            .filter(
              (folder) =>
                (!folder.location || folder.location === "local") &&
                !boundary.permitsWriteRoot(folder.path),
            )
            .map((folder) => folder.id),
        );
      },
      this.executionTargets,
      (paths, home, signal) => assertWritableFolders(deps, paths, home, signal),
    );
    this.writeLocks = new FolderWriteLocks({ platform: deps.platform, logger: deps.logger });
    this.background = new BackgroundService(this);
    this.background.onPortsChanged = (botId) => this.browserProvider?.refreshLocalPorts(botId);
    this.yolo = new YoloService(this);
    this.autoCheck = new AutoCheckService(this, deps.autoCheck);
    this.drafts = new DraftService(this);
    timing.mark("workplaces_services");
    this.approvals.recover();
    timing.mark("approvals_recover");
    this.tools.recover();
    timing.mark("tool_calls_recover");
    this.budgets = new BudgetService({
      db: deps.db,
      modelRequest: deps.modelRequest,
      redact: (text) => deps.redactor.redact(text),
      changed: (snapshot) => deps.peer.emit("execution.budget.changed", snapshot),
      groupStopped: (groupId) => {
        deps.peer.emit("groups.changed", { groupId, reason: "updated" });
        deps.peer.emit("sidebar.changed", { conversationKey: `group:${groupId}` });
      },
      warning: (reason) => deps.logger.warn(JSON.stringify({ module: "execution-budget", reason })),
    });
    timing.mark("budget_service");
    this.toolJournal = new ToolJournal(this);
    timing.mark("tool_journal_recover");
    this.continuationState = new ContinuationState(deps.db);
    this.continuationBudget = new ContinuationBudget(this.continuationState.ledgers, (root) =>
      deps.logger.warn(
        JSON.stringify({ module: "continuation-budget", event: "capacity_reached", root }),
      ),
    );
    timing.mark("durable_recovery");
    const orchestration = deps.orchestration.createLocal(this);
    this.runCleanup = orchestration.runCleanup;
    this.execution = orchestration.execution;
    this.tasks = orchestration.tasks;
    this.taskAuthority = orchestration.tasks;
    this.navigation = new CodeNavigationService(this);
    this.codeMap = new CodeMapIndex(this);
    this.codeMapTools = new CodeMapTools(this);
    this.reviews = new ReviewExecutionService(this);
    this.evidence = new DeliveryEvidenceService(this);
    this.reviews.attachTasks(this.tasks);
    this.reviews.attachNavigation(this.navigation);
    this.evidence.attachReviews(this.reviews);
    this.tasks.onReviewTaskCreated = (profile, task) => this.reviews.bindTask(profile, task);
    this.tasks.onSettled = (id, record) => this.reviews.settled(id, record);
    timing.mark("orchestration_review");
    timing.report(deps.logger, "local_service_ready");
  }
  /**
   * The root whose durable parent intent this run owns, if any. Sharing a budget root is not
   * ownership: a child task run has its own task plan, and a summary-only run has no plan at all,
   * so neither may mirror (or clear) the parent's pause. A parent resumed by a continuation run
   * owns it too, because that run continues the same plan.
   */
  private parentIntentRoot(context: ToolRunContext): string | undefined {
    if (!context.todoRun || context.executionTaskId) return undefined;
    const root = this.budgets.root(context);
    return context.runId === root || this.tasks.isParentResume(context.runId) ? root : undefined;
  }
  /**
   * Durable mirror of the parent's plan state: pause reason plus the run and plan version actually
   * driving it (a spawn-time row predates later `todo_update`s). Only a row an intent already
   * created is updated, so a pause never invents a restorable continuation, and child/summary
   * runs cannot overwrite the parent's state.
   */
  noteParentContinuation(context: ToolRunContext) {
    const state = context.todoRun;
    const root = this.parentIntentRoot(context);
    if (!state || root === undefined) return;
    this.continuationState.intents.pause(
      root,
      state.paused ? "paused" : "clear",
      state.paused?.reason ?? null,
      {
        runId: context.runId,
        ...(state.planVersion === undefined ? {} : { planVersion: state.planVersion }),
      },
    );
  }
  getPolicy(parent = this.shutdown.signal): Promise<Policy> {
    this.shutdown.signal.throwIfAborted();
    this.policy ??= createPolicy({
      platform: this.deps.platform,
      userHome: this.deps.userHome,
      ...(this.deps.platform === "win32"
        ? {
            windowsSystemDrive: windowsSystemDrive(this.deps.env),
            windowsSystemTrees: windowsSystemTrees(this.deps.env),
          }
        : {}),
      resourcesDir: this.deps.resourcesDir,
    }).then((policy) => {
      if (this.shutdown.signal.aborted) {
        policy.dispose();
        throw new RpcError(-32001, "Brain stopping");
      }
      return policy;
    });
    return abortable(
      this.policy,
      AbortSignal.any([parent, this.shutdown.signal, AbortSignal.timeout(10_000)]),
    );
  }
  run(context: ToolRunContext): {
    ports: LocalToolPorts;
    useModel(input: readonly string[], maxTokens?: number): void;
    toolGroups: LocalRun["toolGroups"];
    modelToolCalls: LocalRun["modelToolCalls"];
    successfulFileWrites: LocalRun["successfulFileWrites"];
    successfulFileSends: LocalRun["successfulFileSends"];
    hasShownImageResult: LocalRun["hasShownImageResult"];
    reply(): string | undefined;
    setMessage(messageId: string): void;
    runSynthetic: LocalRun["runSynthetic"];
    reuseCheck: LocalRun["reuseCheck"];
    finish(): void;
  } {
    return new LocalRun(this, this.retainRunContext(context));
  }
  retainRunContext(context: ToolRunContext): ToolRunContext {
    const previous = this.runContexts.get(context.runId);
    if (previous && previous !== context) this.managedConfigurationSignals.delete(previous);
    context.untrustedContent ??= { seen: false };
    // Post-tool checks must observe committed boundary changes on the same run, not a copy.
    if (!this.managedConfigurationSignals.has(context))
      this.managedConfigurationSignals.set(context, context.signal);
    context.signal = AbortSignal.any([context.signal, this.shutdown.signal]);
    this.runContexts.set(context.runId, context);
    return context;
  }
  ownsManagedConfigurationContext(context: ToolRunContext, queueSignal?: AbortSignal) {
    return (
      this.runContexts.get(context.runId) === context &&
      (!queueSignal || this.managedConfigurationSignals.get(context) === queueSignal)
    );
  }
  drainedContext(runId: string) {
    return this.runContexts.get(runId);
  }
  hasConversationWork(conversationId: string) {
    for (const context of this.runContexts.values()) {
      if (
        context.conversationId === conversationId ||
        (context.executionTaskId &&
          this.tasks.tasks.get(context.executionTaskId)?.conversationId === conversationId)
      )
        return true;
    }
    return false;
  }
  releaseContext(runId: string) {
    const context = this.runContexts.get(runId);
    if (context) this.managedConfigurationSignals.delete(context);
    this.runContexts.delete(runId);
  }
  grants(botId: string, context?: BrowserRunScope) {
    const groupId = context ? runPermissionScope(this, context) : undefined;
    const entries = [];
    let before: string | undefined;
    for (;;) {
      const page = this.approvals.grants.list({
        ...(groupId ? { groupId } : { botId }),
        before,
        limit: 200,
      });
      // Policy matches the acting Bot; the stored group grant keeps its original actor for audit/UI.
      entries.push(
        ...page.map((grant) =>
          groupId && grant.scope.kind !== "secret" ? { ...grant, botId } : grant,
        ),
      );
      if (page.length < 200) break;
      before = page.at(-1)?.id;
    }
    return entries;
  }
  async openLog(runId: string, toolCallId?: string, signal?: AbortSignal) {
    return this.logs.open(runId, toolCallId, signal);
  }

  cancel() {
    this.projectNotes.clear();
    this.shutdown.abort();
    for (const context of this.runContexts.values())
      this.managedConfigurationSignals.delete(context);
    this.tasks.continuations.dispose();
    this.writeLocks.dispose();
    this.approvals.cancel();
    this.approvals.clearWebDomains();
    this.computerUse?.cancel();
  }
  async dispose() {
    this.cancel();
    try {
      // Quit / brain stop ends every background command; recorded before exec closes.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.background.stopAll("app_quit"),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 10_000);
        }),
      ]);
      clearTimeout(timer);
      const results = await Promise.allSettled([
        this.drafts.dispose(),
        this.target.dispose(),
        this.logs.dispose(),
        this.externalImages.stop(),
        this.computerSteps.dispose(),
        this.budgets.dispose(),
        this.navigation.dispose(),
        this.codeMap.dispose(),
      ]);
      await this.browserView?.dispose();
      await this.browserProvider?.dispose();
      await this.background.dispose();
      this.credentialServices?.credentials.dispose();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      this.runContexts.clear();
    } finally {
      if (this.policy) (await abortable(this.policy, AbortSignal.timeout(5000))).dispose();
    }
  }
}
