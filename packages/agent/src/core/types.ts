// Define the SDK-neutral contracts used by the agent and its callers.
import type {
  AgentErrorCode,
  CustomModel,
  CustomProvider,
  ExecutionCheckCode,
  ImageContent,
  ImageDelivery,
  ImageMode,
  ImageModelInfo,
  ModelInfo,
  PermissionLevels,
  ResolvedCustomModel,
} from "@pibot/protocol-base";
import type { AgentNetwork } from "../network/network.ts";

export type { AgentErrorCode, ModelInfo } from "@pibot/protocol-base";
export type CustomProviderConfig = Omit<CustomProvider, "id" | "apiKey"> & { id: string };

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  group: "common" | "cn" | "gateway" | "cloud" | "fast" | "subscription" | "local" | "other";
  auth: "apiKey" | "oauth" | "cloud" | "custom";
  modelCount: number;
  envVarName?: string;
  baseUrl?: string;
  available: boolean;
  unavailableReason?: "openai_approval_required";
}

export interface OpenSessionOptions {
  /** Supplied after the host has loaded its registered secrets. */
  redactProviderDetail?(text: string): string;
  retryBoundary?: {
    messageId: string;
    record(entryId: string, sessionFile: string, messageId?: string): void;
  };
  requestObserver?: AgentRequestObserver;
  botId: string;
  homeDir: string;
  sessionDir: string;
  sessionFile?: string;
  model: { provider: string; id: string };
  thinkingLevel: "off" | "low" | "medium" | "high";
  // Resolve runtime identity from the same model snapshot used for this session.
  systemPrompt: string | ((model: ModelInfo, providerName: string) => string);
  localTools?: LocalToolPorts;
  /** Compatibility rollback: expose the same allowed catalog eagerly, never change authority. */
  toolLoading?: "grouped" | "eager";
  signal?: AbortSignal;
  unattended?: boolean;
  onCompaction?(event: CompactionActivity): void;
  /**
   * Diagnostics only: called as each opening step starts, so a brain stall can be pinned to the
   * step that held the thread. Names are fixed; nothing about the session is passed.
   */
  phase?(name: "runtime" | "model" | "session_load" | "extensions" | "create" | "bind"): void;
  phaseTiming?(name: string, elapsedMs: number): void;
  /** The Bot's enabled skills, listed after the system prompt. */
  skills?: { entries: SkillPromptEntry[]; language: "zh" | "en" };
  /**
   * A workflow run's contract block, appended after the skills. SEC: only what the program
   * authored (rules, budget, acceptance checks, deliverables, folders); never the skill's own text.
   */
  workflowPrompt?: string;
  /**
   * SEC: the workflow skill's own text (body and its rules). It is skill-author content, possibly
   * from a third-party plugin, so it rides in a reference message from the run's first request,
   * never in the system prompt. Requires `context`.
   */
  workflowSkill?: WorkflowSkillReference;
  /** `cheap` runs on the auxiliary model when it is usable, otherwise on `model`. */
  modelTier?: "main" | "cheap";
  context?: {
    prepare(signal: AbortSignal, model?: Pick<ModelInfo, "input">): Promise<PromptContext>;
    refresh?(
      signal: AbortSignal,
      model?: Pick<ModelInfo, "input">,
    ): PromptContext | Promise<PromptContext>;
    redact(text: string): string;
  };
}

export interface ModelRequestMetrics {
  startedAt: number;
  provider: string;
  api: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Omitted when the HTTP request body could not be observed. */
  cacheFields?: string[];
}

/** One record for every provider stream, including SDK context compaction. No message content. */
export interface AgentRequestObserver {
  beforeRequest(input: {
    id: string;
    /** `auxiliary`: a run-scoped helper call on the auxiliary model (page extraction). */
    kind: "response" | "compaction" | "auxiliary";
    provider: string;
    model: string;
    pricingKnown: boolean;
    toolSet?: ToolSetSnapshot;
  }): void;
  settled(input: {
    id: string;
    complete: boolean;
    usage?: { tokens?: number; costUsd?: number };
  }): void;
  /** One content-free prompt-cache line per settled conversation request. */
  cacheDiagnostic?(line: CacheDiagnostic): void;
  metrics?(request: ModelRequestMetrics): void;
}

