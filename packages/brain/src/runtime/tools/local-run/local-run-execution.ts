import { createHash } from "node:crypto";
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import { ExecError } from "@pibot/execution";
import {
  containsPath,
  explainPolicyResult,
  REVEAL_CONFIRMATION_REASON,
  secretWriteOutDenied,
  WINDOWS_ORDINARY_COMMAND,
  WINDOWS_READ_ONLY,
} from "@pibot/policy";
import { officeRenderOutputPath } from "@pibot/protocol-base";
import { SettingsRepo } from "@pibot/storage";
import { auditAutoAllow, isAutoAllowed } from "../../../core/auto-allow.ts";
import type { PreparedTool } from "../../../core/local-types.ts";
import { allowedByYolo, runYolo } from "../../../core/yolo.ts";
import { taskCompleted } from "../../continuation/task-completion.ts";
import { gitEntriesCurrent } from "../git-entry-prepare.ts";
import { executeTool } from "../local-execute.ts";
import { authorizationSnapshot, toolFingerprint as fingerprint } from "../local-prepare.ts";
import type { LocalRunOperations } from "../local-run.ts";
import { memorySafetySnapshot, memoryWriteFacts } from "../memory-safety.ts";
import { policyWebsiteGuidance } from "../policy-website-notices.ts";
import { openPrivateTargets } from "../private-network.ts";
import { revealIntentReason } from "../reveal-intent.ts";
import { runnerLinkLost } from "../target-tools.ts";
import { authorizationCheckText } from "../tool-error-text.ts";
import { toolSecretContent } from "../tool-secret-content.ts";
import { blockedReason, parseTool } from "../tools.ts";
import { noteUntrustedContent, readsUntrustedContent } from "../untrusted-content.ts";
import { applyExplicitUnisolatedTarget } from "./local-run-authorization.ts";
import {
  approvalContext,
  approvalResult,
  isCommandCall,
  PLAN_READ_ONLY,
  ToolAuthorizationError,
  WRITE_FILE_TOOLS,
} from "./local-run-shared.ts";
import {
  REPEAT_LIMIT,
  rememberRepeatedCommand,
  repeatAnswer,
  repeatedCommandKey,
  stepChangesFiles,
} from "./repeated-command.ts";
import {
  noteRepeatedRead,
  REPEAT_READ_LIMIT,
  repeatedReadKey,
  repeatReadHint,
} from "./repeated-read.ts";
import { parallelToolCall } from "./tool-batch.ts";

