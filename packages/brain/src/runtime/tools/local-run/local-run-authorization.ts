import type { LocalToolCall } from "@pibot/agent";
import { ExecError, type ExecutionTarget, linuxIsolationRemedy } from "@pibot/execution";
import {
  applyEditorTerminal,
  applyWindowsCommandConsent,
  applyYolo,
  browserSecretPolicy,
  EDITOR_TERMINAL_UNISOLATED,
  editorTerminalReadonly,
  explainPolicyResult,
  mustAskNow,
  OUTSIDE_WRITE_REASON,
  type PolicyResult,
  REVEAL_CONFIRMATION_REASON,
  recordPolicyStep,
  WINDOWS_ORDINARY_COMMAND,
  WINDOWS_READ_ONLY,
} from "@pibot/policy";
import { BrowserNetworkConsentText, RpcError } from "@pibot/protocol-base";
import { BotsRepo, SettingsRepo } from "@pibot/storage";
import { BROWSER_RESOURCE_BUSY, loginChoiceText } from "@pibot/tools/browser";
import type { ConnectorCardDisplay } from "../../../core/approvals.ts";
import { collaborationRefusal } from "../../../core/assignment-refusal.ts";
import { auditProviderName, auditText, auditToolFields } from "../../../core/audit-fields.ts";
import { allowFolderForRun, auditAutoAllow, isAutoAllowed } from "../../../core/auto-allow.ts";
import { GroupToolError } from "../../../core/collaboration-tool-error.ts";
import type { PreparedTool } from "../../../core/local-types.ts";
import { allowedByYolo, runYolo } from "../../../core/yolo.ts";
import {
  acceptSearch,
  confirmSearch,
  needsSearchDisclosure,
  type SearchConsentReceipt,
} from "../../../integrations/search/search-consent.ts";
import type { SearchRecipient } from "../../../integrations/search/search-service.ts";
import { isComputerTool } from "../../computer/computer-grants-policy.ts";
import { loginNeedsChoice, loginTitle } from "../browser/browser-login.ts";
import { CommandInputError } from "../command-input.ts";
import { connectionRuled } from "../connectors/capability-adapter.ts";
import { executionPaused } from "../execution-paused.ts";
import {
  approvedUnchanged,
  authorizationSnapshot,
  toolFingerprint as fingerprint,
} from "../local-prepare.ts";
import type { LocalRunOperations } from "../local-run.ts";
import { policyWebsiteGuidance } from "../policy-website-notices.ts";
import { openPrivateTargets } from "../private-network.ts";
import { linkSandboxApproval } from "../sandbox-notices.ts";
import { RunnerToolUnsupportedError, runnerFailure } from "../target-tools.ts";
import { authorizationCheckText } from "../tool-error-text.ts";
import { blockedReason, isCollaboration, toolInputFailure } from "../tools.ts";
import {
  approvalContext,
  approvalResult,
  isCommandCall,
  PLAN_READ_ONLY,
  type State,
} from "./local-run-shared.ts";

/**
 * The session's working folders (primary and the editor's additional directories) and the
 * platform the editor terminal runs on, as policy judges an ACP command against them.
 */
function editorTerminalScope(this: LocalRunOperations, prepared: PreparedTool) {
  return {
    roots: prepared.boundary?.readRoots ?? prepared.roots,
    platform: prepared.boundary?.location?.platform ?? this.local.deps.platform,
  };
}

/** Apply the explicit approval boundary of ACP and Windows targets; neither is ever a grant. */
export function applyExplicitUnisolatedTarget(
  this: LocalRunOperations,
  prepared: PreparedTool,
  reason: string | undefined,
) {
  if (
    !isCommandCall(prepared.call.tool) ||
    prepared.result.decision === "deny" ||
    prepared.docker ||
    (reason !== "windows_unisolated" && reason !== EDITOR_TERMINAL_UNISOLATED)
  )
    return;
  const consent =
    runYolo(this.local, this.context) &&
    new SettingsRepo(this.local.deps.db).get().yoloUnisolatedCommands === true;
  const bounded =
    reason === EDITOR_TERMINAL_UNISOLATED
      ? applyYolo(
          applyEditorTerminal(prepared.result, {
            ...editorTerminalScope.call(this, prepared),
            sessionShapes: this.local.approvals.editorSessionShapes(this.context),
          }),
          consent,
          { unisolatedCommands: true },
        )
      : applyWindowsCommandConsent(prepared.result, consent);
  prepared.result = browserSecretPolicy(bounded, prepared.browserSecretUses?.length ?? 0);
}