/**
 * Prompt-cache diagnostic of one provider request: shape, hashes and counts only, never text.
 * `boundaries` are `index:hash` of the serialized prefix at each cache boundary (last eight);
 * equal hashes in consecutive requests mean that prefix was sent byte-identically.
 */
export interface CacheDiagnostic {
  api: string;
  requestedAt?: number;
  intervalMs?: number;
  /** Configured transport; `wire` is what the Codex adapter actually used. */
  transport: string;
  wire?: "sse" | "sse-fallback" | "websocket-full" | "websocket-continuation";
  cacheKey?: string;
  items: number;
  /** type/role of the last three input items. */
  tail: string[];
  /**
   * Indices of Pi Bot's runtime state items. Append-only (Responses APIs): earlier
   * indices stay put and a new one appears only when the state changed mid-run.
   */
  states: number[];
  boundaries: string[];
  /** The comparison is with the last request of the previous run in this session file. */
  sincePreviousRun?: boolean;
  /** Instructions or tool declarations differ from the previous request. */
  headerChanged?: boolean;
  /** Same header, and the previous request's items are an exact prefix of this one's. */
  extendsPrevious?: boolean;
  /** `index:type` of the first item that differs from the previous request. */
  firstChange?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ToolPermissionSnapshot {
  version: string;
  scope: "bot" | "group";
  scopeId: string;
  mode: "plan" | "execute";
  levels: PermissionLevels;
  yolo: boolean;
  grantsVersion: string;
  workplaceVersion: string;
}
export interface ToolSetSnapshot {
  catalogVersion: string;
  visible: { id: string; name: string; schemaVersion: string; implementationVersion: string }[];
  permissions?: ToolPermissionSnapshot;
  discovery?: {
    catalogVersion: string;
    tools: { id: string; schemaVersion: string; catalogVersion: number }[];
    truncated: boolean;
  };
}

/**
 * Where a skill's text came from. `builtin`: the app's own methods. `own`: taught by the user,
 * proposed by the Bot and accepted, or saved from a passed plan. `imported`: copied from
 * a plugin, a skill file / archive / folder or a team file, i.e. authored elsewhere.
 */
export type SkillProvenance = "builtin" | "own" | "imported";

/** One enabled skill as brain resolved it; text is already redacted, paths are absolute. */
export interface SkillPromptEntry {
  name: string;
  description: string;
  /** SEC: imported entries are listed in their own fenced, untrusted block. */
  provenance: SkillProvenance;
  /** Absolute path of SKILL.md inside the Bot's own skills folder. */
  filePath: string;
  baseDir: string;
}

export interface CompactionMetrics {
  mode?: "foreground" | "background";
  toolResultTokens?: Record<string, number>;
  plannedChunks?: number;
  originalTokens?: number;
  outputTokens?: number;
  firstTokenMs?: number;
  requestDurationMs?: number;
  retries?: number;
  retryable?: number;
  completedChunks?: number;
  elapsedMs?: number;
}
export interface CompactionActivity {
  phase: "start" | "end" | "progress";
  metrics?: CompactionMetrics;
  reason: "manual" | "threshold" | "overflow";
  entryCount: number;
  durationMs?: number;
  outcome?: "done" | "error" | "aborted";
  /** Fixed diagnostic metadata only; never SDK error messages or transcript text. */
  failure?: CompactionMetrics & {
    stage: "transcript" | "request" | "response" | "summary";
    code: AgentErrorCode;
    httpStatus?: number;
    stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
    contextWindow?: number;
    estimatedInputTokens?: number;
    requestedOutputTokens?: number;
    deadlineMs?: number;
    totalDeadlineMs?: number;
    requestIndex?: number;
    completedChunks?: number;
    elapsedMs?: number;
  };
}

/** SEC: a workflow skill's own text for the run's reference message; already redacted. */
export interface WorkflowSkillReference {
  name: string;
  version?: number;
  provenance: SkillProvenance;
  text: string;
}

// Brain supplies a validated snapshot; SDK message/extension types stay inside agent.
export interface PromptContext {
  /** Background completion output is untrusted reference data, never user instructions. */
  backgroundResults?: string;
  /** Earlier trigger/result in this topic: untrusted background for ordinary user follow-up. */
  routineTopicReference?: string;
  /**
   * SEC: memory, workplace and project notes are run context, not instructions; they reach the
   * model in a reference message (`context-reference.ts`), never in the system prompt.
   */
  memory: string;
  availableSecrets?: string;
  /** Brain-confirmed primary folder and tool cwd; does not change the SDK's isolated home. */
  workplace?: string;
  /** Brain-owned execution ceiling and persisted plan; user/model plan text is labelled data. */
  execution?: string;
  /** Program-owned connection labels/reasons only; descriptive state, never authorization. */
  connectionStatus?: string;
  /** The working folder's AGENTS.md / CLAUDE.md section, already labelled and size-capped. */
  projectNotes?: string;
  routineSummary?: string;
  routineResume?: string;
  /**
   * Pi Bot's note on a run the user resumed after a restart cut it off: that it was
   * interrupted and which calls have an unknown outcome (tool names and classes only).
   */
  runResume?: string;
  /** Pi Bot's own run ledger facts (output folder, previous period, earlier attempts). */
  routineLedger?: string;
  group?: {
    /** Fixed lines (safety notice, identity); never trimmed. */
    information: string;
    /**
     * Budgeted profile and live-reference lines. Stable parts use a separate fixed share
     * of the header budget. For live parts, task snapshots go first (lowest `taskRank` first),
     * then parts with a `compact` form are replaced by it. Parts with neither are fixed.
     */
    parts?: GroupContextPart[];
    /** Task snapshots brain already left out by its own byte cap (added to the "N not listed" note). */
    omittedTasks?: number;
    workplace?: string;
    messages: {
      id: string;
      role: "user" | "assistant";
      text: string;
      botName?: string;
      priority?: boolean;
      imageDelivery?: ImageDelivery;
      sourceRunId?: string;
      attachments?: { id: string; name: string; kind: "image" | "file"; mimeType: string }[];
    }[];
    images?: { messageId: string; attachmentId: string; image: ImageContent }[];
    imageStatus?: {
      attachmentId: string;
      status: "loaded" | "unsupported" | "budget" | "unavailable" | "not_loaded";
    }[];
  };
}
export interface GroupContextPart {
  text: string;
  /** Stable group profile data belongs in the system prefix, within the group byte budget. */
  stable?: boolean;
  /** Shorter replacement when this part's profile or live-reference header is over budget. */
  compact?: string;
  /** Present on task snapshots: droppable, lower = less relevant (older / finished / unrelated). */
  taskRank?: number;
}
export interface PersonaRequest {
  description: string;
  language: "zh" | "en";
  model: { provider: string; id: string };
  signal: AbortSignal;
}
/** The changes sidebar asks the conversation's model to draft a commit message. */
export interface CommitDraftRequest {
  /** Already redacted and bounded by brain; treated as untrusted data in the prompt. */
  summary: string;
  language: "zh" | "en";
  model: { provider: string; id: string };
  signal: AbortSignal;
}

/** Reviewed teach steps, already redacted and bounded by brain; untrusted in the prompt. */
export interface SkillDraftRequest {
  steps: string;
  language: "zh" | "en";
  model: { provider: string; id: string };
  signal: AbortSignal;
}

/** Conversation text or a note catalog, already redacted by brain. */
export interface MemoryDraftRequest {
  text: string;
  /** Explicit import distillation uses the local-only Ollama transport, with no model fallback. */
  useLocalOllama?: true;
  /** Replaces the extraction instruction; both share the same model and cost path. */
  instruction?: string;
  model: { provider: string; id: string };
  signal: AbortSignal;
  /** Dream can restrict the selected generation route to a literal loopback endpoint. */
  localOnly?: true;
  /** Remaining shared background allowance; checked after selecting the actual model. */
  budget?: { tokens: number; costUsd: number };
  /** Includes failed/truncated responses; never contains model text. */
  onUsage?(usage: MemoryDraftUsage): void;
}
export interface MemoryDraftUsage {
  tokens: number;
  costUsd?: number;
  modelProvider: string;
  modelId: string;
}
export interface MemoryDraftResult {
  draft: unknown;
  tokens: number;
  costUsd?: number;
}

/** Brain fetched the page under policy; agent asks the auxiliary model what answers the question. */
export interface PageExtractRequest {
  /** Internal timing scope only; never sent to a provider or persisted. */
  onQueue?(): () => void;
  /** The Bot's question, already redacted by brain. It goes to the auxiliary provider. */
  question: string;
  /** Untrusted page data; agent caps the text it sends. */
  page: { url: string; title: string; text: string };
  /** Counts the helper request in the run's execution budget (same path as responses). */
  observer?: AgentRequestObserver;
  signal: AbortSignal;
}
export interface PageExtractResult {
  /** Plain text, bounded; still untrusted reference data. */
  text: string;
  model: { provider: string; id: string };
  /** Characters of page text the extractor actually read (may be less than the page). */
  readChars: number;
}

export interface LocalToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}
export interface LocalToolResult {
  /** Program-owned provenance, independent of command success; never permission authority. */
  untrustedContent?: boolean;
  text: string;
  images?: ImageContent[];
  summary?: string;
  details?: {
    exitCode?: number | null;
    timedOut?: boolean;
    stopped?: boolean;
    durationMs?: number;
    logPath?: string;
    backgroundWaiting?: boolean;
    backgroundJobId?: string;
    backgroundStatus?: "running" | "exited" | "stopped" | "failed";
    /** Program metadata only; never extracted from a text result. */
    errorCode?: string;
    /** Fixed execution check, distinct from the outcome of the dispatched operation. */
    executionCheck?: ExecutionCheckCode;
    userRejected?: boolean;
    resultCount?: number | null;
    fallback?: "browser";
    fallbackReason?: "http_status" | "anti_bot_page" | "js_required";
  };
  isError?: boolean;
  /** Brain-issued availability receipt; never parsed from model text or restored tool results. */
  loadedTools?: string[];
}
export interface LocalToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** The brain selected a connector implementation for this stable capability tool. */
  capabilityImplementation?: {
    capabilityId: import("@pibot/protocol-base").CapabilityId;
    connectorId: string;
  };
  loadGroup?: { id: string; description: string };
  /**
   * Top-level object arguments some models send as JSON text although the schema declares an
   * object. Such a string is parsed once before
   * schema validation; whatever it parses to is still validated by the same schema.
   */
  jsonTextArguments?: readonly string[];
  id?: string;
  schemaVersion?: string;
  implementationVersion?: string;
}
export interface LocalToolActivity {
  id: string;
  tool: string;
  phase: "start" | "output" | "end";
  output?: string;
  isError?: boolean;
  durationMs?: number;
  // Only used in memory to classify pre-gate SDK failures, never emitted or stored as activity text.
  input?: unknown;
  failure?: "not_authorized";
}
export interface LocalToolPorts {
  signal: AbortSignal;
  definitions: readonly LocalToolDefinition[];
  /** Recent groups of this Bot/topic only; hints are intersected with the current catalog. */
  initialToolGroups?: readonly string[];
  /**
   * Groups to load in addition to `initialToolGroups`, even when that one is undefined (a role
   * default). `undefined` there keeps its legacy-transcript meaning; this list never replaces it.
   */
  initialToolGroupsAlways?: readonly string[];
  activeToolGroups?(groups: readonly string[]): void;
  /** Connector-backed stable tools; registered sequentially by the connector extension. */
  capabilityDefinitions?: readonly LocalToolDefinition[];
  permissionsSnapshot?(): ToolPermissionSnapshot;
  discoverySnapshot?(): ToolSetSnapshot["discovery"];
  authorize(call: LocalToolCall, signal: AbortSignal): Promise<{ allow: boolean; reason?: string }>;
  /** `failed`: the check itself could not finish (not a permission decision); shown as failed. */
  blocked(call: LocalToolCall, reason: string, failed?: boolean): void;
  execute(
    call: LocalToolCall,
    signal: AbortSignal,
    output: (text: string) => void,
  ): Promise<LocalToolResult>;
  activity(event: LocalToolActivity): void;
  assistantReply?(text: string): void;
  errorText(id: string): string;
  redact(text: string): string;
  /**
   * A gate failure the model only sees as a fixed text would otherwise leave no trace. The host
   * owns the logger (bot / run context); this package never logs on its own.
   */
  logError?(entry: LocalToolErrorLog): void;
}

