import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { BotPageSchema } from "../core/page.ts";
import { SandboxBlockKindSchema } from "../execution/sandbox-block.ts";
import { PhoneRunnerReceiptSchema } from "../runner/offline-receipt.ts";
import { CapabilityIdSchema, CapabilityImplTypeSchema } from "../tools/capabilities.ts";
import { ApprovalCategorySchema, ApprovalStatusSchema, RiskSchema } from "./approvals.ts";
import { DomainSchema } from "./settings.ts";

const text = z.string().min(1);
const time = z.iso.datetime();
const count = z.number().int().nonnegative().safe();
export const AuditKindSchema = z.enum([
  "acp.attach",
  "acp.detach",
  "acp.session.new",
  // An ACP client continued an existing topic instead of opening one.
  "acp.session.attach",
  "bot.updated",
  "feedback.opened",
  "hook.finished",
  "remote.request",
  "remote.changed",
  // A Bot read the paired phone (category and item count; never content or codes).
  "phone.data_read",
  "phone.wake",
  "personal_todo.changed",
  "routine.run.cancelled",
  "routine.created",
  "routine.updated",
  "routine.deleted",
  "routine.paused",
  "routine.resumed",
  "routine.proposed",
  "routine.proposal.resolved",
  "routine.preauth.allowed",
  "routine.preauth.revoked",
  "group.topic.renamed",
  "group.topic.restored",
  "group.topic.switched",
  "group.topic.created",
  "group.topic.archived",
  // Saved group references removed from Bots' session files (counts only, never content).
  "group.reference.purged",
  "topic.folder.added",
  "topic.folder.removed",
  "topic.folder.moved",
  "topic.folder.move_declined",
  "outputs.migrated",
  "group.folder.added",
  "group.folder.removed",
  "approval.requested",
  "approval.paused",
  "approval.resolved",
  "exec.started",
  "exec.promoted_to_background",
  "exec.finished",
  "delivery.evidence",
  "file.checkpoint",
  "file.written",
  "file.sent",
  // A Bot read a file (path only) / fetched a web page (hostname only), so a run's receipt
  // can list its inputs by folder and domain. Never the content.
  "file.read",
  // A Bot showed a file or folder in the system file manager (path only).
  "file.revealed",
  "web.fetched",
  "image.loaded",
  "image.started",
  "image.finished",
  "messages.read",
  "import.changed",
  "grant.created",
  "grant.revoked",
  "policy.denied",
  "oauth.changed",
  "provider.imported",
  "network.changed",
  "permissions.changed",
  "search.sent",
  "collaboration.queued",
  "collaboration.completed",
  "collaboration.cancelled",
  // A direct request the member answered as plain chat; the task closed without work.
  "group.task.quiet",
  "group.workflow.started",
  "group.workflow.migrated",
  "group.workflow.recovered",
  "group.workflow.step_dispatched",
  "group.workflow.step_passed",
  "group.workflow.step_failed",
  "group.workflow.step_blocked",
  // Maintainers 2026-11-14: Pi Bot merged a plan step's own workspace into the group folder.
  "group.workflow.step_merged",
  "group.workflow.disposition",
  "group.workflow.completed",
  // Facts only (how long, which site); nothing typed or clicked during takeover.
  "browser.takeover",
  "browser.data_cleared",
  "browser.google_compat",
  // The user closed a Bot browser tab (site hostname only, never the full URL).
  "browser.tab_closed",
  // The user opened a Bot's own local service (background command port) in its browser.
  "browser.local_opened",
  // The user typed an address into the Bot browser (site hostname only).
  "browser.user_opened",
  "browser.user_browser",
  // A skill was created, imported, edited, enabled/disabled, removed or proposed/resolved.
  "skill.changed",
  "skill.downloaded",
  // A skill's runtime environment was prepared, failed, or removed. Counts and a reason
  // code only; the command text and its output stay in the environment's log file.
  "skill.runtime.prepared",
  // The user asked Pi Bot to install Git system-wide (started, then how it ended); the command
  // text and outcome only, never the installer's output.
  "git.install",
  "memory.changed",
  // Saved website accounts. Site, display name and Bots only; never the secret.
  "credential.saved",
  "credential.updated",
  "credential.deleted",
  "credential.revealed",
  "credential.filled",
  // A background command started / stopped or ended (command text, reason; no output).
  "exec.background.started",
  "exec.background.stopped",
  // A conversation's YOLO switch turned on / off (conversation and Bot/group only).
  "yolo.changed",
  "topic.archived",
  "topic.restored",
  "execution.changed",
  "execution.todo.changed",
  "execution.todo.paused",
  // An automatic continuation was dropped at the root's round / no-progress limit.
  "execution.continuation.limited",
  "execution.continuation.restored",
  // A run or the interactive client could not be drained; only the reason is recorded.
  "runtime.drain_failed",
  // The user asked to force-release a failed drain (requested / released / refused).
  "runtime.force_release",
  // New commands paused because a previous command was not confirmed stopped (reasonCode
  // paused / stuck / recovered); fixed codes only, never command text.
  "runtime.commands_paused",
  "execution.task.changed",
  // Bots/groups created from a role, template, profession or imported file; a group file
  // exported. Counts and built-in ids only, never personas, norms or skill content.
  "team.created",
  "team.exported",
  // A Bot / group took a newer built-in version (adopted, partial, permission) or the
  // user kept the current one (kept). Role / template id, versions and counts only.
  "builtin.updated",
  // The role library was checked or one role / template installed from it (id@version and
  // a failure code; never the catalog's text).
  "builtin.catalog",
  // The automatic check switch / rounds / a folder's commands changed (actor user).
  "autocheck.changed",
  // One check round ended (verdict, duration, round; the command, never its output).
  "autocheck.finished",
  // A "come help for a moment" card was shown / answered (failure code and hint, app id,
  // the choice and how long it waited; never screen content).
  "computer.handoff",
  "plugin.changed",
  "connector.changed",
  "connector.called",
  "capability.changed",
  "secret.changed",
  // The execution journal of non-read tool calls. Tool name, effect class, attempt and
  // reason only; never arguments, results or content.
  // started: recorded before dispatch. finished: settled as done or failed (reasonCode).
  // replay_blocked: an identical call was not executed (already done, still running, or unknown).
  // unknown: the outcome could not be established (stopped, timed out, or left by a restart).
  "tool.journal.started",
  "tool.journal.finished",
  "tool.journal.replay_blocked",
  "tool.journal.unknown",
  // A restart cut a running chat / group run off (actor system; `entryCount` = its calls
  // with an unknown outcome), and the user resumed one (`target` = the interrupted run, `runId` =
  // the new run). Run ids, counts and reason codes only; never prompts or tool arguments.
  // A 「加预算继续」 is a run.resumed with reasonCode `budget_raised`, `costUsd` (new cap),
  // `amountUsd` (added) and `used` (raises of this root so far).
  "run.interrupted",
  "run.resumed",
  // User-requested retention cleanup, counts only; never paths or event payloads.
  "run.retention.requested",
  "run.retention.cleaned",
  "command.logs.prune",
  // An external coding agent (Codex, Claude Agent, …) started or ended a turn, or asked
  // for a permission that Pi Bot answered. Agent id, isolation and counts only, never content.
  "external_agent.started",
  "external_agent.prewarmed",
  "external_agent.permission",
  "external_agent.finished",
  // The default Pi created, changed, archived or restored a Bot or group (action code, names,
  // changed field names), or handed work to one (target name, the task's short title and the
  // receipt's status). Never personas, task text or replies.
  "pi.managed",
  "pi.dispatched",
]);
export const AuditAuthEventSchema = z.enum([
  "oauth.connected",
  "oauth.disconnected",
  "oauth.subscription_removed",
  "oauth.subscriptions_removed",
  "oauth.chatgpt_migrated",
  "oauth.failed",
  "oauth.reauth_required",
  "oauth.risk_acknowledged",
  "oauth.risk_acknowledged_models_may_be_enabled",
  "unknown",
]);
export type AuditAuthEvent = z.infer<typeof AuditAuthEventSchema>;
// Detail contains facts only. Tool output, prompts and file content have separate storage paths.
export const AuditDetailSchema = z.strictObject({
  conversationImport: z
    .strictObject({
      importId: IdSchema,
      source: z.string().min(1).max(32),
      state: z.enum(["completed", "cancelled", "failed", "undone"]),
      topics: count,
      messages: count,
      memories: count.optional(),
      persona: z.literal(true).optional(),
      // Single-file fields of earlier batches stay readable in the audit log.
      projectFile: z.literal("AGENTS.md").optional(),
      keptProjectFile: z.literal("AGENTS.md").optional(),
      projectFiles: count.optional(),
      folders: count.optional(),
      keptProjectFiles: count.optional(),
      keptFolders: count.optional(),
    })
    .optional(),
  pluginInstall: z
    .strictObject({
      name: z.string().max(200),
      version: z.string().max(100),
      components: count,
      domains: z.array(z.string().max(253)).max(100),
    })
    .optional(),
  skillDownload: z
    .strictObject({
      host: z.string().min(1).max(253),
      owner: z.string().min(1).max(100).optional(),
      repo: z.string().min(1).max(100).optional(),
      ref: z.string().min(1).max(512).optional(),
      commit: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .optional(),
    })
    .optional(),
  skillRuntime: z
    .strictObject({
      runtime: z.enum(["python", "node"]),
      packages: count.max(1000),
      result: z.enum(["ready", "failed", "removed"]),
      reasonCode: z.string().max(64).optional(),
    })
    .optional(),
  memoryScope: z.enum(["user", "bot", "group", "project"]).optional(),
  memoryOwnerId: z.union([IdSchema, z.literal("user")]).optional(),
  memoryId: IdSchema.optional(),
  memoryProposalId: IdSchema.optional(),
  trigger: z.literal("background_finished").optional(),
  backgroundCommandId: IdSchema.optional(),
  /** Exact fetched URL fingerprint; the URL and its query never enter the audit. */
  sourceDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  deviceId: IdSchema.optional(),
  offlineRunner: PhoneRunnerReceiptSchema.optional(),
  /**
   * exec.* / file.* on another computer (`runner:<id>`): which device ran the command or holds the
   * file. Recorded here because the run's own workplace says only that it was remote, and 「这条
   * 命令在哪台机器上跑的」 must be answerable from the audit alone.
   */
  deviceName: text.max(200).optional(),
  deviceTarget: text.max(200).optional(),
  connectorConsent: z.enum(["once", "bot", "all"]).optional(),
  conversationId: IdSchema.optional(),
  messageCount: count.max(50).optional(),
  conversationCount: count.max(50).optional(),
  modelId: text.max(200).optional(),
  imageMode: z.enum(["text-to-image", "image-to-image"]).optional(),
  imageCount: count.max(5).optional(),
  providerId: text.optional(),
  providerName: text.max(200).optional(),
  botName: text.max(200).optional(),
  targetBotName: text.max(200).optional(),
  taskTitle: text.max(200).optional(),
  taskSummary: text.max(200).optional(),
  toolName: text.max(80).optional(),
  /** Which external agent, how it ran and what kind of action it asked for; no content. */
  externalAgent: z
    .strictObject({
      agentId: z.enum(["codex", "claude", "cursor", "opencode", "antigravity", "custom"]),
      isolation: z.enum(["sandbox", "unisolated"]).optional(),
      actionKind: z
        .string()
        .regex(/^[a-z_]{1,20}$/)
        .optional(),
      mapped: z.boolean().optional(),
      steps: count.optional(),
      roots: count.optional(),
    })
    .optional(),
  target: text.max(200).optional(),
  reasonCode: text.max(80).optional(),
  policySteps: z
    .array(z.string().regex(/^[a-z0-9_]{1,64}$/))
    .max(200)
    .optional(),
  collaborationAction: z
    .enum(["assign", "ask", "complete", "cancel", "completion_wake", "return"])
    .optional(),
  botRole: z.enum(["coordinator", "assignee"]).optional(),
  internal: z.boolean().optional(),
  groupId: IdSchema.optional(),
  groupName: text.max(200).optional(),
  targetBotId: IdSchema.optional(),
  childRunId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  workflowRunId: IdSchema.optional(),
  stepId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  workflowAction: z.enum(["retry", "skip", "reassign", "accept"]).optional(),
  stepCount: count.max(20).optional(),
  credentialId: IdSchema.optional(),
  installationId: IdSchema.optional(),
  connectorId: IdSchema.optional(),
  /** connector.called: user secrets the connection's configuration read (names, never values). */
  secretNames: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
    .max(64)
    .optional(),
  capabilityId: CapabilityIdSchema.optional(),
  capabilityImpl: CapabilityImplTypeSchema.optional(),
  connectorOperationId: IdSchema.optional(),
  revision: count.optional(),
  catalogVersion: count.optional(),
  botIds: z.array(IdSchema).max(500).optional(),
  // Unknown legacy event strings remain readable without exposing their constants or rejecting the page.
  authEvent: z
    .string()
    .max(200)
    .transform((value) => AuditAuthEventSchema.safeParse(value).data ?? "unknown")
    .optional(),
  routineId: IdSchema.optional(),
  routineRunId: IdSchema.optional(),
  preauthId: IdSchema.optional(),
  // "external_agent" marks what an external agent did through Pi Bot.
  source: z.enum(["chat", "routine", "trial", "external_agent"]).optional(),
  answeredVia: z.literal("acp").optional(),
  acpClient: z.strictObject({ name: z.string().max(120), version: z.string().max(100) }).optional(),
  acpFolders: z.array(z.string().max(32768)).max(21).optional(),
  approvalId: IdSchema.optional(),
  toolCallId: text.optional(),
  toolId: z.string().min(1).max(200).optional(),
  schemaVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  implementationVersion: z
    .string()
    .regex(/^\d+:[a-f0-9]{64}$/)
    .optional(),
  grantId: IdSchema.optional(),
  category: ApprovalCategorySchema.optional(),
  risk: RiskSchema.optional(),
  decision: z.enum(["allow", "deny"]).optional(),
  remember: z.boolean().optional(),
  actor: z.enum(["user", "automatic", "system", "phone"]).optional(),
  status: ApprovalStatusSchema.optional(),
  reason: z.string().optional(),
  command: z.string().optional(),
  commandHome: text.max(4096).optional(),
  /** Bounded policy targets shown for this call, not observations that the command touched them. */
  commandReads: z.array(text.max(4096)).max(16).optional(),
  commandWrites: z.array(text.max(4096)).max(16).optional(),
  programs: z.array(text).optional(),
  path: text.optional(),
  /** Browser local-file receipt; the path is relative to an authorized workplace root. */
  fileExtension: text.max(16).optional(),
  /** Exec.*: folders outside every workplace a person opened for this one command. */
  writeRoots: z.array(text.max(4096)).max(16).optional(),
  cwd: text.optional(),
  url: text.optional(),
  domain: text.optional(),
  /** Which of the user's browsers a Bot used, and the page action (open, click, …). */
  browser: z.enum(["chrome", "edge", "brave", "chromium", "firefox", "unknown"]).optional(),
  browserAction: z.string().min(1).max(32).optional(),
  /** browser.takeover — sites a login form was submitted on (hostnames only). */
  signedIn: z.array(DomainSchema).max(3).optional(),
  bytes: count.optional(),
  pdfProgress: z
    .strictObject({
      read: z.number().int().min(0).max(20),
      total: z.number().int().min(0).max(20),
      truncated: z.boolean(),
    })
    .optional(),
  contentDigest: z.string().max(200).optional(),
  contentLength: count.optional(),
  edited: z.boolean().optional(),
  /** skill.changed (imported package): how many files and how many of them are runnable. */
  fileCount: count.optional(),
  /** outputs.migrated: entries moved to .pibot/out and entries left (name taken). */
  movedCount: count.optional(),
  skippedCount: count.optional(),
  /** run.retention.cleaned: requested cutoff and removed record counts. */
  olderThanDays: count.max(36_500).optional(),
  runCount: count.optional(),
  eventCount: count.optional(),
  executionCount: count.optional(),
  /** Session entries a purge replaced; tool.journal.unknown at startup: how many
   * in-flight calls a restart left without outcome. */
  entryCount: count.optional(),
  /** SSH host settings removed because the configuration no longer defines them. */
  removedCount: count.optional(),
  scriptCount: count.optional(),
  /** team.created / team.exported. */
  botCount: count.optional(),
  groupCount: count.optional(),
  skillCount: count.optional(),
  exitCode: z.number().int().safe().nullable().optional(),
  /** A search command exited 1 with no output — "no matches", not a failure. */
  noMatches: z.literal(true).optional(),
  /** command started: this run was confirmed to leave the sandbox once. */
  outsideSandbox: z.literal(true).optional(),
  /**
   * command finished: a listed outside run executed its stdin filter stages by their
   * verified system path instead of a PATH lookup; the approved text is unchanged.
   */
  outsideFilters: z.literal("pinned_system_path").optional(),
  /** command finished: categories of a recognized sandbox block; no paths. */
  sandboxBlockKinds: z.array(SandboxBlockKindSchema).min(1).max(9).optional(),
  durationMs: count.optional(),
  timedOut: z.boolean().optional(),
  stopped: z.boolean().optional(),
  /** autocheck.finished: 0 = right after the turn, 1..3 = after a fix round. */
  round: count.max(3).optional(),
  /** execution.continuation.limited: rounds already spent from the root's continuation budget. */
  used: count.optional(),
  /** execution.continuation.restored: what the user's restart decision did to one chain. */
  restore: z.enum(["resumed", "discarded", "dropped", "kept"]).optional(),
  /** remote.request: names of the settings a phone write changed, never their values. */
  fields: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/))
    .max(40)
    .optional(),
  /** phone.data_read: which phone data, and how many items came back. */
  phoneData: z.enum(["media", "media_get", "sms_code", "calls", "notifications"]).optional(),
  itemCount: count.max(100).optional(),
  /** web.fetched: the auxiliary model read the page, or that step fell back to raw text. */
  pageExtract: z.enum(["auxiliary", "fallback"]).optional(),
  /** tool.journal.*: the call's effect class and how many times this key was executed. */
  effectClass: z.enum(["idempotent", "local_effect", "external"]).optional(),
  attempt: count.max(1000).optional(),
  /**
   * run.resumed with reasonCode `budget_raised`: the workflow's new cost cap and how much
   * the user's raise added (USD). Amounts only.
   */
  costUsd: z.number().positive().max(10_000).optional(),
  amountUsd: z.number().positive().max(10_000).optional(),
  /** plugin.changed: one item brought over from another AI tool; never its content. */
  originTool: z.enum(["claude-code", "codex", "cursor", "pi", "opencode"]).optional(),
  itemKind: z.enum(["skill", "mcp", "plugin"]).optional(),
  itemName: text.max(200).optional(),
  outcome: z.enum(["imported", "skipped", "failed"]).optional(),
  /** computer.handoff: the card appeared, or how it ended. */
  handoff: z.enum(["shown", "continued", "declined", "timeout", "cancelled"]).optional(),
});
export const AuditEntrySchema = z.strictObject({
  id: IdSchema,
  at: time,
  botId: IdSchema,
  kind: AuditKindSchema,
  summary: z.string(),
  detail: AuditDetailSchema,
  runId: IdSchema.nullable(),
});
export const AuditQuerySchema = BotPageSchema.extend({
  kind: AuditKindSchema.optional(),
  groupId: IdSchema.optional(),
});
const _botId = z.strictObject({ botId: IdSchema });
export const ActivityCountQuerySchema = z.strictObject({
  botId: IdSchema.optional(),
  groupId: IdSchema.optional(),
  from: time.optional(),
});
// Old connector records have no internal flag; producers and grouped reads share their markers.
export const legacyInternalConnectorSummaries = [
  "Connector lifecycle intent recorded",
  "Connector catalog published",
  "Connector resources drained",
] as const;
export const AuditCountBucketSchema = z.strictObject({
  source: z.enum(["audit", "computer", "background"]),
  kind: AuditKindSchema.nullable(),
  category: ApprovalCategorySchema.nullable(),
  internal: z.boolean(),
  count,
});
export const AuditMethods = {
  "audit.list": { params: AuditQuerySchema, result: z.array(AuditEntrySchema).max(200) },
  "audit.counts": {
    params: ActivityCountQuerySchema,
    result: z.array(AuditCountBucketSchema).max(10_000),
  },
} as const;
export type ActivityCountQuery = z.infer<typeof ActivityCountQuerySchema>;
export type AuditCountBucket = z.infer<typeof AuditCountBucketSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditKind = z.infer<typeof AuditKindSchema>;
export type AuditDetail = z.infer<typeof AuditDetailSchema>;
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