export async function authorizeStep(
  this: LocalRunOperations,
  call: LocalToolCall,
  signal: AbortSignal,
  confirmation = false,
  recipient?: SearchRecipient,
): Promise<{ allow: boolean; reason?: string }> {
  if (this.closed) return { allow: false, reason: "已停止 / Stopped" };
  const state = this.state(call);
  const refuse = (code: string, reason: string) => {
    state.auditFacts = {
      ...state.auditFacts,
      policySteps: [...new Set([...(state.auditFacts?.policySteps ?? []), code])],
      // The audit and the step record keep the structured code; no display text is parsed.
      // A more specific code (the policy deny that produced this refusal) wins over the generic
      // refuser, so "记录" can name the actual reason.
      ...(state.auditFacts?.reasonCode ? {} : { reasonCode: code }),
    };
    return { allow: false, reason };
  };
  if (this.local.approvals.deniedOnResume(this.context, call))
    return refuse(
      "approval_user_denied",
      "用户拒绝了暂停的这一步，请换办法 / The user denied this paused operation; use another approach",
    );
  let failedRecheck: { check: string; text: string } | undefined;
  const recheckRefusal = (result: PolicyResult, error: ExecError): PolicyResult => {
    const check = error.check;
    failedRecheck = { check, text: authorizationCheckText(error) };
    return explainPolicyResult(
      { ...result, decision: "deny", reason: check, canRemember: false },
      "boundary",
      check,
    );
  };
  await this.local.tasks.guard(this.context, signal);
  if (!this.ports.definitions.some((tool) => tool.name === call.tool)) {
    const reason =
      "当前未加载此工具：先用 tool_discover 查找；确实不可用时请在 Bot / 群权限与连接详情中核对启用和访问范围。 / Tool not loaded: use tool_discover first; if unavailable, check Bot/group permissions and the connection’s enabled tools and access.";
    const denied = refuse("tool_not_loaded", reason);
    this.blocked(call, reason);
    return denied;
  }
  if (
    this.context.executionTaskId &&
    (call.tool === "read_messages" || isCollaboration(call.tool))
  ) {
    return refuse(
      "task_conversation_scope",
      "子任务只能使用父任务明确提供的对话引用 / A subtask can use only conversation references provided by its parent",
    );
  }
  if (!this.local.execution.allows(this.context, call.tool)) {
    state.auditFacts = { policySteps: ["plan_readonly"] };
    const denied = refuse("plan_readonly", PLAN_READ_ONLY);
    this.blocked(call, PLAN_READ_ONLY);
    return denied;
  }
  state.preauthId = undefined;
  state.preauthWriteRoot = undefined;
  // A retry of the same call id is a new call; what was opened before is not reused.
  state.outsideWriteRoots = undefined;
  const failure = toolInputFailure(call.tool, call.input, this.local.deps.capabilityTools);
  if (failure) {
    const reported =
      this.local.collaboration?.planInputFailure?.(this.context, call, failure) ?? failure;
    this.failInput(state, { ...failure, text: reported.text });
    return refuse("invalid_tool_input", reported.text);
  }
  if (isComputerTool(call.tool)) return this.authorizeComputer(state, call, signal);
  let prepared: PreparedTool;
  try {
    prepared = await this.prepare(call, signal, recipient);
  } catch (error) {
    // Commands are paused while a background cleanup is unconfirmed; reporting that as a refused
    // approval is what hid the real cause for hours.
    const paused = executionPaused(error);
    if (paused) {
      signal.throwIfAborted();
      const denied = refuse("cleanup_failed", paused);
      this.blocked(call, paused);
      return denied;
    }
    if (error instanceof CommandInputError) {
      const failure = toolInputFailure(
        call.tool,
        call.input,
        this.local.deps.capabilityTools,
        error.validation,
      );
      if (failure) {
        this.failInput(state, failure);
        return refuse("invalid_tool_input", failure.text);
      }
    }
    const assignment = collaborationRefusal(call.tool, error);
    if (assignment && !signal.aborted) return refuse("tool_authorization_refused", assignment);
    if (error instanceof RpcError && error.message === "background_input_unavailable")
      return refuse(
        "background_input_unavailable",
        "找不到当前 Bot 在此话题的存活后台进程，或当前运行不支持交互输入 / No live background process owned by this Bot in this conversation, or this run does not support interactive input",
      );
    if (error instanceof RpcError && error.message === "browser_resource_busy")
      return refuse("browser_resource_busy", BROWSER_RESOURCE_BUSY);
    // The catalog hides these for a runner workplace; a direct or retried call still gets the
    // tool's name instead of the generic "tool approval failed" text.
    if (error instanceof RunnerToolUnsupportedError)
      return refuse("runner_tool_unsupported", error.message);
    // Preparing the call resolves the runner target, so offline / revoked / dropped surfaces here.
    if (error instanceof RpcError && ["endpoint_offline", "capability_off"].includes(error.message))
      return refuse(error.message, error.message);
    if (error instanceof RpcError && error.message === "phone_wake_timeout")
      return refuse(
        "phone_wake_timeout",
        "已尝试唤醒，手机没有及时上线；请打开 App 或开启保持连接 / Wake attempted, but the phone did not connect in time; open the app or enable Stay connected",
      );
    if (error instanceof RpcError && error.message === "phone_wake_unavailable")
      return refuse(
        "phone_wake_unavailable",
        "无法后台唤醒手机（未开启通知或数据、达到频率限制，或不支持推送）；请打开 App 或开启保持连接。无 Google 服务的安卓手机不支持后台推送 / Cannot wake the phone (notifications or data off, rate limited, or push unavailable); open the app or enable Stay connected. Android without Google services cannot receive background pushes",
      );
    const runnerFailed = runnerFailure(error);
    if (runnerFailed) return refuse(runnerFailed.code, runnerFailed.text);
    // The execution device refuses its own private paths (credentials, its data
    // folder, a drive root, another machine's share) the same way policy protects this computer's.
    // Thrown, that correct refusal reached the model as "Tool approval failed" and logged at error
    // level, as if the gate had crashed.
    if (error instanceof RpcError && error.message === "runner_path_unavailable")
      return refuse(
        "protected_path",
        "执行端拒绝了这个位置：它在执行端设备上受保护或不可用（凭据、Pi Bot 数据目录、盘符根目录、其他设备的共享，或工作位置之外）。请改用工作文件夹里的具体子路径，或请用户自己处理 / The execution target refused this location: on that device it is protected or unavailable (credentials, Pi Bot's data folder, a drive root, another device's share, or outside the workplace). Use a specific path inside the working folder, or ask the user to handle it",
      );
    if (error instanceof GroupToolError)
      return refuse("tool_authorization_refused", this.local.deps.redactor.redact(error.message));
    if (
      isCollaboration(call.tool) &&
      error instanceof RpcError &&
      (error.code === -32602 || error.code === -32011)
    )
      return refuse(
        "tool_authorization_refused",
        "协作身份、归属或周期不可用，或存在循环 / Collaboration identity, ownership or cycle unavailable, or cyclic request",
      );
    throw error;
  }
  state.auditFacts = {
    ...auditToolFields(
      call,
      this.local.deps.redactor,
      prepared.result,
      this.local.deps.capabilityTools,
    ),
    source: this.context.routineSource ?? this.context.auditSource ?? "chat",
    ...(this.context.routineRunId ? { routineRunId: this.context.routineRunId } : {}),
    ...(prepared.result.decision === "deny" ? { reasonCode: prepared.result.reason } : {}),
  };
  if (prepared.result.decision === "deny")
    return refuse(
      prepared.result.reason,
      prepared.result.reason === "browser_login_choose"
        ? loginChoiceText(prepared.login?.accounts.map((account) => account.label) ?? [])
        : blockedReason(prepared.result.reason, prepared.result.category) +
            policyWebsiteGuidance(this.local, this.context, prepared),
    );
  if (needsSearchDisclosure(prepared.result.reason) && !confirmation && this.local.deps.search)
    return this.local.deps.search.confirmation(
      signal,
      (current) => this.authorize(call, current, true, recipient),
      this.timing(call.id),
    );
  let isolation: Awaited<ReturnType<ExecutionTarget["isolationStatus"]>>;
  try {
    isolation = isCommandCall(call.tool)
      ? await this.owner.target.isolationStatus(signal)
      : { available: true, reason: "command_isolation_not_applicable" };
  } catch (error) {
    const paused = executionPaused(error);
    if (!paused) throw error;
    signal.throwIfAborted();
    const denied = refuse("cleanup_failed", paused);
    this.blocked(call, paused);
    return denied;
  }
  state.isolated = isolation.available;
  const readonlyRoots =
    isCommandCall(call.tool) && prepared.boundary?.roots.some((root) => root.role === "readonly");
  // Readonly references normally rely on the sandbox to stop writes. In an editor terminal a
  // command the analysis proved read-only cannot write there, so only those may still run.
  const editorScope = editorTerminalScope.call(this, prepared);
  const editorReadonly =
    readonlyRoots &&
    !prepared.docker &&
    isolation.reason === EDITOR_TERMINAL_UNISOLATED &&
    editorTerminalReadonly(prepared.result, editorScope.roots, editorScope.platform);
  if (readonlyRoots && !editorReadonly && (this.owner.platform !== "darwin" || prepared.docker))
    return refuse(
      "readonly_isolation_required",
      "当前平台或 Docker 运行时尚不支持带只读参考目录的命令；请用文件工具并写入主目录 / This platform or Docker runtime cannot isolate commands with readonly references; use file tools and write into the primary folder",
    );
  if (
    authorizationSnapshot(this.local, this.context.botId, this.context) !== prepared.authorization
  )
    return refuse("changed", blockedReason("changed"));
  if (isCommandCall(call.tool) && !isolation.available && !prepared.docker) {
    if (readonlyRoots && !editorReadonly)
      return refuse(
        "readonly_isolation_required",
        "附加目录只读，当前系统无法隔离命令 / Readonly roots require command isolation",
      );
    // Windows and an ACP editor terminal are explicit execution targets that cannot attest to
    // Pi Bot's local sandbox. Both stay on the unisolated approval path; an arbitrary local
    // sandbox failure is still a hard stop that no approval or YOLO may bypass.
    // A run outside the sandbox needs a working sandbox that blocked this very call
    // first, so it never reaches this branch.
    if (
      isolation.reason !== "windows_unisolated" &&
      isolation.reason !== "acp_editor_terminal_unisolated"
    ) {
      // A Linux host that cannot isolate looks identical to a broken one unless the cause
      // and the fix travel with the refusal; the caller cannot see the runner's log.
      const remedy = linuxIsolationRemedy(isolation.reason);
      const cause = isolation.reason ? ` (${isolation.reason})` : "";
      return refuse(
        "isolation_unavailable",
        `命令隔离当前不可用${cause}，不能在没有隔离的情况下运行。${remedy?.zh ?? ""} / Command isolation is unavailable${cause}; commands never run unisolated here. ${remedy?.en ?? ""}`,
      );
    }
    const unisolatedReason =
      isolation.reason === "acp_editor_terminal_unisolated"
        ? "acp_editor_terminal_unisolated"
        : "windows_unisolated";
    // An explicitly unisolated execution target is an ask; YOLO approves it only when the
    // user has turned on "YOLO auto-approves commands (no isolation)".
    applyExplicitUnisolatedTarget.call(this, prepared, unisolatedReason);
    if (
      allowedByYolo(prepared.result) ||
      (prepared.result.decision === "allow" && prepared.result.reason === WINDOWS_READ_ONLY)
    )
      state.unisolatedApproved = true;
  }
  // Isolation inspection may yield while the user enables YOLO. Re-check immediately before
  // creating a card, otherwise the newly created card would miss releasePending().
  // Naming a saved display name settles the choice; only an unnamed call still stops here.
  if (loginNeedsChoice(prepared) && runYolo(this.local, this.context))
    return refuse(
      "browser_login_choose",
      loginChoiceText(prepared.login?.accounts.map((account) => account.label) ?? []),
    );
  prepared.result = applyYolo(prepared.result, runYolo(this.local, this.context));
  // A capability tool served by a connection asks about the connection first. Secrets the
  // connection's own configuration references ride on that answer (`secret_connector_config`).
  if (
    prepared.connectorPolicy?.decision === "ask" &&
    prepared.capabilityConnector &&
    !connectionRuled(prepared.capabilityConnector.capabilityId)
  ) {
    const original = prepared;
    const before = fingerprint(original);
    if (mustAskNow(prepared.connectorPolicy)) {
      const status = await this.local.approvals.request(
        approvalContext(this.context, signal),
        call,
        approvalResult(this.context, prepared.connectorPolicy),
        isolation,
        async () => {
          let current: PreparedTool;
          try {
            current = await this.prepare(call, signal, recipient);
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof ExecError)) throw error;
            return recheckRefusal(original.result, error);
          }
          return fingerprint(current) === before && current.connectorPolicy
            ? current.connectorPolicy
            : explainPolicyResult(
                { ...original.result, decision: "deny", reason: "changed", canRemember: false },
                "boundary",
                "changed",
              );
        },
        undefined,
        undefined,
        undefined,
        prepared.connector ? { connector: connectorCardDisplay(prepared.connector) } : undefined,
      );
      if (status !== "allowed")
        return status === "denied" && failedRecheck
          ? refuse(failedRecheck.check, failedRecheck.text)
          : refuse("changed", blockedReason("changed"));
      prepared = await this.prepare(call, signal, recipient);
      if (prepared.result.decision === "deny" || !approvedUnchanged(prepared, original, before))
        return refuse("changed", blockedReason("changed"));
      // Only a person answers this card (YOLO and pre-authorization leave it pending), so its
      // draft is that same confirmation and is sent without a second card.
      prepared.confirmedNow = true;
    }
  }
  const resumed = this.local.unattendedAuthorization.resumed(
    this.context,
    prepared,
    isolation.available,
  );
  if (resumed !== undefined)
    recordPolicyStep(
      prepared.result,
      "grant",
      resumed ? "routine_resumed_allowed" : "routine_resumed_denied",
      "info",
    );
  state.auditFacts = {
    ...state.auditFacts,
    policySteps: prepared.result.explanation.map((step) => step.code),
  };
  if (resumed === true) {
    if (prepared.memorySafety) prepared.confirmedNow = true;
    state.unisolatedApproved = isCommandCall(call.tool) && !isolation.available;
    // The parked card was answered by the person; its hash covers the roots it named.
    state.outsideWriteRoots = openedByPerson(prepared.result);
    openPrivateTargets(this.local, this.context, prepared.result, prepared.result);
  }
  if (resumed === false)
    return refuse(
      "tool_authorization_refused",
      "用户拒绝或未响应，请换办法，不要重复请求 / The user denied or did not respond; use another approach and do not repeat the request",
    );
  const preauth =
    resumed === undefined
      ? this.local.unattendedAuthorization.match(this.context, prepared, isolation.available)
      : undefined;
  if (preauth && prepared.result.decision === "ask") {
    recordPolicyStep(prepared.result, "grant", "routine_preauth", "info");
    state.preauthId = preauth.id;
    if (preauth.operation.scope.kind === "workplace" || preauth.operation.scope.kind === "programs")
      state.preauthWriteRoot = preauth.operation.scope.root;
    this.local.unattendedAuthorization.audit(this.context, "routine.preauth.allowed", {
      preauthId: preauth.id,
      reasonCode: "routine_preauth",
      policySteps: prepared.result.explanation.map((step) => step.code),
    });
  }
  // A card answered by YOLO turning on is audited as that approval, not again as a step.
  // The connection card above already answered this exact call's mandatory question.
  const carded =
    prepared.result.decision === "ask" &&
    !preauth &&
    resumed !== true &&
    !(prepared.confirmedNow && mustAskNow(prepared.result));
  if (carded) {
    const invalid = this.local.toolCards.get(call.tool)?.(
      this.context,
      call.input,
      this.context.language,
    ).invalid;
    if (invalid) return refuse(invalid.code, invalid.text);
    const original = prepared;
    const approvedFingerprint = fingerprint(original);
    let receipt: SearchConsentReceipt | undefined;
    let folderAdded = false;
    let windowsYoloCard = false;
    const lifecycle = this.local.unattended?.approvalLifecycle(
      this.context,
      call,
      prepared,
      isolation,
    );
    const status = await this.local.approvals.request(
      approvalContext(this.context, signal),
      call,
      approvalResult(this.context, prepared.result),
      isolation,
      async () => {
        let current: PreparedTool;
        try {
          current = await this.prepare(call, signal, recipient);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ExecError) return recheckRefusal(original.result, error);
          // A revoked managed source/root invalidates this card; it must not stay pending.
          if (call.tool === "image_result" && error instanceof RpcError && error.code === -32602)
            return explainPolicyResult(
              {
                ...original.result,
                decision: "deny",
                reason: "changed",
                canRemember: false,
              },
              "boundary",
              "changed",
            );
          throw error;
        }
        let currentIsolation = isolation;
        if (isCommandCall(call.tool)) {
          try {
            currentIsolation = await this.owner.target.isolationStatus(signal);
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof ExecError)) throw error;
            return recheckRefusal(current.result, error);
          }
        }
        if (!currentIsolation.available)
          applyExplicitUnisolatedTarget.call(this, current, currentIsolation.reason);
        current.result = applyYolo(current.result, runYolo(this.local, this.context));
        if (
          fingerprint(current) !== approvedFingerprint ||
          currentIsolation.available !== isolation.available ||
          currentIsolation.reason !== isolation.reason
        )
          return explainPolicyResult(
            { ...current.result, decision: "deny", reason: "changed", canRemember: false },
            "boundary",
            "changed",
          );
        return current.result;
      },
      needsSearchDisclosure(original.result.reason)
        ? () => {
            // A waiting disclosure released by YOLO is temporary authorization, not consent
            // to persist a global search setting for other conversations.
            if (runYolo(this.local, this.context)) return;
            receipt = acceptSearch(this.owner, original, approvedFingerprint);
          }
        : undefined,
      {
        ...lifecycle,
        requested: (approval) => {
          lifecycle?.requested(approval);
          linkSandboxApproval(this.local, this.context, original, approval);
        },
        resolved: (approval, by) => {
          windowsYoloCard =
            by === "yolo" &&
            isolation.reason === "windows_unisolated" &&
            original.result.explanation.some((step) => step.code === WINDOWS_ORDINARY_COMMAND);
          lifecycle?.resolved(approval);
        },
      },
      {
        available:
          !!this.context.routineRunId &&
          this.context.routineSource === "routine" &&
          !!this.local.unattendedAuthorization.operation(prepared, isolation.available),
        allow: (approval) =>
          this.local.unattendedAuthorization.remember(
            this.context,
            original,
            approval,
            isolation.available,
          ),
      },
      this.consentCard(original),
      this.owner.folderChange(original, () => {
        folderAdded = true;
      }),
    );
    if (folderAdded)
      return refuse(
        "workspace_folder_added",
        "用户已把文件夹加入工作范围，请重试 / The user added the folder to this topic’s writable workspace; retry with a new tool call",
      );
    if (status === "denied" && failedRecheck)
      return refuse(failedRecheck.check, failedRecheck.text);
    if (status !== "allowed")
      return refuse(
        loginNeedsChoice(original) && runYolo(this.local, this.context)
          ? "browser_login_choose"
          : status === "cancelled"
            ? "approval_cancelled"
            : status === "expired" || status === "auto_denied"
              ? "approval_expired"
              : "approval_user_denied",
        loginNeedsChoice(original) && runYolo(this.local, this.context)
          ? loginChoiceText(original.login?.accounts.map((account) => account.label) ?? [])
          : needsSearchDisclosure(original.result.reason)
            ? `用户没有同意把查询发给 ${auditProviderName(recipient ?? "") ?? recipient} / The user did not consent to sending the query to ${auditProviderName(recipient ?? "") ?? recipient}`
            : status === "cancelled"
              ? "已停止 / Stopped"
              : status === "expired" || status === "auto_denied"
                ? "用户未响应，请换办法，不要重复请求 / The user did not respond; use another approach rather than repeating the request"
                : "用户拒绝，请换办法，不要重复请求 / The user denied permission; use another approach rather than repeating the request",
      );
    state.unisolatedApproved = isCommandCall(call.tool) && !isolation.available;
    if (prepared.result.domain) state.onceDomains.add(prepared.result.domain);
    if (prepared.result.url) state.onceUrls.add(prepared.result.url);
    if (needsSearchDisclosure(original.result.reason)) {
      if (receipt)
        prepared = await confirmSearch(this.owner, original, signal, approvedFingerprint, receipt);
      else {
        prepared = await this.prepare(call, signal, recipient);
        if (!allowedByYolo(prepared.result)) return refuse("changed", blockedReason("changed"));
        state.yolo = prepared.result.risk;
      }
      if (fingerprint(prepared, original.authorization) !== approvedFingerprint)
        return refuse("changed", blockedReason("changed"));
    } else {
      prepared = await this.prepare(call, signal, recipient);
      if (!isolation.available)
        applyExplicitUnisolatedTarget.call(this, prepared, isolation.reason);
      prepared.result = applyYolo(prepared.result, runYolo(this.local, this.context));
      if (
        prepared.result.decision === "deny" ||
        (windowsYoloCard && !allowedByYolo(prepared.result)) ||
        !approvedUnchanged(prepared, original, approvedFingerprint)
      )
        return refuse("changed", blockedReason("changed"));
      // The card was let through by YOLO turning on; its step says so while live.
      if (allowedByYolo(prepared.result)) state.yolo = prepared.result.risk;
      else allowFolderForRun(this.local, this.context, call.tool, original.result);
      // YOLO never releases this card (`mustAskNow`), so "allowed" is the person's answer.
      if (original.result.reason === OUTSIDE_WRITE_REASON)
        state.outsideWriteRoots = openedByPerson(prepared.result);
      // YOLO never releases a must-ask card, so "allowed" here is the person's answer to this
      // exact call; its draft is the same confirmation and is not asked again.
      // SSH cards are ordinary ask cards, not must-ask, but the final dispatch still has to
      // know that this exact call was approved. YOLO can also release an ordinary card, and
      // that is not the person answering this card, so only the non-YOLO SSH case sets the
      // mark. The fingerprint recheck above binds it to this call, host and recipe; it is
      // never remembered for a later call.
      openPrivateTargets(this.local, this.context, original.result, prepared.result);
      if (
        (mustAskNow(original.result) && mustAskNow(prepared.result)) ||
        (original.hostSsh !== undefined &&
          prepared.hostSsh !== undefined &&
          !allowedByYolo(prepared.result))
      )
        prepared.confirmedNow = true;
    }
  }
  // Card/connector finalization may re-prepare the call. Restore the execution-target fact before
  // binding the value used by the final side-effect dispatch; otherwise the same safe transform
  // would look like a permission change at execution time.
  if (!isolation.available) applyExplicitUnisolatedTarget.call(this, prepared, isolation.reason);
  prepared.result = applyYolo(prepared.result, runYolo(this.local, this.context));
  signal.throwIfAborted();
  if (this.context.routineRunId)
    this.local.unattendedAuthorization.allowed(this.context, prepared, isolation.available);
  if (!carded && allowedByYolo(prepared.result)) this.markYolo(call, prepared.result);
  if (!carded && isAutoAllowed(prepared.result))
    auditAutoAllow(this.local, this.context, call, prepared.result);
  if (call.tool === "web_fetch" && state.yolo) state.initialPageYolo = prepared.result.url;
  state.auditFacts = {
    ...state.auditFacts,
    policySteps: prepared.result.explanation.map((step) => step.code),
  };
  state.prepared = prepared;
  // The SDK owns its argument object; bind a value, not a mutable object reference.
  state.fingerprint = fingerprint(prepared);
  if (state.startSeen) this.start(state);
  return { allow: true };
}