/** Only identifiers and the error's class / code: messages and arguments may quote user data. */
export interface LocalToolErrorLog {
  event: "tool_authorization_failed" | "tool_execution_failed";
  tool: string;
  toolCallId: string;
  errorName: string;
  code?: string | number;
  /** Why the command failed, when the error carries it; same identifier rules as `code`. */
  reason?: string;
}

export interface BotSession {
  readonly sessionFile: string;
  /** The model this session actually runs on (differs from the request for a `cheap` tier). */
  readonly model?: { provider: string; id: string };
  // Both promises drain actual SDK work through idle, including JSONL persistence listeners.
  prompt(
    text: string,
    onEvent: (event: SessionEvent) => void,
    images?: ImageContent[],
  ): Promise<{
    stopReason: string;
    finalText?: string;
    calledTools?: string[];
    usage?: unknown;
    /** The request was cut because the reasoning kept repeating; reported as a length stop. */
    repeatedThinking?: boolean;
    /**
     * The stream dropped after visible text; that text is kept and the response is
     * reported as a length stop so the run can continue it in the same reply.
     */
    interrupted?: boolean;
  }>;
  canAppend?(): boolean;
  hasPendingInput?(text: string): boolean;
  append?(
    id: string,
    mode: "steer" | "followUp",
    text: string,
    images?: ImageContent[],
  ): Promise<boolean>;
  /** Moves a still-queued addition between steer and follow-up; false when it is too late. */
  switchAddition?(id: string, mode: "steer" | "followUp"): Promise<boolean>;
  abort(): Promise<void>;
  /** Idle certification without aborting: a rejected abort does not mean the SDK still runs. */
  waitForIdle?(): Promise<void>;
  // Disposal requested during a prompt is deferred until that drain completes.
  dispose(): void;
}