export async function executeStep(
  this: LocalRunOperations,
  call: LocalToolCall,
  signal: AbortSignal,
  output: (text: string) => void,
): Promise<LocalToolResult> {
  if (this.closed) return { text: "已停止 / Stopped", isError: true };
  // This ceiling is checked again after any approval/lock wait and cannot become a YOLO ask.
  if (!this.local.execution.allows(this.context, call.tool)) {
    this.state(call).auditFacts = { policySteps: ["plan_readonly"], reasonCode: "plan_readonly" };
    this.blocked(call, PLAN_READ_ONLY);
    return { text: PLAN_READ_ONLY, isError: true };
  }
  const state = this.states.get(call.id);
  if (
    !state?.prepared ||
    state.fingerprint !== fingerprint(state.prepared) ||
    state.finished ||
    state.prepared.call.tool !== call.tool ||
    JSON.stringify(state.prepared.call.input) !== JSON.stringify(call.input)
  )
    throw new ToolAuthorizationError("Tool authorization missing");
  signal.throwIfAborted();
  // Taken after approval (a run waiting on the user must not keep other Bots out of the
  // folder) and before the re-check below, so what was approved is verified after the wait.
  const roots = this.writeLockRoots(state.prepared);
  if (roots.length) await this.lockWrite(call.id, roots, signal);
  // Consume the gate's decision; changed capabilities invalidate it rather than re-approving here.
  const checkRefused = (error: unknown): LocalToolResult => {
    signal.throwIfAborted();
    // The re-check resolves paths on the target: a runner that dropped is a connection failure.
    const lost = runnerLinkLost(error);
    if (lost) {
      state.auditFacts = { ...state.auditFacts, reasonCode: lost.code };
      this.blocked(call, lost.text);
      return { text: lost.text, isError: true };
    }
    if (!(error instanceof ExecError)) throw error;
    const check = error.check;
    state.auditFacts = {
      ...state.auditFacts,
      reasonCode: check,
      policySteps: [...(state.auditFacts?.policySteps ?? []), check],
    };
    const text = authorizationCheckText(error);
    this.blocked(call, text);
    return { text, isError: true };
  };
  let checked: PreparedTool;
  try {
    checked = await this.prepare(call, signal, state.prepared.searchRecipient);
  } catch (error) {
    return checkRefused(error);
  }
  signal.throwIfAborted();
  if (checked.result.decision === "deny") {
    const { reason, category, explanation } = checked.result;
    state.auditFacts = {
      ...state.auditFacts,
      reasonCode: reason,
      policySteps: explanation.map((step) => step.code),
    };
    const text =
      blockedReason(reason, category) + policyWebsiteGuidance(this.local, this.context, checked);
    this.blocked(call, text);
    return { text, isError: true };
  }
  if (state.batchParallel && !parallelToolCall(checked, this.owner.platform)) {
    state.auditFacts = { ...state.auditFacts, reasonCode: "changed" };
    this.blocked(call, blockedReason("changed"));
    return { text: blockedReason("changed"), isError: true };
  }
  let preauthIsolation = true;
  try {
    if (isCommandCall(call.tool)) {
      const isolation = await this.owner.target.isolationStatus(signal);
      if (!isolation.available) applyExplicitUnisolatedTarget.call(this, checked, isolation.reason);
      if (state.preauthId)
        preauthIsolation = (await this.owner.target.isolationStatus(signal)).available;
    }
  } catch (error) {
    return checkRefused(error);
  }
  if (
    state.preauthId &&
    this.local.unattendedAuthorization.match(this.context, checked, preauthIsolation)?.id !==
      state.preauthId
  ) {
    state.auditFacts = {
      ...state.auditFacts,
      policySteps: [...checked.result.explanation.map((step) => step.code), "changed"],
    };
    this.blocked(call, blockedReason("changed"));
    return { text: blockedReason("changed"), isError: true };
  }
  if (
    fingerprint(checked) !== state.fingerprint ||
    (allowedByYolo(state.prepared.result) && checked.result.decision !== "allow") ||
    (state.prepared.result.reason === WINDOWS_READ_ONLY &&
      checked.result.reason !== WINDOWS_READ_ONLY)
  ) {
    state.auditFacts = {
      ...state.auditFacts,
      policySteps: [...checked.result.explanation.map((step) => step.code), "changed"],
      reasonCode: "changed",
    };
    const text = blockedReason("changed");
    this.blocked(call, text);
    return { text, isError: true };
  }
  if (
    authorizationSnapshot(this.local, this.context.botId, this.context) !==
    state.prepared.authorization
  ) {
    state.auditFacts = {
      ...state.auditFacts,
      policySteps: [...checked.result.explanation.map((step) => step.code), "changed"],
      reasonCode: "changed",
    };
    const text = blockedReason("changed");
    this.blocked(call, text);
    return { text, isError: true };
  }
  if (!this.local.execution.allows(this.context, call.tool)) {
    this.state(call).auditFacts = { policySteps: ["plan_readonly"], reasonCode: "plan_readonly" };
    this.blocked(call, PLAN_READ_ONLY);
    return { text: PLAN_READ_ONLY, isError: true };
  }
  if (this.context.executionClock) this.local.budgets.dispatch(this.context, call);
  this.start(state);
  const prepared = state.prepared;
  const previousTodo =
    call.tool === "todo_update" && this.context.conversationId
      ? this.local.execution.todo({
          botId: this.context.botId,
          conversationId: this.context.conversationId,
        })
      : undefined;
  // A read-only command whose answer changed nothing a third time is not progress, and
  // the model repeating it is exactly the loop this skips. Only the denial above could have
  // stopped it otherwise, since other calls in between reset that budget.
  // A running background command is still writing, so no search answer is stable while it runs —
  // and what it already wrote may have voided what we cached before it started.
  const backgroundRunning = this.local.background.runningRows().length > 0;
  if (backgroundRunning) {
    this.context.repeatedCommands?.clear();
    this.context.repeatedReads?.clear();
  }
  const repeatKey = backgroundRunning ? undefined : repeatedCommandKey(prepared);
  const repeated = repeatKey ? this.context.repeatedCommands?.get(repeatKey) : undefined;
  if (repeatKey && repeated && repeated.count >= REPEAT_LIMIT) {
    state.result = repeatAnswer(repeated);
    return state.result;
  }
  const dispatch = () => executeTool(this.owner, prepared, signal, output);
  try {
    // The one place a tool executes, so the journal sits here and nowhere else. A
    // synthetic step (the automatic check) re-verifies by design each round and is not journalled.
    const journalled = state.synthetic
      ? { result: await dispatch(), executed: true }
      : await this.local.toolJournal.run(this.context, prepared, signal, dispatch);
    state.result = journalled.result;
    // An answer cached before a write describes files that no longer look like that.
    if (journalled.executed && stepChangesFiles(prepared)) {
      this.context.repeatedCommands?.clear();
      this.context.repeatedReads?.clear();
    } else if (repeatKey && journalled.executed && !state.result.isError) {
      this.context.repeatedCommands ??= new Map();
      rememberRepeatedCommand(this.context.repeatedCommands, repeatKey, state.result);
    }
    // The 3rd unchanged read of one range carries a hint, never a block — the text is
    // still useful when another file was edited in between.
    const readKey = repeatedReadKey(prepared);
    if (readKey && journalled.executed && !state.result.isError) {
      this.context.repeatedReads ??= new Map();
      const count = noteRepeatedRead(this.context.repeatedReads, readKey, state.result.text);
      if (count > REPEAT_READ_LIMIT)
        state.result = { ...state.result, text: `${state.result.text}\n${repeatReadHint(count)}` };
    }
    if (
      readsUntrustedContent(prepared) &&
      (state.result.untrustedContent ||
        !state.result.isError ||
        prepared.connector ||
        prepared.capabilityConnector)
    )
      noteUntrustedContent(this.context);
    if (journalled.executed && !state.result.isError) {
      this.context.compactionProgress ??= { count: 0, reads: [] };
      const progress = this.context.compactionProgress;
      const nextTodo =
        previousTodo && this.context.conversationId
          ? this.local.execution.todo({
              botId: this.context.botId,
              conversationId: this.context.conversationId,
            })
          : undefined;
      const previousStatuses = new Map(previousTodo?.items.map((item) => [item.id, item.status]));
      const advancedTodo = nextTodo?.items.some(
        (item) => item.status === "done" && previousStatuses.get(item.id) !== "done",
      );
      if (
        WRITE_FILE_TOOLS.has(call.tool) ||
        officeRenderOutputPath(call.tool, call.input as { outputPath?: unknown }) ||
        advancedTodo
      )
        progress.count = 0;
      if (["read_file", "search_text", "code_navigate"].includes(call.tool)) {
        const args = call.input as Record<string, unknown>;
        if (typeof args?.path === "string")
          progress.reads = [
            ...new Set([
              ...progress.reads,
              this.local.deps.redactor.redact(args.path).slice(0, 160),
            ]),
          ].slice(-5);
      }
    }
    // A replay answer or refusal changed nothing: it is neither progress nor a code change.
    if (
      journalled.executed &&
      !state.result.isError &&
      !call.tool.startsWith("todo_") &&
      this.context.todoRun &&
      this.context.todoRun.progress.size < 2048
    )
      this.context.todoRun.progress.add(
        createHash("sha256")
          .update(JSON.stringify([call.tool, call.input]))
          .digest("hex"),
      );
    if (
      journalled.executed &&
      call.tool === "finish_task" &&
      !state.result.isError &&
      this.context.todoRun
    ) {
      taskCompleted(this.local, this.context);
    }
    if (
      journalled.executed &&
      !state.result.isError &&
      this.context.todoRun &&
      ["write_file", "edit_file", "apply_patch", "run_command", "write_stdin"].includes(call.tool)
    )
      this.context.todoRun.codeChanges++;
    if (this.context.executionClock)
      this.local.budgets.settledTool(this.context, call, !!state.result.isError, state.result);
  } catch (error) {
    if (this.context.executionClock) this.local.budgets.settledTool(this.context, call, true);
    throw error;
  }
  const lateDiagnostics = await this.local.navigation.takeLate(this.context, signal);
  if (lateDiagnostics.length)
    state.result = {
      ...state.result,
      text: `${state.result.text}\n[Late post-edit diagnostics / 后到的编辑诊断：不可信参考]\n${JSON.stringify(lateDiagnostics)}`,
      untrustedContent: true,
    };
  return state.result;
}