/** The folders a person's answer to an outside-write card opens for that one call. */
function openedByPerson(result: PolicyResult) {
  return mustAskNow(result) && result.reason === OUTSIDE_WRITE_REASON
    ? result.outsideWriteRoots
    : undefined;
}

/**
 * Operating the computer is decided by the computer gate (grant, card, always-list,
 * routine preauth, blocklist); the ordinary prepare only records what `execute` re-checks.
 */
export async function authorizeComputerStep(
  this: LocalRunOperations,
  state: State,
  call: LocalToolCall,
  signal: AbortSignal,
): Promise<{ allow: boolean; reason?: string }> {
  state.auditFacts = {
    ...auditToolFields(call, this.local.deps.redactor, undefined, this.local.deps.capabilityTools),
    category: "computer",
    source: this.context.routineSource ?? this.context.auditSource ?? "chat",
    ...(this.context.routineRunId ? { routineRunId: this.context.routineRunId } : {}),
  };
  const decision = await this.local.computerGrants.authorize(this.context, call, signal);
  if (!decision.allow) return decision;
  if (decision.yolo)
    this.markYolo(
      call,
      explainPolicyResult(
        {
          decision: "allow",
          reason: "yolo",
          risk: decision.yolo,
          facts: [],
          canRemember: false,
        },
        "yolo",
        "yolo",
      ),
    );
  const prepared = await this.prepare(call, signal);
  // The gate already handled "ask"; only a policy deny that appeared meanwhile still wins.
  if (prepared.result.decision === "deny") {
    state.auditFacts = {
      ...state.auditFacts,
      reasonCode: prepared.result.reason,
      policySteps: prepared.result.explanation.map((step) => step.code),
    };
    return {
      allow: false,
      reason: blockedReason(prepared.result.reason, prepared.result.category),
    };
  }
  signal.throwIfAborted();
  state.auditFacts = {
    ...state.auditFacts,
    policySteps: prepared.result.explanation.map((step) => step.code),
  };
  state.prepared = prepared;
  state.fingerprint = fingerprint(prepared);
  if (state.startSeen) this.start(state);
  return { allow: true };
}