export type SessionEvent =
  | {
      type: "reconnect";
      phase: "start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      /** Error class of the failed attempt (agent error code or recovery kind). */
      reason?: string;
      status?: number;
    }
  | {
      type: "reconnect";
      phase: "end";
      attempt: number;
      maxAttempts: number;
      outcome: "done" | "error" | "aborted";
    }
  | { type: "delta"; text: string }
  | {
      type: "activity";
      activity:
        | { phase: "waiting_model" }
        | { phase: "preparing_tool"; tool: string; characters: number }
        | { phase: "clear" };
    }
  | { type: "addition"; id: string }
  | { type: "replyStart" };

export type FetchCustomModelsOptions = Pick<CustomProviderConfig, "baseUrl" | "api" | "headers"> & {
  apiKey?: string;
};

export interface CompactHistoryRequest {
  botId: string;
  sessionFile: string;
  model: { provider: string; id: string };
  fork: boolean;
  signal: AbortSignal;
  redact(text: string): string;
}
/** How much conversation a topic already carries, without opening a model request. */
export interface ContextEstimateRequest {
  botId: string;
  sessionFile: string;
  signal: AbortSignal;
}
/**
 * `model` is the model of the newest assistant turn, not the Bot's current setting: only the
 * pair tells a real model switch apart from a topic that simply grew past the line.
 */
