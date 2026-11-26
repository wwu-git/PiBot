import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime, LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import type {
  Bot,
  EventTable,
  ExecutionMode,
  ExecutionScope,
  ExecutionSettings,
  Group,
  GroupExecutionPlan,
  GroupTask,
  KernelMethodParams,
  KernelMethodResults,
  MethodTable,
  ModelInfo,
  Peer,
  PermissionsSettings,
  ResolvedWorkplace,
  ReviewProfile,
  Run,
  TaskDetail,
  TaskSpawn,
  TaskSummary,
  TodoPlan,
  TodoUpdate,
} from "@pibot/protocol-base";
import type {
  GroupCyclesRepo,
  GroupsRepo,
  GroupTasksRepo,
  ManagedRecord,
  RunsRepo,
  TaskAuthority,
  TaskRepo,
} from "@pibot/storage";
import type { ChatService } from "../conversations/chat/chat.ts";
import type { LocalService } from "../local-service.ts";
import type { KernelRegisterRpc } from "./business-rpc.ts";
import type { CollaborationPort, ToolRunContext } from "./local-types.ts";
import type { BrainRedactor } from "./privacy.ts";

export interface TaskAuthorityPort {
  hasAuthority(context: Pick<ToolRunContext, "runId" | "executionTaskId">): boolean;
  bindContinuation(runId: string, authority: TaskAuthority, parentResume?: boolean): void;
  releaseContinuation(runId: string): void;
  isParentResume(runId: string): boolean;
  isContinuation(runId: string): boolean;
  verifyContinuation(runId: string, signal: AbortSignal): void;
  source(context: ToolRunContext): ToolRunContext;
  guardSync(context: ToolRunContext): void;
  verifySource(authority: TaskAuthority, signal: AbortSignal, language?: "zh" | "en"): void;
  guard(context: ToolRunContext, signal: AbortSignal): Promise<void>;
  settings(context: ToolRunContext, current: PermissionsSettings): PermissionsSettings;
  mode(context: ToolRunContext): ExecutionMode;
  yolo(context: ToolRunContext): boolean;
  workplace(context: ToolRunContext, signal: AbortSignal): Promise<ResolvedWorkplace>;
  freeze(context: ToolRunContext, signal: AbortSignal, forcePlan: boolean): Promise<TaskAuthority>;
}

export interface TaskContinuationsPort {
  readonly parents: {
    settled(root: string, runId: string, status: string): void;
  };
  isIdle(): boolean;
  hasPending(conversationId: string): boolean;
  restorable(after?: string, limit?: number): KernelMethodResults["continuations.list"];
  resumeRestored(
    conversationId: string,
    signal: AbortSignal,
  ): KernelMethodResults["continuations.resume"];
  discardRestored(conversationId: string): KernelMethodResults["continuations.discard"];
  releaseIfIdle(root: string): void;
  cancel(root: string): void;
  pause(): void;
  dispose(): void;
}

