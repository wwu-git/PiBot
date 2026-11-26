import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime, LocalToolCall } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import type {
  Approval,
  Bot,
  EventTable,
  Group,
  KernelMethodParams,
  KernelMethodResults,
  MethodTable,
  Peer,
  RoutinePreauth,
  RoutinePreauthInput,
  Run,
  WorkspaceSnapshot,
} from "@pibot/protocol-base";
import type { ChatService } from "../conversations/chat/chat.ts";
import type { LocalService } from "../local-service.ts";
import type { QueueInput } from "../runtime/queue/run-queue.ts";
import type { RegisterRpc } from "./business-rpc.ts";
import type { PreparedTool, ToolRunContext } from "./local-types.ts";
import type { BrainRedactor } from "./privacy.ts";

/**
 * Capability packages: how one capability plugs into the brain kernel. The kernel never imports
 * a capability; `@pibot/brain-app` passes the enabled list to `startBrain`, which registers them
 * once the kernel services exist, starts them in order and stops them in reverse order before the
 * kernel itself shuts down. Adding a capability means a new package plus one line in that list.
 */
export interface BrainCapability {
  /** Stable id used in logs and for the ports a capability provides ("routines"). */
  readonly id: string;
  /**
   * Startup repair that must run before any service touches the database (for example marking
   * runs a crash left unfinished). Synchronous, right after migrations.
   */
  recover?(db: DatabaseSync): void;
  register(context: CapabilityContext): CapabilityHandle | Promise<CapabilityHandle>;
}

/** Interactive desktop lifecycle exposed to capabilities without importing a capability package. */
export interface InteractiveClientPort {
  setInteractive(state: "available" | "quit"): void;
}

/** What a registered capability hands back: optional start and stop hooks, nothing else. */
export interface CapabilityHandle {
  start?(): void | Promise<void>;
  /** Optional diagnostics only: RPC prerequisites must be complete before start resolves. */
  afterReady?(signal: AbortSignal): void | Promise<void>;
  /** Must drain everything the capability started; the database closes after the last stop. */
  stop?(): Promise<void>;
}

/**
 * Everything a capability may use from the kernel. Fields are kernel services and extension
 * points, never another capability: capabilities reach each other only through `ports`.
 */