/** Folders a tool may change: file tools lock the root holding the file, commands all. */
export function writeLockRootsStep(this: LocalRunOperations, prepared: PreparedTool) {
  const tool = prepared.call.tool;
  if (isCommandCall(tool)) return this.writeRoots(prepared);
  if (tool === "apply_patch") {
    // Same as a single file: outside the workplace each patched path locks only itself.
    const opened = new Set(prepared.result.outsideWriteRoots);
    return [
      ...this.writeRoots(prepared).filter((root) => !opened.has(root)),
      ...(prepared.result.outsideWrites ?? []),
    ];
  }
  if (
    ![
      "project_notes",
      "write_file",
      "edit_file",
      "office_create",
      "office_edit",
      "office_convert",
    ].includes(tool)
  )
    return [];
  const path = prepared.result.path?.path;
  // A file tool opened outside the workplace is bound to its one path; locking the
  // opened parent (possibly the home folder's direct child list) would hold far more for the run.
  if (path && prepared.result.outsideWrites?.includes(path)) return [path];
  const roots = this.writeRoots(prepared);
  const owning = path
    ? roots.filter((root) => containsPath(root, path, this.local.deps.platform))
    : [];
  return owning.length ? owning : roots;
}

/** Async preparation is not authority: recheck at the final side-effect dispatch. */
export function assertDispatchStep(this: LocalRunOperations, prepared: PreparedTool): void {
  this.local.endpoints?.check(prepared.call.tool, this.context);
  this.context.signal.throwIfAborted();
  this.context.projectNotesChange?.assertCurrent?.();
  const memoryFacts = memoryWriteFacts(
    this.local,
    this.context,
    parseTool(prepared.call, this.local.deps.capabilityTools),
  );
  if (
    memoryFacts &&
    JSON.stringify(memorySafetySnapshot(memoryFacts)) !== JSON.stringify(prepared.memorySafety)
  )
    throw new ToolAuthorizationError("Memory authorization changed");
  this.local.collaboration?.guardTool?.(this.context, prepared.call.tool);
  // A reconnect must not substitute a new adapter behind the device shown on the card.
  if (prepared.boundary?.location?.target.startsWith("runner:")) void this.owner.target;
  const state = this.states.get(prepared.call.id);
  const revealIntent =
    prepared.call.tool === "reveal_in_folder"
      ? revealIntentReason(this.local, this.context)
      : undefined;
  if (
    this.closed ||
    !state ||
    state.finished ||
    state.prepared !== prepared ||
    state.fingerprint !== fingerprint(prepared) ||
    (revealIntent !== undefined &&
      !(
        revealIntent === REVEAL_CONFIRMATION_REASON &&
        prepared.result.reason === REVEAL_CONFIRMATION_REASON &&
        prepared.confirmedNow
      )) ||
    !this.local.execution.allows(this.context, prepared.call.tool) ||
    authorizationSnapshot(this.local, this.context.botId, this.context) !==
      prepared.authorization ||
    ((state.yolo || allowedByYolo(prepared.result)) && !runYolo(this.local, this.context)) ||
    (allowedByYolo(prepared.result) &&
      prepared.result.explanation.some((step) => step.code === WINDOWS_ORDINARY_COMMAND) &&
      new SettingsRepo(this.local.deps.db).get().yoloUnisolatedCommands !== true)
  )
    throw new ToolAuthorizationError("Tool authorization changed");
  if (
    secretWriteOutDenied(
      prepared.call.tool,
      this.local.deps.redactor.contains(
        toolSecretContent(prepared.call.tool, prepared.call.input, this.local.toolDefinitions),
      ),
    )
  )
    throw new ToolAuthorizationError("内容里有密钥，已拒绝 / Content contains a secret; refused");
  // Includes the final assertion right before the process starts.
  if (!gitEntriesCurrent(prepared))
    throw new ToolAuthorizationError("Git hooks or configuration changed");
  this.local.userSecrets.assertUses(prepared.secretUses ?? [], this.context.botId);
  this.local.tasks.guardSync(this.context);
  this.local.unattendedAuthorization.record(this.context);
  if (
    state.preauthId &&
    this.local.unattendedAuthorization.match(this.context, prepared, state.isolated === true)
      ?.id !== state.preauthId
  )
    throw new ToolAuthorizationError("Routine authority changed");
}

