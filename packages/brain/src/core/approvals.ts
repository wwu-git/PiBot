import type { LocalToolCall } from "@pibot/agent";
import { rememberableSystemService } from "@pibot/execution";
import {
  createGrantScope,
  explainPolicyResult,
  type PolicyResult,
  yoloMustAsk,
} from "@pibot/policy";
import {
  type Approval,
  type ApprovalFact,
  type ApprovalFinalStatus,
  type ComputerApprovalRequest,
  credentialSiteLabel,
  isPiManagerCategory,
  type LoginApprovalRequest,
  RpcError,
  type ToolTiming,
} from "@pibot/protocol-base";
import {
  ApprovalPausesRepo,
  ApprovalsRepo,
  AuditRepo,
  BotsRepo,
  ConversationsRepo,
  GrantsRepo,
  MessagesRepo,
  PermissionsRepo,
  SettingsRepo,
  SidebarRepo,
  ToolCallsRepo,
  transaction,
} from "@pibot/storage";
import { abortable } from "./abort.ts";
import { approvalDisplay } from "./approval-display.ts";
import type {
  ApprovalFolderChange,
  PreparedApprovalFolderChange,
} from "./approval-folder-change.ts";
import { approvalNotification } from "./approval-notification.ts";
import { approvalCallHash, approvalFactsHash } from "./approval-pause.ts";
import { auditLeaf, auditText, auditToolFields } from "./audit-fields.ts";
import type { LocalDependencies, ToolRunContext } from "./local-types.ts";
import { resolvePersonaLanguage } from "./personas/language.ts";
import { redactValue } from "./privacy.ts";
import { toolPermissionCategory } from "./tool-category.ts";

export class ApprovalChangedError extends RpcError {
  constructor() {
    super(-32602, "Approval authorization changed");
  }
}