export interface CapabilityContext {
  readonly version: string;
  readonly db: DatabaseSync;
  readonly dataDir: string;
  /**
   * The app's own requests (catalogs, updates) through the proxy the user configured. Never for a
   * Bot's tools: those go through policy and their own network rules.
   */
  readonly fetch: typeof fetch;
  readonly dev: boolean;
  readonly logger: Logger;
  readonly redactor: BrainRedactor;
  /** Encrypted secret store (provider keys, connector credentials); values never leave the brain. */
  readonly secrets: import("@pibot/storage").SecretStore;
  /** Type-erased at the extension seam; the injected runtime tables validate every payload. */
  readonly peer: Peer<MethodTable, EventTable>;
  readonly agent: AgentRuntime;
  /** Runtime engine and shared services (approvals, permissions, tools, budgets, …). */
  readonly local: LocalService;
  readonly chat: ChatService;
  /** Fixed first topic for a newly created Bot; no runtime or management implementation escapes. */
  readonly bots: {
    introduce(botId: string): void;
    /**
     * The same update as the `bots.update` RPC (per-Bot lock, redaction, model and
     * thinking fit, `bots.changed`), for capabilities that change a Bot on the user's request.
     */
    update(params: KernelMethodParams["bots.update"]): Promise<Bot>;
    /** The same as the `bots.create`, `bots.archive` and `bots.restore` RPCs. */
    create(params: KernelMethodParams["bots.create"]): Promise<Bot>;
    archive(botId: string): Promise<{ ok: true }>;
    restore(botId: string): Promise<Bot>;
    /** The same as the `topics.create` RPC (new private topic, made current). */
    newTopic(botId: string): Promise<{ id: string }>;
    /**
     * The same as the `topics.workplace.update` RPC (busy and revision checks, audit), for a
     * folder change the user confirmed on a card.
     */
    updateTopicWorkplace(
      params: KernelMethodParams["topics.workplace.update"],
      signal: AbortSignal,
    ): Promise<KernelMethodResults["topics.workplace.update"]>;
  };
  /**
   * The same group changes as the `groups.update` / `groups.addMember` RPCs (group lock,
   * queued runs superseded, `groups.changed`).
   */
  readonly groups: {
    /** Trusted proposal acceptance only; queues an acknowledgement in its original group topic. */
    confirmNotice(
      groupId: string,
      conversationId: string,
      botId: string,
      text: string,
      confirmation: import("../conversations/chat/chat-confirmation.ts").ChatConfirmation,
      display?: import("../conversations/chat/user-message-display.ts").UserMessageDisplay,
    ): Promise<void>;
    update(params: KernelMethodParams["groups.update"]): Promise<Group>;
    addMember(groupId: string, botId: string): Promise<Group>;
    /** The same as the `groups.create` / `removeMember` / `archive` / `restore` RPCs. */
    create(params: KernelMethodParams["groups.create"]): Group;
    removeMember(groupId: string, botId: string): Promise<Group>;
    archive(groupId: string): Promise<Group | { ok: true }>;
    restore(groupId: string): Promise<Group | { ok: true }>;
    /**
     * A message into a group topic through the same admission as a person's group message;
     * `display` labels it (a Pi dispatch), the text is what the coordinator reads.
     */
    send(
      groupId: string,
      conversationId: string,
      text: string,
      display: import("../conversations/chat/user-message-display.ts").UserMessageDisplay,
    ): Promise<KernelMethodResults["chat.send"]>;
    /**
     * The same as `groups.topics.create` with the current folders kept; refused while the
     * group is busy (the caller then stays in the current topic).
     */
    newTopic(groupId: string): Promise<Group>;
    /**
     * A workflow run addressed to one member, through the same admission as a user's
     * group message (`ChatService.sendWorkflow` is the private-chat counterpart).
     */
    sendWorkflow(
      groupId: string,
      botId: string,
      workflow: import("../runtime/workflows/workflow-prepare.ts").WorkflowRun,
      conversationId?: string,
    ): Promise<KernelMethodResults["chat.send"]>;
  };
  /** Host ports of the current process (notifications, files, …); absent ones are unsupported. */
  readonly host: import("../index.ts").BrainHost;
  /** The unified RPC wrapper: schema check, redacted log, error mapping (AGENTS.md). */
  readonly rpc: {
    handle: RegisterRpc;
    /** This method may run while no desktop client is attached. */
    allowOffline(method: string): void;
    /** KernelMethods under this prefix serve background work and never hold up the interactive drain. */
    background(prefix: string): void;
  };
  /**
   * Unattended runs (automatic work with nobody watching) are a kernel concept: approvals park,
   * pre-authorizations may answer them, risky features are off. Exactly one capability owns them
   * and answers the kernel's questions about them.
   */
  readonly unattended: { claim(owner: UnattendedRunOwner): void };
  /** Media dispatch and attachment preflight are kernel-owned; capabilities supply execution. */
  readonly computer: {
    readonly runtime: import("../runtime/computer/port.ts").ComputerRuntime;
    readonly handoffWaitMs?: number;
    provide(port: import("../runtime/computer/port.ts").ComputerUsePort): void;
  };
  readonly office: { provide(port: import("../runtime/media/office-port.ts").OfficePort): void };
  readonly images: { provide(port: import("../runtime/media/images-port.ts").ImagesPort): void };
  /** Runs of Bots of kind "agent" (external coding agents over ACP). */
  readonly externalAgents: {
    provide(port: import("../runtime/external-agents/port.ts").ExternalAgentsPort): void;
  };
  /** Memory business logic is an L2 capability; L3 consumes only prompt/profile projections. */
  readonly memory: {
    provide(port: import("../runtime/memory/port.ts").MemoryPort): () => void;
  };
  /** Runtime owns login authorization and secret injection; one capability supplies their data. */
  readonly credentialServices: {
    provide(port: import("../runtime/credentials/port.ts").CredentialServices): void;
  };
  /** Browser resources outlive capability.stop and are released after the run queue drains. */
  readonly browser: {
    environment: import("../runtime/browser/port.ts").BrowserEnvironment;
    notices: import("../runtime/browser/port.ts").BrowserHandBackRecorder;
    beginTakeover(botId: string): () => void;
    members(groupId: string): string[];
    afterHandBack(botId: string): Promise<void>;
    provide(
      port: import("../runtime/browser/port.ts").BrowserPort,
      view: import("../runtime/browser/port.ts").BrowserViewPort,
    ): void;
  };
  /** Skills and teaching use the injected overlay without importing browser implementation. */
  readonly skills: {
    provide(port: import("../runtime/tools/skills/port.ts").SkillsPort): void;
    /** Uses the current host overlay; no browser implementation is exported to the capability. */
    takeover(botId: string, on: boolean): Promise<unknown>;
  };
  /**
   * Connected apps are reasoned about by the run engine itself (tool runner, approvals, send drafts,
   * unattended pre-authorization), so the kernel owns the port shape and one capability fills it.
   */
  readonly connectors: {
    provide(port: import("../runtime/tools/connectors/port.ts").ConnectorsPort): void;
  };
  /** Runtime owns write hooks, queue order and workspace authorization; one capability records changes. */
  readonly workspaces: {
    readonly host: import("../runtime/workspaces/host.ts").WorkspaceHost;
    provide(port: import("../runtime/workspaces/port.ts").WorkspaceServices): void;
  };
  /** Executes a capability tool by name once policy allowed it. Kernel names are rejected. */
  readonly tools: {
    executor(tool: string, run: ToolExecutor): () => void;
    /**
     * What a capability tool's approval card says (title, one lead sentence and labelled rows)
     * in each language. Display only: the decision stays with policy and the call itself.
     */
    card(tool: string, describe: ToolCardDescriber): () => void;
    /** Explicit, typed allowlist for kernel tools whose implementation moved to a capability. */
    delegateKernel(
      tool: import("../runtime/tools/tools.ts").DelegatedKernelToolName,
      run: ToolExecutor,
    ): () => void;
  };
  /** Adds a kind of item to the inbox (its query, badge count and item builder). */
  readonly inbox: { source(source: import("@pibot/storage").InboxSource): void };
  /** Brain standby: report idle work, drain on sleep, and say when to wake. */
  readonly sleep: {
    participate(participant: SleepParticipant): void;
    wakeSource(source: import("../runtime/queue/brain-sleep.ts").WakeSource): void;
    /** Activity that must cancel a pending standby; false once standby is committed. */
    interrupt(): boolean;
  };
  /** Resolves (or refuses) the credentials of a model provider before a run uses it. */
  credentials(providerId: string): Promise<void>;
  readonly models: {
    provide(port: import("../runtime/models/port.ts").ModelProvidersPort): void;
    /** Interactive calls are cancelled on detach and get a fresh signal on reattach. */
    signal(): AbortSignal;
  };
  readonly ports: CapabilityPorts;
}