export interface TaskRuntimePort extends TaskAuthorityPort {
  readonly tasks: TaskRepo;
  readonly continuations: TaskContinuationsPort;
  onSettled?: (taskId: string, run: Run) => void;
  onReviewTaskCreated?: (profile: ReviewProfile, task: TaskSummary) => void;
  attachQueue(queue: import("../runtime/queue/run-queue.ts").RunQueue): void;
  assertCollectionIdle(scope: ExecutionScope): void;
  list(
    scope: ExecutionScope,
    page?: { before?: string; limit?: number; archived?: boolean },
  ): ReturnType<TaskRepo["list"]>;
  hasPendingChildren(context: ToolRunContext): boolean;
  status(
    context: ToolRunContext,
    input: { taskId?: string; before?: string; limit?: number },
  ): TaskDetail | ReturnType<TaskRepo["list"]>;
  detail(scope: ExecutionScope, id: string, context?: ToolRunContext): TaskDetail;
  history(
    scope: ExecutionScope,
    id: string,
    page?: { before?: string; limit?: number },
  ): KernelMethodResults["execution.tasks.history"];
  spawn(
    context: ToolRunContext,
    callId: string,
    input: TaskSpawn,
    signal: AbortSignal,
  ): Promise<TaskSummary>;
  message(
    scope: ExecutionScope,
    id: string,
    requestId: string,
    message: string,
    context?: ToolRunContext,
  ): Promise<KernelMethodResults["execution.tasks.message"]>;
  cancel(
    scope: ExecutionScope,
    id: string,
    context?: ToolRunContext,
  ): KernelMethodResults["execution.tasks.cancel"];
  resume(
    scope: ExecutionScope,
    id: string,
    expectedVersion: number,
    verified: boolean,
    signal: AbortSignal,
  ): Promise<TaskSummary>;
  spawnReadonlyReview(
    context: ToolRunContext,
    callId: string,
    brief: { title: string; prompt: string },
    profile: ReviewProfile,
    signal: AbortSignal,
  ): Promise<TaskSummary>;
  claim(runId: string, claim: () => boolean): boolean;
  prompt(runId: string, text: string): string;
  promptParts(
    runId: string,
    text: string,
  ): { text: string; current: string[]; references: string[] };
  promptStarted(runId: string): void;
  settled(record: Run): void;
  budgetRoot(record: Run): string;
  cancelContinuationTree(runId: string): void;
  execute(
    context: ToolRunContext,
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<LocalToolResult>;
}

export interface ExecutionPort {
  get(scope: ExecutionScope): ExecutionSettings;
  initialize(scope: ExecutionScope, mode: ExecutionMode): ExecutionSettings;
  mode(
    context: Pick<ToolRunContext, "botId" | "conversationId"> & Partial<ToolRunContext>,
  ): ExecutionMode;
  continuationMode(context: ToolRunContext): ExecutionMode | undefined;
  allows(
    context: Pick<ToolRunContext, "botId" | "conversationId"> & Partial<ToolRunContext>,
    tool: string,
  ): boolean;
  catalogAvailability(
    context: Pick<ToolRunContext, "botId" | "conversationId"> & Partial<ToolRunContext>,
  ): (tool: string) => boolean;
  todo(scope: ExecutionScope): TodoPlan;
  updateTodo(
    scope: ExecutionScope,
    input: TodoUpdate,
    actor?: NonNullable<TodoPlan["source"]>,
  ): TodoPlan;
  execute(context: ToolRunContext, call: LocalToolCall): LocalToolResult;
  prompt(
    context: Pick<ToolRunContext, "botId" | "conversationId" | "language"> &
      Partial<ToolRunContext>,
  ): string;
}

export interface ExecutionCleanupPort {
  hold(runId: string, settling: Promise<void>, release: () => void): void;
  drain(runId: string, beforeRelease?: () => Promise<void>): Promise<void>;
}

export interface GroupOrchestrationPort extends CollaborationPort {
  /** Returns false only for questions unrelated to a persisted plan step. */
  answerStepQuestion(
    sourceMessageId: string,
    text: string,
    confirmation: import("../conversations/chat/chat-confirmation.ts").ChatConfirmation,
  ): Promise<boolean>;
  confirmNotice(
    groupId: string,
    conversationId: string,
    botId: string,
    text: string,
    confirmation: import("../conversations/chat/chat-confirmation.ts").ChatConfirmation,
    display?: import("../conversations/chat/user-message-display.ts").UserMessageDisplay,
  ): Promise<void>;
  readonly deps: GroupOrchestrationDependencies;
  readonly signal: AbortSignal;
  readonly groups: GroupsRepo;
  readonly tasks: GroupTasksRepo;
  readonly cycles: GroupCyclesRepo;
  readonly runs: RunsRepo;
  readonly topics: {
    create(params: KernelMethodParams["groups.topics.create"]): Promise<Group>;
    history(
      params: KernelMethodParams["groups.topics.history"],
    ): KernelMethodResults["groups.topics.history"];
  };
  readonly folders: {
    bindManaged(
      id: string,
      folderPath: string,
      assertCurrent: () => void,
      recordReference: () => void,
      managed: { tree: ManagedRecord; restoreSource: boolean; signal: AbortSignal },
    ): Promise<void>;
  };
  readonly wakes: {
    enqueue(taskId: string): { runId?: string; reason?: string };
  };
  active(groupId: string, botId?: string, conversationId?: string): Group;
  changing(groupId: string): boolean;
  changed(groupId: string, reason: "created" | "updated" | "members" | "deleted"): void;
  taskChanged(task: GroupTask): void;
  planStepRetryInput?(
    failedRunId: string,
  ):
    | Pick<
        import("../runtime/queue/run-queue.ts").QueueInput,
        "budgetRootRunId" | "budgetWorkflow" | "enforceBudgetCost"
      >
    | undefined;
  planStepRetried?(failedRunId: string, newRunId: string): void;
  mutate(
    groupId: string,
    operation: () => Group | { ok: true },
    reason: "updated" | "members" | "deleted",
    automaticOnly?: boolean,
    idleOnly?: boolean,
    preservePlans?: boolean,
  ): Promise<Group | { ok: true }>;
  create(params: KernelMethodParams["groups.create"]): Group;
  update(params: KernelMethodParams["groups.update"]): Promise<Group>;
  addMember(groupId: string, botId: string): Promise<Group>;
  removeMember(groupId: string, botId: string): Promise<Group>;
  archive(groupId: string): Promise<Group | { ok: true }>;
  restore(groupId: string): Promise<Group | { ok: true }>;
  remove(groupId: string): Promise<{ ok: true }>;
  history(
    groupId: string,
    threadId: string | undefined,
    page: { before?: string; limit?: number },
  ): KernelMethodResults["chat.history"];
  send(
    params: KernelMethodParams["chat.send"] & { groupId: string },
    confirmation?: import("../conversations/chat/chat-confirmation.ts").ChatConfirmation,
    workflow?: {
      botId: string;
      run: import("../runtime/workflows/workflow-prepare.ts").WorkflowRun;
    },
    display?: import("../conversations/chat/user-message-display.ts").UserMessageDisplay,
  ): Promise<KernelMethodResults["chat.send"]>;
  startWorkflow(
    groupId: string,
    botId: string,
    workflow: import("../runtime/workflows/workflow-prepare.ts").WorkflowRun,
    conversationId?: string,
  ): Promise<KernelMethodResults["chat.send"]>;
  /**
   * Run a saved plan (a contract with `planTemplate`) as a fresh coordinator request; the
   * plan is submitted through D1 validation and confirmation, never started directly.
   */
  startPlanTemplate(
    groupId: string,
    workflow: import("../runtime/workflows/workflow-prepare.ts").WorkflowRun,
    text: string,
    conversationId?: string,
  ): Promise<KernelMethodResults["chat.send"]>;
  /** Trusted D1 boundary, after plan validation and any required user confirmation. */
  startPlan(
    groupId: string,
    coordinatorBotId: string,
    plan: GroupExecutionPlan,
    conversationId?: string,
  ): Promise<KernelMethodResults["chat.send"]>;
  model(
    botId: string,
    signal: AbortSignal,
    selection?: Pick<
      Extract<KernelMethodParams["runs.retry"], { source: "group" }>,
      "model" | "thinkingLevel"
    >,
  ): Promise<{ bot: Bot; model: Pick<ModelInfo, "contextWindow" | "input"> }>;
  admitInteractive(connected: boolean): void;
  drainInteractive(): Promise<void>;
  pauseMaintenance(): Promise<void>;
  resumeMaintenance(): void;
  startWorkspaceRouting(): void;
  stop(): Promise<void>;
}

export interface GroupOrchestrationDependencies {
  db: DatabaseSync;
  dataDir: string;
  chat: ChatService;
  agent: AgentRuntime;
  local: LocalService;
  peer: Peer<MethodTable, EventTable>;
  redactor: BrainRedactor;
  logger: Logger;
  requireCredentials(id: string): Promise<void>;
}

export interface OrchestrationFactory {
  createLocal(local: LocalService): {
    runCleanup: ExecutionCleanupPort;
    execution: ExecutionPort;
    tasks: TaskRuntimePort;
  };
  createGroups(deps: GroupOrchestrationDependencies): GroupOrchestrationPort;
  registerLocalRpc(handle: KernelRegisterRpc, local: LocalService): void;
  registerGroupRpc(handle: KernelRegisterRpc, groups: GroupOrchestrationPort, runs: RunsRepo): void;
}
