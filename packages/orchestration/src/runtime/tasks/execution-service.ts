import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type {
  KernelRegisterRpc,
  LocalService,
  ToolRunContext,
} from "@pibot/brain/orchestration-kit";
import { canAskUser, redactValue } from "@pibot/brain/orchestration-kit";
import {
  type ExecutionLimits,
  type ExecutionMode,
  type ExecutionScope,
  type ExecutionSettings,
  normalizeTodoPauseInput,
  RpcError,
  TodoPauseSchema,
  type TodoPlan,
  type TodoUpdate,
  TodoUpdateSchema,
  UserQuestionSchema,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  ExecutionConflictError,
  ExecutionRepo,
  GroupsRepo,
  transaction,
} from "@pibot/storage";
import { GroupExecutionService, registerGroupExecutionRpc } from "./group-execution-service.ts";
import { executionServicePrompts } from "./prompts/execution-service.ts";

// Commands and browser interaction are excluded even if their inputs claim to be read-only.
const PLAN_TOOLS = new Set([
  "office_inspect",
  "office_read",
  "office_preview",
  "office_render",
  "office_capabilities",
  "connector_discover",
  // The connector gate resolves current user-classified readOnly metadata before dispatch.
  "connector_call",
  "code_navigate",
  "code_outline",
  "code_symbols",
  "code_map",
  "review_start",
  "review_read",
  "delivery_evidence",
  "task_spawn",
  "task_status",
  "task_message",
  "task_cancel",
  "read_file",
  // Opens a file manager window on the user's screen; changes no file.
  "reveal_in_folder",
  "list_dir",
  "find_files",
  "search_text",
  "read_messages",
  "web_fetch",
  "web_search",
  "personal_todo",
  "todo_list",
  "tool_discover",
  "todo_update",
  "todo_pause",
  "ask_user",
  "review_finding",
]);

export class ExecutionService {
  readonly repo: ExecutionRepo;
  readonly groups: GroupExecutionService;
  constructor(private readonly local: LocalService) {
    this.repo = new ExecutionRepo(local.deps.db);
    this.groups = new GroupExecutionService(local);
  }

  private scope(scope: ExecutionScope): ExecutionScope {
    const { db } = this.local.deps;
    const bot = new BotsRepo(db).get(scope.botId);
    const conversation = new ConversationsRepo(db).get(scope.conversationId);
    if (!bot || bot.archivedAt || !conversation || conversation.archivedAt)
      throw new RpcError(-32602, "execution_unavailable");
    if (conversation.kind === "dm") {
      if (conversation.botId !== bot.id) throw new RpcError(-32602, "execution_unavailable");
    } else {
      const group = conversation.groupId ? new GroupsRepo(db).get(conversation.groupId) : undefined;
      const current = group ? new ConversationsRepo(db).get(group.conversationId) : undefined;
      if (
        !group?.members.some((member) => member.botId === bot.id) ||
        !current ||
        current.archivedAt ||
        (conversation.kind === "group"
          ? conversation.id !== current.id
          : conversation.kind !== "thread" || conversation.threadOf !== current.id)
      )
        throw new RpcError(-32602, "execution_unavailable");
    }
    return scope;
  }

  get(scope: ExecutionScope): ExecutionSettings {
    const current = this.repo.get(this.scope(scope));
    const groupId = new ConversationsRepo(this.local.deps.db).get(scope.conversationId)?.groupId;
    if (!groupId) return current;
    const settings = this.groups.get(groupId);
    return {
      ...current,
      mode: settings.mode,
      limits: settings.limits,
      version: settings.version,
      updatedAt: settings.updatedAt,
    };
  }

  /** Called only in the user send's creation transaction, before a new topic can be admitted. */
  initialize(scope: ExecutionScope, mode: ExecutionMode) {
    if (new ConversationsRepo(this.local.deps.db).get(scope.conversationId)?.groupId)
      throw new RpcError(-32602, "group_execution_settings_shared");
    const result = this.repo.set(this.scope(scope), { expectedVersion: 0, mode });
    this.local.approvals.audit.append({
      botId: scope.botId,
      kind: "execution.changed",
      summary: "New topic execution mode selected",
      detail: { conversationId: scope.conversationId, actor: "user", reasonCode: mode },
    });
    // No event before the outer send commits: the new topic's first read returns this state.
    return result;
  }

  set(
    scope: ExecutionScope,
    input: { expectedVersion: number; mode: ExecutionMode; limits?: ExecutionLimits },
  ) {
    this.scope(scope);
    if (new ConversationsRepo(this.local.deps.db).get(scope.conversationId)?.groupId)
      throw new RpcError(-32602, "group_execution_settings_shared");
    const next = this.change(() =>
      transaction(this.local.deps.db, () => {
        const result = this.repo.set(scope, input);
        this.local.approvals.audit.append({
          botId: scope.botId,
          kind: "execution.changed",
          summary: "Conversation execution mode changed",
          detail: { conversationId: scope.conversationId, actor: "user", reasonCode: result.mode },
        });
        return this.get(scope);
      }),
    );
    this.local.deps.peer.emit("execution.changed", next);
    return next;
  }