/**
 * Pre-authorization inside unattended runs: whether an operation is covered, recording the user's
 * "always allow" answer, consuming a resumed decision and auditing. The kernel calls it through
 * `LocalService.unattendedAuthorization`, which fails closed when no owner is registered.
 */
export interface UnattendedAuthorization {
  /** The live run behind this context; throws when its identity no longer matches. */
  record(context: ToolRunContext): UnattendedRunRecord | undefined;
  match(
    context: ToolRunContext,
    prepared: PreparedTool,
    isolated: boolean,
  ): RoutinePreauth | undefined;
  remember(
    context: ToolRunContext,
    prepared: PreparedTool,
    approval: Approval,
    isolated: boolean,
  ): void;
  rememberInRun(
    context: ToolRunContext,
    prepared: PreparedTool,
    approval: Approval,
    isolated: boolean,
  ): void;
  /** A trial run learns which operations its real gate allowed. */
  allowed(context: ToolRunContext, prepared: PreparedTool, isolated: boolean): void;
  /** true = the parked decision allows exactly this operation, false = refuse, undefined = ask. */
  resumed(context: ToolRunContext, prepared: PreparedTool, isolated: boolean): boolean | undefined;
  audit(
    context: ToolRunContext,
    kind: "routine.preauth.allowed",
    detail?: {
      preauthId?: string;
      approvalId?: string;
      reasonCode?: string;
      policySteps?: string[];
    },
  ): void;
}