export interface ContextEstimate {
  tokens: number;
  model?: { provider: string; id: string };
}
export interface AgentRuntime {
  /** Loads the pi SDK ahead of the first model operation; safe to call repeatedly. */
  preloadSdk?(): Promise<void>;
  /**
   * Evaluates the SDK on this thread now (after the startup admission window), so the first model
   * operation does not; "already_loaded" when something loaded it first.
   */
  loadSdkWhenIdle?(): Promise<"loaded" | "already_loaded">;
  /** Reserve a startup window for local RPCs before synchronous SDK evaluation. */
  deferSdk?(milliseconds: number): void;
  compactHistory?(
    request: CompactHistoryRequest,
  ): Promise<{ sessionFile: string; summary: string; mechanical: boolean }>;
  estimateContext?(request: ContextEstimateRequest): Promise<ContextEstimate | undefined>;
  listImageModels?(opts?: {
    availableOnly?: boolean;
    mode?: ImageMode;
    signal?: AbortSignal;
  }): Promise<ImageModelInfo[]>;
  generateImage?(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  generatePersona(request: PersonaRequest): Promise<{ name: string; systemPrompt: string }>;
  draftCommitMessage?(request: CommitDraftRequest): Promise<string>;
  transformMessage?(request: {
    kind: "translation" | "handoff";
    model: { provider: string; id: string };
    text: string;
    language: "zh" | "en";
    signal: AbortSignal;
  }): Promise<string>;
  /**
   * Only on a configured auxiliary model, never the main one; throws when it is unset or
   * unusable so brain returns the page as before.
   */
  extractPage?(request: PageExtractRequest): Promise<PageExtractResult>;
  /** Parsed JSON from the model; brain validates it before anything uses it. */
  draftSkill?(request: SkillDraftRequest): Promise<unknown>;
  /** 0–5 memory candidates plus the cost the daily cap accounts for. */
  draftMemories?(request: MemoryDraftRequest): Promise<MemoryDraftResult>;
  login?(providerId: string, interaction: LoginInteraction): Promise<void>;
  refreshAuth?(providerId: string, signal: AbortSignal): Promise<void>;
  // Model discovery refreshes credential presence without accessing the system keyring.
  refreshModels?(
    providerId: string,
    signal: AbortSignal,
  ): Promise<{ providerId: "openrouter"; count: number; updatedAt: string }>;
  listModels(opts?: { availableOnly?: boolean }): Promise<ModelInfo[]>;
  testProvider(
    providerId: string,
    modelId?: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    modelCount?: number;
    error?: AgentErrorCode;
    httpStatus?: number;
    verification?: "credentials" | "generation";
    /** Models the test called, in order (diagnostics only; a model id is not a secret). */
    testedModels?: string[];
  }>;
  fetchCustomModels(cfg: FetchCustomModelsOptions): Promise<{ id: string }[]>;
  resolveCustomModels(models: CustomModel[]): Promise<ResolvedCustomModel[]>;
  openSession(opts: OpenSessionOptions): Promise<BotSession>;
  /**
   * The model description a paired phone needs to stream this model itself (pi-ai's own
   * fields, no credential). Undefined when the model is not usable now or its API is not one the
   * phone runtime has (`@pibot/agent/portable`).
   */
  portableModel?(providerId: string, modelId: string): Promise<PortableModelDescriptor | undefined>;
  /**
   * Writes a new session file holding an already finished conversation (a phone's offline
   * chat), so later runs in that topic see it as ordinary history. Never overwrites a file;
   * with `append` an existing file gets the messages after its last entry instead (the caller
   * makes sure no run has that session open).
   */
  seedSession?(request: SeedSessionRequest): Promise<void>;
}
export interface PortableModelDescriptor {
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  provider: string;
  id: string;
  name: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Static per-model request headers (never credentials); a phone cannot send what is absent. */
  hasHeaders: boolean;
}
export interface SeedSessionRequest {
  botId: string;
  homeDir: string;
  sessionDir: string;
  sessionFile: string;
  /** A phone's offline turns that joined a topic the computer already has a session for. */
  append?: boolean;
  model: { api: string; provider: string; id: string };
  messages: readonly {
    role: "user" | "assistant";
    text: string;
    at: number;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }[];
  signal: AbortSignal;
}

export interface ImageGenerationRequest {
  model: { provider: string; id: string };
  // Brain pins the service recipient it authorized before resolving credentials.
  recipient: string;
  mode: ImageMode;
  prompt: string;
  images: ImageContent[];
  signal: AbortSignal;
  /** Cap on the whole request (default and maximum 300 s); reaching it fails with `image_timeout`. */
  timeoutMs?: number;
}
export interface ImageGenerationResult {
  text: string;
  images: ImageContent[];
  usage?: unknown;
}

export type AuxiliaryPurpose =
  | "compaction"
  | "handoff"
  | "translation"
  | "persona"
  | "commit"
  | "skill"
  | "memory"
  | "workflow"
  | "web_page";

/**
 * Downloads an image link an image service returned instead of bytes. The link is supplier
 * output: the host refuses private, loopback and metadata destinations (also after DNS) and
 * redirects, bounds size and time, and sends no credentials.
 */
export type ImageUrlFetch = (input: {
  url: string;
  signal: AbortSignal;
}) => Promise<{ data: Uint8Array }>;

export interface AgentRuntimeDeps {
  network?: AgentNetwork;
  /** Without it, an image service's link results fail with `image_url_unavailable`. */
  fetchImageUrl?: ImageUrlFetch;
  auth?: AgentAuthPorts;
  dataDir: string;
  hasApiKey(providerId: string): boolean;
  getApiKey(providerId: string): Promise<string | undefined>;
  customProviders(): CustomProviderConfig[];
  /** Model ids the user added to built-in providers by hand, keyed by provider id. */
  addedModels?(): Readonly<Record<string, readonly string[]>>;
  auxiliaryModel?(): { provider: string; id: string } | null | undefined;
  auxiliaryModelFallback?(purpose: AuxiliaryPurpose, code: AgentErrorCode): void;
  /** A failed background compile-cache warm-up, as a fixed reason code. */
  sdkWarmupFailed?(code: string): void;
  /** Persist a provider-advertised limit; never overrides a user-specified model field. */
  onCustomModelLimit?(
    providerId: string,
    modelId: string,
    limit: { maxTokens?: number; contextWindow?: number },
  ): void;
}

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}
export interface CloudMaterial {
  providerId: string;
  env: Record<string, string>;
  apiKey?: string;
  googleCredentials?: Record<string, string>;
}
export interface LoginInteraction {
  signal: AbortSignal;
  prompt(input: {
    type: string;
    options?: readonly { id: string }[];
    signal?: AbortSignal;
  }): Promise<string>;
  notify(event: { type: string; url?: string; userCode?: string; verificationUri?: string }): void;
}
export interface AgentAuthPorts {
  /** Stable opaque installation identity (UUID) for OpenAI's ext_agent_host_id; never a client ID. */
  chatgptHostId?(): string;
  /** A ChatGPT-plan request hit (true) or no longer hits (false) the plan's usage limit. */
  usageLimit?(providerId: string, limited: boolean): void;
  /** The route a ChatGPT-plan request is about to take (API family and host only). */
  planRequest?(route: { api: string; host: string; failure?: string }): void;
  mode(providerId: string): "apiKey" | "oauth" | "cloud" | "custom";
  has(providerId: string): boolean;
  read(providerId: string): Promise<OAuthCredential | undefined>;
  entries(): { providerId: string; type: "oauth" }[];
  modify(
    providerId: string,
    update: (value: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<OAuthCredential | undefined>;
  remove(providerId: string, signal?: AbortSignal): Promise<void>;
  cloud(providerId: string, signal: AbortSignal): Promise<CloudMaterial | undefined>;
  reauth(providerId: string): void;
  /** Called only after newly issued OAuth credentials have been persisted. */
  authenticated?(providerId: string): void;
}