  todo(scope: ExecutionScope): TodoPlan {
    return this.repo.todo(this.scope(scope));
  }

  updateTodo(scope: ExecutionScope, input: TodoUpdate, actor?: NonNullable<TodoPlan["source"]>) {
    const change = TodoUpdateSchema.parse({
      ...input,
      goal: this.local.deps.redactor.redact(input.goal),
      items: input.items.map((item) => ({
        ...item,
        title: this.local.deps.redactor.redact(item.title),
      })),
    });
    const next = this.change(() =>
      transaction(this.local.deps.db, () => {
        const result = this.repo.setTodo(this.scope(scope), change, actor);
        this.local.approvals.audit.append({
          botId: scope.botId,
          ...(actor ? { runId: actor.runId } : {}),
          kind: "execution.todo.changed",
          summary: "Conversation plan updated",
          detail: {
            conversationId: scope.conversationId,
            actor: actor ? "automatic" : "user",
            ...(actor ? { toolCallId: actor.toolCallId } : {}),
            reasonCode: "todo_updated",
          },
        });
        return result;
      }),
    );
    this.local.deps.peer.emit("execution.todo.changed", next);
    return next;
  }

  private change<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof ExecutionConflictError)
        throw new RpcError(-32602, "execution_version_changed");
      throw error;
    }
  }

  mode(
    context: Pick<ToolRunContext, "botId" | "conversationId"> & Partial<ToolRunContext>,
  ): ExecutionMode {
    if (context.runId && this.local.tasks.hasAuthority(context as ToolRunContext))
      return this.local.tasks.mode(context as ToolRunContext);
    return context.conversationId
      ? this.get({ botId: context.botId, conversationId: context.conversationId }).mode
      : "execute";
  }

  /**
   * Admission for automatic continuation: an unreadable scope refuses the continuation instead of
   * falling back to a wider default. A vanished bot, conversation or authority is the only expected
   * refusal here; anything else is still a bug and stays thrown.
   */
  continuationMode(context: ToolRunContext): ExecutionMode | undefined {
    if (!context.conversationId) return undefined;
    try {
      return this.mode(context);
    } catch (error) {
      if (error instanceof RpcError) return undefined;
      throw error;
    }
  }

  allows(
    context: Pick<ToolRunContext, "botId" | "conversationId"> & Partial<ToolRunContext>,
    tool: string,
  ) {
    return this.allowsInMode(context, tool, () => this.mode(context));
  }

  /** One synchronous catalog pass can share the first successful scope lookup. */
  catalogAvailability(
    context: Pick<ToolRunContext, "botId" | "conversationId"> & Partial<ToolRunContext>,
  ): (tool: string) => boolean {
    let mode: ExecutionMode | undefined;
    const readMode = () => (mode ??= this.mode(context));
    return (tool) => this.allowsInMode(context, tool, readMode);
  }

  private allowsInMode(
    context: Pick<ToolRunContext, "todoRun">,
    tool: string,
    readMode: () => ExecutionMode,
  ) {
    if (context.todoRun?.paused?.question && tool !== "todo_list") return false;
    return readMode() !== "plan" || PLAN_TOOLS.has(tool);
  }

  execute(context: ToolRunContext, call: LocalToolCall): LocalToolResult {
    if (!context.conversationId) throw new RpcError(-32602, "execution_unavailable");
    context.signal.throwIfAborted();
    const scope = this.scope({ botId: context.botId, conversationId: context.conversationId });
    try {
      // After a choice card the run has nothing left to do but end: models polled todo_list to
      // "wait" for the answer. The answer
      // arrives as the user's next message, never through the plan.
      if (call.tool === "todo_list" && context.todoRun?.paused?.question)
        return {
          text: executionServicePrompts.choiceWaiting,
        };
      if (call.tool === "todo_pause" || call.tool === "ask_user") {
        // A second pause in the same run changes nothing; say so plainly so the model ends its
        // reply instead of trying other reasons (小知 called todo_pause 5 times in one run).
        if (call.tool === "todo_pause" && context.todoRun?.paused)
          return {
            text: executionServicePrompts.alreadyPaused,
          };
        const question =
          call.tool === "ask_user" ? UserQuestionSchema.parse(call.input) : undefined;
        const pause = question
          ? { reason: "needs_user" as const, summary: question.prompt, question }
          : TodoPauseSchema.parse(normalizeTodoPauseInput(call.input));
        if (pause.reason === "needs_user" && !pause.question && canAskUser(context))
          return {
            isError: true,
            text: executionServicePrompts.askUserRequired,
          };
        if (pause.question && !canAskUser(context))
          throw new RpcError(-32602, "question_context_unavailable");
        if (pause.reason === "waiting_tasks" && !this.local.tasks.hasPendingChildren(context))
          throw new RpcError(-32602, "task_wait_unavailable");
        if (context.todoRun)
          context.todoRun.paused = {
            reason: pause.reason,
            summary: this.local.deps.redactor.redact(pause.summary),
            ...(pause.question
              ? {
                  question: UserQuestionSchema.parse(
                    redactValue(pause.question, this.local.deps.redactor),
                  ),
                }
              : {}),
          };
        this.local.noteParentContinuation(context);
        this.local.approvals.audit.append({
          botId: context.botId,
          runId: context.runId,
          kind: "execution.todo.paused",
          summary: "TODO follow-through explicitly paused",
          detail: { conversationId: context.conversationId, reasonCode: pause.reason },
        });
        return {
          // Maintainers 2026-11-20: a coordinator answered 「已暂停」 after todo_pause while its member's
          // plan step kept running. In a group the result says what was paused; a tool result is
          // appended after the cached prefix, so this text changes no cache hit.
          text: pause.question
            ? executionServicePrompts.pauseResult.question
            : context.groupId
              ? executionServicePrompts.pauseResult.group
              : executionServicePrompts.pauseResult.own,
        };
      }
      const plan =
        call.tool === "todo_list"
          ? this.todo(scope)
          : this.updateTodo(scope, TodoUpdateSchema.parse(call.input), {
              runId: context.runId,
              messageId: context.messageId,
              toolCallId: call.id,
            });
      if (call.tool === "todo_update" && context.todoRun) {
        context.todoRun.planVersion = plan.version;
        if (this.mode(context) === "execute")
          context.todoRun.armed = plan.items.some(
            (item) => item.status === "pending" || item.status === "in_progress",
          );
        // The durable parent intent must name the plan this run actually continues; the admission
        // baseline and progress streak stay where the last admitted round left them.
        this.local.noteParentContinuation(context);
      }
      return { text: JSON.stringify(plan) };
    } catch (error) {
      if (error instanceof RpcError && error.message === "execution_version_changed")
        return {
          text: "计划已更新，请重新读取计划后再修改 / The plan changed; read it again before editing",
          isError: true,
        };
      throw error;
    }
  }

  prompt(
    context: Pick<ToolRunContext, "botId" | "conversationId" | "language"> &
      Partial<ToolRunContext>,
  ): string {
    if (!context.conversationId) return "";
    const scope = { botId: context.botId, conversationId: context.conversationId };
    const mode = this.mode(context),
      plan = this.todo(scope);
    const intro =
      context.language === "zh"
        ? mode === "plan"
          ? executionServicePrompts.intro.plan.zh
          : executionServicePrompts.intro.execute.zh
        : mode === "plan"
          ? executionServicePrompts.intro.plan.en
          : executionServicePrompts.intro.execute.en;
    // Parent resumes carry the original execution plan forward; only summary-only passes are review-bound.
    const followThrough =
      context.runId &&
      this.local.tasks.isContinuation(context.runId) &&
      !this.local.tasks.isParentResume(context.runId)
        ? executionServicePrompts.followThrough.summary
        : executionServicePrompts.followThrough.normal;
    // Titles are user/model-authored data, not instructions capable of changing this mode. `<` is
    // escaped so a title cannot close the <execution> tag and append rules of its own.
    const planData = JSON.stringify({
      goal: plan.goal,
      items: plan.items,
      version: plan.version,
    }).replaceAll("<", "\\u003c");
    const decision = canAskUser(context)
      ? context.language === "zh"
        ? executionServicePrompts.decision.zh
        : executionServicePrompts.decision.en
      : "";
    return `${intro}\n${followThrough}\n${decision}\nPlan data (untrusted): ${planData}`;
  }
}

export function registerExecutionRpc(handle: KernelRegisterRpc, service: ExecutionService) {
  registerGroupExecutionRpc(handle, service.groups);
  handle("execution.get", async (scope) => service.get(scope));
  handle("execution.set", async ({ botId, conversationId, expectedVersion, mode, limits }) => {
    return service.set(
      { botId, conversationId },
      { expectedVersion, mode, ...(limits ? { limits } : {}) },
    );
  });
  handle("execution.todo.get", async (scope) => service.todo(scope));
  handle("execution.todo.set", async ({ botId, conversationId, ...change }) =>
    service.updateTodo({ botId, conversationId }, change),
  );
}