export interface UnattendedDefinition {
  botId: string;
  enabled: boolean;
  deletedAt?: string | null;
  workplace: UnattendedWorkplace;
  triggers: readonly UnattendedTrigger[];
  preauth: readonly RoutinePreauth[];
}
export interface UnattendedTrialDefinition {
  botId: string;
  enabled: boolean;
  workplace: UnattendedWorkplace;
  triggers: readonly UnattendedTrigger[];
}
export type UnattendedWorkplace =
  | { kind: "bot" }
  | { kind: "folder"; folderId: string; readonly?: string[]; cwd?: string };
export type UnattendedTrigger =
  | { kind: string; path?: string }
  | { config: { kind: string; path?: string } };
export interface UnattendedRunRecord {
  id: string;
  routineId?: string | null;
  trialDraft?: UnattendedTrialDefinition | null;
  botId: string;
  runId: string | null;
  conversationId: string | null;
  status: string;
  reason: string;
  occurrenceId?: string | null;
  waitCheckpoint?: {
    approvalId: string;
    drain?: unknown;
    workspaceSnapshot: WorkspaceSnapshot;
  } | null;
}

/** One external send an unattended run is about to make (facts only, never the content). */
export interface UnattendedSendIntent {
  /** Identifies the tool call, so a replay of the same call keeps its key. */
  callDigest: string;
  connectorId: string;
  tool: string;
  targetDigest: string;
  /** Redacted, for the ledger the user sees. */
  target: string;
  contentDigest: string;
}
/**
 * The run ledger's send side. Each intended send gets an idempotency key that is the same
 * in every attempt of one occurrence (a resume of a failed run), so the send layer can refuse to
 * deliver what an earlier attempt already delivered or may have delivered.
 */
export interface UnattendedSendLedger {
  /** Records the intent; returns its key and the approvals earlier attempts bound to that key. */
  intend(context: ToolRunContext, intent: UnattendedSendIntent): { key: string; earlier: string[] };
  /** The draft that carries this send (inside the transaction that creates it). */
  bind(unattendedRunId: string, key: string, approvalId: string): void;
  /** Not sent: an earlier attempt's draft already covers it. */
  duplicate(unattendedRunId: string, key: string, approvalId: string): void;
}