export async function allowPageStep(
  this: LocalRunOperations,
  call: LocalToolCall,
  signal: AbortSignal,
): Promise<boolean> {
  return this.local.approvals.serial(
    this.context.runId,
    signal,
    async () => {
      const prepared = await this.prepare(call, signal);
      const state = this.states.get(call.id);
      const initialPageYolo = state?.initialPageYolo;
      if (state) delete state.initialPageYolo;
      if (prepared.result.decision === "deny") {
        if (state)
          state.auditFacts = {
            ...state.auditFacts,
            reasonCode: state.auditFacts?.reasonCode ?? prepared.result.reason,
          };
        this.blocked(call, blockedReason(prepared.result.reason));
        return false;
      }
      if (
        prepared.result.decision === "allow" ||
        (prepared.result.domain &&
          this.states.get(call.id)?.onceDomains.has(prepared.result.domain)) ||
        (prepared.result.url && this.states.get(call.id)?.onceUrls.has(prepared.result.url))
      ) {
        // Only the first identical URL reuses the gate's audit; each redirect remains an action.
        if (allowedByYolo(prepared.result) && prepared.result.url !== initialPageYolo)
          this.markYolo(call, prepared.result);
        if (isAutoAllowed(prepared.result) && prepared.result.url !== state?.prepared?.result.url)
          auditAutoAllow(this.local, this.context, call, prepared.result);
        this.local.unattendedAuthorization.allowed(this.context, prepared, true);
        return true;
      }
      const preauth = this.local.unattendedAuthorization.match(this.context, prepared, true);
      if (preauth) {
        this.local.unattendedAuthorization.audit(this.context, "routine.preauth.allowed", {
          preauthId: preauth.id,
          reasonCode: "routine_preauth",
          policySteps: [...prepared.result.explanation.map((step) => step.code), "routine_preauth"],
        });
        return true;
      }
      const status = await this.local.approvals.request(
        approvalContext(this.context, signal),
        call,
        approvalResult(this.context, prepared.result),
        { available: true, reason: "command_isolation_not_applicable" },
        async () => {
          const current = await this.prepare(call, signal);
          return fingerprint(current) === fingerprint(prepared)
            ? current.result
            : explainPolicyResult(
                { ...current.result, decision: "deny", reason: "changed", canRemember: false },
                "boundary",
                "changed",
              );
        },
        undefined,
        this.local.unattended?.approvalLifecycle(this.context, call, prepared, {
          available: true,
          reason: "command_isolation_not_applicable",
        }),
        {
          available:
            this.context.routineSource === "routine" &&
            !!this.local.unattendedAuthorization.operation(prepared, true),
          allow: (approval) =>
            this.local.unattendedAuthorization.remember(this.context, prepared, approval, true),
        },
      );
      if (status !== "allowed") {
        if (state)
          state.auditFacts = {
            ...state.auditFacts,
            reasonCode:
              state.auditFacts?.reasonCode ??
              (status === "cancelled"
                ? "approval_cancelled"
                : status === "expired" || status === "auto_denied"
                  ? "approval_expired"
                  : "approval_user_denied"),
          };
        this.blocked(
          call,
          "网站访问被拒绝或审批已过期 / Website access was denied or approval expired",
        );
        return false;
      }
      const current = await this.prepare(call, signal);
      const allowed =
        current.result.decision !== "deny" && fingerprint(current) === fingerprint(prepared);
      if (allowed && current.result.domain)
        this.states.get(call.id)?.onceDomains.add(current.result.domain);
      if (allowed && current.result.url) this.states.get(call.id)?.onceUrls.add(current.result.url);
      if (allowed) openPrivateTargets(this.local, this.context, prepared.result, current.result);
      if (allowed) this.local.unattendedAuthorization.allowed(this.context, current, true);
      if (!allowed) {
        const blockedState = this.states.get(call.id);
        if (blockedState)
          blockedState.auditFacts = { ...blockedState.auditFacts, reasonCode: "changed" };
        this.blocked(call, blockedReason("changed"));
      }
      return allowed;
    },
    this.timing(call.id),
  );
}

