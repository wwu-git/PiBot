import {
  automaticOutsidePatterns,
  automaticOutsideShape,
  OUTSIDE_SANDBOX_REASON,
  OUTSIDE_WRITE_REASON,
} from "@pibot/policy";
import { ToolTimer } from "../../core/tool-timing.ts";
import { observeProjectNotes } from "../notes/project-notes-observe.ts";
import { commandHandleEnvironment, validateCommandHandles } from "./browser/secret-handles.ts";
import { groupPlanFailure } from "./group-plan-failure.ts";
import { approvalFolderChange } from "./local-run/approval-folder.ts";
import {
  activityStep,
  blockedStep,
  emitStep,
  failInputStep,
  runSyntheticStep,
} from "./local-run/local-run-activity.ts";
import {
  authorizeComputerStep,
  authorizeStep,
  consentCardStep,
  loginTitleStep,
} from "./local-run/local-run-authorization.ts";
import {
  allowPageStep,
  assertDispatchStep,
  executeStep,
  fallbackSearchStep,
  validSearchStep,
  writeLockRootsStep,
} from "./local-run/local-run-execution.ts";
import {
  type State,
  ToolAuthorizationError,
  WRITE_FILE_TOOLS,
} from "./local-run/local-run-shared.ts";
import { parallelToolCall, ToolBatch } from "./local-run/tool-batch.ts";
import { recordSandboxNotices } from "./sandbox-notices.ts";
export type LocalRunOperations = ReturnType<LocalRun["operationContext"]>;

import { createHash, randomUUID } from "node:crypto";
import type {
  LocalToolActivity,
  LocalToolCall,
  LocalToolDefinition,
  LocalToolPorts,
  LocalToolResult,
  ToolSetSnapshot,
} from "@pibot/agent";
import { mapAgentError } from "@pibot/agent";
import {
  ExecError,
  type ExecutionTarget,
  rememberableSystemService,
  type SandboxBlock,
} from "@pibot/execution";
import { containsPath, type Platform, type PolicyResult, soleInvokedProgram } from "@pibot/policy";
import {
  type AuditDetail,
  CAPABILITIES,
  type CapabilityId,
  officeRenderOutputPath,
  RpcError,
  type ToolStatus,
} from "@pibot/protocol-base";
import { BotsRepo, SettingsRepo, transaction } from "@pibot/storage";
import type {
  BrowserToolPort,
  PreparedToolView,
  ToolCallView,
  ToolRuntime,
} from "@pibot/tools/runtime";
import { RunWebCache } from "@pibot/tools/web";
import { extractAttachment } from "../../conversations/attachments/extract-attachment.ts";
import { redactAiConfig } from "../../core/ai-config-redaction.ts";
import { collaborationRefusal } from "../../core/assignment-refusal.ts";
import { auditText, auditToolFields } from "../../core/audit-fields.ts";
import { GroupToolError } from "../../core/collaboration-tool-error.ts";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import { mainDirectTopic } from "../../core/main-direct.ts";
import { runPermissionScope, runPermissions } from "../../core/run-permissions.ts";
import { toolPermissionCategory } from "../../core/tool-category.ts";
import { auditYolo, runYolo } from "../../core/yolo.ts";
import type { SearchRecipient } from "../../integrations/search/search-service.ts";
import type { LocalService } from "../../local-service.ts";
import {
  FolderLockError,
  folderLockText,
  type WriteLockOwner,
} from "../../resources/workplaces/folder-write-lock.ts";
import { CheckReceipts, type CheckScope, type PendingCheck } from "../checks/check-receipts.ts";
import { isComputerTool } from "../computer/computer-grants-policy.ts";
import { visualComputerTools } from "../computer/computer-tools.ts";
import { runPostWriteHook } from "../hooks/bot-hooks.ts";
import { canAskUser } from "../questions/user-question-tools.ts";
import { createBrowserToolPort } from "./browser/browser-adapter.ts";
import { isBrowserTool, visualBrowserTools } from "./browser/browser-tools.ts";
import {
  commandBrowserOpenGuidance,
  commandFailureGuidance,
  commandReadGuidance,
} from "./command-guidance.ts";
import { connectorCapabilityDefinition } from "./connectors/capability-adapter.ts";
import { connectorToolIndex } from "./connectors/connector-index.ts";
import { ConnectorSchemaError } from "./connectors/connector-schema.ts";
import { ConnectorToolError, connectorError } from "./connectors/connector-tools.ts";
import { auditInput } from "./input-audit.ts";
import { ToolJournalError } from "./journal/journal.ts";
import { authorizationSnapshot, groupAuthorization, prepareTool } from "./local-prepare.ts";
import { outsideSandboxPermit, SandboxBlockRegistry } from "./outside-sandbox.ts";
import { searchPathAuthorizer } from "./search-path-authorizer.ts";
import { runnerHidesTool, runnerLinkLost, targetSupportsTool } from "./target-tools.ts";
import { scopedToolCatalog } from "./tool-catalog.ts";
import { authorizationCheckText } from "./tool-error-text.ts";
import { ToolGroupHistory } from "./tool-group-history.ts";
import { blockedReason, isCollaboration, toolSummary } from "./tools.ts";

const builtinToolCapabilities = new Map<string, CapabilityId>(
  CAPABILITIES.flatMap((capability) =>
    capability.builtinTools.map((tool) => [tool, capability.id] as const),
  ),
);