function connectorCardDisplay(
  prepared: NonNullable<PreparedTool["connector"]>,
): ConnectorCardDisplay {
  return {
    id: prepared.connector.id,
    name: prepared.connector.name,
    tool: prepared.tool.tool,
    ...(prepared.tool.displayDescription ? { label: prepared.tool.displayDescription } : {}),
  };
}

/** First-login card title with the Bot's (redacted) display name. */
export function consentCardStep(this: LocalRunOperations, prepared: PreparedTool) {
  const { login, searchRecipient, result } = prepared;
  const describe = this.local.toolCards.get(prepared.call.tool);
  if (describe) {
    const context = this.context;
    const input = prepared.call.input;
    return { text: (language: "zh" | "en") => describe(context, input, language) };
  }
  if (prepared.browserSecretUses?.length) {
    const sources = prepared.browserSecretUses
      .map((use) =>
        auditText(
          `${use.site} · ${use.kind} · ${use.name} → ${use.destination}`,
          this.local.deps.redactor,
        ),
      )
      .join("; ");
    return {
      title: (language: "zh" | "en") =>
        BrowserNetworkConsentText[language].use.replace("{sources}", sources),
    };
  }
  if (
    prepared.call.tool === "browser_secret" ||
    (prepared.call.tool === "browser_request" && result.reason === "browser_sensitive_confirmation")
  ) {
    const input = prepared.call.input;
    const site = this.local.deps.redactor.redact(String(input.origin ?? ""));
    const kind = auditText(
      String(input.kind ?? input.method ?? "request"),
      this.local.deps.redactor,
    );
    const name = auditText(String(input.name ?? ""), this.local.deps.redactor);
    return {
      title: (language: "zh" | "en") =>
        BrowserNetworkConsentText[language][
          prepared.call.tool === "browser_secret" ? "reveal" : "request"
        ]
          .replace("{site}", site)
          .replace("{kind}", kind)
          .replace("{name}", name),
    };
  }
  if (prepared.call.tool === "reveal_in_folder" && result.reason === REVEAL_CONFIRMATION_REASON) {
    const path = auditText(result.path?.path ?? "", this.local.deps.redactor);
    const platform = this.local.deps.platform;
    return {
      title: (language: "zh" | "en") => {
        const manager =
          language === "zh"
            ? platform === "darwin"
              ? "访达"
              : platform === "win32"
                ? "资源管理器"
                : "文件管理器"
            : platform === "darwin"
              ? "Finder"
              : platform === "win32"
                ? "File Explorer"
                : "the file manager";
        return language === "zh"
          ? `要在${manager}中打开 ${path} 吗？`
          : `Open ${path} in ${manager}?`;
      },
    };
  }
  if (login) return { login, title: (language: "zh" | "en") => this.loginTitle(login, language) };
  if (prepared.connector) return { connector: connectorCardDisplay(prepared.connector) };
  if (result.reason !== "search_provider_disclosure_required" || !searchRecipient) return;
  const provider = auditProviderName(searchRecipient) ?? searchRecipient;
  const recipient = `${provider} (${result.domain ?? ""})`;
  return {
    title: (language: "zh" | "en") =>
      language === "zh" ? `查询词会发送给 ${recipient}` : `Queries will be sent to ${recipient}`,
  };
}

export function loginTitleStep(
  this: LocalRunOperations,
  login: NonNullable<PreparedTool["login"]>,
  language: "zh" | "en",
) {
  const name = new BotsRepo(this.local.deps.db).get(this.context.botId)?.name ?? "Bot";
  return loginTitle(auditText(name, this.local.deps.redactor), login, language);
}
