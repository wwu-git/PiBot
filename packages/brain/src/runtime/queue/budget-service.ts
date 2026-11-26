// Track and enforce execution budgets across model requests and tool calls.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ModelRequestMetrics } from "@pibot/agent";
import {
  AgentError,
  type AgentRequestObserver,
  type LocalToolCall,
  type LocalToolResult,
} from "@pibot/agent";
import {
  BUDGET_RAISE_SHARE,
  BUDGET_RAISES_MAX,
  type BudgetSnapshot,
  type ExecutionLimits,
} from "@pibot/protocol-base";
import { BudgetRepo, CheckpointRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { GroupBudgetGuard } from "./group-budget.ts";

interface TreeClock {
  last: number;
  language: "zh" | "en";
  leases: Map<string, Set<string>>;
}
/** Varied invalid shapes for one tool: after this many in a run, stop instead of guessing on. */
const INVALID_INPUTS_PER_TOOL = 5;
/**
 * A group cycle shares one budget root with every member's step run, so a per-run loop stops only
 * that run (2026-11-11 real run: the coordinator's three post-question todo_pause calls aborted the
 * started plan before its first step ran). The group-wide cap is the runaway guard across members:
 * it needs rejected calls from at least two runs, so one member alone can never reach it.
 */
const GROUP_RUN_INVALID_PER_TOOL = 3;
const GROUP_RUN_INVALID_ANY_TOOL = 6;
const GROUP_INVALID_ACROSS_RUNS = 9;
export class BudgetExceededError extends AgentError {
  constructor(readonly reason: string) {
    super(reason === "repeated_operation" ? "repeated_operation" : "budget_exhausted");
  }
}
/**
 * One run of a shared group root stopped itself. Deliberately not a BudgetExceededError: callers
 * that translate that error into a root-wide halt (task spawn rollback) must not widen this stop.
 */
export class RunHaltedError extends AgentError {
  constructor(readonly reason: string) {
    super("repeated_operation");
  }
}
/** All admissions are synchronous SQLite transactions; leases measure union active wall time. */
export class BudgetService {
  readonly repo: BudgetRepo;
  readonly checkpoints: CheckpointRepo;
  private readonly groups: GroupBudgetGuard;
  abortTree?: (rootRunId: string) => Promise<void>;
  validate?: (context: ToolRunContext) => void;
  private readonly clocks = new Map<string, TreeClock>();
  private readonly aborts = new Map<string, Promise<void>>();
  private readonly repetitions = new Map<
    string,
    { callId: string; fingerprint: string; count: number }
  >();
  /** Distinct rejected calls per run/tool, or across one group cycle (bounded process cache). */
  private readonly invalidByTool = new Map<string, Set<string>>();
  /** Runs of a shared group root that stopped alone; cleared when the run ends. */
  private readonly halted = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly notifications = new Map<string, BudgetSnapshot>();
  private readonly notificationTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly deps: {
      db: DatabaseSync;
      changed(snapshot: BudgetSnapshot): void;
      modelRequest?(runId: string, request: ModelRequestMetrics): void;
      groupStopped?(groupId: string): void;
      warning(reason: string): void;
      redact(text: string): string;
    },
  ) {
    this.groups = new GroupBudgetGuard(deps.db);
    this.repo = new BudgetRepo(deps.db);
    this.checkpoints = new CheckpointRepo(deps.db);
    this.repo.recover();
    this.checkpoints.recover();
    this.timer = setInterval(() => {
      for (const root of this.clocks.keys()) {
        try {
          this.flush(root);
        } catch {
          this.exhaust(root, "ledger_unavailable");
        }
      }
    }, 1_000);
    this.timer.unref();
    this.notificationTimer = setInterval(() => this.publishPending(), 500);
    this.notificationTimer.unref();
  }
  private publish(snapshot: BudgetSnapshot) {
    this.notifications.set(snapshot.rootRunId, snapshot);
  }
  private publishPending() {
    const snapshots = [...this.notifications.values()];
    this.notifications.clear();
    for (const snapshot of snapshots) this.deps.changed(snapshot);
  }
  root(context: Pick<ToolRunContext, "runId" | "budgetRootRunId">) {
    return context.budgetRootRunId ?? context.runId;
  }
  begin(context: ToolRunContext, limits: ExecutionLimits) {
    const root = this.root(context);
    this.repo.ensure(root, this.groups.limits(root, limits));
    this.flush(root);
    let clock = this.clocks.get(root);
    if (!clock) {
      clock = { last: performance.now(), leases: new Map(), language: context.language };
      this.clocks.set(root, clock);
    }
    clock.leases.set(context.runId, new Set());
    const pause = (reason: string, value: boolean) => {
      this.flush(root);
      const reasons = this.clocks.get(root)?.leases.get(context.runId);
      if (value) reasons?.add(reason);
      else reasons?.delete(reason);
    };
    context.executionClock = {
      pause: (reason) => pause(reason, true),
      resume: (reason) => pause(reason, false),
    };
    this.assert(context);
  }
  end(context: Pick<ToolRunContext, "runId" | "budgetRootRunId">) {
    const root = this.root(context);
    this.flush(root);
    const clock = this.clocks.get(root);
    clock?.leases.delete(context.runId);
    if (!clock?.leases.size) this.clocks.delete(root);
    this.repetitions.delete(context.runId);
    this.halted.delete(context.runId);
    for (const key of this.invalidByTool.keys())
      if (key.startsWith(`${context.runId}\0`)) this.invalidByTool.delete(key);
  }
  snapshot(root: string) {
    this.flush(root);
    return this.repo.get(root);
  }
  private flush(root: string) {
    const clock = this.clocks.get(root);
    if (!clock) return;
    const now = performance.now(),
      delta = Math.max(0, now - clock.last);
    clock.last = now;
    if (![...clock.leases.values()].some((reasons) => reasons.size === 0) || delta === 0) return;
    const next = this.repo.change(root, (value) => {
      value.activeMillis += delta;
      value.exhaustedReason ??= this.repo.reason(value);
    });
    this.publish(next);
    const reason = next.exhaustedReason ?? this.groups.reason(root)?.reason;
    if (reason) this.exhaust(root, reason);
  }
  assert(context: ToolRunContext) {
    context.signal.throwIfAborted();
    const halted = this.halted.get(context.runId);
    if (halted) throw new RunHaltedError(halted);
    this.validate?.(context);
    const root = this.root(context);
    this.flush(root);
    const value = this.repo.get(root);
    if (!value) throw new Error("budget_missing");
    const reason = this.repo.reason(value) ?? this.groups.reason(root)?.reason;
    if (reason) {
      this.exhaust(root, reason, context.runId);
      throw new BudgetExceededError(reason);
    }
  }
  reserve(
    context: ToolRunContext,
    id: string,
    kind: "tool" | "model" | "child",
    options?: { pricingKnown?: boolean; depth?: number },
  ) {
    this.assert(context);
    const groupReason = this.groups.reason(
      this.root(context),
      kind === "model",
      options?.pricingKnown ?? false,
    )?.reason;
    if (groupReason) {
      this.exhaust(this.root(context), groupReason, context.runId);
      throw new BudgetExceededError(groupReason);
    }
    const result = this.repo.reserve(
      this.root(context),
      this.eventId(context, id, kind),
      kind,
      options,
    );
    if ("reason" in result) {
      this.exhaust(this.root(context), result.reason, context.runId);
      throw new BudgetExceededError(result.reason);
    }
    this.publish(result);
    return result;
  }
  beforeTool(context: ToolRunContext, call: LocalToolCall) {
    this.reserve(context, `${context.runId}:${call.id}`, "tool");
  }
  dispatch(context: ToolRunContext, call: LocalToolCall) {
    this.assert(context);
    const previous = this.checkpoints.get(context.runId);
    const description = this.deps.redact(
      JSON.stringify({
        tool: call.tool,
        toolCallId: call.id,
        ...(typeof call.input.path === "string" ? { path: call.input.path } : {}),
      }),
    );
    this.checkpoints.set({
      runId: context.runId,
      toolCallId: call.id,
      tool: call.tool,
      phase: "dispatch",
      sideEffectsPossible:
        !!previous?.sideEffectsPossible ||
        !new Set([
          "read_file",
          "list_dir",
          "find_files",
          "search_text",
          "read_messages",
          "task_status",
          "todo_list",
        ]).has(call.tool),
      outcome: null,
      summary:
        `${previous?.summary ?? ""}\nDispatched: ${description}\nVerify its outcome before any recovery replay.`.slice(
          -8_000,
        ),
    });
  }
  settledTool(
    context: ToolRunContext,
    call: LocalToolCall,
    isError: boolean,
    result?: LocalToolResult,
  ) {
    const previous = this.checkpoints.get(context.runId);
    this.checkpoints.set({
      runId: context.runId,
      toolCallId: call.id,
      tool: call.tool,
      phase: "settled",
      sideEffectsPossible: previous?.sideEffectsPossible ?? true,
      outcome: isError ? "error" : "done",
      summary: this.deps
        .redact(
          `${previous?.summary ?? ""}\n${isError ? "Tool reported an error; verify possible partial side effects." : "Tool reported completion."}\n${result?.summary ?? result?.text ?? ""}`,
        )
        .slice(-8_000),
    });
    const observesBackground =
      call.tool === "background_command" &&
      ["output", "wait", "list"].includes(String(call.input.action));
    if (observesBackground && result?.details?.backgroundWaiting) {
      this.repetitions.delete(context.runId);
      return;
    }
    const resultHash = observesBackground
      ? createHash("sha256")
          .update(result?.text ?? result?.summary ?? "")
          .digest("hex")
      : undefined;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([call.tool, call.input, isError, ...(resultHash ? [resultHash] : [])]))
      .digest("hex");
    this.observeRepetition(context, call.id, fingerprint, isError);
  }
  /** Validation ran no operation; share the failure loop without claiming dispatch/side effects. */
  rejectedInput(context: ToolRunContext, call: LocalToolCall, issueFacts: string) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([call.tool, "invalid_input", issueFacts]))
      .digest("hex");
    this.observeRepetition(context, call.id, fingerprint, true);
    // A model that keeps varying a wrong shape never repeats one fingerprint; cap the tool itself.
    const root = this.root(context);
    const group = this.groups.key(root);
    const entry = `${context.runId}:${call.id}`;
    const count = (key: string) => {
      const seen = this.invalidByTool.get(key) ?? new Set<string>();
      seen.add(entry);
      this.invalidByTool.set(key, seen);
      if (this.invalidByTool.size > 256)
        this.invalidByTool.delete(this.invalidByTool.keys().next().value as string);
      return seen;
    };
    if (!group) {
      if (count(`${context.runId}\0${call.tool}`).size >= INVALID_INPUTS_PER_TOOL)
        this.exhaust(root, "repeated_operation", context.runId);
      return;
    }
    // Run-scoped keys start with the run id so `end` drops them with the run.
    if (
      count(`${context.runId}\0${call.tool}`).size >= GROUP_RUN_INVALID_PER_TOOL ||
      count(`${context.runId}\0*`).size >= GROUP_RUN_INVALID_ANY_TOOL
    )
      this.stopRun(context, "repeated_operation");
    const across = count(`group:${group}\0*`);
    const runs = new Set([...across].map((item) => item.slice(0, item.indexOf(":"))));
    if (across.size >= GROUP_INVALID_ACROSS_RUNS && runs.size >= 2)
      this.exhaust(root, "repeated_operation", context.runId);
  }
  /** Stops one run of a shared group root; a run alone at its root still stops its whole tree. */
  private stopRun(context: ToolRunContext, reason: string) {
    const root = this.root(context);
    if (!this.groups.key(root)) {
      this.exhaust(root, reason, context.runId);
      return;
    }
    // The run's own error code (repeated_operation) records the stop; nothing else is shared.
    this.halted.set(context.runId, reason);
  }
  private observeRepetition(
    context: ToolRunContext,
    callId: string,
    fingerprint: string,
    isError: boolean,
  ) {
    const last = this.repetitions.get(context.runId);
    // The SDK result and gate can report the same rejected call; only a new call is a retry.
    if (last?.callId === callId) return;
    const count = last?.fingerprint === fingerprint ? last.count + 1 : 1;
    this.repetitions.set(context.runId, { callId, fingerprint, count });
    if (count >= (isError ? 6 : 16)) this.stopRun(context, "repeated_operation");
  }
  observer(context: ToolRunContext): AgentRequestObserver {
    const modelRequest = this.deps.modelRequest;
    return {
      ...(modelRequest && { metrics: (request) => modelRequest(context.runId, request) }),
      beforeRequest: (request) => {
        this.reserve(context, request.id, "model", { pricingKnown: request.pricingKnown });
      },
      settled: (request) => {
        // Agent-attested zero-output transient attempts settle with explicit zero usage;
        // absent usage (including output without a bill) must still fail closed below.
        const next = this.repo.settleModel(
          this.root(context),
          this.eventId(context, request.id, "model"),
          request.usage,
        );
        if (next) {
          this.publish(next);
          const reason = next.exhaustedReason ?? this.groups.reason(next.rootRunId)?.reason;
          if (reason) this.exhaust(next.rootRunId, reason, context.runId);
        }
      },
    };
  }
  private eventId(context: ToolRunContext, id: string, kind: string) {
    // Provider-authored IDs cannot collide with another counter's namespace or exceed DB bounds.
    return createHash("sha256")
      .update(JSON.stringify([context.runId, kind, id]))
      .digest("hex");
  }
  private exhaust(root: string, reason: string, runId = root) {
    // Only a workflow's own lower cost cap is recoverable through a user budget raise.
    // A genuine group aggregate/round stop and every other failure keep the cycle hard stop.
    const localCost = reason === "cost" && !this.groups.reason(root);
    if (!localCost) {
      const groupId = this.groups.stop(root, reason, runId, this.clocks.get(root)?.language);
      if (groupId) this.deps.groupStopped?.(groupId);
      // Independent roots share a cycle even when their durable parent_run_id is null.
      for (const active of this.clocks.keys())
        if (active !== root && this.groups.sameCycle(root, active)) this.abortRoot(active, reason);
    }
    this.abortRoot(root, reason);
  }
  private abortRoot(root: string, reason: string) {
    const old = this.repo.get(root);
    if (old)
      this.publish(
        old.exhaustedReason
          ? old
          : this.repo.change(root, (value) => {
              value.exhaustedReason = reason;
            }),
      );
    if (!this.abortTree || this.aborts.has(root)) return;
    const pending = Promise.resolve()
      .then(() => this.abortTree?.(root))
      .then(() => {})
      .catch(() => {
        this.deps.warning("budget_abort_drain_failed");
      });
    this.aborts.set(root, pending);
  }
  /**
   * The user's 「加预算继续」. Raises the root's cost cap (see `BudgetRepo.raiseCost`) and
   * forgets the earlier tree abort, so reaching the new cap stops the resumed tree again.
   */
  raiseCost(root: string) {
    const raised = this.repo.raiseCost(root, BUDGET_RAISE_SHARE, BUDGET_RAISES_MAX);
    if (!raised) return undefined;
    this.aborts.delete(root);
    const snapshot = this.repo.get(root);
    if (snapshot) this.publish(snapshot);
    return raised;
  }
  halt(context: ToolRunContext, reason: string) {
    this.exhaust(this.root(context), reason);
  }
  async dispose() {
    clearInterval(this.timer);
    clearInterval(this.notificationTimer);
    for (const root of this.clocks.keys()) this.flush(root);
    await Promise.all([...this.aborts.values()]);
    this.publishPending();
    this.clocks.clear();
    this.repetitions.clear();
    this.invalidByTool.clear();
  }
}