export function validSearchStep(this: LocalRunOperations, prepared: PreparedTool) {
  const state = this.states.get(prepared.call.id);
  return (
    !this.closed &&
    !state?.finished &&
    state?.prepared === prepared &&
    state.fingerprint === fingerprint(prepared) &&
    authorizationSnapshot(this.local, this.context.botId, this.context) === prepared.authorization
  );
}

export async function fallbackSearchStep(
  this: LocalRunOperations,
  prepared: PreparedTool,
  signal: AbortSignal,
): Promise<PreparedTool | string> {
  const input = JSON.stringify(prepared.call.input);
  if (!this.validSearch(prepared) || this.local.deps.search?.get()?.provider !== "keyless")
    return blockedReason("changed");
  const allowed = await this.local.approvals.serial(
    this.context.runId,
    signal,
    async () => {
      if (!this.validSearch(prepared) || JSON.stringify(prepared.call.input) !== input)
        return { allow: false, reason: blockedReason("changed") };
      return this.authorize(prepared.call, signal, false, "bing");
    },
    this.timing(prepared.call.id),
  );
  const current = this.states.get(prepared.call.id)?.prepared;
  if (!allowed.allow) return allowed.reason ?? blockedReason("changed");
  if (!current || !this.validSearch(current) || JSON.stringify(current.call.input) !== input)
    return blockedReason("changed");
  return current;
}
