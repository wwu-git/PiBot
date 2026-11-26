// Define the dependencies and scopes of local brain services.
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentRuntime,
  LocalToolCall,
  LocalToolResult,
  ModelRequestMetrics,
  PromptContext,
} from "@pibot/agent";
import type { AliasFileSystem, ExecutionTarget, fetchPage, NetworkProxy } from "@pibot/execution";
import type { Logger } from "@pibot/observability";
import type { PolicyResult } from "@pibot/policy";
import type {
  AuditDetail,
  CapabilityToolRegistry,
  EventTable,
  MethodTable,
  ModelInfo,
  Peer,
  PermissionsSettings,
  ResolvedWorkplace,
  TopicWorkplaceSnapshot,
  WorkspaceSnapshot,
} from "@pibot/protocol-base";
import type { ImageDownload } from "../conversations/attachments/external-images.ts";
import type { BrainHost } from "../index.ts";
import type { SearchRecipient, SearchService } from "../integrations/search/search-service.ts";
import type { ToolInput } from "../runtime/tools/tools.ts";
import type { BrainRedactor } from "./privacy.ts";

export interface ToolRunContext {
  /** Kernel-issued, single-call project change; never parsed from tool or RPC arguments. */
  projectNotesChange?: Readonly<{
    callId: string;
    workplace: ResolvedWorkplace;
    diff: string;
    /** `null`: the reviewed change creates AGENTS.md, so the file must still be missing. */
    expectedHash: string | null;
    assertSource?(signal: AbortSignal): Promise<void>;
    assertCurrent?(): void;
  }>;
  /** Committed delivery paths for this run; never populated from model claims. */
  sentFilePaths?: Set<string>;
  /** Render delegated approval cards in the delegating topic. */
  approvalCardContext?: ToolRunContext;
  endpointPhoneId?: string;
  /** The external agent's real HOME; its delegated requests expand `~` to it. */
  delegatedHome?: string;
  /** Live reply text before throttled persistence; can only tighten plan confirmation. */
  currentReplyText?(): string;
  /** Actual session model capability, set before registering its tools; unknown is not image-capable. */
  modelAcceptsImages?: boolean;
  /** Output budget used to size recovery guidance after a truncated tool call. */
  modelMaxTokens?: number;
  /** This run's request/hand-off, before old task results or checkpoints are appended. */
  memoryQuery?: string;
  /** Shared, monotonic runtime evidence, never accepted from model arguments. */
  untrustedContent?: { seen: boolean };
  toolTiming?: (callId: string) => import("@pibot/protocol-base").ToolTiming | undefined;
  /** Sandbox blocks this run hit; set by LocalRun, lives as long as the run. */
  sandboxBlocks?: import("../runtime/tools/outside-sandbox.ts").SandboxBlockRegistry;
  pdfBatch?: { admitted: Set<string>; read: Set<string>; total: number };
  /** Model runs resolve this once; non-model boundary contexts may omit it. */
  capabilities?: ReadonlyMap<
    import("@pibot/protocol-base").CapabilityId,
    import("@pibot/protocol-base").CapabilityImpl
  >;
  quality?: import("../runtime/review/work-quality-run.ts").WorkQualityFacts;
  /** Shared by context copies; only terminal host errors set these per-run retry boundaries. */
  browserFailures?: {
    takeover?: boolean;
    screenshot?: boolean;
    /** Model screenshots that got no picture this turn; the second sets `screenshot`. */
    screenshotMisses?: number;
    /** A step thumbnail got no picture; later actions skip theirs. */
    stepPictures?: boolean;
    /** Acceptance: a screenshot was looked at this turn (visual deliverables). */
    screenshotTaken?: boolean;
    /** The one "look at it before sending" reminder of this turn was given. */
    visualReminded?: boolean;
  };
  /** Server-issued SCM review intent; never parsed from model tool arguments. */
  worktreeReview?: import("../runtime/workspaces/types.ts").WorktreeReceipt;
  /** Applied compactions since a confirmed write or TODO completion, with locations only. */
  compactionProgress?: { count: number; reads: string[] };
  /** Per-run notice budget; cross-run circuit metadata belongs to CodeNavigationService. */
  editDiagnostics?: import("../runtime/review/post-edit-diagnostics.ts").EditDiagnosticsState;
  /** Run-owned repeated read-only command answers; a cached answer never leaves the run. */
  repeatedCommands?: Map<
    string,
    import("../runtime/tools/local-run/repeated-command.ts").RepeatedCommand
  >;
  /** Run-owned count of unchanged reads per file range; it never leaves the run. */
  repeatedReads?: Map<string, import("../runtime/tools/local-run/repeated-read.ts").RepeatedRead>;
  /** Run-owned semantic snapshot bytes, keyed by root and capture scope. */
  semanticFileCaches?: Map<string, import("@pibot/execution/semantic").SemanticFileCache>;
  /** Per-run intent only: reading an old plan must never start unattended work. */
  todoRun?: {
    armed: boolean;
    completedTask?: boolean;
    planVersion?: number;
    paused?: {
      reason: string;
      summary: string;
      groupPlanId?: string;
      stall?: import("@pibot/protocol-base").ExecutionStall;
      question?: import("@pibot/protocol-base").UserQuestion;
    };
    progress: Set<string>;
    codeChanges: number;
    /**
     * Tool calls made after this run's choice card was submitted. The card already ended the
     * turn's work; chat-run ends the run itself once the model keeps calling tools anyway.
     */
    afterQuestionCalls?: number;
  };
  /**
   * The plan this run inherited. A member answering in a group chat may advance that plan
   * without doing plan work, so only the difference from what it saw counts as starting one.
   */
  planAtStart?: { goal: string; version: number };
  /**
   * The workflow this run executes, as a group hand-off carries it to the sign-off run.
   * `assigned` (shared by context copies) marks a structured hand-off queued in this run: its
   * own delivery check then waits for the sign-off run that has the members' results.
   */
  workflowPipeline?: {
    pipeline: import("@pibot/protocol-base").HandoffPipeline;
    assigned: boolean;
  };
  /** Trusted task/queue metadata, never accepted from a model's tool arguments. */
  executionTaskId?: string;
  permissionGroupId?: string;
  budgetRootRunId?: string;
  pauseForApproval?: (approvalId: string) => void;
  executionClock?: { pause(reason: string): void; resume(reason: string): void };
  /** Run-owned: tools and post-tool checks share committed updates, never refresh from live state. */
  topicWorkplace?: TopicWorkplaceSnapshot;
  runWorkplace?: { cwd: string; boundary: WorkspaceSnapshot };
  /** Frozen together with the execution adapter, never sourced from model arguments. */
  executionDevice?: { target: string; name: string };
  // Volatile evidence of scoped image_result reads in this run; restored JSONL never grants access.
  imageResultSources?: Set<string>;
  // Element id → "role name" from the run's latest ui_tree, only for step descriptions.
  computerElements?: Map<string, string>;
  // The run's latest screenshots by screenshotId, attached to pointer steps on them.
  computerShots?: Map<string, import("@pibot/protocol-base").ImageContent>;
  // The run's current streak of identical computer-tool failures (computer-retry-guard.ts).
  // `handedOff` once a "come help" card was shown for the streak (one card per streak).
  computerFailures?: { key: string; code: string; count: number; handedOff?: boolean };
  /** Run-owned progress, independent of successful read-only observations and retry cards. */
  computerProgress?: {
    reads: number;
    readsAfterFailure: number;
    failures: number;
    stopped?: boolean;
    lastTool?: string;
  };
  // Cards the user declined or let time out in this run (computer-handoff.ts declinedKey).
  computerHandoffDeclined?: Set<string>;
  interactiveChat?: true;
  routineRunId?: string;
  /**
   * The interrupted run this one resumes. Replay detection then pairs the n-th identical
   * call with the n-th of the earlier runs of the same root (`ToolJournal.scope`).
   */
  resumedFromRunId?: string;
  routineResume?: {
    operationHash: string;
    status: "allowed" | "denied" | "expired";
    consumed?: boolean;
  };
  routineApprovalWaitMs?: number;
  routineSource?: "routine" | "trial";
  /**
   * An external agent's turn. Its audit rows (its own permission asks and the Pi Bot tools it
   * called through the bridge) say so instead of "chat"; nothing else changes.
   */
  auditSource?: "external_agent";
  routineName?: string;
  routineClock?: import("../runtime/unattended/clock.ts").RoutineClock;
  routineWorkplace?: {
    kind?: "bot" | "folder";
    folderId?: string;
    /** The routine's read-only references plus the folders its triggers watch. */
    readonly?: string[];
    /** Migration 0027: the read-only folder (or `home`) commands started in before per-topic folders. */
    cwd?: string;
    temporaryRoots?: { id: string; path: string }[];
  };
  /**
   * Folders the user picked as a workflow's inputs in the run form (owner
   * 2026-10-22): read-only for this run only, so reading them asks no second approval.
   */
  workflowReadRoots?: { id: string; path: string }[];
  /**
   * A folder outside the workplace the user allowed once in this run (read or list); later
   * calls in the same run are allowed by policy as `run_grant_matched`. In memory, never stored.
   */
  runGrants?: import("@pibot/protocol-base").Grant[];
  /** This run executes a workflow skill, so `task_spawn` may choose a `cheap` child. */
  workflowSkillId?: string;
  isParking?: () => boolean;
  botId: string;
  runId: string;
  messageId: string;
  conversationId?: string;
  groupId?: string;
  threadId?: string;
  groupAuthorization?: string;
  groupMemberWorktreeId?: string;
  cycleId?: string;
  taskId?: string;
  assistantReply?: string;
  /** Transient UI-only progress; the run owner throttles and clears it, never stores or audits it. */
  runActivity?: (
    messageId: string,
    activity:
      | { phase: "waiting_model" }
      | { phase: "executing_tool"; tool: string }
      | { phase: "clear" },
  ) => void;
  signal: AbortSignal;
  language: "zh" | "en";
}
export interface CollaborationPort {
  /** Bounded, redacted context for an external-agent group step. */
  agentStepBrief?(context: ToolRunContext, signal: AbortSignal): Promise<string | undefined>;
  /** Live persisted group task/plan identity; absent once its authority has ended. */
  publicWebTaskScope?(context: ToolRunContext): string | undefined;
  guardTool?(context: ToolRunContext, tool: string): void;
  planInputFailure?(
    context: ToolRunContext,
    call: LocalToolCall,
    failure: LocalToolResult,
  ): LocalToolResult;
  answerPlanLimit?(
    messageId: string,
    reply: import("@pibot/protocol-base").KernelMethodParams["execution.question.answer"]["reply"],
    signal: AbortSignal,
  ): Promise<boolean>;