interface Waiting {
  taskWebScope?: string;
  editorSessionShape?: string;
  folderChange?: ApprovalFolderChange;
  folderChanging?: boolean;
  signal: AbortSignal;
  detach(): void;
  expire(): void;
  approval: Approval;
  context: ToolRunContext;
  evaluate(): Promise<PolicyResult>;
  finish(
    status: ApprovalFinalStatus,
    remember?: boolean,
    result?: PolicyResult,
    preauthorize?: boolean,
    by?: ResolvedBy,
    rememberSecrets?: string[],
    connectorConsent?: "once" | "bot" | "all",
    folderChange?: PreparedApprovalFolderChange,
    allowConversation?: boolean,
    allowTaskWeb?: boolean,
    allowSession?: boolean,
  ): void;
}
/** The connection tool a card asks about, taken from the resolved call rather than model text. */
export interface ConnectorCardDisplay {
  id: string;
  name: string;
  tool: string;
  /** Bundled display translation of the tool; the MCP description is untrusted and not shown. */
  label?: { zh: string; en: string };
}
/** Who answered a card: the user, or YOLO turned on in its conversation. */
export type ResolvedBy = "user" | "yolo" | "task" | "acp";
export class ApprovalService {
  /** Tells clients a Bot's permission levels changed (set by the kernel after startup). */
  levelChanged?: (botId: string) => void;
  parkedResolve?: (
    id: string,
    decision: "allow" | "deny",
    remember: boolean,
    preauthorize: boolean,
  ) => Promise<{ ok: true }>;
  pausedResolve?: (id: string, decision: "allow" | "deny") => Promise<{ ok: true }>;
  deniedOnResume(context: ToolRunContext, call: LocalToolCall): boolean {
    return (
      new ApprovalPausesRepo(this.deps.db).consume(context.runId, approvalCallHash(call)) ===
      "denied"
    );
  }
  /** Specialized cards must persist their choices after the timeout has established the pause. */
  pauseExpiredChat(id: string) {
    const waiter = this.waiting.get(id);
    if (
      waiter?.context.pauseForApproval &&
      !waiter.context.routineRunId &&
      Date.parse(waiter.approval.expiresAt) <= Date.now()
    )
      waiter.expire();
  }
  private readonly taskWebScopes = new Set<string>();
  taskWebIdentity(context: ToolRunContext) {
    return this.taskScope(context);
  }
  taskWebAllowed(context: ToolRunContext) {
    const scope = this.taskScope(context);
    return !!scope && this.taskWebScopes.has(scope);
  }
  revokeTaskWeb(scope: string) {
    this.taskWebScopes.delete(scope);
  }
  private readonly conversationSites = new Map<string, Set<string>>();
  webDomains(context: ToolRunContext): readonly string[] {
    const key = this.webScope(context);
    return key ? [...(this.conversationSites.get(key) ?? [])] : [];
  }
  private webScope(context: ToolRunContext): string | undefined {
    return context.conversationId &&
      !context.groupId &&
      !context.routineRunId &&
      !context.executionTaskId
      ? `${context.botId}:${context.conversationId}`
      : undefined;
  }
  /**
   * ACP "allow for this session": command shapes per Bot and ACP topic, in memory only. Each ACP
   * session gets its own topic and lives in one `pibot acp` process, so the shapes end with it.
   */
  private readonly editorSessions = new Map<string, Set<string>>();
  editorSessionShapes(context: ToolRunContext): ReadonlySet<string> {
    const key = this.webScope(context);
    return (key && this.editorSessions.get(key)) || new Set();
  }
  clearWebDomains() {
    this.conversationSites.clear();
    this.taskWebScopes.clear();
    this.editorSessions.clear();
  }
  readonly repo: ApprovalsRepo;
  readonly audit: AuditRepo;
  readonly grants: GrantsRepo;
  private readonly bots: BotsRepo;
  private readonly settings: SettingsRepo;
  private readonly waiting = new Map<string, Waiting>();
  private readonly queues = new Map<string, Promise<void>>();
  isIdle() {
    return this.waiting.size === 0 && this.queues.size === 0;
  }
  constructor(
    private readonly deps: LocalDependencies,
    private readonly taskScope: (context: ToolRunContext) => string | undefined = () => undefined,
  ) {
    this.repo = new ApprovalsRepo(deps.db);
    this.audit = new AuditRepo(deps.db, deps.redactor);
    this.grants = new GrantsRepo(deps.db);
    this.bots = new BotsRepo(deps.db);
    this.settings = new SettingsRepo(deps.db);
  }
  recover() {
    for (;;) {
      const pending = this.repo.pendingForRecovery({ limit: 200 });
      if (!pending.length) break;
      transaction(this.deps.db, () => {
        for (const value of pending) {
          this.repo.resolve(value.id, "expired");
          this.audit.append({
            botId: value.botId,
            runId: value.runId,
            kind: "approval.resolved",
            summary: "Approval expired after restart / 重启后审批过期",
            detail: {
              ...auditToolFields(
                { tool: value.category, input: {} },
                this.deps.redactor,
                value,
                this.deps.capabilityTools,
              ),
              botName: auditText(this.bots.get(value.botId)?.name ?? "Bot", this.deps.redactor),
              category: value.category,
              approvalId: value.id,
              toolCallId: value.toolCallId,
              status: "expired",
              actor: "system",
              decision: "deny",
              remember: false,
            },
          });
        }
      });
    }
  }
  async serial<T>(
    botId: string,
    signal: AbortSignal,
    action: () => Promise<T>,
    timing?: ToolTiming,
  ): Promise<T> {
    const previous = this.queues.get(botId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => next);
    this.queues.set(botId, chain);
    void chain.then(() => {
      if (this.queues.get(botId) === chain) this.queues.delete(botId);
    });
    try {
      if (timing) await timing.measure("queue", () => abortable(previous, signal));
      else await abortable(previous, signal);
      signal.throwIfAborted();
      return await action();
    } finally {
      release();
    }
  }
  request(
    context: ToolRunContext,
    call: LocalToolCall,
    result: PolicyResult,
    isolation: Approval["isolation"],
    evaluate: () => Promise<PolicyResult>,
    onAllowed?: () => void,
    lifecycle?: {
      requested(approval: Approval): void;
      resolved(approval: Approval, by: ResolvedBy): void;
      resuming?(choice: unknown): void;
    },
    consent?: { available: boolean; allow(approval: Approval): void },
    // The "operate your computer" card carries its own payload and title; the
    // first-login card its site and account choices; a connection tool card its trusted names.
    card?: {
      computer?: ComputerApprovalRequest;
      login?: LoginApprovalRequest;
      connector?: ConnectorCardDisplay;
      /** Original delegated request spelling; policy facts retain their canonical identities. */
      facts?: ApprovalFact[];
      title?(language: "zh" | "en"): string;
      /** A capability's own card text (labelled rows, one lead sentence) in each language. */
      text?(language: "zh" | "en"): { title: string; lead?: string; facts: ApprovalFact[] };
    },
    folderChange?: ApprovalFolderChange,
  ): Promise<ApprovalFinalStatus> {
    context.signal.throwIfAborted();
    const { deps } = this;
    const pauseRepo = new ApprovalPausesRepo(deps.db);
    const callHash = approvalCallHash(call);
    const factsHash = approvalFactsHash(context, call, result, isolation);
    const resumed = transaction(deps.db, () => {
      const status = pauseRepo.consume(context.runId, callHash, factsHash, call.id);
      if (status === "allowed") {
        if (lifecycle?.resuming) lifecycle.resuming(pauseRepo.takeChoice(context.runId, call.id));
        onAllowed?.();
      }
      return status;
    });
    if (resumed) return Promise.resolve(resumed);
    const taskWebScope =
      call.tool === "web_fetch" && result.taskWebReadAvailable
        ? this.taskScope(context)
        : undefined;
    const editorSessionShape =
      call.tool === "run_command" && result.risk === "normal" && this.webScope(context)
        ? result.editorSessionShape
        : undefined;
    const botName = auditText(this.bots.get(context.botId)?.name ?? "Bot", deps.redactor);
    const device = context.executionDevice
      ? {
          name: auditText(context.executionDevice.name, deps.redactor),
          target: context.executionDevice.target,
        }
      : undefined;
    const connector = card?.connector
      ? {
          ...card.connector,
          name: auditText(card.connector.name, deps.redactor),
          tool: auditText(card.connector.tool, deps.redactor, 4096),
        }
      : undefined;
    // The card is written in both languages so it follows a later language switch;
    // `title` / `facts` keep the language of the moment (audit, notifications, older readers).
    const textFor = (
      language: "zh" | "en",
    ): { title: string; shown: string; lead?: string; facts: ApprovalFact[] } => {
      const zh = language === "zh";
      const described = card?.text?.(language);
      if (described) {
        const facts = described.facts.map((fact) => ({
          ...fact,
          value: auditText(fact.value, deps.redactor, 2000),
          ...(fact.label ? { label: fact.label.slice(0, 80) } : {}),
        }));
        const title = auditText(described.title, deps.redactor);
        return {
          title,
          shown: title,
          ...(described.lead ? { lead: auditText(described.lead, deps.redactor, 1000) } : {}),
          facts,
        };
      }
      const display = approvalDisplay(
        call,
        // The title names the connection and tool; their internal ids are not for people.
        connector
          ? result.facts.filter(
              (fact) =>
                fact.kind !== "read" ||
                (fact.value !== connector.id && fact.value !== card?.connector?.tool),
            )
          : (card?.facts ?? result.facts),
        language,
        botName,
        {
          secrets: !!result.secretUses?.length,
          ...(connector
            ? {
                connector: {
                  name: connector.name,
                  tool: connector.label?.[language] || connector.tool,
                },
              }
            : {}),
        },
      );
      if (result.secretUses?.length)
        display.facts.push({
          kind: "warning",
          value: zh
            ? `访问令牌（不会显示值）：${result.secretUses.map((use) => use.name).join("、")}`
            : `Access tokens (values hidden): ${result.secretUses.map((use) => use.name).join(", ")}`,
        });
      const deviceScope = device ? `${device.name} (${device.target})` : undefined;
      if (device && deviceScope) {
        display.facts.push({
          kind: "warning",
          value: `${zh ? "执行设备" : "Execution device"}: ${deviceScope}`,
        });
        if (call.tool === "run_command")
          display.title = zh
            ? `${botName} 想在 ${device.name} 上运行命令`
            : `${botName} wants to run a command on ${device.name}`;
      }
      if (result.canRemember && result.grantScope) {
        const scope = result.grantScope;
        const description =
          scope.kind === "send_target"
            ? scope.target
            : scope.kind === "programs"
              ? // A pinned script is named by its content's digest; say so in words.
                `${scope.root} (${scope.programs
                  .filter((program) => !program.startsWith("script-file:"))
                  .map((program) =>
                    program.startsWith("script:")
                      ? zh
                        ? "按内容核对过的脚本"
                        : "a script checked by its content"
                      : program,
                  )
                  .join(", ")})`
              : scope.kind === "domain" || scope.kind === "submit"
                ? scope.domain
                : scope.kind === "folder"
                  ? scope.path
                  : scope.kind === "apps"
                    ? scope.apps.join(", ")
                    : scope.kind === "login"
                      ? credentialSiteLabel(scope.site)
                      : scope.kind === "connector" || scope.kind === "connector_tool"
                        ? connector?.id === scope.connectorId
                          ? connector.name
                          : scope.connectorId
                        : scope.kind === "secret"
                          ? scope.name
                          : scope.kind === "web_read"
                            ? zh
                              ? "读取公开网页（只读获取；不含 Bot 浏览器、登录、提交表单和内网地址）"
                              : "Reading public web pages (read-only fetch; not the Bot browser, logins, form submissions or private addresses)"
                            : scope.kind === "paid_image"
                              ? zh
                                ? `这个 Bot 用 ${scope.provider} / ${scope.model} 付费生成图片（换模型会再问）`
                                : `This Bot generating paid images with ${scope.provider} / ${scope.model} (another model asks again)`
                              : scope.root;
        display.facts.push({
          kind: "warning",
          value: `${zh ? "记住授权的实际范围" : "Actual scope of remembered permission"}: ${deviceScope ? `${deviceScope} · ` : ""}${description}`,
        });
      }
      const sent = () =>
        result.facts
          .filter((f) => f.kind === "read")
          .map((f) => auditLeaf(f.value, deps.redactor))
          .join(zh ? "、" : ", ");
      const title =
        result.category === "read_ai_config"
          ? zh
            ? `${botName} 想读其他 AI 工具的配置`
            : `${botName} wants to read another AI tool's configuration`
          : call.tool === "send_file"
            ? zh
              ? `${botName} 想把 ${sent()} 发给你`
              : `${botName} wants to send you ${sent()}`
            : call.tool === "web_search" && result.reason === "search_disclosure_required"
              ? zh
                ? "免 Key 搜索服务：查询词可能发给 DuckDuckGo（duckduckgo.com）或 Microsoft Bing（bing.com）"
                : "Keyless search: queries may be sent to DuckDuckGo (duckduckgo.com) or Microsoft Bing (bing.com)"
              : call.tool === "web_search" && result.domain === "cn.bing.com"
                ? zh
                  ? "查询词会发给 Microsoft Bing（bing.com）"
                  : "Queries will be sent to Microsoft Bing (bing.com)"
                : (card?.title?.(language) ?? display.title);
      return {
        title,
        shown: context.routineName
          ? `${context.routineName} (${zh ? "例行任务" : "routine"}) · ${title}`.slice(0, 200)
          : title,
        facts: display.facts,
      };
    };
    const texts = { zh: textFor("zh"), en: textFor("en") };
    const { title, shown, facts } = texts[context.language];
    const searchDisclosure =
      call.tool === "web_search" && result.reason === "search_disclosure_required"
        ? {
            provider: "keyless" as const,
            querySummary: deps.redactor
              .redact(String(call.input.query ?? ""))
              .replace(/[\p{Cc}\p{Cf}]/gu, " ")
              .slice(0, 240),
          }
        : undefined;
    const auditFields = {
      ...auditToolFields(call, deps.redactor, result, deps.capabilityTools),
      botName: auditText(this.bots.get(context.botId)?.name ?? "Bot", deps.redactor),
      source: context.routineSource ?? context.auditSource ?? ("chat" as const),
      ...(context.routineRunId ? { routineRunId: context.routineRunId } : {}),
    };
    const input = {
      botId: context.botId,
      runId: context.runId,
      messageId: context.messageId,
      toolCallId: call.id,
      category: call.tool.startsWith("memory_")
        ? ("memory" as const)
        : (result.category ??
          toolPermissionCategory(call.tool, this.deps.capabilityTools) ??
          call.tool),
      risk: result.risk,
      title: shown,
      localized: {
        zh: {
          title: texts.zh.shown,
          ...(texts.zh.lead ? { lead: texts.zh.lead } : {}),
          facts: texts.zh.facts,
        },
        en: {
          title: texts.en.shown,
          ...(texts.en.lead ? { lead: texts.en.lead } : {}),
          facts: texts.en.facts,
        },
      },
      ...(searchDisclosure ? { searchDisclosure } : {}),
      ...(call.tool === "web_fetch" &&
      result.risk === "normal" &&
      result.conversationWebDomain &&
      this.webScope(context)
        ? { conversationWebDomain: result.conversationWebDomain }
        : {}),
      ...(taskWebScope ? { taskWebRead: true as const } : {}),
      ...(editorSessionShape ? { editorSession: true as const } : {}),
      ...(card?.computer ? { computer: card.computer } : {}),
      ...(card?.login ? { login: card.login } : {}),
      ...(connector
        ? {
            connectorCall: {
              bot: botName,
              name: connector.name,
              tool: connector.tool,
              ...(connector.label ? { label: connector.label } : {}),
            },
          }
        : {}),
      facts,
      explanation: result.explanation,
      ...(result.canRemember && result.grantScope ? { grantScope: result.grantScope } : {}),
      ...(result.secretUses?.length
        ? {
            secretUses: result.secretUses,
            rememberOnly: "secrets" as const,
            canRememberSecrets: result.canRememberSecrets === true,
          }
        : {}),
      canRemember: context.routineRunId ? false : result.canRemember,
      ...(folderChange ? { canAddWritableFolder: true } : {}),
      canPreauthorize: context.routineSource === "routine" && !!consent?.available,
      ...(context.routineRunId
        ? { routineRunId: context.routineRunId, source: context.routineSource ?? "routine" }
        : {}),
      expiresAt: new Date(
        Date.now() + (context.routineRunId ? (context.routineApprovalWaitMs ?? 86400000) : 600000),
      ).toISOString(),
      isolation,
      ...(result.command ? { command: result.command } : {}),
      ...(result.url ? { url: result.url } : {}),
      ...(result.domain ? { domain: result.domain } : {}),
    };
    const approval = transaction(deps.db, () => {
      const value = this.repo.create(
        redactValue(input, deps.redactor) as Parameters<ApprovalsRepo["create"]>[0],
      );
      this.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "approval.requested",
        summary: title,
        detail: {
          ...auditFields,
          approvalId: value.id,
          toolCallId: call.id,
          category: value.category,
          risk: value.risk,
        },
      });
      // The checkpoint and approval must commit together; a failed hook cannot leave an orphan.
      try {
        lifecycle?.requested(value);
      } catch (error) {
        context.routineClock?.resume("approval");
        context.executionClock?.resume("approval");
        throw error;
      }
      return value;
    });
    const timing = context.toolTiming?.(call.id);
    const endWait = timing?.enter("approvalWait");
    const evaluatePolicy = evaluate;
    evaluate = () => (timing ? timing.measure("policy", evaluatePolicy) : evaluatePolicy());
    return new Promise<ApprovalFinalStatus>((resolve, reject) => {
      const lifetime = new AbortController();
      context.routineClock?.pause("approval");
      context.executionClock?.pause("approval");
      let timer: ReturnType<typeof setTimeout>;
      let finished = false;
      const cleanup = () => {
        context.routineClock?.resume("approval");
        context.executionClock?.resume("approval");
        finished = true;
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
        this.waiting.delete(approval.id);
        lifetime.abort();
      };
      const automatic = (status: ApprovalFinalStatus) => {
        try {
          finish(status);
        } catch (error) {
          cleanup();
          reject(error);
          deps.logger.error("Approval finalization failed");
        }
      };
      const pause = () => {
        if (finished) return;
        if (!context.pauseForApproval || context.routineRunId) {
          automatic(context.routineRunId ? "expired" : "auto_denied");
          return;
        }
        try {
          transaction(deps.db, () => {
            pauseRepo.pause(approval.id, callHash, factsHash);
            const messages = new MessagesRepo(deps.db);
            const usage = messages.get(context.messageId)?.usage;
            messages.update(context.messageId, {
              usage: {
                ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
                executionPause: { reason: "approval", summary: "" },
              },
            });
            this.audit.append({
              botId: context.botId,
              runId: context.runId,
              kind: "approval.paused",
              summary: "Approval expired; waiting for you / 审批到期暂停，等你确认",
              detail: {
                approvalId: approval.id,
                toolCallId: call.id,
                actor: "system",
                reasonCode: "approval_timeout_paused",
              },
            });
          });
          cleanup();
          context.pauseForApproval(approval.id);
          deps.peer.emit("inbox.changed", {});
          resolve("cancelled");
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const abort = () => automatic("cancelled");
      const finish = (
        status: ApprovalFinalStatus,
        remember = false,
        current?: PolicyResult,
        preauthorize = false,
        by: ResolvedBy = "user",
        rememberSecrets: string[] = [],
        connectorChoice?: "once" | "bot" | "all",
        folderChange?: PreparedApprovalFolderChange,
        allowConversation = false,
        allowTaskWeb = false,
        allowSession = false,
      ) => {
        if (finished) return;
        const checked = current?.explanation ?? result.explanation;
        const terminal =
          status === "allowed"
            ? {
                axis: by === "yolo" ? ("yolo" as const) : ("grant" as const),
                code:
                  by === "yolo"
                    ? "yolo"
                    : by === "task"
                      ? "approval_task_web_allowed"
                      : "approval_user_allowed",
                effect: "allow" as const,
              }
            : {
                axis: "grant" as const,
                code:
                  status === "denied"
                    ? "approval_user_denied"
                    : status === "cancelled"
                      ? "approval_cancelled"
                      : "approval_expired",
                effect: "deny" as const,
              };
        const resolvedExplanation = [
          ...checked,
          ...(rememberSecrets.length
            ? [
                {
                  axis: "secret" as const,
                  code: "remember_secret_checked",
                  effect: "info" as const,
                },
              ]
            : []),
          ...(remember
            ? [{ axis: "grant" as const, code: "remember_grant_checked", effect: "info" as const }]
            : []),
          ...(current?.decision === "deny" ? [] : [terminal]),
        ];
        transaction(deps.db, () => {
          folderChange?.commit();
          // First-use access widening is gone (no card offers it since a
          // migration); an old client's choice can only confirm this one call.
          if (connectorChoice === "all" || connectorChoice === "bot")
            throw new RpcError(-32602, "Invalid connector consent");
          if (preauthorize) {
            if (status !== "allowed" || !approval.canPreauthorize || !consent?.available)
              throw new RpcError(-32602, "Approval cannot preauthorize this routine");
            consent.allow(approval);
          }
          const sandboxConsent =
            current?.reason === "local_service_once" || current?.reason === "system_service_once";
          if (remember && sandboxConsent && current) {
            const folder = current.cwd;
            const program = current.analysis?.commands?.[0]?.program;
            const target = current.facts.findLast((fact) => fact.kind === "network")?.value;
            if (!folder || !program || !target || deps.platform !== "darwin")
              throw new RpcError(-32602, "Sandbox consent changed");
            const repo = new SettingsRepo(deps.db);
            const settings = repo.get();
            if (settings.strictSandbox) throw new RpcError(-32602, "Sandbox consent changed");
            if (current.reason === "system_service_once") {
              if (!rememberableSystemService(target))
                throw new RpcError(-32602, "Sandbox consent changed");
              const entries = settings.sandboxAutoSystemServices ?? [];
              repo.set({
                sandboxAutoSystemServices: [
                  ...entries.filter(
                    (e) => !(e.folder === folder && e.program === program && e.service === target),
                  ),
                  { folder, program, service: target, createdAt: Date.now() },
                ].slice(-256),
              });
            } else {
              const entries = settings.sandboxAutoLocalServices ?? [];
              repo.set({
                sandboxAutoLocalServices: [
                  ...entries.filter(
                    (e) => !(e.folder === folder && e.program === program && e.target === target),
                  ),
                  { folder, program, target, createdAt: Date.now() },
                ].slice(-256),
              });
            }
            this.audit.append({
              botId: context.botId,
              runId: context.runId,
              kind: "permissions.changed",
              summary: "Sandbox permission remembered / 已记住沙箱授权",
              detail: { actor: "user", reasonCode: "sandbox_permission_remembered" },
            });
          }
          // The default Pi's management and dispatch cards remember by changing Pi's own level
          // to "always" (the same switch as its permissions page); no grant is created.
          const levelRemember = remember && isPiManagerCategory(approval.category);
          if (levelRemember) {
            if (status !== "allowed" || !this.bots.get(context.botId)?.isMain)
              throw new RpcError(-32602, "Approval cannot be remembered");
            const permissions = new PermissionsRepo(deps.db);
            permissions.setBotOverrides(context.botId, {
              ...(permissions.getBotOverrides(context.botId) ?? {}),
              [approval.category]: "always",
            });
            this.audit.append({
              botId: context.botId,
              runId: context.runId,
              kind: "permissions.changed",
              summary: "Permission set to always from a card / 已从卡片改成总是允许",
              detail: {
                actor: "user",
                category: approval.category,
                approvalId: approval.id,
                reasonCode: "pi_manager_always",
              },
            });
          }
          if ((remember && !sandboxConsent && !levelRemember) || rememberSecrets.length) {
            if (approval.category === "memory")
              throw new RpcError(-32602, "Memory approval cannot be remembered");
            // Separate controls: a legacy remember=true can never authorize secret or command
            // persistence on a combined card. Only the explicitly selected names are saved.
            const scopes = rememberSecrets.length
              ? rememberSecrets.map((name) => ({ kind: "secret" as const, name }))
              : [current && createGrantScope(current)];
            for (const scope of scopes) {
              if (!scope) throw new RpcError(-32602, "Approval cannot be remembered");
              const grant = this.grants.create({
                botId: context.botId,
                category: scope.kind === "secret" ? "run_command" : approval.category,
                scope,
                ...((context.permissionGroupId ?? context.groupId)
                  ? { groupId: context.permissionGroupId ?? context.groupId }
                  : {}),
              });
              this.audit.append({
                botId: context.botId,
                runId: context.runId,
                kind: "grant.created",
                summary: "Permission remembered / 已记住授权",
                detail: {
                  ...auditFields,
                  grantId: grant.id,
                  category: grant.category,
                  approvalId: approval.id,
                  actor: "user",
                },
              });
            }
          }
          if (status === "allowed") onAllowed?.();
          if (!this.repo.resolve(approval.id, status, remember, resolvedExplanation))
            throw new RpcError(-32602, "Approval is no longer pending");
          if (by === "yolo" && status === "allowed")
            new ToolCallsRepo(deps.db).markYoloApproval(approval.id, approval.risk);
          this.audit.append({
            botId: context.botId,
            runId: context.runId,
            kind: "approval.resolved",
            summary: `Approval ${status}`,
            detail: {
              ...auditFields,
              policySteps: resolvedExplanation.map((step) => step.code),
              category: approval.category,
              approvalId: approval.id,
              toolCallId: call.id,
              decision: status === "allowed" ? "allow" : "deny",
              remember,
              ...(allowConversation ? { reasonCode: "conversation_web_read" } : {}),
              ...(allowSession ? { reasonCode: "editor_session_command" } : {}),
              ...(allowTaskWeb || by === "task"
                ? { reasonCode: "task_web_read", target: taskWebScope, groupId: context.groupId }
                : {}),
              ...(connectorChoice ? { connectorConsent: connectorChoice } : {}),
              status,
              ...(by === "acp" ? { answeredVia: "acp" as const } : {}),
              actor:
                current?.decision === "deny"
                  ? "system"
                  : by !== "user" && by !== "acp"
                    ? "automatic"
                    : status === "allowed" || status === "denied"
                      ? "user"
                      : "automatic",
              ...(current?.decision === "deny"
                ? { reasonCode: current.reason }
                : by === "yolo"
                  ? { reasonCode: "yolo" }
                  : {}),
            },
          });
        });
        folderChange?.committed();
        cleanup();
        const resolvedApproval = this.repo.get(approval.id);
        if (resolvedApproval) {
          try {
            lifecycle?.resolved(resolvedApproval, by);
          } catch (error) {
            reject(error);
            throw error;
          }
        }
        resolve(status);
        if (remember && isPiManagerCategory(approval.category)) this.levelChanged?.(context.botId);
        if (
          remember &&
          (current?.reason === "local_service_once" || current?.reason === "system_service_once")
        )
          deps.peer.emit("settings.changed", new SettingsRepo(deps.db).get());
        deps.peer.emit("approval.resolved", { id: approval.id, status, remembered: remember });
        deps.peer.emit("inbox.changed", {});
        if (preauthorize) deps.peer.emit("routines.changed", {});
      };
      timer = setTimeout(pause, Math.max(1, Date.parse(approval.expiresAt) - Date.now()));
      context.signal.addEventListener("abort", abort, { once: true });
      this.waiting.set(approval.id, {
        ...(taskWebScope ? { taskWebScope } : {}),
        ...(editorSessionShape ? { editorSessionShape } : {}),
        signal: AbortSignal.any([context.signal, lifetime.signal]),
        folderChange,
        approval,
        context,
        evaluate,
        finish,
        expire: pause,
        detach: () => {
          cleanup();
          resolve("cancelled");
        },
      });
      try {
        const message = new MessagesRepo(deps.db).get(context.messageId);
        const conversation = message
          ? new ConversationsRepo(deps.db).get(message.conversationId)
          : undefined;
        const conversationKey = conversation?.groupId
          ? `group:${conversation.groupId}`
          : `dm:${context.botId}`;
        new SidebarRepo(deps.db).activity(conversationKey, true);
        deps.peer.emit("sidebar.changed", { conversationKey });
        deps.peer.emit("approval.requested", approval);
        deps.peer.emit("inbox.changed", {});
      } catch (error) {
        automatic("cancelled");
        reject(error);
        return;
      }
      if (context.signal.aborted) abort();
      if (deps.host.notify)
        void Promise.resolve()
          .then(() => {
            const notification = approvalNotification({
              botName: this.bots.get(context.botId)?.name,
              tool: call.tool,
              result,
              language: resolvePersonaLanguage(
                this.settings.get().language,
                Intl.DateTimeFormat().resolvedOptions().locale,
              ),
              redactor: deps.redactor,
            });
            return deps.host.notify?.(
              {
                ...notification,
                botId: context.botId,
                tab: "permissions",
                ...(context.routineRunId
                  ? {
                      title: deps.redactor.redact(`Pi · ${context.routineName ?? "Routine"}`),
                      body: deps.redactor.redact(approval.title).slice(0, 80),
                      routineRunId: context.routineRunId,
                      ...(context.conversationId
                        ? { conversationId: context.conversationId, messageId: context.messageId }
                        : {}),
                    }
                  : {}),
              },
              AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
            );
          })
          .catch(() => deps.logger.warn("Approval notification unavailable"));
    }).finally(() => endWait?.());
  }
  detachForPark(runId: string) {
    for (const value of this.waiting.values())
      if (value.context.runId === runId && value.context.routineRunId) value.detach();
  }
  /** Cards still waiting whose run matches (YOLO lets a conversation's cards through). */
  waitingIn(match: (context: ToolRunContext) => boolean): Approval[] {
    return [...this.waiting.values()]
      .filter((waiter) => match(waiter.context))
      .map((waiter) => waiter.approval);
  }
  async resolve(
    id: string,
    decision: "allow" | "deny",
    remember: boolean,
    preauthorize = false,
    by: ResolvedBy = "user",
    rememberSecrets: string[] = [],
    connectorConsent?: "once" | "bot" | "all",
    allowConversation = false,
    allowTaskWeb = false,
    allowSession = false,
  ): Promise<{ ok: true }> {
    const waiter = this.waiting.get(id);
    const storedPause = new ApprovalPausesRepo(this.deps.db).get(id);
    if (storedPause && this.pausedResolve) {
      // Persistent/session grants require the new run's current authority, not a stopped waiter.
      if (
        remember ||
        preauthorize ||
        rememberSecrets.length ||
        connectorConsent ||
        allowConversation ||
        allowTaskWeb ||
        allowSession ||
        (by !== "user" && by !== "acp")
      )
        throw new RpcError(-32602, "Paused approval requires a one-time user decision");
      if (decision === "allow" && this.repo.get(id)?.computer && !storedPause.choice)
        throw new RpcError(-32602, "computer_grant_resolve_required");
      return this.pausedResolve(id, decision);
    }
    if (
      allowSession &&
      (!waiter?.approval.editorSession ||
        !waiter.editorSessionShape ||
        !this.webScope(waiter.context) ||
        (by !== "user" && by !== "acp") ||
        decision !== "allow" ||
        remember ||
        preauthorize ||
        rememberSecrets.length ||
        connectorConsent ||
        allowConversation ||
        allowTaskWeb)
    )
      throw new RpcError(-32602, "Invalid session command consent");
    if (
      allowTaskWeb &&
      (!waiter?.approval.taskWebRead ||
        !waiter.taskWebScope ||
        this.taskScope(waiter.context) !== waiter.taskWebScope ||
        (by !== "user" && by !== "acp") ||
        decision !== "allow" ||
        remember ||
        preauthorize ||
        rememberSecrets.length ||
        connectorConsent ||
        allowConversation)
    )
      throw new RpcError(-32602, "Invalid task website consent");
    if (
      connectorConsent !== undefined &&
      (!waiter?.approval.connectorConsent ||
        decision !== "allow" ||
        (by !== "user" && by !== "acp") ||
        remember ||
        preauthorize ||
        rememberSecrets.length)
    )
      throw new RpcError(-32602, "Invalid connector consent");
    if (
      allowConversation &&
      (!waiter?.approval.conversationWebDomain ||
        !this.webScope(waiter.context) ||
        (by !== "user" && by !== "acp") ||
        decision !== "allow" ||
        remember ||
        preauthorize ||
        rememberSecrets.length ||
        connectorConsent)
    )
      throw new RpcError(-32602, "Invalid conversation website consent");
    // Legacy per-Bot remember remains compatible; only the explicit all choice expands access.
    if (connectorConsent === "bot") remember = true;
    if (
      rememberSecrets.length &&
      (remember || preauthorize || decision !== "allow" || (by !== "user" && by !== "acp"))
    )
      throw new RpcError(-32602, "Invalid secret consent");
    if (!waiter && this.repo.get(id)?.routineRunId && this.parkedResolve) {
      if (rememberSecrets.length) throw new RpcError(-32602, "Routine cannot remember secrets");
      return this.parkedResolve(id, decision, remember, preauthorize);
    }
    if (!waiter || this.repo.get(id)?.status !== "pending")
      throw new RpcError(-32602, "Approval is no longer pending");
    waiter.context.signal.throwIfAborted();
    if (preauthorize && (remember || decision !== "allow" || !waiter.approval.canPreauthorize))
      throw new RpcError(-32602, "Invalid routine consent");
    if (Date.now() >= Date.parse(waiter.approval.expiresAt)) {
      waiter.expire();
      if (
        !waiter.context.routineRunId &&
        this.pausedResolve &&
        new ApprovalPausesRepo(this.deps.db).get(id)
      )
        return this.resolve(
          id,
          decision,
          remember,
          preauthorize,
          by,
          rememberSecrets,
          connectorConsent,
          allowConversation,
          allowTaskWeb,
          allowSession,
        );
      throw new RpcError(-32602, "Approval has expired");
    }
    if (decision === "deny") {
      waiter.finish("denied");
      return { ok: true as const };
    }
    const result = await waiter.evaluate();
    waiter.context.signal.throwIfAborted();
    if (this.waiting.get(id) !== waiter || this.repo.get(id)?.status !== "pending")
      throw new RpcError(-32602, "Approval is no longer pending");
    if (Date.now() >= Date.parse(waiter.approval.expiresAt)) {
      waiter.expire();
      if (
        !waiter.context.routineRunId &&
        this.pausedResolve &&
        new ApprovalPausesRepo(this.deps.db).get(id)
      )
        return this.resolve(
          id,
          decision,
          remember,
          preauthorize,
          by,
          rememberSecrets,
          connectorConsent,
          allowConversation,
          allowTaskWeb,
          allowSession,
        );
      throw new RpcError(-32602, "Approval has expired");
    }
    if (result.decision === "deny") {
      waiter.finish("denied", false, result);
      throw new RpcError(-32602, "Permission is now disallowed");
    }
    if (
      allowConversation &&
      (result.risk !== "normal" ||
        result.conversationWebDomain !== waiter.approval.conversationWebDomain)
    )
      throw new RpcError(-32602, "Conversation website consent changed");
    if (
      allowTaskWeb &&
      (!result.taskWebReadAvailable ||
        result.risk !== "normal" ||
        this.taskScope(waiter.context) !== waiter.taskWebScope)
    )
      throw new RpcError(-32602, "Task website consent changed");
    if (
      allowSession &&
      (result.risk !== "normal" || result.editorSessionShape !== waiter.editorSessionShape)
    )
      throw new RpcError(-32602, "Session command consent changed");
    if (by === "task" && (result.decision !== "allow" || result.reason !== "task_web_read"))
      return { ok: true as const };
    // Automatic release is not a user answer. Leave mandatory confirmation pending,
    // returning normally so the YOLO release loop does not reject it in its recovery path.
    if (by === "yolo" && yoloMustAsk(result)) return { ok: true as const };
    if (
      connectorConsent !== undefined &&
      (!result.canRemember ||
        result.risk === "danger" ||
        result.grantScope?.kind !== "connector" ||
        result.grantScope.connectorId !== waiter.approval.connectorConsent?.connectorId)
    )
      throw new RpcError(-32602, "Connector consent changed");
    if (
      remember &&
      (!waiter.approval.canRemember || !result.canRemember || result.risk === "danger")
    )
      throw new RpcError(-32602, "This approval cannot be remembered");
    if (
      rememberSecrets.length &&
      (!waiter.approval.canRememberSecrets ||
        !result.canRememberSecrets ||
        result.risk === "danger" ||
        new Set(rememberSecrets).size !== rememberSecrets.length ||
        rememberSecrets.some(
          (name) =>
            !result.secretUses?.some(
              (use) =>
                use.name === name &&
                waiter.approval.secretUses?.some(
                  (shown) => shown.name === name && shown.revision === use.revision,
                ),
            ),
        ))
    )
      throw new RpcError(-32602, "Secret consent changed or cannot be remembered");
    try {
      waiter.finish(
        "allowed",
        remember,
        result,
        preauthorize,
        by,
        rememberSecrets,
        connectorConsent,
        undefined,
        allowConversation,
        allowTaskWeb,
        allowSession,
      );
      const sessionKey = allowSession ? this.webScope(waiter.context) : undefined;
      if (sessionKey && waiter.editorSessionShape) {
        // Bounded like the website consent above; eviction narrows authority and asks again.
        const oldest = this.editorSessions.keys().next().value;
        if (!this.editorSessions.has(sessionKey) && this.editorSessions.size >= 512 && oldest)
          this.editorSessions.delete(oldest);
        const shapes = this.editorSessions.get(sessionKey) ?? new Set<string>();
        const first = shapes.values().next().value;
        if (shapes.size >= 200 && first) shapes.delete(first);
        shapes.add(waiter.editorSessionShape);
        this.editorSessions.set(sessionKey, shapes);
      }
      if (
        allowTaskWeb &&
        waiter.taskWebScope &&
        this.taskScope(waiter.context) === waiter.taskWebScope
      ) {
        const first = this.taskWebScopes.values().next().value;
        if (this.taskWebScopes.size >= 512 && first) this.taskWebScopes.delete(first);
        this.taskWebScopes.add(waiter.taskWebScope);
        // Other members may already have a card; re-evaluate them under the same live scope.
        for (const [pendingId, pending] of this.waiting) {
          if (pending.taskWebScope !== waiter.taskWebScope) continue;
          void this.resolve(pendingId, "allow", false, false, "task").catch(() => {
            this.deps.logger.warn("Task website approval release unavailable");
          });
        }
      }
      if (allowConversation) {
        const key = this.webScope(waiter.context);
        if (key && result.conversationWebDomain) {
          // Bounded memory; eviction narrows authority and merely asks again.
          const oldest = this.conversationSites.keys().next().value;
          if (!this.conversationSites.has(key) && this.conversationSites.size >= 512 && oldest)
            this.conversationSites.delete(oldest);
          const domains = this.conversationSites.get(key) ?? new Set<string>();
          const first = domains.values().next().value;
          if (domains.size >= 100 && first) domains.delete(first);
          domains.add(result.conversationWebDomain);
          this.conversationSites.set(key, domains);
        }
      }
    } catch (error) {
      if (error instanceof ApprovalChangedError)
        waiter.finish(
          "denied",
          false,
          explainPolicyResult(
            {
              ...result,
              decision: "deny",
              reason: "changed",
              canRemember: false,
            },
            "boundary",
            "changed",
          ),
        );
      throw error;
    }
    return { ok: true as const };
  }
  cancel(runId?: string) {
    for (const waiter of [...this.waiting.values()])
      if (!runId || waiter.context.runId === runId) waiter.finish("cancelled");
  }
  async addWritableFolder(id: string, parent: AbortSignal) {
    const waiter = this.waiting.get(id);
    if (!waiter?.folderChange) throw new RpcError(-32601, "approval_folder_unsupported");
    if (waiter.folderChanging) throw new RpcError(-32011, "folder_picker_busy");
    const signal = AbortSignal.any([parent, waiter.signal, AbortSignal.timeout(650_000)]);
    const assertPending = () => {
      signal.throwIfAborted();
      if (
        this.waiting.get(id) !== waiter ||
        this.repo.get(id)?.status !== "pending" ||
        Date.now() >= Date.parse(waiter.approval.expiresAt)
      )
        throw new RpcError(-32602, "approval_no_longer_pending");
    };
    assertPending();
    waiter.folderChanging = true;
    try {
      const change = await waiter.folderChange(signal, assertPending);
      assertPending();
      if (!change) return { added: false };
      const result = await waiter.evaluate();
      assertPending();
      if (result.decision === "deny" || result.reason !== "outside_workplace_write")
        throw new RpcError(-32602, "workspace_boundary_changed");
      waiter.finish(
        "denied",
        false,
        explainPolicyResult(
          { ...result, decision: "deny", reason: "workspace_folder_added", canRemember: false },
          "boundary",
          "workspace_folder_added",
        ),
        false,
        "user",
        [],
        undefined,
        change,
      );
      this.deps.peer.emit("sidebar.changed", { conversationKey: `dm:${waiter.context.botId}` });
      this.deps.peer.emit("bots.changed", { botId: waiter.context.botId, reason: "updated" });
      this.deps.peer.emit("changes.changed", {
        conversationKey: `dm:${waiter.context.botId}`,
        topicId: waiter.context.conversationId,
        reason: "folder",
      });
      return { added: true };
    } finally {
      waiter.folderChanging = false;
    }
  }
  cancelBot(botId: string) {
    for (const waiter of [...this.waiting.values()])
      if (waiter.context.botId === botId) waiter.finish("cancelled");
  }
}
