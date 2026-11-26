// Define the policy inputs and filesystem facts used at authorization boundaries.
import type {
  ApprovalFact,
  BotPermissionOverrides,
  Category,
  GitConfigurationFacts,
  GitEntryFacts,
  GitHookFacts,
  Grant,
  GrantScope,
  HostSshFacts,
  ManagedGitConfigurationPolicyInput,
  PermissionsSettings,
  Workplaces,
  WorkspaceSnapshot,
} from "@pibot/protocol-base";

export type PolicyStep = import("@pibot/protocol-base").PolicyStep;

export type Platform = "darwin" | "linux" | "win32";
export type Decision = "allow" | "ask" | "deny";
export type PolicyRequest =
  | { category: "tool_discovery" }
  | { category: "plugin_install" }
  | {
      category: "send_out";
      identity: "user" | "bot";
      connectorId: string;
      tool: string;
      target: string;
      definitionDigest: string;
      targetDigest: string;
      rememberable: boolean;
    }
  | { category: "planning" }
  | { category: "connector"; operation: "discover"; visible: boolean }
  | {
      category: "connector";
      operation: "call";
      /** Absent only on a capability template with no connection behind it; that is denied. */
      connectorId?: string;
      tool?: string;
      visible: boolean;
      readOnly: boolean;
      /**
       * Required so a request built without it cannot silently skip "ask every time" or
       * "read only". Build it with `connectorCallRequest`.
       */
      confirmationMode: import("@pibot/protocol-base").ConnectorConfirmationMode;
    }
  | { category: "read_messages"; target: string; scopeValid: boolean }
  | { category: "image_generation"; recipient: string; provider: string; model: string }
  | { category: "routine_proposal"; operation: "propose" | "query" }
  | { category: "skill_proposal" }
  /** List paired runners, or propose moving a DM topic to a runner folder (card only). */
  | { category: "workplace_proposal"; operation: "list" | "propose" }
  /** The Bot proposes check commands for its folder; only a confirmation card. */
  | { category: "check_proposal" }
  | {
      category: "collaboration";
      operation: "assign_task" | "ask_bot" | "finish_task" | "group_pause";
    }
  /** Hand one piece of work to an external agent Bot (`agent` = its display name). */
  | { category: "agent_delegation"; agent?: string }
  /**
   * The default Pi manages Bots and groups ("list" reads metadata only). `mainDirect` is set by
   * the kernel, never by the capability or the model: true only in Pi's own direct chat typed by
   * the person on this computer. Absent or false is refused.
   */
  | { category: "bot_management"; operation: "list" | "change"; mainDirect?: boolean }
  /** The default Pi sends a message or task to another Bot or a group (`mainDirect` as above). */
  | { category: "work_dispatch"; mainDirect?: boolean }
  | ({
      category: "memory";
      operation: "add" | "update" | "remove";
    } & import("./memory-write.ts").MemoryWriteFacts)
  /** Reading the Bot's own memory notes reaches nothing new; no confirmation needed. */
  | { category: "memory_read" }
  /** A review note in Pi Bot's own database; reads and writes no files. */
  | { category: "review" }
  /** Read data on the paired phone; the phone's own switches and consent decide. */
  | {
      category: "phone_data";
      operation: "media" | "media_get" | "sms_code" | "calls" | "notifications";
    }
  /**
   * `background`: same gate as any command; the card says it keeps running.
   * `writePaths`: writes the model declares because analysis cannot see them (package caches).
   */
  | {
      category: "run_command";
      command: string;
      cwd?: string;
      background?: true;
      stdin?: true;
      writePaths?: string[];
      outsideSandbox?: true;
      /**
       * Maintainers 2026-11-14: present for a command whose network goes through Pi Bot's sandbox
       * proxy (brain leaves it out on Windows, outside the sandbox and for Docker). A
       * local-network host the command names asks unless this run's user already allowed it.
       */
      privateNetwork?: { approved: string[] };
    }
  /** Read the computer's own network state (no card), or ping a local-network host (card). */
  | { category: "local_network"; operation: "info" }
  | { category: "local_network"; operation: "ping"; host: string; approved: string[] }
  /** List / read output of / stop the Bot's own background commands (no new capability). */
  | { category: "background"; operation: "list" | "output" | "wait" | "stop" }
  /** List or close the Bot browser's own tabs; nothing is sent to any site. */
  | { category: "browser_tabs" }
  | { category: "read_file" | "list_dir" | "write_file"; path: string; projectNotes?: boolean }
  | {
      // Screenshot coordinates are host-bound browser input, so they retain this site's gate.
      category: "web";
      browserSensitive?: { kind: string; name: string };
      url: string;
      search?: { disclosed: boolean; configuredEndpoint?: string; confirmBeforeUse?: boolean };
      /** Log in to the current page (`url`) with an account saved for `site`. */
      login?: { site: string };
      /** Submit a form on the Bot browser page `url`. */
      submit?: true;
      /**
       * A cookieless GET by `web_fetch` (not the Bot browser), the only web request a
       * remembered "read public web pages" grant (`web_read`) covers.
       */
      fetch?: true;
      /**
       * Loopback ports the Bot's own background commands listen on now (brain supplies
       * them). Only a `localServiceTarget` URL on one of them is exempt from the local-address ban.
       */
      localPorts?: number[];
      /**
       * Maintainers 2026-11-14: a Bot-browser request (never web_fetch or search) may reach a
       * local-network origin after the user's card; `approved` are this run's allowed origins.
       */
      privateNetwork?: { approved: string[] };
    }
  | {
      category: "computer";
      /** Tool name, for facts and audit only. */
      tool?: string;
      /** App IDs the call operates (`computer-apps.ts`). */
      apps?: string[];
      /** Screenshot clicks or a whole-display screenshot (never "always"). */
      coordinates?: boolean;
      /** The Bot's always-list, supplied by brain from its repository. */
      alwaysApps?: string[];
    }
  | { category: "read_ai_config" };