  /** L4 owns plan recovery; the ticket is rechecked inside the existing resume transaction. */
  planBudgetResume?(runId: string):
    | {
        redirect?: { botId: string; conversationId: string; runId: string };
        resumedRunId?: string;
        /** Before admission there is only a card: increase its root without running a model. */
        budgetOnly?: { prepare(signal: AbortSignal): Promise<void> };
        assertCurrent(): void;
        inserted(runId: string): void;
      }
    | undefined;
  /** Snapshot for a coordinator's final reply; the orchestrator owns plan interpretation. */
  groupExecution?(
    context: ToolRunContext,
  ): import("@pibot/protocol-base").GroupExecutionReceipt | undefined;
  admitPdf?(context: ToolRunContext, path: string): boolean;
  /** The orchestrator's vouched sources for a run's delivery (plan steps, inputs). */
  deliveryProvenance?(
    runId: string,
    taskId?: string,
  ): import("../runtime/workflows/delivery-sources.ts").DeliveryProvenance | undefined;
  /** L4 supplies the task's durable handoff contract; L3 owns its existing correction loop. */
  deliveryRun?(
    context: ToolRunContext,
    workflow?: import("../runtime/workflows/workflow-prepare.ts").WorkflowRun,
  ): import("../runtime/workflows/delivery-run.ts").DeliveryRun | undefined;
  /** Only user-requested names vouched for by the run's persisted plan/task association. */
  deliveryOutputNames?(runId: string): readonly string[];
  /**
   * The coordinator's solo run (no plan, no delegation in its cycle): the members' method
   * contracts its outputs are checked against. Undefined when the run is not solo work.
   */
  soloDelivery?(
    context: ToolRunContext,
    signal: AbortSignal,
  ): Promise<
    | {
        methods: readonly Pick<
          import("@pibot/protocol-base").SkillContract,
          "deliverables" | "acceptance"
        >[];
      }
    | undefined
  >;
  observePdf?(
    context: ToolRunContext,
    progress: NonNullable<AuditDetail["pdfProgress"]>,
    path: string,
    readable: boolean,
  ): void;
  workplaceGroup?(context: ToolRunContext): import("@pibot/protocol-base").Group | undefined;
  workplace?(context: ToolRunContext, signal: AbortSignal): Promise<ResolvedWorkplace>;
  completeRun?(
    context: ToolRunContext,
    finalText: string,
    stopReason: string,
    calledTools?: readonly string[],
  ): (() => void) | undefined;
  validate(context: ToolRunContext, input: ToolInput): void;
  execute(
    context: ToolRunContext,
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<LocalToolResult>;
  prepare(context: ToolRunContext, signal: AbortSignal): Promise<PromptContext>;
  refresh(
    context: ToolRunContext,
    signal: AbortSignal,
    model: Pick<ModelInfo, "input">,
  ): Promise<PromptContext>;
}
export interface LocalDependencies {
  modelRequest?(runId: string, request: ModelRequestMetrics): void;
  /** L4 orchestration is composed outside the L3 kernel; the kernel only owns this factory port. */
  orchestration: import("./orchestration.ts").OrchestrationFactory;
  aliasFileSystem?: AliasFileSystem;
  /** Product-composed execution adapter; absence preserves the local target byte-for-byte. */
  executionTarget?: ExecutionTarget;
  executionLocation?: {
    target: import("@pibot/protocol-base").ExecutionLocationTarget;
    platform: "darwin" | "linux" | "win32";
  };
  /** Injected selection port. */
  capabilityResolver?: import("./capability-resolver.ts").CapabilityResolver;
  /** Product-composed declarations; executors still register through the capability context. */
  capabilityTools: CapabilityToolRegistry;
  /**
   * Tools the model must not be offered (evaluation only). This removes a name from the
   * tool list; it never grants anything, and every remaining tool is still decided by policy.
   */
  hiddenTools?: readonly string[];
  /** Code extensions, proposal wait and per-command timeout of the automatic check. */
  autoCheck?: import("../runtime/checks/auto-check.ts").AutoCheckOptions;
  /** Replaces the 10 min / routine wait of "come help" cards (probes only). */
  computerHandoffWaitMs?: number;
  downloadImage?: ImageDownload;
  /** The agent port that lets the auxiliary model read a fetched page; absent → raw page. */
  extractPage?: AgentRuntime["extractPage"];
  /** Probes only: replaces the 300 s cap on one image generation request (never raises it). */
  imageGenerationTimeoutMs?: number;
  /** Probes only: a stubbed page source with `fetchPage`'s contract (policy callbacks included). */
  fetchPage?: typeof fetchPage;
  proxy?: () => NetworkProxy | undefined;
  search?: SearchService;
  db: DatabaseSync;
  dataDir: string;
  resourcesDir?: string;
  platform: "darwin" | "linux" | "win32";
  env: Readonly<NodeJS.ProcessEnv>;
  userHome: string;
  tempDir: string;
  host: BrainHost;
  peer: Peer<MethodTable, EventTable>;
  redactor: BrainRedactor;
  logger: Logger;
}
export interface PreparedTool {
  /** Kernel-only optimistic write condition, bound by this call's approval fingerprint. */
  projectNotesWrite?: { expectedHash: string | null };
  browserSecretUses?: import("@pibot/protocol-base").BrowserSecretUse[];
  hostSsh?: import("../runtime/tools/host-ssh-prepare.ts").PreparedHostSshCall;
  /**
   * State the capability returned from its prepare-phase policy hook for its own executor
   * (for example which connections this call's sources were judged against). Carried per call
   * instead of in shared mutable state, so concurrent calls and slow approvals cannot mix.
   */
  capabilityPolicyData?: unknown;
  /** Trusted recipe preparation, consumed only after the same call's ordinary policy gate. */
  gitConfiguration?: import("../runtime/tools/git-configuration-prepare.ts").PreparedGitConfiguration;
  gitHook?: import("../runtime/tools/git-hook-prepare.ts").PreparedGitHook;
  /** Project hooks / executable config this ordinary Git call would run. */
  gitEntries?: import("../runtime/tools/git-entry-prepare.ts").PreparedGitEntries;
  memorySafety?: { digest: string; reason: string; scope?: "user" | "bot" | "group" | "project" };
  secretUses?: import("../runtime/credentials/port.ts").SecretUse[];
  connector?: import("@pibot/protocol-base").PreparedConnector;
  /** Raw MCP call hidden behind this stable capability tool. */
  capabilityConnector?: {
    capabilityId: import("@pibot/protocol-base").CapabilityId;
    input: import("@pibot/protocol-base").ConnectorCallInput;
  };
  connectorPolicy?: PolicyResult;
  /**
   * The person answered this exact call's "ask every time" card. Set only by the
   * authorization step after that answer, never from input; the draft it creates is sent
   * without a second card. File-manager confirmation also uses this call-bound receipt.
   */
  confirmedNow?: true;
  sensitiveReadRoots?: readonly string[];
  docker?: import("@pibot/execution").DockerConnection;
  messageScope?: string;
  boundary?: WorkspaceSnapshot;
  searchRecipient?: SearchRecipient;
  sendPaths?: string[];
  patchPaths?: string[];
  patchFingerprints?: string[];
  call: LocalToolCall;
  /** Browser_login: the saved site and the accounts offered on the card (no secrets). */
  login?: import("@pibot/protocol-base").LoginApprovalRequest;
  result: PolicyResult;
  settings: PermissionsSettings;
  roots: string[];
  cwd: string;
  home: string;
  authorization: string;
}