export class LocalRun implements ToolRuntime {
  private backgroundPoll?: { id: string; value: string; count: number };
  observeBackground(id: string, _value: string) {
    const snapshot = this.local.background.toolOutput(this.context.botId, id, 20_000);
    const value = createHash("sha256")
      .update(JSON.stringify([snapshot.row.outputLines, snapshot.output]))
      .digest("hex");
    const previous = this.backgroundPoll;
    const count = previous?.id === id && previous.value === value ? previous.count + 1 : 1;
    this.backgroundPoll = { id, value, count };
    return count >= 3;
  }
  readonly ports: LocalToolPorts;
  private readonly groupHistory: ToolGroupHistory;
  readonly webFetchCache = new RunWebCache();
  private readonly capabilities: NonNullable<ToolRunContext["capabilities"]>;
  readonly checkReceipts = new CheckReceipts(
    { readCheckpoint: (...args) => this.target.readCheckpoint(...args) },
    (scope) => {
      const resources = this.local.background.resources();
      return (
        !this.closed &&
        !this.remote &&
        !this.context.signal.aborted &&
        this.local.autoCheck.active(this.context) &&
        this.context.runWorkplace?.cwd === scope.cwd &&
        authorizationSnapshot(this.local, this.context.botId, this.context) ===
          scope.authorization &&
        !resources.starting &&
        !resources.roots.some((root) =>
          scope.roots.some(
            (other) =>
              containsPath(root, other, this.local.deps.platform) ||
              containsPath(other, root, this.local.deps.platform),
          ),
        )
      );
    },
  );
  checkScope(): CheckScope | undefined {
    const workplace = this.context.runWorkplace;
    if (!workplace) return;
    return {
      cwd: workplace.cwd,
      roots: [
        workplace.cwd,
        ...workplace.boundary.roots.map((r) => r.canonicalPath).filter((r) => r !== workplace.cwd),
      ],
      authorization: authorizationSnapshot(this.local, this.context.botId, this.context),
    };
  }
  async reuseCheck(command: string, signal: AbortSignal) {
    const scope = this.checkScope();
    return scope ? this.checkReceipts.reuse(command, scope, signal) : undefined;
  }
  private readonly states = new Map<string, State>();
  private readonly batch = new ToolBatch();
  private readonly pendingSearches = new Set<string>();
  private readonly deferredWebReads = new Map<string, string>();
  /** One read hint per run; a run is one conversation turn, not one tool call. */
  private readHintShown = false;
  private browserOpenHintShown = false;
  private closed = false;
  folderChange(prepared: PreparedTool, committed: () => void) {
    return approvalFolderChange(
      this.local,
      this.context,
      prepared,
      () => {
        if (this.closed || !this.batch.isIdle()) throw new RpcError(-32011, "topic_workplace_busy");
      },
      () => {
        this.clearCommandChecks();
        committed();
      },
    );
  }
  private modelInput?: readonly string[];
  private discovery?: ToolSetSnapshot["discovery"];
  private readonly lockOwner: WriteLockOwner;
  private browserTools?: BrowserToolPort;
  constructor(
    readonly local: LocalService,
    readonly context: ToolRunContext,
  ) {
    context.toolTiming = (id) => this.timing(id);
    context.sandboxBlocks ??= new SandboxBlockRegistry();
    this.capabilities =
      context.capabilities ??
      local.capabilities.resolve({
        botId: context.botId,
        ...(context.groupId ? { groupId: context.groupId } : {}),
      });
    local.changes.turn.begin(context);
    this.lockOwner = { runId: context.runId, botId: context.botId, lease: randomUUID() };
    let mainDirectAnswer: boolean | undefined;
    const mainDirect = () => (mainDirectAnswer ??= mainDirectTopic(local, context));
    const definitions = local.toolDefinitions.filter(
      (tool) =>
        (!context.executionTaskId ||
          (tool.name !== "read_messages" && !isCollaboration(tool.name))) &&
        (!isCollaboration(tool.name) || (!!context.groupId && !!local.collaboration)) &&
        (!runPermissionScope(local, context) || tool.name !== "skill_propose") &&
        // A capability's run bookkeeping (routine_flag_attention) exists only inside such a run.
        (!local.deps.capabilityTools.specs[tool.name]?.unattendedOnly || !!context.routineRunId) &&
        // The default Pi's management and dispatch tools exist only in its own direct chat.
        (!local.deps.capabilityTools.specs[tool.name]?.mainBotOnly || mainDirect()) &&
        (!local.deps.capabilityTools.specs[tool.name]?.roleIds ||
          local.deps.capabilityTools.specs[tool.name]?.roleIds?.includes(
            new BotsRepo(local.deps.db).get(context.botId)?.role?.id ?? "",
          )),
    );
    const run = this;
    const groupHistory = new ToolGroupHistory(local, context);
    this.groupHistory = groupHistory;
    this.ports = {
      signal: context.signal,
      get initialToolGroups() {
        return groupHistory.initial();
      },
      get initialToolGroupsAlways() {
        return groupHistory.always();
      },
      activeToolGroups: (groups) => groupHistory.setActive(groups),
      // Read when the session registers tools, after useModel() saw the model.
      get definitions() {
        const offered = run.offered(definitions);
        const index = connectorToolIndex(local, context, offered);
        run.discovery = index?.snapshot;
        return scopedToolCatalog(offered, local.deps.capabilityTools).map((tool) =>
          tool.name === "tool_discover" && index
            ? { ...tool, description: `${tool.description}\n${index.text}` }
            : tool,
        );
      },
      get capabilityDefinitions() {
        return run.ports.definitions.filter((tool) => !!tool.capabilityImplementation);
      },
      discoverySnapshot: () => run.discovery,
      permissionsSnapshot: () => {
        const settings = local.tasks.settings(context, runPermissions(local, context));
        const scopeId = runPermissionScope(local, context);
        const digest = (value: unknown) =>
          createHash("sha256").update(JSON.stringify(value)).digest("hex");
        return {
          version: digest(authorizationSnapshot(local, context.botId, context)),
          scope: scopeId ? "group" : "bot",
          scopeId: scopeId ?? context.botId,
          mode: local.execution.mode(context),
          levels: { ...settings.levels },
          yolo: runYolo(local, context),
          grantsVersion: digest(local.grants(context.botId, context)),
          workplaceVersion: digest(context.runWorkplace ?? context.topicWorkplace ?? null),
        };
      },
      authorize: async (call, signal) => {
        this.state(call);
        try {
          if (
            call.tool === "web_fetch" &&
            this.pendingSearches.size &&
            !this.states.get(call.id)?.synthetic
          ) {
            // pi prepares the entire batch before executing: waiting here would deadlock search.
            signal.throwIfAborted();
            if (this.closed) return { allow: false, reason: "Stopped / 已停止" };
            // Even the staging ticket sees policy; only the user question waits for execution.
            const preflight = await this.prepare(call, signal);
            if (preflight.result.decision === "deny") {
              this.state(call).auditFacts = {
                ...auditToolFields(
                  call,
                  local.deps.redactor,
                  preflight.result,
                  local.deps.capabilityTools,
                ),
                reasonCode: preflight.result.reason,
              };
              return { allow: false, reason: blockedReason(preflight.result.reason) };
            }
            signal.throwIfAborted();
            if (this.closed) return { allow: false, reason: "Stopped / 已停止" };
            this.deferredWebReads.set(call.id, JSON.stringify([call.tool, call.input]));
            this.batch.reserve(call.id, false);
            return { allow: true };
          }
          if (context.executionClock) local.budgets.beforeTool(context, call);
          if (call.tool === "web_search") this.pendingSearches.add(call.id);
          const decision = await local.approvals.serial(
            context.runId,
            signal,
            () => this.authorize(call, signal),
            this.timing(call.id),
          );
          const state = this.states.get(call.id);
          if (decision.allow && state?.prepared && !state.synthetic) {
            state.batchParallel = parallelToolCall(state.prepared, this.platform);
            this.batch.reserve(call.id, state.batchParallel);
          }
          if (!decision.allow) this.pendingSearches.delete(call.id);
          return decision;
        } catch (error) {
          this.pendingSearches.delete(call.id);
          const planFailure = groupPlanFailure(local, context, call, error);
          if (planFailure) {
            this.state(call).result = planFailure;
            this.blocked(call, planFailure.text);
            return { allow: false, reason: planFailure.text };
          }
          signal.throwIfAborted();
          if (error instanceof ExecError)
            return {
              allow: false,
              reason: this.refuseExecutionCheck(call, error),
            };
          // Both callers (the SDK gate and runSyntheticStep) log the throw once through logError;
          // a second line here would double-count and could carry message text.
          if (!(error instanceof ConnectorToolError || error instanceof ConnectorSchemaError))
            throw error;
          const result = connectorError(error.code);
          const state = this.state(call);
          state.result = result;
          state.auditFacts = {
            ...auditToolFields(call, local.deps.redactor, undefined, local.deps.capabilityTools),
            reasonCode: error.code,
          };
          this.blocked(call, result.text);
          return { allow: false, reason: result.text };
        }
      },
      blocked: (call, reason, failed) => this.blocked(call, reason, failed),
      execute: async (call, signal, output) => {
        try {
          const result = await this.execute(call, signal, output);
          groupHistory.remember(call, result, this.ports.definitions);
          return result;
        } catch (error) {
          const planFailure = groupPlanFailure(local, context, call, error);
          if (planFailure) {
            this.state(call).result = planFailure;
            this.blocked(call, planFailure.text);
            return planFailure;
          }
          if (error instanceof ConnectorToolError || error instanceof ConnectorSchemaError) {
            const result = connectorError(
              error.code,
              error instanceof ConnectorToolError ? error.serviceMessage : undefined,
            );
            const state = this.state(call);
            state.result = result;
            state.auditFacts = {
              ...auditToolFields(call, local.deps.redactor, undefined, local.deps.capabilityTools),
              reasonCode: error.code,
            };
            // The audited reason stays the fixed text; service wording only reaches the model.
            this.blocked(call, connectorError(error.code).text);
            return result;
          }
          const assignment = collaborationRefusal(call.tool, error);
          // F5: a link that dropped before dispatch is a connection failure, not a policy one.
          const lost = signal.aborted ? undefined : runnerLinkLost(error);
          if (lost)
            this.state(call).auditFacts = { ...this.state(call).auditFacts, reasonCode: lost.code };
          const text = signal.aborted
            ? "已停止 / Stopped"
            : lost
              ? lost.text
              : assignment
                ? assignment
                : error instanceof ToolAuthorizationError
                  ? "工具未获授权 / Tool was not authorized"
                  : error instanceof GroupToolError
                    ? local.deps.redactor.redact(error.message)
                    : error instanceof FolderLockError
                      ? folderLockText(error)
                      : error instanceof ToolJournalError
                        ? "执行登记失败，工具未执行，请稍后重试 / Could not record the execution, so the tool did not run; retry later"
                        : "无法安全执行工具，请检查权限和工作位置 / Could not safely execute the tool; check permissions and workplaces";
          this.local.deps.logger.warn(
            `Tool execution failed bot=${context.botId} run=${context.runId}`,
          );
          this.blocked(call, text);
          return { text, isError: true };
        }
      },
      activity: (event) => this.activity(event),
      assistantReply: (text) => {
        if (!this.closed && !context.signal.aborted && context.groupId)
          context.assistantReply = local.deps.redactor
            .redact(text)
            .slice(0, 100_000)
            .replace(/[\uD800-\uDBFF]$/u, "");
      },
      errorText: (id) =>
        this.states.get(id)?.result?.text ??
        this.states.get(id)?.failureReason ??
        "未知工具、参数无效或工具执行失败 / Unknown tool, invalid arguments, or tool execution failed",
      redact: (text) => local.deps.redactor.redact(text),
      logError: (entry) =>
        local.deps.logger.error(
          JSON.stringify({
            module: "tool-gate",
            botId: context.botId,
            runId: context.runId,
            ...entry,
          }),
        ),
    };
  }
  /**
   * Computer / browser tools only where the host provides them, and screenshot tools only
   * for models that accept images (unknown model = no images). Image Bots never reach here.
   */
  private offered(definitions: LocalToolDefinition[]) {
    const host = this.local.deps.host;
    const images = this.modelInput?.includes("image") === true;
    // Proposing check commands only exists for Bots with the automatic check on.
    const checks = this.local.autoCheck.active(this.context);
    const levels = this.local.tasks.settings(
      this.context,
      runPermissions(this.local, this.context),
    ).levels;
    // Only the brain's own target is known before a tool runs; a runner target may still be
    // offline here, and resolving it would fail the whole turn instead of one call.
    const location = this.context.runWorkplace?.boundary.location;
    const ownTarget =
      !location ||
      location.target === "local" ||
      location.target === this.local.deps.executionLocation?.target
        ? this.local.target
        : undefined;
    const selected = definitions.flatMap((tool) => {
      const capability = builtinToolCapabilities.get(tool.name);
      if (!capability) return [tool];
      const implementation = this.capabilities.get(capability);
      if (implementation === "builtin") return [tool];
      if (!implementation?.startsWith("connector:")) return [];
      const adapted = connectorCapabilityDefinition(this.local, this.context, tool, capability);
      return adapted ? [adapted] : [];
    });
    const executionAllows = this.local.execution.catalogAvailability(this.context);
    return selected.filter((tool) => {
      if (this.local.endpoints && !this.local.endpoints.allows(tool.name, this.context))
        return false;
      if (
        tool.name === "write_stdin" &&
        (this.context.routineSource || this.context.executionTaskId)
      )
        return false;
      if (tool.name === "skill_propose" && !this.local.skills) return false;
      // A runner target is unresolved here, so filter by the workplace's location instead of
      // target capabilities. The location is fixed per session, so the catalog stays stable.
      if (location?.target.startsWith("runner:") && runnerHidesTool(tool.name)) return false;
      if (ownTarget && !targetSupportsTool(ownTarget, tool.name)) return false;
      // A server/CLI brain has no screen to show a folder on.
      if (tool.name === "reveal_in_folder" && !host.revealPath) return false;
      const category = toolPermissionCategory(tool.name, this.local.deps.capabilityTools);
      if (["ask_user", "personal_todo"].includes(tool.name) && !canAskUser(this.context))
        return false;
      return (
        (!category ||
          levels[category] !== "never" ||
          (["read_file", "list_dir"].includes(tool.name) && levels.read_ai_config !== "never")) &&
        this.local.reviews.allowsTool(this.context, tool.name) &&
        executionAllows(tool.name) &&
        (tool.name !== "check_command_propose" || checks) &&
        // A capability tool that answers with an image (phone_media_get) needs image input too.
        (images || !this.local.deps.capabilityTools.specs[tool.name]?.imageInput) &&
        (!isComputerTool(tool.name) ||
          (!!this.local.computerUse &&
            !!(location?.target.startsWith("runner:")
              ? this.local.executionTargets.get(location.target)?.target.computer
              : host.computer) &&
            (images || !visualComputerTools.includes(tool.name)))) &&
        (!isBrowserTool(tool.name) ||
          (tool.capabilityImplementation
            ? images || !visualBrowserTools.includes(tool.name)
            : !!host.browser && (images || !visualBrowserTools.includes(tool.name)))) &&
        (tool.name !== "browser_login" || (!!host.browser && !!host.credentials))
      );
    });
  }
  toolGroups() {
    return this.groupHistory.snapshot(this.ports.definitions);
  }
  modelToolCalls() {
    return [...this.states.values()].filter((state) => !state.synthetic).length;
  }
  /**
   * Did a real file write succeed in this run? A refused, failed or automatic-check call
   * does not count, and neither does a planned-but-ungated write, so the reply check only skips a
   * reminder when a deliverable already exists on disk.
   */
  successfulFileWrites() {
    for (const state of this.states.values())
      if (
        state.result &&
        !state.result.isError &&
        (WRITE_FILE_TOOLS.has(state.call.tool) ||
          officeRenderOutputPath(state.call.tool, state.call.input) !== undefined)
      )
        return true;
    return false;
  }
  /** A delivery claim is satisfied only by a successful send_file result, never by model prose. */
  successfulFileSends() {
    // These are the only current kernel tools whose successful result creates/reuses an
    // attachment visible to the user. Browser/computer screenshots are model observations.
    const USER_DELIVERY_TOOLS = new Set(["send_file", "image_result"]);
    for (const state of this.states.values())
      if (USER_DELIVERY_TOOLS.has(state.call.tool) && state.result && !state.result.isError)
        return true;
    return false;
  }
  hasShownImageResult() {
    for (const state of this.states.values())
      if (state.result && !state.result.isError && (state.result.images?.length ?? 0) > 0)
        return true;
    return false;
  }
  /** Called with the session's model before tools are registered. */
  useModel(input: readonly string[], maxTokens?: number) {
    this.modelInput = input;
    this.context.modelAcceptsImages = input.includes("image");
    this.context.modelMaxTokens = maxTokens;
  }
  private state(call: LocalToolCall): State {
    // Unknown names are untrusted model text, not safe diagnostic metadata.
    if (!this.local.toolDefinitions.some((tool) => tool.name === call.tool))
      call = { ...call, tool: "unknown_tool" };
    let state = this.states.get(call.id);
    if (!state) {
      const record = this.local.tools.create({
        messageId: this.context.messageId,
        toolCallId: call.id,
        tool: call.tool,
        summary: toolSummary(call, this.local.deps.redactor, this.local.deps.capabilityTools),
        status: "pending",
      });
      state = {
        call,
        timing: new ToolTimer(call.tool === "web_fetch" || call.tool === "web_search"),
        recordId: record.id,
        messageId: this.context.messageId,
        unisolatedApproved: false,
        startSeen: false,
        started: false,
        finished: false,
        onceDomains: new Set(),
        onceUrls: new Set(),
      };
      this.states.set(call.id, state);
    } else {
      state.call = call;
      this.local.tools.update(state.recordId, {
        summary: toolSummary(call, this.local.deps.redactor, this.local.deps.capabilityTools),
      });
    }
    return state;
  }
  timing(callId: string) {
    return this.states.get(callId)?.timing;
  }
  async prepare(
    call: LocalToolCall,
    signal: AbortSignal,
    recipient?: SearchRecipient,
    options?: { submit?: boolean; deferBrowserLease?: boolean },
  ): Promise<PreparedTool> {
    const prepared = await prepareTool(this.local, this.context, call, signal, recipient, options);
    if (this.remote) void this.target;
    return prepared;
  }
  private authorize(
    call: LocalToolCall,
    signal: AbortSignal,
    confirmation = false,
    recipient = call.tool === "web_search" ? this.local.deps.search?.recipient() : undefined,
  ): Promise<{ allow: boolean; reason?: string }> {
    return this.state(call).timing.measure("policy", () =>
      authorizeStep.call(this.operationContext(), call, signal, confirmation, recipient),
    );
  }
  /** First-login card title with the Bot's (redacted) display name. */
  private consentCard(prepared: PreparedTool) {
    return consentCardStep.call(this.operationContext(), prepared);
  }
  private loginTitle(login: NonNullable<PreparedTool["login"]>, language: "zh" | "en") {
    return loginTitleStep.call(this.operationContext(), login, language);
  }
  /**
   * Operating the computer is decided by the computer gate (grant, card, always-list,
   * routine preauth, blocklist); the ordinary prepare only records what `execute` re-checks.
   */
  private authorizeComputer(
    state: State,
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<{ allow: boolean; reason?: string }> {
    return authorizeComputerStep.call(this.operationContext(), state, call, signal);
  }
  validSearch(prepared: PreparedTool) {
    return validSearchStep.call(this.operationContext(), prepared);
  }
  fallbackSearch(prepared: PreparedTool, signal: AbortSignal): Promise<PreparedTool | string> {
    return fallbackSearchStep.call(this.operationContext(), prepared, signal);
  }
  private execute(
    call: LocalToolCall,
    signal: AbortSignal,
    output: (text: string) => void,
  ): Promise<LocalToolResult> {
    if (
      call.tool !== "background_command" ||
      !["wait", "output"].includes(String(call.input.action))
    )
      this.backgroundPoll = undefined;
    const action = async () => {
      const deferred = this.deferredWebReads.get(call.id);
      if (deferred !== undefined) {
        this.deferredWebReads.delete(call.id);
        if (deferred !== JSON.stringify([call.tool, call.input]))
          throw new Error("Deferred tool input changed");
        if (this.context.executionClock) this.local.budgets.beforeTool(this.context, call);
        const decision = await this.local.approvals.serial(
          this.context.runId,
          signal,
          () => this.authorize(call, signal),
          this.timing(call.id),
        );
        if (!decision.allow) {
          const text = decision.reason ?? "Tool was not authorized / 工具未获授权";
          this.blocked(call, text);
          return { text, isError: true };
        }
      }
      return executeStep.call(this.operationContext(), call, signal, output);
    };
    const execute = () => this.timing(call.id)?.measure("exec", action) ?? action();
    if (this.states.get(call.id)?.synthetic) return execute();
    const endQueue = this.timing(call.id)?.enter("queue");
    return this.batch
      .run(call.id, signal, () => {
        endQueue?.();
        return execute();
      })
      .finally(() => {
        endQueue?.();
        this.pendingSearches.delete(call.id);
        this.deferredWebReads.delete(call.id);
      });
  }
  /** Folders a tool may change: file tools lock the root holding the file, commands all. */
  private writeLockRoots(prepared: PreparedTool) {
    return writeLockRootsStep.call(this.operationContext(), prepared);
  }
  /**
   * Holds `roots` for the rest of this run. While another run writes there the tool step shows
   * whom it is waiting for; reads and other tools of waiting Bots continue meanwhile.
   */
  async lockWrite(toolCallId: string, roots: readonly string[], signal: AbortSignal) {
    let waited = false;
    const end = this.timing(toolCallId)?.enter("queue");
    try {
      await this.local.writeLocks.acquire(this.lockOwner, roots, signal, (holder) => {
        waited = true;
        this.waitingForFolder(toolCallId, holder);
      });
    } finally {
      end?.();
    }
    if (waited) this.waitingForFolder(toolCallId);
  }
  /** The proof closes over this tool-run instance's random lease; no caller supplies an owner. */
  async managedConfigurationPublication<T>(
    prepared: PreparedTool,
    signal: AbortSignal,
    operation: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    const handle = prepared.gitConfiguration?.managed;
    if (
      !handle ||
      handle.binding.call.botId !== this.context.botId ||
      handle.binding.call.runId !== this.context.runId ||
      handle.binding.call.toolCallId !== prepared.call.id ||
      handle.binding.call.conversationId !== this.context.conversationId ||
      handle.binding.call.groupId !== this.context.groupId
    )
      throw new ExecError("authorization_changed");
    const assertCurrentOwner = () => {
      this.assertDispatch(prepared);
      if (!this.local.ownsManagedConfigurationContext(this.context))
        throw new ExecError("authorization_changed");
      this.local.writeLocks.assertOwner(this.lockOwner);
    };
    const proof = Object.freeze({
      call: handle.binding.call,
      assertCurrentOwner,
      ownsQueueEntry: (
        entry: Pick<ToolRunContext, "botId" | "runId" | "signal" | "conversationId" | "groupId"> & {
          drained?: boolean;
        },
      ) =>
        !entry.drained &&
        entry.runId === this.context.runId &&
        entry.botId === this.context.botId &&
        entry.conversationId === this.context.conversationId &&
        entry.groupId === this.context.groupId &&
        this.local.ownsManagedConfigurationContext(this.context, entry.signal),
      acquirePublicationRoots: async (observation: AbortSignal) => {
        assertCurrentOwner();
        await this.lockWrite(
          prepared.call.id,
          [handle.binding.primary.path, handle.binding.common.path],
          observation,
        );
        assertCurrentOwner();
      },
    });
    return handle.withPublicationLease(proof, signal, operation);
  }
  waitingForFolder(toolCallId: string, holder?: WriteLockOwner) {
    const state = this.states.get(toolCallId);
    if (!state || state.finished || this.closed) return;
    this.start(state);
    const name = holder ? (new BotsRepo(this.local.deps.db).get(holder.botId)?.name ?? "") : "";
    this.emit(state, "start", {
      status: "running",
      ...(holder ? { waitingFor: this.local.deps.redactor.redact(name).slice(0, 200) } : {}),
    });
  }
  private start(state: State) {
    if (state.started || state.finished) return;
    state.started = true;
    this.local.tools.update(state.recordId, { status: "running" });
    this.emit(state, "start", { status: "running" });
  }
  /** Async preparation is not authority: recheck at the final side-effect dispatch. */
  assertDispatch(prepared: PreparedToolView): void {
    assertDispatchStep.call(this.operationContext(), prepared as PreparedTool);
  }
  allowsUnisolated(id: string) {
    return this.states.get(id)?.unisolatedApproved === true;
  }
  writeRoots(prepared: PreparedToolView) {
    const state = this.states.get(prepared.call.id);
    const extra = state?.outsideWriteRoots ?? [];
    const analysis = (prepared as PreparedTool).result.analysis;
    // A proven query needs no project writes. Linux must scan writable aliases after adding
    // Git denies; omitting unused writes keeps large read-only queries out of that scan.
    if (
      prepared.call.tool === "run_command" &&
      (this.local.deps.platform === "linux" ||
        (this.local.deps.platform === "darwin" &&
          prepared.boundary?.roots.some((root) => root.role === "readonly"))) &&
      (prepared.boundary?.location?.target ?? "local") === "local" &&
      !prepared.docker &&
      analysis?.readonly &&
      !analysis.incomplete &&
      !analysis.network &&
      !analysis.writes.length &&
      !extra.length
    )
      return [];
    // Base roots first: callers such as the browser use the first root as their download folder.
    return [...new Set([...this.workplaceWriteRoots(prepared), ...extra])];
  }
  /** The run's own write roots, without folders a person opened for one call. */
  private workplaceWriteRoots(prepared: PreparedToolView) {
    const root = this.states.get(prepared.call.id)?.preauthWriteRoot;
    // A routine scope narrows the runtime sandbox as well as the gate's static analysis.
    return root ? [root] : (prepared.boundary?.writeRoots ?? prepared.roots);
  }
  allowPage(call: LocalToolCall, signal: AbortSignal): Promise<boolean> {
    return allowPageStep.call(this.operationContext(), call, signal);
  }

  get target(): ExecutionTarget {
    const location = this.context.runWorkplace?.boundary.location;
    const current = this.local.targetFor(location);
    if (this.selectedTarget && this.selectedTarget !== current)
      throw new RpcError(-32602, "execution_target_changed");
    if (!this.selectedTarget && location?.target.startsWith("runner:")) {
      const name =
        location.target === this.local.deps.executionLocation?.target
          ? location.target
          : this.local.executionTargets.require(location.target).name;
      this.context.executionDevice = { target: location.target, name };
    }
    this.selectedTarget ??= current;
    return this.selectedTarget;
  }
  private selectedTarget?: ExecutionTarget;
  private get remote() {
    return this.context.runWorkplace?.boundary.location?.target.startsWith("runner:") === true;
  }
  get browser(): BrowserToolPort | undefined {
    if (!this.local.deps.host.browser) return undefined;
    if (!this.browserTools) this.browserTools = createBrowserToolPort(this);
    return this.browserTools;
  }
  get platform() {
    return this.context.runWorkplace?.boundary.location?.platform ?? this.local.deps.platform;
  }
  get dataDir() {
    if (this.remote) return this.context.runWorkplace?.cwd ?? this.local.deps.dataDir;
    return this.local.deps.dataDir;
  }
  authorizationMatches(preparedView: PreparedToolView) {
    return (
      authorizationSnapshot(this.local, this.context.botId, this.context) ===
      (preparedView as PreparedTool).authorization
    );
  }
  commandSecretEnvironment(preparedView: PreparedToolView, signal: AbortSignal) {
    const prepared = preparedView as PreparedTool;
    return this.local.userSecrets.environment(prepared.secretUses ?? [], this.context, signal);
  }
  async validateCommandHandles(preparedView: PreparedToolView, signal: AbortSignal) {
    this.assertDispatch(preparedView);
    await validateCommandHandles(this.local, this.context, preparedView as PreparedTool, signal);
    this.assertDispatch(preparedView);
  }
  async commandHandleEnvironment(preparedView: PreparedToolView, signal: AbortSignal) {
    const prepared = preparedView as PreparedTool;
    this.assertDispatch(prepared);
    const resolved = await commandHandleEnvironment(this.local, this.context, prepared, signal);
    this.assertDispatch(prepared);
    return resolved;
  }
  commandSkillPackageIds() {
    return this.remote
      ? undefined
      : this.local.skills?.packageIds?.(
          this.context.botId,
          runPermissionScope(this.local, this.context),
        );
  }
  // A runner host has no skill environment of its own, so it never inherits one here.
  async commandSkillEnvironment() {
    if (this.remote) return undefined;
    return this.local.skills?.runtimeEnvironment?.(
      this.context.botId,
      runPermissionScope(this.local, this.context),
    );
  }
  commandGroupId() {
    return runPermissionScope(this.local, this.context);
  }
  commandPrivateHosts() {
    // Windows and runners have no Pi Bot sandbox proxy here; policy never asks for them either.
    if (this.remote || this.local.deps.platform === "win32") return [];
    return this.local.privateNetwork.hosts(this.context.runId);
  }
  async watchCommandRoots(prepared: PreparedToolView, serial = false) {
    // The desktop filesystem watcher cannot observe a runner; never inspect a same-named local root.
    if (this.remote) return;
    // A folder opened for one call is outside the workplace whose changes this lists;
    // scanning a cache tree there would only cost time. The audit names it instead.
    const roots = this.workplaceWriteRoots(prepared);
    if (serial) {
      for (const root of roots) await this.local.changes.turn.watchCommand(this.context, root);
      return;
    }
    await Promise.all(
      roots.map((root) => this.local.changes.turn.watchCommand(this.context, root)),
    );
  }
  clearCommandChecks() {
    this.checkReceipts.clear();
  }
  async beginCommandCheck(command: string, preparedView: PreparedToolView, signal: AbortSignal) {
    const prepared = preparedView as PreparedTool;
    const scope = this.checkScope();
    if (!scope || prepared.docker || prepared.secretUses?.length) {
      this.checkReceipts.clear();
      return;
    }
    return this.checkReceipts.begin(command, scope, signal);
  }
  finishCommandCheck(check: unknown, toolCallId: string, success: boolean, signal: AbortSignal) {
    return this.checkReceipts.finish(
      check as PendingCheck | undefined,
      toolCallId,
      success,
      signal,
    );
  }
  assertDockerDispatch(preparedView: PreparedToolView) {
    const prepared = preparedView as PreparedTool;
    if (
      this.local.permissions.effective(this.context.botId).dockerRuntime !==
        prepared.docker?.runtime ||
      !this.authorizationMatches(prepared)
    )
      throw new ExecError("docker_permission_changed");
  }
  commandFailureGuidance(
    literal: { program: string; args: string[] } | undefined,
    output: string,
    sandboxBlock?: SandboxBlock,
    outsideSandbox = false,
    sandboxedExecution = false,
    network?: { allowAll: boolean; domains: readonly string[] },
  ) {
    return commandFailureGuidance(
      this.platform,
      literal,
      output,
      !this.remote,
      sandboxBlock,
      outsideSandbox,
      sandboxedExecution,
      network,
    );
  }
  commandReadGuidance(literal: { program: string; args: string[] } | undefined) {
    // Only a returned hint spends the run's one reminder; a non-read must not swallow it.
    if (this.readHintShown) return undefined;
    const hint = commandReadGuidance(this.context.language, literal);
    if (hint) this.readHintShown = true;
    return hint;
  }
  commandBrowserOpenGuidance(literal: { program: string; args: string[] } | undefined) {
    if (this.browserOpenHintShown) return undefined;
    const hint = commandBrowserOpenGuidance(this.context.language, literal);
    if (hint) this.browserOpenHintShown = true;
    return hint;
  }
  /** Remembers the block; true when a run outside the sandbox may be offered. */
  recordSandboxBlock(prepared: PreparedToolView, block: SandboxBlock) {
    recordSandboxNotices(this.local, this.context, prepared as PreparedTool, block);
    const call = prepared.call.input as { command?: unknown; cwd?: unknown };
    if (
      typeof call.command !== "string" ||
      (call.cwd !== undefined && typeof call.cwd !== "string")
    )
      return false;
    const recorded = this.context.sandboxBlocks?.record(
      { command: call.command, cwd: call.cwd as string | undefined },
      (prepared as PreparedTool).cwd,
      block,
    );
    return (
      !!recorded &&
      !this.remote &&
      new SettingsRepo(this.local.deps.db).get().strictSandbox !== true
    );
  }
  sandboxBlockRepeatCount(prepared: PreparedToolView, block: SandboxBlock) {
    const call = prepared.call.input as { command?: unknown; cwd?: unknown };
    return typeof call.command === "string" &&
      (call.cwd === undefined || typeof call.cwd === "string")
      ? (this.context.sandboxBlocks?.repeatCount(
          { command: call.command, cwd: call.cwd as string | undefined },
          block,
        ) ?? 0)
      : 0;
  }
  outsideSandboxPermit(prepared: PreparedToolView) {
    return outsideSandboxPermit(prepared as PreparedTool, this.context.sandboxBlocks, {
      patterns: new SettingsRepo(this.local.deps.db).get().sandboxOutsideCommands ?? [],
      automatic: automaticOutsidePatterns(
        new SettingsRepo(this.local.deps.db).get().sandboxAutoOutsideCommands ?? [],
        prepared.cwd,
      ),
      strict: new SettingsRepo(this.local.deps.db).get().strictSandbox,
      platform: this.local.deps.platform as Platform,
    });
  }
  rememberOutsideCommand(view: PreparedToolView) {
    const prepared = view as PreparedTool;
    const repo = new SettingsRepo(this.local.deps.db);
    const settings = repo.get();
    if (this.remote || settings.strictSandbox || !prepared.confirmedNow) return;
    if (
      prepared.result.reason === "local_service_once" ||
      prepared.result.reason === "system_service_once"
    ) {
      this.context.sandboxBlocks?.consume(
        prepared.call.input as { command: string; cwd?: string },
        prepared.cwd,
      );
      return;
    }
    if (prepared.result.reason === OUTSIDE_WRITE_REASON) {
      const command = (prepared.call.input as { command?: string }).command;
      const program = prepared.result.analysis?.commands?.[0]?.program;
      const paths = prepared.result.outsideWrites ?? [];
      if (!command || !program || !paths.length) return;
      const entries = settings.sandboxAutoWritePaths ?? [];
      const next = paths
        .filter(
          (path) =>
            !entries.some(
              (entry) =>
                entry.folder === prepared.cwd && entry.program === program && entry.path === path,
            ),
        )
        .slice(0, Math.max(0, 256 - entries.length))
        .map((path) => ({ folder: prepared.cwd, program, path, createdAt: Date.now() }));
      if (!next.length) return;
      transaction(this.local.deps.db, () => {
        repo.set({ sandboxAutoWritePaths: [...entries, ...next] });
        this.local.approvals.audit.append({
          botId: this.context.botId,
          runId: this.context.runId,
          kind: "permissions.changed",
          summary: "Remembered command write path / 自动记住命令写入路径",
          detail: { actor: "automatic", reasonCode: "sandbox_write_path_remembered" },
        });
      });
      this.local.deps.peer.emit("settings.changed", repo.get());
      return;
    }
    if (prepared.result.reason !== OUTSIDE_SANDBOX_REASON) return;
    const command = (prepared.call.input as { command?: string }).command;
    const pattern =
      command &&
      automaticOutsideShape(
        command,
        prepared.result.analysis,
        this.local.deps.platform as Platform,
      );
    const entries = settings.sandboxAutoOutsideCommands ?? [];
    if (
      !pattern ||
      entries.length >= 256 ||
      entries.some((entry) => entry.pattern === pattern && entry.folder === prepared.cwd)
    )
      return;
    transaction(this.local.deps.db, () => {
      repo.set({
        sandboxAutoOutsideCommands: [
          ...entries,
          { pattern, folder: prepared.cwd, source: "auto", createdAt: Date.now() },
        ],
      });
      this.local.approvals.audit.append({
        botId: this.context.botId,
        runId: this.context.runId,
        kind: "permissions.changed",
        summary: "Remembered outside-sandbox command / 自动记住沙箱外命令",
        detail: { actor: "automatic", reasonCode: "sandbox_outside_auto_remembered" },
      });
    });
    this.local.deps.peer.emit("settings.changed", repo.get());
  }
  commandSystemServices(view: PreparedToolView) {
    const prepared = view as PreparedTool;
    if (
      this.remote ||
      this.local.deps.platform !== "darwin" ||
      this.context.routineRunId ||
      prepared.call.tool !== "run_command"
    )
      return undefined;
    const settings = new SettingsRepo(this.local.deps.db).get();
    if (settings.strictSandbox) return undefined;
    const program = prepared.result.analysis?.commands?.[0]?.program;
    if (!program) return undefined;
    const current =
      prepared.result.reason === "system_service_once" && prepared.confirmedNow
        ? this.context.sandboxBlocks?.systemService(
            prepared.call.input as { command: string; cwd?: string },
          )
        : undefined;
    return [
      ...new Set([
        ...(settings.sandboxAutoSystemServices ?? [])
          .filter((entry) => entry.folder === prepared.cwd && entry.program === program)
          .map((entry) => entry.service)
          // Remembered under an older list: a service closed since is skipped, not a failed run.
          .filter(rememberableSystemService),
        ...(current ? [current] : []),
      ]),
    ];
  }
  commandLocalServices(prepared: PreparedToolView) {
    if (
      this.remote ||
      this.local.deps.platform !== "darwin" ||
      this.context.routineRunId ||
      prepared.call.tool !== "run_command"
    )
      return undefined;
    const input = prepared.call.input as { command?: unknown };
    const program = prepared.result.analysis?.commands?.[0]?.program;
    if (typeof input.command !== "string" || !program) return undefined;
    const settings = new SettingsRepo(this.local.deps.db).get();
    if (settings.strictSandbox) return undefined;
    const entries = settings.sandboxAutoLocalServices ?? [];
    const matches = entries.filter(
      (entry) => entry.folder === prepared.cwd && entry.program === program,
    );
    const current = [
      ...new Set([
        ...matches.map((entry) => entry.target),
        ...(prepared.result.reason === "local_service_once" &&
        (prepared as PreparedTool).confirmedNow
          ? [
              this.context.sandboxBlocks?.localService({
                command: input.command,
                cwd: (prepared.call.input as { cwd?: string }).cwd,
              })?.target,
            ].filter((target): target is string => !!target)
          : []),
      ]),
    ];
    if (!current.length) return undefined;
    return {
      ports: current.flatMap((target) => {
        const match = /^(?:127\.0\.0\.1|localhost|::1):(\d+)$/.exec(target);
        return match ? [Number(match[1])] : [];
      }),
      sockets: current.filter((target) => target.startsWith("/")),
    };
  }
  /** The line's one result-bearing program, from the shell analysis policy made. */
  commandCredentialProgram(prepared: PreparedToolView) {
    const command = (prepared.call.input as { command?: unknown }).command;
    if (typeof command !== "string" || this.remote) return undefined;
    return soleInvokedProgram(
      command,
      (prepared as PreparedTool).result.analysis,
      this.local.deps.platform as Platform,
    );
  }
  /** An exec record names every folder a person opened for that one call. */
  private withOpenedRoots(detail: AuditDetail): AuditDetail {
    const opened = detail.toolCallId
      ? this.states.get(detail.toolCallId)?.outsideWriteRoots
      : undefined;
    if (!opened?.length) return detail;
    return {
      ...detail,
      writeRoots: opened
        .slice(0, 16)
        .map((root) => auditText(root, this.local.deps.redactor, 4096)),
    };
  }
  /**
   * A command or file operation may run on another computer; the device name and target go into
   * the record so the audit alone says where it happened. Local work records nothing extra.
   */
  private withDevice(detail: AuditDetail): AuditDetail {
    const device = this.context.executionDevice;
    if (!device) return detail;
    return {
      ...detail,
      deviceName: auditText(device.name, this.local.deps.redactor),
      deviceTarget: device.target,
    };
  }
  auditCommand(phase: "started" | "finished", summary: string, detail: AuditDetail) {
    detail = this.withDevice(detail);
    if (phase === "started") detail = this.withOpenedRoots(detail);
    this.local.approvals.audit.append({
      botId: this.context.botId,
      runId: this.context.runId,
      kind: phase === "started" ? "exec.started" : "exec.finished",
      summary,
      detail,
    });
  }
  prepareForegroundCommand(preparedView: PreparedToolView) {
    if (
      !this.target.supportsCommandPromotion ||
      this.remote ||
      this.context.routineSource ||
      this.states.get(preparedView.call.id)?.synthetic
    )
      return;
    const prepared = preparedView as PreparedTool;
    return this.local.background.foreground.prepare({
      context: this.context,
      prepared,
      assertCurrent: () => this.assertDispatch(prepared),
    });
  }
  startBackgroundCommand(input: {
    prepared: PreparedToolView;
    command: string;
    secretEnv: Record<string, string>;
    allowUnisolated: boolean;
    auditFields: AuditDetail;
    signal: AbortSignal;
  }) {
    const prepared = input.prepared as PreparedTool;
    return this.local.background.start({
      context: this.context,
      prepared,
      assertAuthorized: () => this.assertDispatch(prepared),
      command: input.command,
      secretEnv: input.secretEnv,
      file: {
        rootIdentities: prepared.boundary?.roots,
        cwd: prepared.cwd,
        writeRoots: this.writeRoots(prepared),
        denyWriteRoots: prepared.boundary?.denyWriteRoots,
      },
      allowUnisolated: input.allowUnisolated,
      auditFields: this.withOpenedRoots(input.auditFields),
      signal: input.signal,
    });
  }
  listBackgroundCommands(limit: number) {
    return this.local.background.list(this.context.botId, limit);
  }
  getBackgroundCommand(id: string) {
    return this.local.background.toolRecord(this.context.botId, id);
  }
  stopBackgroundCommand(id: string) {
    return this.local.background.stop(this.context.botId, id, "bot");
  }
  backgroundOutput(id: string, maxChars: number) {
    return this.local.background.readOutput(
      this.context.botId,
      id,
      maxChars,
      this.context.conversationId,
    );
  }
  async waitBackgroundOutput(
    id: string,
    maxChars: number,
    seconds: number,
    signal: AbortSignal,
    untilEnd = false,
  ) {
    return this.local.background.waitOutput(
      this.context.botId,
      id,
      maxChars,
      seconds,
      signal,
      this.context.conversationId,
      untilEnd,
    );
  }
  backgroundInputTarget(id: string) {
    return this.local.background.inputTarget(this.context, id);
  }
  get fetchPage() {
    return this.local.deps.fetchPage;
  }
  get proxy() {
    return this.local.deps.proxy;
  }
  get revealPath() {
    return this.local.deps.host.revealPath;
  }
  get extractPage(): ToolRuntime["extractPage"] {
    const extract = this.local.deps.extractPage;
    if (!extract) return undefined;
    return (input) =>
      extract({
        ...input,
        ...(this.context.executionClock
          ? { observer: this.local.budgets.observer(this.context) }
          : {}),
      });
  }
  redact(text: string) {
    return this.local.deps.redactor.redact(text);
  }
  log(level: "info" | "warn", fields: Record<string, unknown>) {
    this.local.deps.logger[level](JSON.stringify(fields));
  }
  async authorizePatchRecovery(
    preparedView: PreparedToolView,
    paths: readonly string[],
    signal: AbortSignal,
  ) {
    const prepared = preparedView as PreparedTool;
    const approved = new Set(
      prepared.patchPaths ?? (prepared.result.path ? [prepared.result.path.path] : []),
    );
    for (const path of paths) {
      const current = await this.prepare(
        { ...prepared.call, tool: "write_file", input: { path, content: "" } },
        signal,
      );
      if (
        current.result.decision === "deny" ||
        (current.result.decision === "ask" && !approved.has(path))
      )
        throw new ExecError("file_conflict", "cleanup_failed");
    }
    this.assertDispatch(prepared);
  }
  async authorizeSearchPath(prepared: PreparedToolView, signal: AbortSignal) {
    const timing = this.timing(prepared.call.id);
    const create = () => searchPathAuthorizer(this, prepared as PreparedTool, signal);
    const authorize = await (timing ? timing.measure("policy", create) : create());
    return (...args: Parameters<typeof authorize>) =>
      timing ? timing.measure("policy", () => authorize(...args)) : authorize(...args);
  }
  /**
   * A file a person allowed outside the workplace is not part of the workplace's change
   * list, whose undo would write there again without a card. The audit records the write.
   */
  private insideRunRoots(path: string) {
    const roots = this.context.runWorkplace?.boundary.roots.map((root) => root.canonicalPath);
    return !roots || roots.some((root) => containsPath(root, path, this.local.deps.platform));
  }
  beforeWrite(path: string): Promise<unknown> {
    if (this.remote || !this.insideRunRoots(path)) return Promise.resolve(undefined);
    return this.local.changes.turn.beforeWrite(this.context, path);
  }
  afterWrite(before: unknown, path: string, root: string) {
    if (this.remote || !before || !containsPath(root, path, this.local.deps.platform))
      return Promise.resolve();
    return this.local.changes.turn.afterWrite(
      this.context,
      before as Awaited<ReturnType<typeof this.local.changes.turn.beforeWrite>>,
      path,
      root,
    );
  }
  auditInput(
    fields: AuditDetail,
    input: { kind: "file"; path: string } | { kind: "web"; domain: string },
  ) {
    auditInput(this.local, this.context, this.withDevice(fields), input);
  }
  observeProjectNotes(prepared: PreparedToolView, path: string, text: string, ownWrite = false) {
    observeProjectNotes(this.local, this.context, prepared, path, text, ownWrite);
  }
  auditWritten(entries: readonly { detail: AuditDetail; summary: string }[]) {
    transaction(this.local.deps.db, () => {
      for (const entry of entries)
        this.local.approvals.audit.append({
          botId: this.context.botId,
          runId: this.context.runId,
          kind: "file.written",
          summary: entry.summary,
          detail: this.withDevice(entry.detail),
        });
    });
  }
  auditRevealed(fields: AuditDetail & { path: string }) {
    this.local.approvals.audit.append({
      botId: this.context.botId,
      runId: this.context.runId,
      kind: "file.revealed",
      summary: "Showed in folder / 在文件夹中显示",
      detail: this.withDevice(fields),
    });
  }
  postWrite(call: ToolCallView, signal: AbortSignal) {
    if (this.remote) return Promise.resolve(undefined);
    return runPostWriteHook(this, call, signal);
  }
  afterEdit(root: string, path: string, signal: AbortSignal) {
    // A file outside the workplace is not part of the project being diagnosed.
    if (this.remote || !containsPath(root, path, this.local.deps.platform))
      return Promise.resolve(undefined);
    return this.local.navigation.afterEdit(this.context, root, path, signal);
  }
  markSkillUsed(path: string) {
    if (this.remote) return;
    return this.local.skills?.markUsedAt(
      this.context.botId,
      path,
      runPermissionScope(this.local, this.context),
      this.context.language,
    );
  }
  redactAiConfig(path: string, text: string) {
    return redactAiConfig(path, text);
  }
  async extractPdf(bytes: Uint8Array, signal: AbortSignal) {
    const parsed = await extractAttachment(Buffer.from(bytes), true, signal, { maxPages: 50 });
    return {
      text: parsed.text,
      totalChars: parsed.totalChars,
      pages: parsed.pages,
      scanned: parsed.scanned,
    };
  }
  admitPdf(path: string) {
    return this.local.collaboration?.admitPdf?.(this.context, path) ?? true;
  }
  mapPageError(error: unknown) {
    return mapAgentError(error);
  }
  /**
   * Audits an operation YOLO let through and marks its step 「YOLO 自动允许」. `call` may be
   * an operation derived from the step (same tool call id), which is what the audit names.
   */
  markYolo(call: LocalToolCall, result: PolicyResult) {
    auditYolo(this.local, this.context, call, result);
    const state = this.states.get(call.id);
    if (!state) return;
    state.yolo = state.yolo === "danger" ? "danger" : result.risk;
    this.local.tools.markYolo(state.recordId, result.risk);
    if (state.started && !state.finished) this.emit(state, "start", { status: "running" });
  }
  private emit(
    state: State,
    phase: LocalToolActivity["phase"],
    extra: {
      output?: string;
      status?: ToolStatus;
      exitCode?: number;
      durationMs?: number;
      waitingFor?: string;
    } = {},
  ): void {
    emitStep.call(this.operationContext(), state, phase, extra);
  }
  private failInput(state: State, failure: NonNullable<State["inputFailure"]>): void {
    failInputStep.call(this.operationContext(), state, failure);
  }
  private refuseExecutionCheck(call: LocalToolCall, error: ExecError): string {
    const state = this.state(call);
    const check = error.check;
    // Log only fixed identifiers. The exception or command can contain user data.
    state.auditFacts = {
      ...state.auditFacts,
      reasonCode: check,
      policySteps: [...(state.auditFacts?.policySteps ?? []), check],
    };
    this.local.deps.logger.warn(
      JSON.stringify({
        module: "tool-gate",
        event: "authorization_check_refused",
        botId: this.context.botId,
        runId: this.context.runId,
        errorCode: error.code,
        check,
      }),
    );
    return authorizationCheckText(error);
  }

  blocked(call: LocalToolCall, reason: string, failed = false): void {
    blockedStep.call(this.operationContext(), call, reason, failed);
    this.batch.skip(call.id);
    this.pendingSearches.delete(call.id);
    this.deferredWebReads.delete(call.id);
  }
  activity(event: LocalToolActivity): void {
    activityStep.call(this.operationContext(), event);
    if (event.phase === "end") {
      this.batch.skip(event.id);
      this.pendingSearches.delete(event.id);
      this.deferredWebReads.delete(event.id);
    }
  }
  /**
   * A step Pi Bot itself starts in this run (the automatic check). It takes exactly the
   * path of a model's tool call — the same gate, card, YOLO, write lock, execution, audit and
   * step record — so there is no second way to run a command.
   */
  runSynthetic(
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<{ allowed: true; result: LocalToolResult } | { allowed: false; reason: string }> {
    return runSyntheticStep.call(this.operationContext(), call, signal);
  }
  reply() {
    return this.context.assistantReply;
  }
  setMessage(messageId: string) {
    if (this.closed || [...this.states.values()].some((state) => !state.finished))
      throw new RpcError(-32603, "Tool boundary not drained");
    // A group run's identity snapshot names its reply; a new segment (automatic-check follow-up)
    // moves
    // it, so re-take the snapshot, but only if it still held for the previous reply.
    const held =
      !!this.context.groupId &&
      groupAuthorization(this.local, this.context) === this.context.groupAuthorization;
    this.context.messageId = messageId;
    this.context.assistantReply = undefined;
    if (held) this.context.groupAuthorization = groupAuthorization(this.local, this.context);
  }
  finish = () => {
    this.batch.close();
    this.pendingSearches.clear();
    this.deferredWebReads.clear();
    this.webFetchCache.clear();
    this.checkReceipts.clear();
    this.local.yolo.releaseRun(this.context.runId);
    // Local-network approvals expire with the run (maintainers 2026-11-14); a parked run asks again.
    this.local.privateNetwork.finishRun(this.context.runId);
    if (this.closed) return;
    // A run's computer grant never outlives it; release is idempotent.
    const computer = this.local.computerGrants.release(this.context.runId);
    // Parking also ends this process's view of the run: its command watch stops here. The folder
    // lock is released only after the watch stopped, so the next writer's changes never land in
    // this run's "this turn".
    const browser = this.local.browserProvider?.finishRun(this.context) ?? Promise.resolve();
    // A command deadline may return before its underlying process drains. Keep the folder
    // lease through exec retirement too; a cleanup failure must remain a failed drain receipt.
    const command =
      this.remote && !this.selectedTarget
        ? Promise.resolve()
        : Promise.resolve().then(() =>
            (this.selectedTarget ?? this.target).releaseRun(this.context.runId),
          );
    const ordinary = Promise.all([
      this.local.changes.turn.finish(this.context),
      browser,
      computer,
    ]).then(() => {});
    const releaseWrite = () =>
      this.local.writeLocks.release(this.lockOwner.runId, this.lockOwner.lease);
    const detached = this.local.background.retainCleanup(
      this.context.runId,
      () => Promise.all([ordinary, command]).then(() => {}),
      releaseWrite,
    );
    this.local.runCleanup.hold(
      this.context.runId,
      detached ? ordinary : Promise.all([ordinary, command]).then(() => {}),
      () => {
        this.local.computerGrants.drained(this.context.runId);
        if (!detached) releaseWrite();
      },
    );
    this.local.credentials.finishRun(this.context.runId);
    if (this.context.isParking?.()) {
      this.context.toolTiming = undefined;
      this.closed = true;
      return;
    }
    if (this.closed) return;
    this.local.approvals.cancel(this.context.runId);
    for (const state of this.states.values())
      if (!state.finished)
        this.activity({ id: state.call.id, tool: state.call.tool, phase: "end", isError: true });
    this.context.toolTiming = undefined;
    this.closed = true;
    this.states.clear();
  };

  // Keep live access to private state: an awaited step must observe later cancellation and scope changes.
  private operationContext() {
    const owner = this;
    return {
      owner,
      activity: owner.activity.bind(owner),
      authorize: owner.authorize.bind(owner),
      authorizeComputer: owner.authorizeComputer.bind(owner),
      blocked: owner.blocked.bind(owner),
      get closed() {
        return owner.closed;
      },
      set closed(value: LocalRun["closed"]) {
        owner.closed = value;
      },
      consentCard: owner.consentCard.bind(owner),
      get context() {
        return owner.context;
      },
      emit: owner.emit.bind(owner),
      failInput: owner.failInput.bind(owner),
      get local() {
        return owner.local;
      },
      lockWrite: owner.lockWrite.bind(owner),
      loginTitle: owner.loginTitle.bind(owner),
      markYolo: owner.markYolo.bind(owner),
      get ports() {
        return owner.ports;
      },
      prepare: owner.prepare.bind(owner),
      timing: owner.timing.bind(owner),
      start: owner.start.bind(owner),
      state: owner.state.bind(owner),
      get states() {
        return owner.states;
      },
      validSearch: owner.validSearch.bind(owner),
      writeLockRoots: owner.writeLockRoots.bind(owner),
      writeRoots: owner.writeRoots.bind(owner),
    };
  }
}
