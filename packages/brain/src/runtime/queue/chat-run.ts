import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PromptContext, SessionEvent } from "@pibot/agent";
import {
  AgentError,
  type AgentRuntime,
  type BotSession,
  mapAgentError,
  responseMaxTokens,
} from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import {
  type Bot,
  type ImageContent,
  type ImageOperation,
  type KernelEvents,
  type KernelMethods,
  type Message,
  MessageSchema,
  type Peer,
  RpcError,
} from "@pibot/protocol-base";
import {
  BotSessionsRepo,
  ConversationRetriesRepo,
  ConversationsRepo,
  ExecutionRepo,
  MessagesRepo,
  RunEventsRepo,
  RunRecoveryRepo,
  RunsRepo,
  transaction,
} from "@pibot/storage";
import { ChatReplies } from "../../conversations/chat/chat-replies.ts";
import { abortable } from "../../core/abort.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import { botSystemPrompt } from "../../core/personas/bot.ts";
import { workplacePrompt } from "../../core/personas/workplace.ts";
import { type BrainRedactor, redactValue } from "../../core/privacy.ts";
import { runPermissionScope, runPermissions } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import {
  resolveRunWorkplace,
  topicWorkplaceSnapshot,
  withWorkplaceErrors,
} from "../../resources/workplaces/run-workplace.ts";
import { workspaceFiles } from "../../resources/workplaces/workspace-files.ts";
import { AutoCheckRun } from "../checks/auto-check-run.ts";
import { assertComputerProgress, computerReadingWindow } from "../computer/progress.ts";
import {
  CONNECTION_CONTINUATION_LIMIT,
  DRAIN_CERTIFY_TIMEOUT_MS,
  OUTPUT_CONTINUATION_LIMIT,
} from "../continuation/continuation-limits.ts";
import {
  autoReviewPrompt,
  connectionContinuation,
  deliveryFileReminder,
  emptyReplyReminder,
  outputLimitContinuation,
} from "../continuation/continuation-prompts.ts";
import { deliveryOnlyInReply } from "../continuation/delivery-reply.ts";
import { promisedWithoutTools } from "../continuation/execution-observation.ts";
import { attachNamedOutputs } from "../continuation/named-outputs.ts";
import { textToolCallCorrection, textToolCallMarker } from "../continuation/text-tool-call.ts";
import { TodoFollowThrough } from "../continuation/todo-follow-through.ts";
import { failAgentRun } from "../external-agents/unavailable-run.ts";
import { memoryProjectPath } from "../memory/project.ts";
import { runProjectNotes } from "../notes/project-notes.ts";
import { reviewerBrain, taskReviewer } from "../review/review-reviewer.ts";
import { workQualityFacts, workQualityReceipt } from "../review/work-quality-run.ts";
import { commandScanGuidance } from "../tools/command-guidance.ts";
import { unavailableConnectionSummary } from "../tools/connectors/connection-summary.ts";
import { groupAuthorization } from "../tools/local-prepare.ts";
import { noteUntrustedContent } from "../tools/untrusted-content.ts";
import { DeliveryRun } from "../workflows/delivery-run.ts";
import { deliverySources } from "../workflows/delivery-sources.ts";
import { checkReplyCitations } from "../workflows/reply-citations.ts";
import { roleDeliveryRun } from "../workflows/role-delivery.ts";
import {
  cheapChildrenAvailable,
  childModelTier,
  workflowLimits,
  workflowPriced,
} from "../workflows/workflow-budget.ts";
import { resolveWorkflowFolder, type WorkflowFolder } from "../workflows/workflow-folder.ts";
import { workflowPipeline } from "../workflows/workflow-pipeline.ts";
import type { WorkflowRun } from "../workflows/workflow-prepare.ts";
import { workflowSkillText, workflowSystemBlock } from "../workflows/workflow-text.ts";
import { routineTopicReference } from "./routine-topic-reference.ts";
import { abortRun } from "./run-queue-shared.ts";
import { runStateFacts } from "./run-state-facts.ts";
import { recordSessionTail } from "./session-tail.ts";

export interface ChatRun {
  projectBackground?: boolean;
  interactiveChat?: true;
  backgroundResults?: string;
  worktreeReview?: import("../workspaces/types.ts").WorktreeReceipt;
  parentFollowThrough?: { planVersion: number };
  executionTaskId?: string;
  budgetRootRunId?: string;
  /** Outer orchestration budget only; unlike `workflow`, its body is not added to the prompt. */
  budgetWorkflow?: Pick<WorkflowRun, "contract">;
  enforceBudgetCost?: boolean;
  /** Resumes an interrupted run (journal attempt scope, trusted runtime note). */
  resume?: { fromRunId: string; note: string };
  imageOperation?: ImageOperation;
  /** The workflow skill this run executes (body injected, delivery checked after). */
  workflow?: WorkflowRun;
  /** A child task a workflow run spawned with `model: "cheap"` (from its authority). */
  modelTier?: "cheap";
  routine?: {
    id: string;
    source: "routine" | "trial";
    name: string;
    approvalWaitMs: number;
    sessionFile: string;
    summary?: string;
    /** The owner's ledger facts for this run (trusted, Pi Bot's own records). */
    ledger?: string;
    resumeFacts?: string;
    resumeDecision?: ToolRunContext["routineResume"];
    workplace?: ToolRunContext["routineWorkplace"];
    clock: import("../unattended/clock.ts").RoutineClock;
  };
  runId: string;
  botId: string;
  messageId: string;
  conversationId: string;
  groupId?: string;
  threadId?: string;
  cycleId?: string;
  taskId?: string;
  aborted: boolean;
  parking?: boolean;
  approvalPause?: string;
  routineFailureCode?: string;
  controller: AbortController;
  signal: AbortSignal;
  stopCause?: import("@pibot/protocol-base").RunStopCause;
  session?: BotSession;
  finished: Promise<void>;
  aborting?: Promise<void>;
}

interface RunDependencies {
  db: DatabaseSync;
  dataDir: string;
  agent: AgentRuntime;
  peer: Peer<typeof KernelMethods, typeof KernelEvents>;
  logger: Logger;
  redactor: BrainRedactor;
  local?: LocalService;
  language(): "zh" | "en";
  finished(run: ChatRun): void;
}

/**
 * Input folders the user picked for a workflow are readable for this run without a second
 * approval (they chose them in the form). File inputs keep asking: making a file readable would
 * mean opening its whole parent folder.
 */
function workflowReadRoots(workflow: WorkflowRun): Pick<ToolRunContext, "workflowReadRoots"> {
  const folders = [
    ...new Set(workflow.inputs.flatMap((i) => (i.kind === "folder" ? [i.value] : []))),
  ];
  return folders.length
    ? { workflowReadRoots: folders.map((path) => ({ id: randomUUID(), path })) }
    : {};
}

/**
 * The model this run was opened with, kept on its reply so the receipt can name it. A
 * workflow's `cheap` tier may run on the auxiliary model; the session reports the real one.
 */
function runModel(bot: Bot, session?: BotSession): { runModel?: { provider: string; id: string } } {
  if (session?.model) return { runModel: session.model };
  if (!bot.modelProvider || !bot.modelId) return {};
  return { runModel: { provider: bot.modelProvider, id: bot.modelId } };
}