export interface FileSystem {
  realpath(path: string, signal: AbortSignal): Promise<string>;
  isSymbolicLink?(path: string, signal: AbortSignal): Promise<boolean>;
  /**
   * One call that resolves a whole absolute path on the machine that has it (a runner): the
   * component walk costs one round trip per directory, which over the relay exceeded policy's
   * 10 s budget (round-1 2026-11-12). Used only for paths without `..`, where it matches the walk.
   */
  canonicalize?(path: string, signal: AbortSignal): Promise<{ path: string; exists: boolean }>;
  /**
   * A script's text, for judging what the run does; undefined when it is not a regular
   * file of at most 64 KB. Only the local file system offers it, so remote targets keep asking.
   */
  readScript?(path: string, signal: AbortSignal): Promise<string | undefined>;
  /**
   * The entry names of a local directory (at most a few thousand), so a
   * Python run can be checked for files that shadow standard modules; undefined when the
   * directory cannot be listed or holds more. Local only, like readScript.
   */
  listNames?(directory: string, signal: AbortSignal): Promise<readonly string[] | undefined>;
  /** Bounded local Windows traversal; unsupported or non-regular entries keep the card. */
  windowsReadEntries?: typeof import("../paths/windows-read-tree.ts").windowsReadEntries;
}
export interface PathContext {
  windowsSystemDrive?: string;
  windowsSystemTrees?: readonly string[];
  platform: Platform;
  home: string;
  /** Host credentials/home protection is independent of the `~` expansion base. */
  protectionHome?: string;
  cwd: string;
  roots: string[];
  fs: FileSystem;
  signal: AbortSignal;
}
export interface ResolvedPath {
  path: string;
  root?: string;
  exists: boolean;
}
export interface CommandInvocation {
  program: string;
  args: string[];
}
export interface CommandAnalysis {
  /** Exact outer literal AST command; never an expansion, command list or unwrapped inner call. */
  literalCommand?: CommandInvocation;
  /** Single outer literal command with only one stdout file redirect; grants no write access. */
  literalOutputRedirect?: { command: CommandInvocation; path: string; operator: ">" | ">>" };
  programs: string[];
  commands: CommandInvocation[];
  reads: string[];
  writes: string[];
  domains: string[];
  network: boolean;
  incomplete: boolean;
  warnings: string[];
  unknownOptions: string[];
  readonly: boolean;
  /** A redirect writes a file: its target comes from shell syntax, not the program's arguments. */
  fileRedirect?: true;
  /** The shell opens an output target, including special targets such as /dev/null. */
  outputRedirect?: true;
  /** Indexes into `commands` of pipeline stages after the first (the stage's own program). */
  pipedCommands?: number[];
  /** Some stdin comes from a file, here-string or here-document instead of the pipe. */
  inputRedirect?: true;
  /**
   * Later pipeline stages whose command word is the program itself (no wrapper, path or quoting),
   * with that word's UTF-16 offsets in the analyzed command text.
   */
  filterCandidates?: { index: number; start: number; end: number }[];
  /** `! cmd` inverts the status: it no longer belongs to the program. */
  negated?: true;
  /** Script files the analysis wants read (inside the workplace) to judge the run. */
  scriptFiles?: string[];
  /** `python3 -c` code would be pure if the cwd holds nothing that shadows a standard module. */
  moduleSearchCwd?: true;
  /**
   * The script files (as the command names them, cwd-joined) whose bytes
   * the verdict rests on, with their SHA-256. Execution re-reads them right before the run starts
   * and refuses with `script_changed` if any differs.
   */
  scriptPins?: ScriptPin[];
  /**
   * Interpreter words a script verdict assumed are the system ones (`python3`,
   * `/bin/sh`, a shebang's `env` target). Execution resolves them in the command's PATH before
   * dispatch and refuses one in a writable folder or a version-manager shim.
   */
  scriptInterpreters?: string[];
}
export interface ScriptPin {
  path: string;
  sha256: string;
}
export interface EvaluationInput {
  /** Current effective skill runtime read roots, supplied by brain; never writable grants. */
  commandReadRoots?: readonly string[];
  /** Trusted target probe for command risk and automatic execution; absent means unconfirmed. */
  commandIsolation?: (signal: AbortSignal) => Promise<boolean>;
  /** Brain's facts on whether this call may leave the sandbox; never model input. */
  outsideSandbox?: import("./outside-sandbox.ts").OutsideSandboxFacts;
  /** Outside write paths remembered for a folder and program; brain facts only. */
  rememberedWritePaths?: readonly { folder: string; program: string; path: string }[];
  /** Host-prepared setter diagnostics; never caller-supplied execution authority. */
  gitConfiguration?: GitConfigurationFacts;
  gitHooksPath?: {
    verifyCurrent(facts: GitConfigurationFacts, command: string): "current" | "changed";
  };
  /** Private issuer-bound file adapter; a copied diagnostic fact alone never grants a write. */
  gitConfigurationFile?: {
    verifyCurrent(facts: GitConfigurationFacts, requestedPath: string): "current" | "changed";
  };
  /** Call-bound managed-Git adapter injected by prepare; never an RPC/model authority flag. */
  managedGitConfiguration?: ManagedGitConfigurationPolicyInput;
  gitHook?: GitHookFacts;
  /** Host facts: project hooks / executable config an ordinary Git command would run. */
  gitEntries?: GitEntryFacts;
  hostSsh?: HostSshFacts;
  /** Ephemeral, user-approved public GET sites of this Bot and conversation only. */
  conversationWebDomains?: readonly string[];
  /** Trusted ephemeral consent for the current live group task/plan, never a durable grant. */
  taskWebReadAllowed?: boolean;
  /** Trusted ordinary DM owner; absent for routines, groups and delegated work. */
  workplaceTopicId?: string;
  /** Supplied only for actual read_file/list_dir calls; search/send aliases never get this. */
  aiConfigReadBoundary?: { roots: readonly string[]; globs: readonly string[] };
  /** Trusted lexical/canonical deny roots supplied by brain from exec's sole sensitive list. */
  sensitiveReadRoots?: readonly string[];
  /**
   * Pi Bot's data layout: other Bots' skills, memory and sessions sit under these roots and are
   * never this run's to read. Refusing them is the point — an approval card with "always allow"
   * would have handed another Bot's data over for good. `allowed` names the roots of the
   * current Bot and group that stay readable inside the same layout.
   */
  botData?: { roots: readonly string[]; allowed: readonly string[] };
  boundary?: WorkspaceSnapshot;
  cwd?: string;
  botId: string;
  request: PolicyRequest;
  settings: PermissionsSettings;
  /** Trusted provenance for already-merged settings; explanation only, never an authority input. */
  permissionSources?: Partial<Record<Category, PolicyStep["source"]>>;
  botOverrides?: BotPermissionOverrides;
  /**
   * Brain's fact from the Bot's own row (`confirmEverySend`), passed separately because a group
   * run's settings come from the group and must not drop it. Only send_out reads it.
   */
  confirmEverySend?: boolean;
  grants?: Grant[];
  /**
   * In-memory grants of this run only (a folder allowed once outside the workplace is
   * allowed for the rest of the run). Matched after the remembered grants, never persisted.
   */
  runGrants?: Grant[];
  workplace: Workplaces;
  /**
   * The group's own artifact roots (`<primary>/.pibot/out`). Writing a file there is what
   * that run is for, so the "ask" level no longer asks; "never" still refuses.
   */
  groupOutputRoots?: readonly string[];
  /**
   * The Bot's own skills folder: reading or listing inside it is always allowed,
   * like the Bot's memory, so a skill named in the system prompt can actually be loaded.
   */
  skillsRoot?: string;
  skillsRoots?: readonly string[];
  /**
   * The Bot's own managed attachments folder. Pi Bot writes these files itself and names
   * the path in the message, so reading one back is intrinsic app data, never a grant.
   */
  attachmentsRoot?: string;
  /**
   * The run's conversation has YOLO on. A decision that would ask becomes "allow" with
   * reason "yolo" except dangerous or mandatory confirmations; denies stay denies. Brain sets it
   * only for chat runs, never for routines.
   */
  yolo?: boolean;
  signal: AbortSignal;
  /** Per-call injection also supports callers that already canonicalize filesystem access. */
  realpath?: FileSystem["realpath"];
  /** With `realpath`: the whole-path resolver of the same machine (see FileSystem.canonicalize). */
  canonicalize?: FileSystem["canonicalize"];
  /**
   * Brain's protected write roots (exec's sensitive list and the Pi Bot data directory),
   * used for outside writes and Windows command text warnings. A caller that supplies none cannot
   * show the per-call card, so its outside writes stay refused (`outside_workplace_write_denied`).
   */
  protectedWriteRoots?: (signal: AbortSignal) => Promise<readonly string[]>;
  /** Target-owned scan metadata; deliberately separate from local outside-write grants. */
  commandProtectionRoots?: (signal: AbortSignal) => Promise<readonly string[]>;
}
export interface PolicyResult {
  /** Per-call restriction for automatically allowed sandbox commands; never model input. */
  commandNetwork?: { allowAll: boolean; domains: string[] };
  /** Present only for a safely scoped public GET, never browser or search calls. */
  conversationWebDomain?: string;
  taskWebReadAvailable?: boolean;
  explanation: PolicyStep[];
  /** A target-derived permission category; the underlying tool identity stays intact. */
  category?: Category;
  secretUses?: Array<{ name: string; revision: number }>;
  canRememberSecrets?: boolean;
  decision: Decision;
  reason: string;
  risk: "normal" | "danger";
  facts: ApprovalFact[];
  canRemember: boolean;
  grantScope?: GrantScope;
  /**
   * A routine-only pre-authorization scope for a read script whose analysis is incomplete
   * (`script:<digest>` + file, rooted at the cwd). Never a remembered grant; set only on the
   * ordinary "cannot fully analyse" ask, removed whenever a stronger card takes over.
   */
  scriptScope?: GrantScope;
  analysis?: CommandAnalysis;
  path?: ResolvedPath;
  cwd?: string;
  command?: string;
  /** The execution environment's Bot home, never the host user's profile. */
  commandHome?: string;
  url?: string;
  domain?: string;
  /**
   * Canonical write targets outside every workplace that this one call asks to change
   * (shown on the card), and the roots execution may open for this call only once a person allows
   * it: the target itself, or its nearest existing folder when it does not exist yet.
   */
  outsideWrites?: string[];
  outsideWriteRoots?: string[];
  /** Every outside write is a path remembered for this folder and program. */
  outsideWritesRemembered?: boolean;
  /**
   * Maintainers 2026-11-14: the local-network targets this call reaches (browser origins or command
   * hosts). With PRIVATE_NETWORK_REASON they are what a person's answer opens for this run.
   */
  privateTargets?: string[];
  /**
   * ACP editor terminal: the "program + argument shape" a person may allow for the rest of this
   * ACP session only (`applyEditorTerminal`). Absent when the command must ask every time.
   */
  editorSessionShape?: string;
}
export interface PolicyOptions {
  windowsSystemDrive?: string;
  windowsSystemTrees?: readonly string[];
  platform: Platform;
  userHome: string;
  fs?: FileSystem;
  resourcesDir?: string;
  wasmPaths?: { core: string; bash: string };
}
export interface Policy {
  evaluate(input: EvaluationInput): Promise<PolicyResult>;
  analyzeCommand(command: string): CommandAnalysis;
  dispose(): void;
}
export interface GrantCandidate {
  commandPaths?: readonly string[];
  writableRoots?: readonly string[];
  botId: string;
  category: Category;
  scope: GrantScope;
}