/** What the kernel asks the owner of unattended runs. */
export interface UnattendedRunOwner {
  /** Send idempotency; an owner without it gets no cross-attempt dedupe. */
  readonly ledger?: UnattendedSendLedger;
  /**
   * Extra read-only folders a run was given, so a later re-check rebuilds
   * the same workspace boundary from the checkpoint.
   */
  temporaryPaths?(unattendedRunId: string): string[];
  /** The run record; throws when it does not exist. */
  run(unattendedRunId: string): UnattendedRunRecord;
  /**
   * The saved definition a run executes; undefined when it never existed. Deletion is soft, so a
   * deleted one is still returned with `deletedAt` set.
   */
  definition(definitionId: string): UnattendedDefinition | undefined;
  /** Records a pre-authorization the user granted on a card inside an unattended run. */
  addPreauth(
    definitionId: string,
    input: RoutinePreauthInput,
    snapshot: WorkspaceSnapshot | null,
  ): void;
  readonly authorization: UnattendedAuthorization;
  /** May this queued run start now? False keeps it queued (another run holds the topic's slot). */
  admit(record: Run, input: QueueInput): boolean;
  /** A user message is about to run in this topic: yield automatic work there first. */
  beforeUser(botId: string, conversationId: string): Promise<void>;
  /** The user stopped this run: end the automation behind it as well. */
  abortRun(runId: string): Promise<boolean>;
  /** A card answered after its run parked (nobody was waiting in memory). */
  resolveParked(
    id: string,
    decision: "allow" | "deny",
    remember: boolean,
    preauthorize: boolean,
  ): Promise<{ ok: true }>;
  /** The live attempt behind an unattended run, or undefined when no process owns it now. */
  identity(
    unattendedRunId: string,
  ): { ownerToken: string; attempt: number; sessionFile: string | null; runId: string } | undefined;
  /** Re-checks a parked run's drain checkpoint before an external send continues it. */
  verifyWaiting(unattendedRunId: string, signal: AbortSignal): Promise<unknown>;
  /** Hooks around one approval of an unattended run (parking, notification); undefined otherwise. */
  approvalLifecycle(
    context: ToolRunContext,
    call: LocalToolCall,
    prepared: PreparedTool,
    isolation: Approval["isolation"],
  ): { requested(approval: Approval): void; resolved(approval: Approval): void } | undefined;
}

/** Runs a tool call a capability owns; returns what the model sees. */
/** Card text for one call; must not read files or the network (it runs while the card opens). */
export type ToolCardDescriber = (
  context: ToolRunContext,
  input: Record<string, unknown>,
  language: "zh" | "en",
) => {
  title: string;
  lead?: string;
  facts: import("@pibot/protocol-base").ApprovalFact[];
  /**
   * The call cannot succeed as written (an unknown Bot, a member that does not exist): no card is
   * shown and the model gets this reason instead, so the person is never asked to approve a step
   * that would only fail.
   */
  invalid?: { code: string; text: string };
};

export type ToolExecutor = (
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  authorization?: {
    confirmedNow: boolean;
    assertCurrent(): void;
    /**
     * What this call's own prepare-phase policy hook returned alongside its requests
     * (e.g. which connections were judged). Per call, so concurrent calls cannot see each other.
     */
    data?: unknown;
  },
) => Promise<import("@pibot/agent").LocalToolResult>;

/** One participant in brain standby; every method must be cheap and must not throw. */
export interface SleepParticipant {
  /** No work in progress that should keep the brain awake. */
  idle(): boolean;
  /** Stop starting new background work before standby and drain what runs. */
  pause?(signal: AbortSignal): Promise<void>;
  resume?(): Promise<void>;
}

/**
 * Behaviour one capability offers others, looked up by name. A provider registers in its
 * `register`; a consumer asks at use time and must degrade explicitly when nothing is there.
 */
export class CapabilityPorts {
  private readonly entries = new Map<string, unknown>();
  provide<T>(name: string, port: T) {
    if (this.entries.has(name)) throw new Error(`Capability port already provided: ${name}`);
    this.entries.set(name, port);
  }
  get<T>(name: string): T | undefined {
    return this.entries.get(name) as T | undefined;
  }
}

/**
 * Starts registered capabilities in order; on failure stops the ones already started (reverse
 * order) before rethrowing, so a half-started brain never leaves a capability running.
 */
export async function startCapabilities(
  handles: readonly CapabilityHandle[],
  /** Called after each handle's start, with its index, for phase timing. */
  started?: (index: number) => void,
) {
  const done: CapabilityHandle[] = [];
  try {
    for (const [index, handle] of handles.entries()) {
      await handle.start?.();
      done.push(handle);
      started?.(index);
    }
  } catch (error) {
    await stopCapabilities(done);
    throw error;
  }
}

/** Reverse order, every stop attempted; the first failure is rethrown after all of them ran. */
export async function stopCapabilities(handles: readonly CapabilityHandle[]) {
  let failure: unknown;
  for (const handle of [...handles].reverse()) {
    try {
      await handle.stop?.();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