/**
 * The plan this run starts from. A group member answering a question may advance the plan it
 * already had; only the plan it found tells that apart from starting one, and the plan row is
 * overwritten before the run reaches its completion check.
 */
function planAtStart(
  db: DatabaseSync,
  run: ChatRun,
): { planAtStart?: { goal: string; version: number } } {
  if (!run.groupId || !run.taskId) return {};
  const plan = new ExecutionRepo(db).todo({ botId: run.botId, conversationId: run.conversationId });
  return { planAtStart: { goal: plan.goal, version: plan.version } };
}

/** Note: the plan's open items when this run ends, so a later run cannot change them. */
function planAtEnd(
  db: DatabaseSync,
  run: ChatRun,
  calledTools: readonly string[] | undefined,
): { planAtEnd?: { open: number; total: number } } {
  if (!calledTools?.includes("todo_update")) return {};
  const plan = new ExecutionRepo(db).todo({ botId: run.botId, conversationId: run.conversationId });
  if (!plan) return {};
  return {
    planAtEnd: {
      open: plan.items.filter((item) => item.status === "pending" || item.status === "in_progress")
        .length,
      total: plan.items.length,
    },
  };
}

export async function generateRun(
  deps: RunDependencies,
  run: ChatRun,
  text: string,
  sessionFile: string | null,
  storedBot: Bot,
  images: ImageContent[],
  memoryQuery = text,
) {
  // A read-only review child chosen to be reviewed by another Bot thinks with that Bot's
  // model and persona; identity, permissions and scope stay the author's (see review-reviewer.ts).
  const reviewer =
    run.executionTaskId && deps.local ? taskReviewer(deps.local, run.executionTaskId) : undefined;
  const reviewedBot = reviewer ? reviewerBrain(storedBot, reviewer) : storedBot;
  // A workflow fixes its own thinking level (⑥); the Bot record is untouched.
  const thinking = run.workflow?.contract.model?.thinking;
  const bot = thinking ? { ...reviewedBot, thinkingLevel: thinking } : reviewedBot;
  // An external agent thinks with its own account and model; the capability runs the turn.
  // A review of its code by another Bot is that Bot's thinking in Pi Bot's own runtime.
  if (storedBot.kind === "agent" && !reviewer) {
    if (deps.local?.externalAgentProvider)
      return deps.local.externalAgentProvider.run(deps, run, text, storedBot, images);
    return failAgentRun(deps, run, "agent_unavailable");
  }
  const imageRun = !!run.imageOperation || bot.category === "image";
  if (imageRun && deps.local?.imageProvider) {
    return deps.local.images.run(deps, run, text, bot, images);
  }
  const conversationId = run.conversationId;
  // Group plan dispatch carries a group task id, not the internal execution-task authority.
  const taskSession = !!(run.executionTaskId || (run.groupId && run.taskId));
  const route = {
    botId: run.botId,
    conversationId,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
  };
  const runs = new RunsRepo(deps.db);
  const conversations = new ConversationsRepo(deps.db);
  let activityPhase = "";
  let activityAt = 0;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingActivity:
    | {
        messageId: string;
        activity:
          | { phase: "waiting_model" }
          | { phase: "preparing_tool"; tool: string; characters: number }
          | { phase: "executing_tool"; tool: string };
      }
    | undefined;
  const publishRunActivity = (
    messageId: string,
    activity:
      | { phase: "waiting_model" }
      | { phase: "preparing_tool"; tool: string; characters: number }
      | { phase: "executing_tool"; tool: string }
      | { phase: "clear" },
  ) => {
    if (run.executionTaskId) return;
    const now = Date.now();
    if (activity.phase === "clear") {
      clearTimeout(activityTimer);
      activityTimer = undefined;
      pendingActivity = undefined;
      if (activityPhase === "clear") return;
    } else if (activity.phase === activityPhase && now - activityAt < 500) {
      pendingActivity = { messageId, activity };
      activityTimer ??= setTimeout(
        () => {
          activityTimer = undefined;
          const pending = pendingActivity;
          pendingActivity = undefined;
          if (pending) publishRunActivity(pending.messageId, pending.activity);
        },
        500 - (now - activityAt),
      );
      return;
    } else {
      clearTimeout(activityTimer);
      activityTimer = undefined;
      pendingActivity = undefined;
    }
    activityPhase = activity.phase;
    activityAt = now;
    deps.peer.emit("chat.activity", {
      ...route,
      runId: run.runId,
      messageId,
      ...activity,
      ...(activity.phase === "waiting_model" && computerReadingWindow(toolContext)
        ? { readingWindow: true }
        : {}),
    });
  };
  const replies = new ChatReplies(
    deps.db,
    run,
    deps.peer,
    deps.redactor,
    (id) => {
      tools?.setMessage(id);
      // Same re-take as LocalRun.setMessage: the group snapshot names the reply message.
      const held =
        !!toolContext.groupId &&
        !!deps.local &&
        groupAuthorization(deps.local, toolContext) === toolContext.groupAuthorization;
      toolContext.messageId = id;
      toolContext.assistantReply = undefined;
      if (held && deps.local)
        toolContext.groupAuthorization = groupAuthorization(deps.local, toolContext);
    },
    publishRunActivity,
    // Execution sub-tasks are internal records, so only visible chats split per reply.
    !run.executionTaskId,
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let tools: ReturnType<LocalService["run"]> | undefined;
  let delivery: DeliveryRun | undefined;
  let resourceGroupId: string | undefined;
  const toolContext: ToolRunContext = {
    ...(run.interactiveChat ? { interactiveChat: true } : {}),
    currentReplyText: () => replies.runContent,
    memoryQuery,
    untrustedContent: {
      seen:
        !!run.backgroundResults ||
        images.length > 0 ||
        (!!run.workflow &&
          run.workflow.provenance !== "own" &&
          run.workflow.provenance !== "builtin"),
    },
    ...(run.workflow ? workflowReadRoots(run.workflow) : {}),
    quality: workQualityFacts(),
    browserFailures: {},
    worktreeReview: run.worktreeReview,
    todoRun: {
      armed: !!run.parentFollowThrough,
      planVersion: run.parentFollowThrough?.planVersion,
      progress: new Set(),
      codeChanges: 0,
    },
    ...planAtStart(deps.db, run),
    executionTaskId: run.executionTaskId,
    budgetRootRunId: run.budgetRootRunId,
    ...(run.workflow ? { workflowSkillId: run.workflow.skillId } : {}),
    ...(run.resume ? { resumedFromRunId: run.resume.fromRunId } : {}),
    imageResultSources: new Set<string>(),
    ...route,
    runId: run.runId,
    messageId: run.messageId,
    cycleId: run.cycleId,
    taskId: run.taskId,
    signal: run.signal,
    language: deps.language(),
    isParking: () => !!run.parking,
    ...(!run.routine && !run.executionTaskId
      ? {
          pauseForApproval: (id: string) => {
            run.approvalPause = id;
            abortRun(run, { code: "approval_paused" });
          },
        }
      : {}),
    runActivity: publishRunActivity,
    ...(run.routine
      ? {
          routineRunId: run.routine.id,
          routineResume: run.routine.resumeDecision,
          routineSource: run.routine.source,
          routineName: run.routine.name,
          routineWorkplace: run.routine.workplace,
          routineClock: run.routine.clock,
          routineApprovalWaitMs: run.routine.approvalWaitMs,
        }
      : {}),
  };
  let groupSnapshot: PromptContext | undefined;
  let projectNotes: string | undefined;
  let routineReference: string | undefined;
  let routineReferenceId: string | undefined;
  let workplace: string | undefined;
  // Ids of memory notes injected into this run's prompts, listed on its receipt.
  const usedMemoryIds = new Set<string>();
  const backgroundRequests = new Set<string>();
  let loggedCatalog: string | undefined;
  let stalledCompaction = false;
  /** The model kept calling tools after its choice card; the program ends the turn for it. */
  let questionEnded = false;
  const rememberUsed = (ids: readonly string[]) => {
    for (const id of ids) usedMemoryIds.add(id);
  };
  let workflowPlace: WorkflowFolder | undefined;
  let childTier: "cheap" | undefined;
  /**
   * The files this run produced reach the chat however it ends (finished, failed or stopped):
   * maintainers 2026-11-20, a run that failed after writing three files must not lose them. The reply
   * already stands, so a file that cannot be attached only loses its card and is logged.
   */
  const deliverOutputs = (reply: string, signal: AbortSignal, declared: string[] = []) =>
    deps.local
      ? attachNamedOutputs({
          local: deps.local,
          context: toolContext,
          reply,
          signal,
          declared,
        }).catch((error: unknown) => {
          if (signal.aborted) return undefined;
          deps.logger.warn(
            JSON.stringify({
              module: "attachments",
              event: "delivery_failed",
              botId: run.botId,
              runId: run.runId,
              code: error instanceof Error ? error.name : "unknown",
            }),
          );
          return undefined;
        })
      : Promise.resolve(undefined);
  try {
    if (run.projectBackground && deps.local) {
      run.signal.throwIfAborted();
      const current = runs.get(run.runId);
      const background = current && deps.local.background.continuation.project(current);
      if (background) {
        run.backgroundResults = background.reference;
        text = `${text}\n\n${background.text}`;
      }
    }
    // Missing optional capabilities still settle through the queue's normal error/finally path.
    if (imageRun) throw new AgentError("image_unsupported");
    run.signal.throwIfAborted();
    if (deps.local) {
      const source = deps.local.tasks.source(toolContext);
      const priced = await workflowPriced(deps, bot, run.workflow, run.signal);
      const budgetPriced = run.enforceBudgetCost
        ? true
        : await workflowPriced(deps, bot, run.budgetWorkflow, run.signal);
      const baseLimits = deps.local.execution.get({
        botId: source.botId,
        conversationId: source.conversationId ?? conversationId,
      }).limits;
      deps.local.budgets.begin(
        toolContext,
        workflowLimits(
          workflowLimits(baseLimits, run.budgetWorkflow, budgetPriced),
          run.workflow,
          priced,
        ),
      );
      if (run.modelTier && !run.workflow)
        childTier = await childModelTier(
          deps,
          deps.local.budgets.repo.get(run.budgetRootRunId ?? run.runId),
          run.signal,
        );
    }
    deps.local?.memory.active(bot.id);
    if (deps.local) {
      runPermissions(deps.local, toolContext);
      resourceGroupId = runPermissionScope(deps.local, toolContext);
      toolContext.capabilities = deps.local.capabilities.resolve({
        botId: toolContext.botId,
        ...(resourceGroupId ? { groupId: resourceGroupId } : {}),
      });
    }
    if (run.groupId) {
      if (!deps.local?.collaboration) throw new RpcError(-32602, "Group context unavailable");
      const before = groupAuthorization(deps.local, toolContext);
      const collaboration = deps.local.collaboration;
      if (!run.worktreeReview)
        groupSnapshot = await withWorkplaceErrors(() =>
          collaboration.prepare(toolContext, run.signal),
        );
      if (before !== groupAuthorization(deps.local, toolContext))
        throw new RpcError(-32602, "Group identity changed");
      toolContext.groupAuthorization = before;
    }
    if (deps.local) {
      toolContext.topicWorkplace = run.executionTaskId
        ? undefined
        : topicWorkplaceSnapshot(deps.local, toolContext);
      const local = deps.local;
      const place = await withWorkplaceErrors(() =>
        resolveRunWorkplace(local, toolContext, run.signal),
      );
      toolContext.runWorkplace = { cwd: place.cwd, boundary: place.boundary };
      if (
        place.boundary.location?.target.startsWith("runner:") &&
        (run.worktreeReview || (run.workflow && !run.groupId))
      )
        throw new RpcError(-32601, "runner_workflow_unsupported");
      workplace = workplacePrompt(
        deps.language(),
        place.boundary.primaryPath,
        place.cwd,
        place.boundary.writeRoots,
      );
      if (run.workflow) {
        workflowPlace = await resolveWorkflowFolder(
          place.boundary.primaryPath,
          run.workflow,
          run.signal,
          undefined,
          workspaceFiles(local, place.boundary),
        );
        // A resume of this run writes into the same period folder.
        new RunRecoveryRepo(deps.db).place(run.runId, workflowPlace);
      }
    }
    if (run.workflow && !workflowPlace) throw new AgentError("internal");
    if (run.workflow && workflowPlace && run.groupId)
      toolContext.workflowPipeline = {
        pipeline: workflowPipeline(run.workflow, workflowPlace),
        assigned: false,
      };
    if (run.worktreeReview && deps.local) {
      const result = await deps.local.reviews.start(
        toolContext,
        "scm-review",
        { scope: "uncommitted" },
        run.signal,
      );
      replies.event({
        type: "delta",
        text:
          deps.language() === "zh"
            ? "已启动所选工作区的独立只读审查。"
            : "Independent read-only review started for the selected worktree.",
      });
      replies.flush();
      const updates = transaction(deps.db, () => {
        const updates = replies.finish("done", {
          stopReason: "stop",
          worktreeRootId: run.worktreeReview?.rootId ?? null,
          review: result.text,
        });
        runs.finish(run.runId, "done", "stop");
        return updates;
      });
      replies.publishUpdates(updates);
      deps.peer.emit("chat.done", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        stopReason: "stop",
      });
      return;
    }
    const local = deps.local;
    const entries =
      (await local?.skills?.promptEntries(bot.id, resourceGroupId, deps.language(), run.signal)) ??
      [];
    run.signal.throwIfAborted();
    tools = local?.run(toolContext);
    const sessionDir = join(deps.dataDir, "bots", bot.id, "sessions");
    transaction(deps.db, () =>
      new RunEventsRepo(deps.db).append({
        runId: run.runId,
        conversationId,
        kind: "model.selected",
        payload: {
          provider: bot.modelProvider,
          model: bot.modelId,
          thinkingLevel: bot.thinkingLevel,
          tier: run.workflow?.contract.model?.tier ?? childTier ?? "main",
        },
      }),
    );
    const connectionStatus = () => {
      const groupId = toolContext.permissionGroupId ?? toolContext.groupId;
      return unavailableConnectionSummary(
        local?.connectors,
        groupId ? { kind: "group", id: groupId } : { kind: "bot", id: bot.id },
      );
    };
    const opening = deps.agent.openSession({
      ...(!run.groupId && !run.routine && run.messageId
        ? {
            retryBoundary: {
              messageId: run.messageId,
              record: (entryId: string, file: string, messageId?: string) =>
                new ConversationRetriesRepo(deps.db).bind(
                  messageId ?? (run.messageId as string),
                  file,
                  entryId,
                ),
            },
          }
        : {}),
      botId: bot.id,
      homeDir: join(deps.dataDir, "bots", bot.id, "home"),
      sessionDir,
      sessionFile:
        run.routine?.sessionFile ??
        (taskSession
          ? join(sessionDir, `${conversationId}-${run.runId}.jsonl`)
          : (new BotSessionsRepo(deps.db).get(bot.id, conversationId) ??
            sessionFile ??
            join(sessionDir, `${conversationId}.jsonl`))),
      model: { provider: bot.modelProvider as string, id: bot.modelId as string },
      thinkingLevel: bot.thinkingLevel,
      ...(run.workflow && workflowPlace
        ? {
            workflowPrompt: deps.redactor.redact(
              workflowSystemBlock(
                run.workflow,
                workflowPlace,
                deps.language(),
                cheapChildrenAvailable(deps.db),
              ),
            ),
            workflowSkill: {
              name: run.workflow.name,
              ...(run.workflow.version ? { version: run.workflow.version } : {}),
              provenance: run.workflow.provenance ?? "imported",
              text: deps.redactor.redact(workflowSkillText(run.workflow, deps.language())),
            },
            modelTier: run.workflow.contract.model?.tier ?? "main",
          }
        : childTier
          ? { modelTier: childTier }
          : {}),
      ...(tools ? { localTools: tools.ports } : {}),
      // Only this Bot's enabled skills, read fresh for every run (no disk discovery).
      ...(tools && local
        ? {
            skills: {
              entries,
              language: deps.language(),
            },
          }
        : {}),
      signal: run.signal,
      ...(local
        ? {
            requestObserver: {
              beforeRequest: (request) => {
                if (
                  request.kind === "response" &&
                  (toolContext.compactionProgress?.count ?? 0) >= 3
                ) {
                  stalledCompaction = true;
                  throw new AgentError("repeated_operation");
                }
                // 2026-11-11 real run: after ask_user the coordinator called todo_pause three
                // times. The card is saved already, so a second ignored "end now" ends the run
                // here: no further request, the card kept, and nothing counted as a failure.
                if (
                  request.kind === "response" &&
                  toolContext.todoRun?.paused?.question &&
                  (toolContext.todoRun.afterQuestionCalls ?? 0) >= 2
                ) {
                  questionEnded = true;
                  throw new AgentError("repeated_operation");
                }
                assertComputerProgress(toolContext);
                local.budgets.observer(toolContext).beforeRequest(request);
                if (request.toolSet)
                  deps.logger.info(
                    JSON.stringify({
                      module: "agent-tools",
                      event: "model_request",
                      audit: true,
                      botId: run.botId,
                      runId: run.runId,
                      requestId: request.id,
                      kind: request.kind,
                      ...request.toolSet,
                      visible:
                        loggedCatalog === request.toolSet.catalogVersion
                          ? undefined
                          : request.toolSet.visible,
                      visibleCount: request.toolSet.visible.length,
                    }),
                  );
                if (request.toolSet) loggedCatalog = request.toolSet.catalogVersion;
                if (request.kind === "response") {
                  local.tasks.promptStarted(run.runId);
                  local.background.continuation.validateProjection(run.runId);
                  backgroundRequests.add(request.id);
                }
              },
              settled: (request) => {
                local.budgets.observer(toolContext).settled(request);
                if (backgroundRequests.delete(request.id) && request.complete)
                  local.background.continuation.confirmProjection(run.runId);
              },
              // Hashes, counts and item types only; explains prompt-cache misses on the
              // user's machine without any prompt text.
              cacheDiagnostic: (line) =>
                deps.logger.info(
                  JSON.stringify({
                    module: "agent-cache",
                    event: "cache_request",
                    botId: run.botId,
                    runId: run.runId,
                    ...line,
                  }),
                ),
            },
          }
        : {}),
      unattended: !!run.routine,
      onCompaction: (event) => {
        if (event.phase === "end" && event.outcome === "done") {
          toolContext.compactionProgress ??= { count: 0, reads: [] };
          toolContext.compactionProgress.count++;
        }
        if (event.phase === "end")
          transaction(deps.db, () =>
            new RunEventsRepo(deps.db).append({
              runId: run.runId,
              conversationId,
              kind: "compaction.finished",
              payload: {
                reason: event.reason,
                entryCount: event.entryCount,
                durationMs: event.durationMs,
                outcome: event.outcome,
                failure: event.failure?.code,
              },
            }),
          );
        if (event.phase !== "start")
          deps.logger[event.failure || event.outcome === "error" ? "warn" : "info"](
            JSON.stringify({
              module: "chat",
              event: "compaction",
              phase: event.phase,
              audit: true,
              botId: run.botId,
              runId: run.runId,
              reason: event.reason,
              entryCount: event.entryCount,
              durationMs: event.durationMs,
              outcome: event.outcome,
              provider: bot.modelProvider,
              model: bot.modelId,
              ...(event.failure ? { failure: event.failure } : {}),
              ...(event.metrics ? { metrics: event.metrics } : {}),
            }),
          );
        if (run.aborted || run.signal.aborted || event.phase === "progress") return;
        if (!run.executionTaskId)
          deps.peer.emit("chat.status", {
            ...route,
            runId: run.runId,
            messageId: run.messageId,
            state: "running",
            compacting: event.phase === "start",
          });
      },
      systemPrompt: (model, providerName) => {
        // Before tools are read: screenshot tools are offered only to image-capable models.
        // The per-reply cap, not the model's ceiling: a 128k-output model still answers in at
        // most 32k tokens, and the truncation hint sizes its chunks from this.
        tools?.useModel(
          model.input,
          model.maxTokens === undefined ? undefined : responseMaxTokens(model.maxTokens),
        );
        const search = local?.deps.search?.get();
        const system = botSystemPrompt(
          bot,
          deps.language(),
          model,
          providerName,
          {
            definitions: tools?.ports.definitions ?? [],
            levels: local ? runPermissions(local, toolContext).levels : undefined,
            search: search ? { provider: search.provider } : null,
            memoryMode: resourceGroupId ? "ask" : (bot.memoryMode ?? "auto"),
            group: !!resourceGroupId,
            // Only runs with a resolved workplace can act on the scratch-file advice.
            workplace: !!workplace,
          },
          local?.deps.capabilityTools ?? { specs: {}, groups: [] },
          // Only names and kinds; what may be read per call is decided by the tools.
          local?.knowledgeSources(bot.id, resourceGroupId) ?? [],
        );
        const scans = tools?.ports.definitions.some((tool) => tool.name === "run_command")
          ? commandScanGuidance(deps.language())
          : "";
        return deps.redactor.redact([system, scans].filter(Boolean).join("\n\n"));
      },
      ...(local
        ? {
            context: {
              prepare: async (signal: AbortSignal, model) => {
                signal.throwIfAborted();
                await local.userSecrets.ready(signal);
                runPermissions(local, toolContext);
                projectNotes = tools
                  ? await runProjectNotes(local, tools, toolContext, signal)
                  : undefined;
                signal.throwIfAborted();
                const actual = conversations.get(conversationId);
                if (run.groupId) {
                  if (groupAuthorization(local, toolContext) !== toolContext.groupAuthorization)
                    throw new RpcError(-32602, "Group identity changed");
                  const current = await local.collaboration?.refresh(
                    toolContext,
                    signal,
                    model ?? { input: [] },
                  );
                  signal.throwIfAborted();
                  if (
                    groupAuthorization(local, toolContext) !== toolContext.groupAuthorization ||
                    !current
                  )
                    throw new RpcError(-32602, "Group identity changed");
                  return {
                    ...current,
                    ...(run.backgroundResults ? { backgroundResults: run.backgroundResults } : {}),
                    execution: [
                      runStateFacts(local, toolContext),
                      local.execution.prompt(toolContext),
                    ]
                      .filter(Boolean)
                      .join("\n\n"),
                    connectionStatus: connectionStatus(),
                    availableSecrets: local.userSecrets.prompt(bot.id),
                    ...(workplace ? { workplace } : {}),
                    ...(projectNotes ? { projectNotes } : {}),
                    ...(run.resume ? { runResume: run.resume.note } : {}),
                    group: current.group && {
                      ...current.group,
                      workplace: groupSnapshot?.group?.workplace,
                    },
                  };
                }
                if (actual?.kind !== "dm" || actual.botId !== bot.id)
                  throw new RpcError(-32602, "Conversation identity changed");
                routineReferenceId = !run.routine ? (actual.routineId ?? undefined) : undefined;
                if (routineReferenceId && actual.archivedAt)
                  throw new RpcError(-32602, "Conversation identity changed");
                routineReference = routineReferenceId
                  ? routineTopicReference(
                      deps.db,
                      { ...route, runId: run.runId, signal },
                      deps.redactor,
                    )
                  : undefined;
                if (routineReference) noteUntrustedContent(toolContext);
                return {
                  ...(routineReference ? { routineTopicReference: routineReference } : {}),
                  ...(run.backgroundResults ? { backgroundResults: run.backgroundResults } : {}),
                  memory: resourceGroupId
                    ? local.groupMemory.prompt(resourceGroupId, bot.id, {
                        query: memoryQuery,
                        signal,
                        project: memoryProjectPath(toolContext),
                        onUsed: rememberUsed,
                      })
                    : local.memory.prompt(bot.id, {
                        query: memoryQuery,
                        signal,
                        project: memoryProjectPath(toolContext),
                        onUsed: rememberUsed,
                      }),
                  execution: [
                    runStateFacts(local, toolContext),
                    local.execution.prompt(toolContext),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  connectionStatus: connectionStatus(),
                  availableSecrets: local.userSecrets.prompt(bot.id),
                  ...(workplace ? { workplace } : {}),
                  ...(projectNotes ? { projectNotes } : {}),
                  ...(run.routine?.resumeFacts ? { routineResume: run.routine.resumeFacts } : {}),
                  ...(run.resume ? { runResume: run.resume.note } : {}),
                  ...(run.routine?.ledger ? { routineLedger: run.routine.ledger } : {}),
                  ...(run.routine?.summary ? { routineSummary: run.routine.summary } : {}),
                };
              },
              ...(run.groupId
                ? {
                    refresh: async (signal, model) => {
                      if (groupAuthorization(local, toolContext) !== toolContext.groupAuthorization)
                        throw new RpcError(-32602, "Group identity changed");
                      const current = await local.collaboration?.refresh(
                        toolContext,
                        signal,
                        model ?? { input: [] },
                      );
                      signal.throwIfAborted();
                      if (groupAuthorization(local, toolContext) !== toolContext.groupAuthorization)
                        throw new RpcError(-32602, "Group identity changed");
                      if (!current) throw new RpcError(-32602, "Group context unavailable");
                      return {
                        ...current,
                        execution: [
                          runStateFacts(local, toolContext),
                          local.execution.prompt(toolContext),
                        ]
                          .filter(Boolean)
                          .join("\n\n"),
                        connectionStatus: connectionStatus(),
                        availableSecrets: local.userSecrets.prompt(bot.id),
                        ...(workplace ? { workplace } : {}),
                        ...(projectNotes &&
                        runPermissions(local, toolContext).levels.read_file !== "never"
                          ? { projectNotes }
                          : {}),
                        ...(run.resume ? { runResume: run.resume.note } : {}),
                        group: current.group && {
                          ...current.group,
                          workplace: groupSnapshot?.group?.workplace,
                        },
                      };
                    },
                  }
                : {
                    refresh: async (signal: AbortSignal) => {
                      signal.throwIfAborted();
                      if (routineReferenceId) {
                        const actual = conversations.get(conversationId);
                        if (
                          actual?.kind !== "dm" ||
                          actual.botId !== bot.id ||
                          actual.routineId !== routineReferenceId ||
                          actual.archivedAt
                        )
                          throw new RpcError(-32602, "Conversation identity changed");
                      }
                      return {
                        ...(routineReference ? { routineTopicReference: routineReference } : {}),
                        memory: resourceGroupId
                          ? local.groupMemory.prompt(resourceGroupId, bot.id, {
                              query: memoryQuery,
                              signal,
                              project: memoryProjectPath(toolContext),
                              onUsed: rememberUsed,
                            })
                          : local.memory.prompt(bot.id, {
                              query: memoryQuery,
                              signal,
                              project: memoryProjectPath(toolContext),
                              onUsed: rememberUsed,
                            }),
                        execution: [
                          runStateFacts(local, toolContext),
                          local.execution.prompt(toolContext),
                        ]
                          .filter(Boolean)
                          .join("\n\n"),
                        connectionStatus: connectionStatus(),
                        availableSecrets: local.userSecrets.prompt(bot.id),
                        ...(workplace ? { workplace } : {}),
                        ...(projectNotes &&
                        runPermissions(local, toolContext).levels.read_file !== "never"
                          ? { projectNotes }
                          : {}),
                        ...(run.routine?.resumeFacts
                          ? { routineResume: run.routine.resumeFacts }
                          : {}),
                        ...(run.resume ? { runResume: run.resume.note } : {}),
                        ...(run.routine?.ledger ? { routineLedger: run.routine.ledger } : {}),
                        ...(run.routine?.summary ? { routineSummary: run.routine.summary } : {}),
                      };
                    },
                  }),
              redact: (text: string) => deps.redactor.redact(text),
            },
          }
        : {}),
    });
    // Setup also owns SDK listeners and JSONL: retain the Bot lock until it really settles.
    run.session = await opening;
    run.signal.throwIfAborted();
    if (run.routine || taskSession) {
      /* Run-owned sessions never replace ordinary topic follow-up sessions. */
    } else if (run.groupId)
      new BotSessionsRepo(deps.db).set(bot.id, conversationId, run.session.sessionFile);
    else conversations.update(conversationId, { piSessionFile: run.session.sessionFile });
    runs.session(run.runId, run.session.sessionFile);
    if (run.aborted) throw new AgentError("aborted");
    timer = setInterval(() => {
      try {
        replies.checkpoint();
      } catch {
        deps.logger.error("Chat checkpoint failed");
        run.aborted = true;
        abortRun(run, { code: "checkpoint_failed" });
        if (run.session) {
          run.aborting ??= run.session.abort();
          void run.aborting.catch(() => deps.logger.warn("Session abort failed"));
        }
      }
    }, 500);
    deps.logger.info(
      JSON.stringify({
        module: "chat",
        event: "send",
        audit: true,
        botId: run.botId,
        runId: run.runId,
        imageCount: images.length,
        // Which model ran: retros could not tell which provider/model a run used.
        ...(run.session?.model ? { model: run.session.model } : {}),
      }),
    );
    const session = run.session;
    const onEvent = (event: SessionEvent) => {
      if (event.type === "reconnect") {
        deps.logger.info(
          JSON.stringify({
            module: "chat",
            event: "model_reconnect",
            audit: true,
            botId: run.botId,
            runId: run.runId,
            phase: event.phase,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            ...(event.phase === "start"
              ? { delayMs: event.delayMs, reason: event.reason, status: event.status }
              : { outcome: event.outcome }),
          }),
        );
        if (run.aborted || run.signal.aborted) return;
        if (!run.executionTaskId)
          deps.peer.emit("chat.status", {
            ...route,
            runId: run.runId,
            messageId: run.messageId,
            state: "running",
            reconnecting:
              event.phase === "start"
                ? { attempt: event.attempt, maxAttempts: event.maxAttempts }
                : null,
          });
        return;
      }
      // A stopped run still owes the renderer its transient-state clear.
      if (event.type === "activity" && event.activity.phase === "clear") {
        replies.event(event);
        return;
      }
      if (run.aborted || run.signal.aborted) return;
      replies.event(event);
    };
    type PromptValue = Awaited<ReturnType<BotSession["prompt"]>>;
    let outputContinuations = 0;
    let connectionContinuations = 0;
    /**
     * One model request with the program's checks, plus — when the cap cut the answer — up to
     * two continuations inside the same reply. The run keeps its budget and permissions; only
     * the receipt counts how often this happened.
     */
    const ask = async (next: string, withImages?: ImageContent[]): Promise<PromptValue> => {
      let value = await session.prompt(deps.redactor.redact(next), onEvent, withImages);
      replies.flush();
      for (;;) {
        if (run.approvalPause || run.aborted || value.stopReason === "aborted")
          throw new AgentError("aborted");
        assertComputerProgress(toolContext);
        if (value.stopReason === "error") throw new AgentError("provider_error");
        if (value.stopReason === "length" && value.interrupted && !run.signal.aborted) {
          if (connectionContinuations >= CONNECTION_CONTINUATION_LIMIT)
            throw new AgentError("network");
          connectionContinuations += 1;
          deps.logger.info(
            JSON.stringify({
              module: "chat",
              event: "connection_continuation",
              audit: true,
              botId: run.botId,
              runId: run.runId,
              attempt: connectionContinuations,
            }),
          );
          replies.continueSameReply();
          value = await session.prompt(deps.redactor.redact(connectionContinuation()), onEvent);
          replies.flush();
          continue;
        }
        if (
          value.stopReason !== "length" ||
          run.signal.aborted ||
          outputContinuations >= OUTPUT_CONTINUATION_LIMIT
        )
          return value;
        outputContinuations += 1;
        deps.logger.info(
          JSON.stringify({
            module: "chat",
            event: "output_continuation",
            audit: true,
            botId: run.botId,
            runId: run.runId,
            attempt: outputContinuations,
            repeatedThinking: value.repeatedThinking === true,
          }),
        );
        // Same reply, not a new one: the user reads one answer that was cut and continued.
        replies.continueSameReply();
        value = await session.prompt(
          deps.redactor.redact(outputLimitContinuation(value.repeatedThinking === true)),
          onEvent,
        );
        replies.flush();
      }
    };
    let result = await ask(text, images);
    if (tools && deps.local) {
      const local = deps.local;
      // Markup in the reply is not a tool call. Ask once for the real call before the
      // text is treated as the answer; a tool that really ran alongside the markup is untouched.
      const marker =
        result.stopReason === "stop"
          ? textToolCallMarker(result.finalText ?? replies.content, [
              ...local.toolDefinitions.map((tool) => tool.name),
              ...Object.keys(local.deps.capabilityTools.specs),
            ])
          : null;
      if (marker && !result.calledTools?.includes(marker)) {
        deps.logger.info(
          JSON.stringify({
            module: "chat",
            event: "text_tool_call",
            audit: true,
            botId: run.botId,
            runId: run.runId,
            tool: marker,
          }),
        );
        replies.segment();
        result = await ask(textToolCallCorrection(marker));
      }
      // The delivery rule asks for a file, but a long document-shaped reply can still be
      // the whole answer. One fixed reminder, once per run, only when no write really succeeded.
      if (
        deliveryOnlyInReply({
          stopReason: result.stopReason,
          reply: result.finalText ?? replies.content,
          wroteFiles: tools.successfulFileWrites(),
          hasWorkplace: !!toolContext.runWorkplace?.cwd,
          inGroup: !!run.groupId,
          userText: text,
          writeFileNever: runPermissions(local, toolContext).levels.write_file === "never",
        })
      ) {
        deps.logger.info(
          JSON.stringify({
            module: "chat",
            event: "delivery_in_reply",
            audit: true,
            botId: run.botId,
            runId: run.runId,
          }),
        );
        replies.segment();
        result = await ask(deliveryFileReminder());
      }
      // A completed turn that showed nothing: no text and no tool call (a card, a pause or a file
      // is a tool call, so those never count). Ask once through the same channel.
      if (
        result.stopReason === "stop" &&
        !(result.finalText ?? replies.content).trim() &&
        !replies.content.trim() &&
        tools.modelToolCalls() === 0
      ) {
        deps.logger.info(
          JSON.stringify({
            module: "chat",
            event: "empty_reply",
            audit: true,
            botId: run.botId,
            runId: run.runId,
          }),
        );
        replies.segment();
        result = await ask(emptyReplyReminder());
      }
      const prompt = async (next: string) => {
        replies.segment();
        return ask(next);
      };
      const driver = new TodoFollowThrough({
        local: deps.local,
        run,
        context: toolContext,
        toolGroups: () => tools?.toolGroups() ?? { active: [], available: [] },
        toolCalls: () => tools?.modelToolCalls() ?? 0,
        replyText: () => replies.content,
      });
      let firstCheck = true;
      let checkedChanges = -1;
      let checkHalted = false;
      delivery =
        local.collaboration?.deliveryRun?.(toolContext, run.workflow) ??
        (run.workflow && workflowPlace
          ? new DeliveryRun({
              sources: () =>
                deliverySources(
                  deps.db,
                  run.runId,
                  run.workflow?.inputs,
                  local.collaboration?.deliveryProvenance?.(run.runId),
                  toolContext.runWorkplace?.cwd,
                  toolContext.runWorkplace
                    ? workspaceFiles(local, toolContext.runWorkplace.boundary)
                    : undefined,
                ),
              workflow: run.workflow,
              folder: workflowPlace.folder,
              office: () => local.officeProvider,
              language: deps.language(),
              signal: run.signal,
              logger: deps.logger,
              runId: run.runId,
              botId: run.botId,
            })
          : roleDeliveryRun(local, toolContext, bot, text));
      const calledTools = new Set(result.calledTools ?? []);
      for (;;) {
        if (deps.local.background.waitingRun(run.runId)) break;
        if (
          toolContext.todoRun?.paused?.question &&
          local.collaboration?.deliveryProvenance?.(run.runId)
        ) {
          // A plan step's question is not a failed delivery; wait for its answer before checking.
          delivery = undefined;
          break;
        }
        // Check every code-changing pass once; no new SDK owner, locks or budget are created.
        const check = new AutoCheckRun({
          local: deps.local,
          run,
          context: toolContext,
          tools,
          replies,
          language: deps.language(),
          prompt,
        });
        const changes = toolContext.todoRun?.codeChanges ?? 0;
        if (checkedChanges !== changes) {
          result = await check.drive(result, firstCheck);
          checkedChanges = toolContext.todoRun?.codeChanges ?? 0;
        }
        for (const tool of result.calledTools ?? []) calledTools.add(tool);
        firstCheck = false;
        checkHalted = check.halted;
        if (check.halted || run.aborted || result.stopReason !== "stop") {
          if (check.halted && toolContext.todoRun?.armed) {
            toolContext.todoRun.paused = { reason: "check_blocked", summary: "" };
            deps.local.noteParentContinuation(toolContext);
          }
          break;
        }
        // Once nothing else follows, the delivery check may send one fix round back.
        // Not while this run's hand-offs are out; the sign-off run checks instead.
        const next =
          driver.next(result) ??
          (toolContext.workflowPipeline?.assigned ? undefined : await delivery?.next());
        if (!next) break;
        result = await prompt(next);
      }
      // Once per turn, after a normal end that changed files, the reviewer looks at it.
      // Review children (execution tasks) and groups never ask; the coordinator dispatches there.
      if (
        bot.autoReview &&
        !run.groupId &&
        !run.executionTaskId &&
        !run.aborted &&
        !checkHalted &&
        result.stopReason === "stop" &&
        !toolContext.todoRun?.paused &&
        !deps.local.background.waitingRun(run.runId) &&
        !calledTools.has("review_start") &&
        (tools?.successfulFileWrites() || (toolContext.todoRun?.codeChanges ?? 0) > 0)
      ) {
        deps.logger.info(
          JSON.stringify({
            module: "chat",
            event: "auto_review",
            audit: true,
            botId: run.botId,
            runId: run.runId,
          }),
        );
        result = await prompt(autoReviewPrompt());
        for (const tool of result.calledTools ?? []) calledTools.add(tool);
      }
      const review = workQualityReceipt(toolContext.quality);
      result = {
        ...result,
        calledTools: [...calledTools],
        ...(review
          ? {
              usage: {
                ...(result.usage && typeof result.usage === "object" && !Array.isArray(result.usage)
                  ? result.usage
                  : { usage: result.usage ?? null }),
                workQuality: review,
              },
            }
          : {}),
      };
      // Final state of this run, including pauses raised by tool boundaries (browser takeover).
      deps.local.noteParentContinuation(toolContext);
      if (toolContext.todoRun?.paused) replies.pause(toolContext.todoRun.paused);
      if (
        deps.local.tasks.isContinuation(run.runId) &&
        deps.local.execution.mode(toolContext) === "plan"
      )
        replies.pause({ reason: "review_summary", summary: "" });
    }
    // Recorded before finishing; a failed delivery keeps every artifact and the reply as they are.
    const deliveryRecord = toolContext.workflowPipeline?.assigned
      ? undefined
      : await delivery?.record();
    // Also a reply cut by length or a provider error that came back as a result, not a throw.
    const delivered = run.signal.aborted
      ? undefined
      : await deliverOutputs(
          result.finalText ?? replies.content,
          run.signal,
          result.stopReason === "stop" &&
            deliveryRecord?.status === "passed" &&
            run.workflow &&
            workflowPlace
            ? run.workflow.contract.deliverables.map((item) =>
                join(workflowPlace?.folder ?? "", item.path),
              )
            : [],
        );
    toolContext.assistantReply = tools?.reply();
    const modelToolCalls = tools?.modelToolCalls() ?? result.calledTools?.length ?? 0;
    const zeroToolPromise =
      result.stopReason === "stop" &&
      promisedWithoutTools(result.finalText ?? replies.content, modelToolCalls);
    if (zeroToolPromise && !toolContext.todoRun?.paused)
      replies.pause({
        reason: "blocked",
        summary: "",
        observation: "promised_without_tools",
      });
    tools?.finish();
    publishRunActivity(toolContext.messageId, { phase: "clear" });
    const usage = MessageSchema.shape.usage.parse(redactValue(result.usage ?? null, deps.redactor));
    const finalReply = result.finalText?.trim()
      ? result.finalText
      : (toolContext.assistantReply ?? result.finalText ?? replies.content);
    const replyCitations =
      run.groupId &&
      !run.workflow &&
      result.stopReason === "stop" &&
      ["researcher", "data-analyst"].includes(bot.role?.id ?? "") &&
      !deps.local?.collaboration?.deliveryProvenance?.(run.runId)
        ? await checkReplyCitations(
            [finalReply, new MessagesRepo(deps.db).get(run.messageId)?.content ?? ""],
            deliverySources(deps.db, run.runId),
            run.signal,
          )
        : undefined;
    // The original schema has no stop_reason column; preserve it with the usage JSON.
    const truncated = result.stopReason === "length";
    let updates: Message[] = [];
    const completed = transaction(deps.db, () => {
      if (zeroToolPromise)
        new RunEventsRepo(deps.db).append({
          runId: run.runId,
          conversationId,
          kind: "run.execution_observation",
          payload: { code: "promised_without_tools", toolCalls: 0 },
        });
      const groupExecution =
        result.stopReason === "stop"
          ? deps.local?.collaboration?.groupExecution?.(toolContext)
          : undefined;
      updates = replies.finish(
        truncated ? "error" : "done",
        {
          ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : { usage }),
          ...(outputContinuations ? { outputContinuations } : {}),
          ...runModel(bot, run.session),
          ...(usedMemoryIds.size ? { memoryIds: [...usedMemoryIds].slice(0, 200) } : {}),
          ...(replyCitations ? { replyCitations } : {}),
          ...planAtEnd(deps.db, run, result.calledTools),
          ...(deliveryRecord ? { delivery: deliveryRecord } : {}),
          ...(delivered?.overflow ? { attachmentOverflow: delivered.overflow } : {}),
          ...(groupExecution ? { groupExecution } : {}),
          stopReason: deps.redactor.redact(result.stopReason),
          ...(zeroToolPromise
            ? { executionObservation: { code: "promised_without_tools", toolCalls: 0 } }
            : {}),
          ...(run.routine ? { finalReply: deps.redactor.redact(finalReply) } : {}),
          ...(run.threadId && result.stopReason === "stop"
            ? {
                taskReply: deps.redactor
                  .redact(finalReply)
                  .slice(0, 100_000)
                  .replace(/[\uD800-\uDBFF]$/u, ""),
              }
            : {}),
        },
        truncated ? "output_limit" : undefined,
        result.stopReason === "stop" || result.stopReason === "toolUse",
      );
      runs.finish(
        run.runId,
        truncated ? "error" : "done",
        deps.redactor.redact(result.stopReason),
        truncated ? "output_limit" : undefined,
      );
      return truncated
        ? undefined
        : deps.local?.background.waitingRun(run.runId)
          ? undefined
          : deps.local?.collaboration?.completeRun?.(
              toolContext,
              deps.redactor.redact(result.finalText ?? replies.content),
              result.stopReason,
              result.calledTools,
            );
    });
    replies.publishUpdates(updates);
    deps.peer.emit("inbox.changed", {});
    completed?.();
    if (!run.executionTaskId && truncated)
      deps.peer.emit("chat.error", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        code: "output_limit",
        message: "output_limit",
      });
    else if (!run.executionTaskId)
      deps.peer.emit("chat.done", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        ...(usage === null ? {} : { usage }),
        stopReason: result.stopReason,
      });
    if (truncated) deps.logger.warn(`Chat output limit ${run.runId}`);
    else deps.logger.info(`Chat done ${run.runId}`);
  } catch (error) {
    if (run.parking) return;
    if (run.approvalPause) {
      abortRun(run, { code: "approval_paused" });
      replies.flush();
      const updates = transaction(deps.db, () => {
        replies.pause({ reason: "approval", summary: "" });
        const updates = replies.finish(
          "aborted",
          { stopReason: "approval_paused", ...runModel(bot, run.session) },
          undefined,
          false,
        );
        runs.finish(run.runId, "aborted", "approval_paused", null);
        return updates;
      });
      replies.publishUpdates(updates);
      deps.peer.emit("chat.done", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        stopReason: "approval_paused",
        usage: updates.find((message) => message.id === run.messageId)?.usage ?? null,
      });
      return;
    }
    const cancelled = run.aborted || run.signal.aborted;
    const questionPause = questionEnded ? toolContext.todoRun?.paused : undefined;
    if ((stalledCompaction || questionPause) && !cancelled) {
      replies.flush();
      let pause = questionPause;
      if (!pause) {
        abortRun(run, { code: "compaction_no_progress" });
        const reading = deps.redactor
          .redact((toolContext.compactionProgress?.reads ?? []).join(", "))
          .slice(0, 300);
        pause = {
          reason: "blocked",
          summary:
            deps.language() === "zh"
              ? `已暂停：连续压缩 3 次，期间没有成功写文件或推进 TODO。正在读取：${reading || "文件与工具结果"}。请缩小任务或指定需要的片段。`
              : `Paused after 3 consecutive compactions without a successful file write or TODO progress. Reading: ${reading || "files and tool results"}. Narrow the task or select the needed excerpts.`,
        };
        if (toolContext.todoRun) toolContext.todoRun.paused = pause;
      } else
        deps.logger.info(
          JSON.stringify({
            module: "chat",
            event: "question_turn_ended",
            botId: run.botId,
            runId: run.runId,
            calls: toolContext.todoRun?.afterQuestionCalls ?? 0,
          }),
        );
      deps.local?.noteParentContinuation(toolContext);
      replies.pause(pause);
      tools?.finish();
      const updates = transaction(deps.db, () => {
        const updates = replies.finish("done", {
          stopReason: "stop",
          ...runModel(bot, run.session),
        });
        runs.finish(run.runId, "done", "stop");
        return updates;
      });
      replies.publishUpdates(updates);
      if (!run.executionTaskId)
        deps.peer.emit("chat.done", {
          ...route,
          runId: run.runId,
          messageId: run.messageId,
          stopReason: "stop",
        });
      return;
    }
    try {
      tools?.finish();
    } catch {
      deps.logger.error("Tool finalization failed");
    }
    const budgetReason = deps.local?.budgets.repo.get(
      run.budgetRootRunId ?? run.runId,
    )?.exhaustedReason;
    abortRun(run, {
      code:
        budgetReason === "repeated_operation"
          ? "repeated_operation"
          : budgetReason
            ? "budget_exhausted"
            : "error",
    });
    const actualError = mapAgentError(error);
    const code =
      !cancelled && actualError === "permission_denied"
        ? "permission_denied"
        : budgetReason === "repeated_operation"
          ? "repeated_operation"
          : budgetReason
            ? "budget_exhausted"
            : cancelled
              ? "aborted"
              : mapAgentError(error);
    const providerError =
      error instanceof AgentError && error.code === code && code !== "aborted" ? error : undefined;
    const status = providerError?.httpStatus;
    const detail = providerError?.providerDetail;
    // The run's own signal may be the reason it ended; delivery gets a short one of its own.
    const delivered = await deliverOutputs(
      replies.content,
      AbortSignal.any([
        ...(deps.local ? [deps.local.shutdown.signal] : []),
        AbortSignal.timeout(15_000),
      ]),
    );
    replies.flush();
    const updates = transaction(deps.db, () => {
      const updates = replies.finish(
        code === "aborted" ? "aborted" : "error",
        {
          stopReason: code === "aborted" ? "aborted" : "error",
          ...runModel(bot, run.session),
          ...(delivered?.overflow ? { attachmentOverflow: delivered.overflow } : {}),
          ...(status || detail
            ? { providerFailure: { ...(status && { status }), ...(detail && { detail }) } }
            : {}),
        },
        code,
      );
      runs.finish(
        run.runId,
        code === "aborted" ? "aborted" : "error",
        code === "aborted" ? "aborted" : "error",
        code,
      );
      return updates;
    });
    replies.publishUpdates(updates);
    if (!run.executionTaskId)
      deps.peer.emit("chat.error", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        code,
        message: code,
      });
    deps.logger.warn(
      // The budget's own reason (which limit) — one run stopped at 220 tools / 128 requests,
      // under both default limits, and the log could not say why.
      `Chat ${run.runId} ${code}${status ? ` status=${status}` : ""}${budgetReason ? ` budget=${budgetReason}` : ""} model=${bot.modelProvider ?? "?"}/${bot.modelId ?? "?"}`,
    );
  } finally {
    deps.local?.background.continuation.releaseProjection(run.runId);
    clearInterval(timer);
    replies.interruptAdditions();
    abortRun(run, run.stopCause ?? { code: "completed" });
    try {
      tools?.finish();
    } catch {
      deps.logger.error("Tool finalization failed");
    }
    if (run.session && run.signal.aborted) {
      const session = run.session;
      run.aborting ??= session.abort();
      // A rejected abort means either "the request already died" or "the SDK is stuck". Only the
      // session can tell those apart by reporting idle, and certifying idle from the session keeps a
      // failed network request from becoming the permanent "drain failed" isolation. A
      // session without that probe offers nothing to certify with, so the old behaviour stands: the
      // abort error propagates and the run stays isolated.
      const confirmDrain = async () => {
        try {
          await run.aborting;
        } catch (error) {
          if (!session.waitForIdle) throw error;
          await abortable(
            session.waitForIdle(),
            AbortSignal.timeout(DRAIN_CERTIFY_TIMEOUT_MS),
          ).catch(() => {
            // Unconfirmable idle must stay isolated: propagation is what marks the drain failed.
            deps.logger.warn(`SDK idle unconfirmed ${run.runId}`);
            throw new Error("session_drain_unconfirmed");
          });
        }
      };
      await confirmDrain();
    }
    try {
      if (run.session)
        await recordSessionTail(deps.db, deps.dataDir, deps.logger, {
          runId: run.runId,
          botId: run.botId,
          conversationId: run.conversationId,
          sessionFile: run.session.sessionFile,
        });
    } finally {
      try {
        run.session?.dispose();
      } catch {
        deps.logger.warn("Session disposal failed");
      }
      deps.finished(run);
      deps.local?.budgets.end(toolContext);
      void deps.local?.logs.prune(run.botId);
    }
  }
}
