import type { TranslationKey } from "@pibot/i18n";
import {
  type AuditEntry,
  type AuditKind,
  connectorAuditEvent,
  internalConnectorAuditEvents,
} from "@pibot/protocol";
import { toolNameKey } from "../tools/presentation.ts";
import { checkpointAuditResult, isFileCheckpoint } from "./checkpoint.ts";
import {
  type AuditT,
  auditAuth,
  auditImageProvider,
  auditImageReason,
  auditOperation,
  auditProvider,
  auditReason,
  gitInstallReason,
  isKnownImageReason,
  safeAuditText,
} from "./facts.ts";
import { groupWorkflowSummary } from "./group-workflow.ts";
import { isRoutineAuditKind, routineAuditResult, routineAuditSummary } from "./routine-audit.ts";

type T = AuditT;
export const auditFilters = [
  "all",
  "approval",
  "scheduling",
  "run",
  "file",
  "web",
  "send",
  "connectors",
  "phone",
  "collaboration",
  "identity",
] as const;
export type AuditFilter = (typeof auditFilters)[number];
export type AuditRange = "7" | "30" | "90" | "all";
type AuditGroup = Exclude<AuditFilter, "all">;
/**
 * The only kind → group table: the row badge (`auditGroup`) and the filter that lists and counts
 * a record (`auditKinds` / `auditMatches`) both read it, so a record can no longer show one group
 * and be missing from it. Two candidates mean the category decides (a denied send, a
 * connector call that sent); every other kind has exactly one group, so per-filter counts add up
 * to "all". Exhaustive `Record<AuditKind, …>`: a new protocol kind fails typecheck until someone
 * decides its group instead of silently falling into 审批.
 */
const USER_BROWSER_NAMES: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  chromium: "Chromium",
  firefox: "Firefox",
};

const kindGroups: Record<AuditKind, readonly [AuditGroup, ...AuditGroup[]]> = {
  "acp.attach": ["run"],
  "acp.detach": ["run"],
  "acp.session.new": ["run"],
  "acp.session.attach": ["run"],
  "bot.updated": ["run"],
  "feedback.opened": ["approval"],
  "import.changed": ["file"],
  "hook.finished": ["run"],
  "remote.request": ["phone"],
  "remote.changed": ["phone"],
  "phone.data_read": ["phone"],
  "phone.wake": ["phone"],
  "personal_todo.changed": ["run"],
  "routine.run.cancelled": ["scheduling"],
  "routine.created": ["scheduling"],
  "routine.updated": ["scheduling"],
  "routine.deleted": ["scheduling"],
  "routine.paused": ["scheduling"],
  "routine.resumed": ["scheduling"],
  "routine.proposed": ["scheduling"],
  "routine.proposal.resolved": ["scheduling"],
  "routine.preauth.allowed": ["scheduling"],
  "routine.preauth.revoked": ["scheduling"],
  "group.topic.renamed": ["collaboration"],
  "group.topic.restored": ["collaboration"],
  "group.topic.switched": ["collaboration"],
  "group.topic.created": ["collaboration"],
  "group.topic.archived": ["collaboration"],
  "group.reference.purged": ["collaboration"],
  "topic.folder.added": ["file"],
  "topic.folder.removed": ["file"],
  "topic.folder.moved": ["file"],
  "topic.folder.move_declined": ["file"],
  "outputs.migrated": ["file"],
  "group.folder.added": ["file"],
  "group.folder.removed": ["file"],
  "approval.requested": ["approval"],
  "approval.paused": ["approval"],
  "approval.resolved": ["approval"],
  "exec.started": ["run"],
  "exec.promoted_to_background": ["run"],
  "exec.finished": ["run"],
  "delivery.evidence": ["run"],
  "file.checkpoint": ["file"],
  "file.written": ["file"],
  "file.sent": ["file"],
  "file.read": ["file"],
  "file.revealed": ["file"],
  "web.fetched": ["web"],
  "image.loaded": ["web"],
  "image.started": ["web"],
  // An external agent's turn is a run; its permission answers are approvals.
  "external_agent.started": ["run"],
  "external_agent.prewarmed": ["run"],
  "external_agent.finished": ["run"],
  "external_agent.permission": ["approval"],
  "image.finished": ["web"],
  "messages.read": ["run"],
  "grant.created": ["approval"],
  "grant.revoked": ["approval"],
  "policy.denied": ["approval", "send"],
  "oauth.changed": ["identity"],
  "provider.imported": ["run"],
  "network.changed": ["web"],
  "permissions.changed": ["approval"],
  "search.sent": ["web"],
  "collaboration.queued": ["collaboration"],
  "collaboration.completed": ["collaboration"],
  "collaboration.cancelled": ["collaboration"],
  "group.task.quiet": ["collaboration"],
  "group.workflow.started": ["collaboration"],
  "group.workflow.migrated": ["collaboration"],
  "group.workflow.recovered": ["collaboration"],
  "group.workflow.step_dispatched": ["collaboration"],
  "group.workflow.step_passed": ["collaboration"],
  "group.workflow.step_failed": ["collaboration"],
  "group.workflow.step_blocked": ["collaboration"],
  "group.workflow.step_merged": ["collaboration"],
  "group.workflow.disposition": ["collaboration"],
  "group.workflow.completed": ["collaboration"],
  "browser.takeover": ["web"],
  "browser.data_cleared": ["web"],
  "browser.google_compat": ["web"],
  "browser.tab_closed": ["web"],
  "browser.local_opened": ["web"],
  "browser.user_opened": ["web"],
  "browser.user_browser": ["web"],
  "skill.changed": ["connectors"],
  // Preparing a runtime installs a skill's dependencies, so it belongs beside the skill it serves.
  "skill.runtime.prepared": ["connectors"],
  "skill.downloaded": ["connectors"],
  // A system installer the user started from a Git card; it ran outside the sandbox.
  "git.install": ["run"],
  "memory.changed": ["run"],
  "credential.saved": ["web"],
  "credential.updated": ["web"],
  "credential.deleted": ["web"],
  "credential.revealed": ["web"],
  "credential.filled": ["web"],
  "exec.background.started": ["run"],
  "exec.background.stopped": ["run"],
  "yolo.changed": ["approval"],
  "topic.archived": ["collaboration"],
  "topic.restored": ["collaboration"],
  "execution.changed": ["run"],
  "execution.todo.changed": ["run"],
  "execution.todo.paused": ["run"],
  "execution.continuation.limited": ["run"],
  "execution.continuation.restored": ["run"],
  "runtime.drain_failed": ["run"],
  "runtime.force_release": ["run"],
  "runtime.commands_paused": ["run"],
  "execution.task.changed": ["run"],
  "team.created": ["collaboration"],
  "pi.managed": ["collaboration"],
  "pi.dispatched": ["collaboration"],
  "team.exported": ["collaboration"],
  "builtin.updated": ["run"],
  "builtin.catalog": ["run"],
  "autocheck.changed": ["run"],
  "autocheck.finished": ["run"],
  "computer.handoff": ["run"],
  "plugin.changed": ["connectors"],
  "connector.changed": ["connectors"],
  "connector.called": ["connectors", "send"],
  "capability.changed": ["connectors"],
  "secret.changed": ["approval"],
  "tool.journal.started": ["run"],
  "tool.journal.finished": ["run"],
  "tool.journal.replay_blocked": ["run"],
  "tool.journal.unknown": ["run"],
  "run.interrupted": ["run"],
  "run.resumed": ["run"],
  "run.retention.requested": ["run"],
  "run.retention.cleaned": ["run"],
  "command.logs.prune": ["run"],
};
export function auditKinds(filter: AuditFilter): readonly (AuditKind | undefined)[] {
  if (filter === "all") return [undefined];
  return (Object.keys(kindGroups) as AuditKind[]).filter((kind) =>
    kindGroups[kind].includes(filter),
  );
}
const backgroundReasons = new Set([
  "user",
  "bot",
  "chat_deleted",
  "bot_archived",
  "left_group",
  "app_quit",
  "exposed",
  "restart",
]);
/** Background command end reasons; "exited" / "failed" are outcomes, not stop reasons. */
function backgroundReason(code: string | undefined, t: T): string {
  if (code && backgroundReasons.has(code))
    return t(`background.reason.${code as "user"}` as TranslationKey);
  if (code === "failed") return t("background.commandFailed");
  return t("background.audit.exited");
}
export function auditGroup(entry: Pick<AuditEntry, "kind" | "detail">): AuditGroup {
  // Legacy rows recorded a managed checkpoint under the command kind; they are file records.
  if (isFileCheckpoint(entry)) return "file";
  const groups = kindGroups[entry.kind];
  // A denied send and a connector call that sent are sends first (second-Mac test: it read
  // 审批 · 执行操作); their other candidate covers the remaining rows.
  return groups.length > 1 && entry.detail.category === "send_out" ? "send" : groups[0];
}
/** A client-wide failure has no owning Bot; the record is filed under main but belongs to the system. */
export function isSystemAudit(entry: AuditEntry): boolean {
  return (
    entry.kind === "runtime.drain_failed" && entry.detail.reasonCode === "interactive_drain_failed"
  );
}
/**
 * Rows a person did themselves are filed under main (the audit table needs a Bot) but belong to
 * the user: today the Git install, which only a click on its card starts.
 */
export function isUserAudit(entry: Pick<AuditEntry, "kind" | "detail">): boolean {
  return entry.kind === "git.install" && entry.detail.actor === "user";
}
function gitInstallSummary(entry: AuditEntry, t: T): string {
  const code = entry.detail.reasonCode;
  if (code === "started")
    return t("audit.git.started", { command: safeAuditText(entry.detail.command) || "-" });
  if (code === "installed") return t("audit.git.installed");
  const reason = gitInstallReason(entry.detail, t);
  return reason ? t("audit.git.failed", { reason }) : t("audit.git.failedGeneric");
}
/** Connector rows written before `internal` was set are recognized by their fixed summary. */
function connectorEvent(entry: Pick<AuditEntry, "kind" | "summary">) {
  return entry.kind === "connector.changed" || entry.kind === "plugin.changed"
    ? connectorAuditEvent(entry.summary)
    : undefined;
}
export function isInternalAudit(entry: Pick<AuditEntry, "kind" | "detail" | "summary">): boolean {
  const detail = entry.detail;
  const connector = connectorEvent(entry);
  return (
    detail.internal === true ||
    isDeliveryEvidence(entry) ||
    // Every side-effect call writes a started + finished pair; the command / write rows
    // already tell the story, so only replay refusals and unknown outcomes reach the list.
    entry.kind === "tool.journal.started" ||
    entry.kind === "tool.journal.finished" ||
    (connector !== undefined && internalConnectorAuditEvents.has(connector)) ||
    detail.collaborationAction === "completion_wake" ||
    (entry.kind === "collaboration.queued" &&
      !detail.collaborationAction &&
      !!detail.taskId &&
      !!detail.childRunId &&
      !detail.toolCallId)
  );
}

/** Older observations used the command kind without recording a command outcome. */
function isDeliveryEvidence(entry: Pick<AuditEntry, "kind" | "detail">): boolean {
  return (
    entry.kind === "delivery.evidence" ||
    (entry.kind === "exec.finished" && entry.detail.toolName === "delivery_evidence")
  );
}
export function auditMatches(
  entry: Pick<AuditEntry, "kind" | "detail" | "summary">,
  filter: AuditFilter,
  showInternal = false,
) {
  return (
    (showInternal || !isInternalAudit(entry)) && (filter === "all" || auditGroup(entry) === filter)
  );
}
export function auditCutoff(range: AuditRange, now = new Date()): string | undefined {
  if (range === "all") return;
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - Number(range) + 1);
  return date.toISOString();
}
export function singleLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
/** Phone requests worth a readable title; the rest show a generic phone action. */
const phoneActions: Record<string, TranslationKey> = {
  "chat.send": "activity.phone.send",
  "chat.append": "activity.phone.send",
  "chat.abort": "activity.phone.stop",
  "approvals.resolve": "activity.phone.approval",
  "runs.retry": "activity.phone.retry",
  "chat.retryFromMessage": "activity.phone.retry",
  "changes.checkpoints.restore": "activity.phone.restore",
  "conversations.yolo.set": "activity.phone.yolo",
  "execution.set": "activity.phone.mode",
  "topics.create": "activity.phone.topic",
  "groups.topics.create": "activity.phone.topic",
  "remote.browser.takeover": "activity.phone.takeover",
  "remote.browser.view": "activity.phone.browser",
  "remote.share.upload": "activity.phone.share",
  "remote.session.update": "activity.phone.push",
  "permissions.set": "activity.phone.settings",
  "bots.update": "activity.phone.settings",
  "groups.update": "activity.phone.settings",
  "groups.create": "activity.phone.settings",
  // Offline grants (computer side), and what a phone did by itself while offline.
  "remote.offline": "activity.phone.offlineModels",
  "offline.tool": "activity.phone.offlineTool",
  "offline.model_request": "activity.phone.offlineModel",
  "remote.offline.upload": "activity.phone.offlineUpload",
};
export function auditSummary(
  entry: AuditEntry,
  t: T,
  context: { botName?: string; source?: AuditEntry } = {},
): string {
  if (isFileCheckpoint(entry)) return t("audit.checkpoint.automatic");
  const workflow = groupWorkflowSummary(entry, t);
  if (workflow) return workflow;
  if (entry.kind === "import.changed") return t("audit.conversationImport");
  if (entry.kind === "feedback.opened") return t("appMenu.feedbackOpened");
  // The stored summary carries both languages for exports; the page shows the reader's own.
  if (entry.kind === "git.install") return gitInstallSummary(entry, t);
  if (entry.kind === "external_agent.prewarmed") return t("audit.externalAgent.prewarmed");
  if (isRoutineAuditKind(entry.kind)) return routineAuditSummary(entry, t);
  const detail = { ...context.source?.detail, ...entry.detail };
  if (isDeliveryEvidence(entry)) return t("audit.result.recorded");
  // Earlier records used a separate kind; new producers use main's action field.
  const cancelled =
    entry.kind === "collaboration.cancelled" || detail.collaborationAction === "cancel";
  const actor = safeAuditText(detail.botName ?? context.botName) || t("audit.actor.bot");
  const title = safeAuditText(detail.taskTitle);
  const targetBot = safeAuditText(detail.targetBotName);
  const operation = auditOperation(detail, t);
  const journalOperation = detail.toolName
    ? t(toolNameKey(detail.toolName))
    : t("audit.operation.generic");
  switch (entry.kind) {
    case "command.logs.prune":
      return t(
        detail.reasonCode === "command_log_retention_deleted"
          ? "audit.commandLogs.deleted"
          : "audit.commandLogs.requested",
        { count: detail.entryCount ?? 0, bytes: detail.bytes ?? 0 },
      );
    case "run.retention.requested":
      return t("audit.runRetention.requested", { days: detail.olderThanDays ?? 0 });
    case "run.retention.cleaned":
      return t("audit.runRetention.cleaned", {
        days: detail.olderThanDays ?? 0,
        runs: detail.runCount ?? 0,
        events: detail.eventCount ?? 0,
        executions: detail.executionCount ?? 0,
        files: detail.fileCount ?? 0,
      });
    case "tool.journal.started":
      return t("audit.toolJournal.started", { operation: journalOperation });
    case "tool.journal.finished":
      return t("audit.toolJournal.finished", { operation: journalOperation });
    case "tool.journal.replay_blocked":
      return t("audit.toolJournal.replayBlocked", { operation: journalOperation });
    case "tool.journal.unknown":
      return detail.reasonCode === "journal_recovered"
        ? t("audit.toolJournal.recovered", { count: detail.entryCount ?? 0 })
        : t("audit.toolJournal.unknown", { operation: journalOperation });
    case "run.interrupted":
      if (detail.reasonCode === "user_stop_requested") return t("audit.run.userStopRequested");
      return t(
        detail.reasonCode === "shutdown_interrupted"
          ? "audit.run.interruptedShutdown"
          : "audit.run.interruptedRestart",
        { count: detail.entryCount ?? 0 },
      );
    case "run.resumed":
      if (detail.trigger === "background_finished")
        return t("background.receiptTrigger", { id: detail.backgroundCommandId ?? "" });
      return t(
        detail.reasonCode === "budget_raised" ? "audit.run.resumedBudget" : "audit.run.resumed",
        { count: detail.entryCount ?? 0 },
      );
    case "remote.request":
    case "remote.changed": {
      if (detail.offlineRunner) return t("activity.phone.offlineControl");
      const method = typeof detail.target === "string" ? detail.target : "";
      // A resume the computer could not serve (it restarted, or the gap left its buffer) is how
      // reconnecting works: the phone reloads its screens. Read as a refusal, it looked like a
      // security block (phone test 2026-11-16). A request refused at the gate still says refused.
      if (method === "events.resume" && detail.reasonCode === "failed")
        return t("activity.phone.resumeReload");
      const action = phoneActions[method];
      const refused = detail.reasonCode === "refused" || detail.reasonCode === "failed";
      const key =
        method === "devices.runnerPair"
          ? refused
            ? "activity.runner.refused"
            : "activity.runner.paired"
          : entry.kind === "remote.changed"
            ? refused
              ? "activity.remote.refused"
              : "activity.remote.action"
            : refused
              ? "activity.phone.refused"
              : "activity.phone.action";
      return t(key, {
        action: action ? t(action) : t("activity.phone.other"),
      });
    }
    case "connector.called": {
      if (entry.detail.reasonCode === "draft_duplicate") return t("draft.duplicateSkipped");
      const status = {
        draft_created: "pending",
        draft_sending: "sending",
        draft_sent: "sent",
        draft_discarded: "discarded",
        draft_cancelled: "discarded",
        draft_unknown: "unknown",
        draft_failed: "failed",
      } as const;
      const key = entry.detail.reasonCode as keyof typeof status;
      if (Object.hasOwn(status, key)) return t(`draft.status.${status[key]}`);
      return entry.detail.reasonCode?.startsWith("draft_")
        ? t("audit.connector.draft")
        : t("audit.connector.read");
    }
    case "connector.changed":
    case "plugin.changed": {
      const event = connectorEvent(entry);
      return event ? t(`connectors.audit.${event}`) : safeAuditText(entry.summary);
    }
    case "hook.finished":
      return t(
        detail.reasonCode === "notification_requested"
          ? "hooks.requested"
          : detail.reasonCode === "notification_shown"
            ? "hooks.shown"
            : detail.reasonCode === "notification_foreground"
              ? "hooks.foreground"
              : detail.reasonCode === "notification_unsupported"
                ? "hooks.unsupported"
                : "hooks.deliveryFailed",
      );
    case "bot.updated":
      return detail.reasonCode === "builtin_thinking_low"
        ? t("builtin.audit.thinkingLow")
        : t("audit.result.changed");
    case "builtin.catalog":
      return t(
        detail.reasonCode === "catalog_installed"
          ? "builtin.audit.catalogInstalled"
          : "builtin.audit.catalogChecked",
        { target: safeAuditText(detail.target) || "—" },
      );
    case "builtin.updated":
      return t(
        detail.reasonCode === "kept"
          ? "builtin.audit.kept"
          : detail.reasonCode === "partial"
            ? "builtin.audit.partial"
            : detail.reasonCode === "permission"
              ? "builtin.audit.permission"
              : "builtin.audit.adopted",
        { target: safeAuditText(detail.target) || "—" },
      );
    case "messages.read":
      return t("audit.messages.read", {
        messages: detail.messageCount ?? 0,
        conversations: detail.conversationCount ?? 0,
      });
    case "image.started":
    case "image.finished":
      return t(entry.kind === "image.started" ? "media.audit.started" : "media.audit.finished", {
        provider: auditImageProvider(detail, t),
        model: safeAuditText(detail.modelId) || t("media.audit.unknownModel"),
      });
    case "topic.folder.added":
      return t("audit.topicFolderAdded");
    case "topic.folder.removed":
      return t("audit.topicFolderRemoved");
    case "topic.folder.moved":
    case "topic.folder.move_declined":
      return t(
        entry.kind === "topic.folder.moved"
          ? "audit.topicFolderMoved"
          : "audit.topicFolderMoveDeclined",
        { name: safeAuditText(detail.target), folder: safeAuditText(detail.path) },
      );
    case "outputs.migrated":
      return t("audit.outputsMigrated", {
        moved: Number(detail.movedCount) || 0,
        skipped: Number(detail.skippedCount) || 0,
      });
    case "group.folder.added":
    case "group.folder.removed":
      return t(
        entry.kind === "group.folder.added" ? "group.auditFolderAdded" : "group.auditFolderRemoved",
        {
          name: safeAuditText(detail.groupName),
          folder: safeAuditText(detail.target),
        },
      );
    case "approval.paused":
      return t("audit.summary.approval.paused");
    case "approval.requested":
    case "approval.resolved":
      return t("audit.describe.approval", { actor, operation });
    case "policy.denied":
      if (detail.reasonCode === "workspace_folder_added")
        return t("policy.reason.workspace_folder_added");
      return t("audit.describe.blocked", { operation, reason: auditReason(detail, t) });
    case "yolo.changed":
      if (detail.reasonCode === "yolo_unisolated_commands_on") return t("yolo.audit.unisolatedOn");
      if (detail.reasonCode === "yolo_unisolated_commands_off")
        return t("yolo.audit.unisolatedOff");
      return t(detail.reasonCode === "yolo_on" ? "yolo.audit.on" : "yolo.audit.off");
    case "topic.archived":
      return t("topic.auditArchived");
    case "topic.restored":
      return t("topic.auditRestored");
    case "execution.changed":
      return t("execution.auditMode");
    case "personal_todo.changed":
      return t("personalTodos.audit");
    case "execution.todo.changed":
      if (detail.reasonCode === "group_plan_limit_reached")
        return t("group.plan.limit.auditReached");
      if (detail.reasonCode === "group_plan_limit_extend") return t("group.plan.limit.auditExtend");
      if (detail.reasonCode === "group_plan_limit_solo") return t("group.plan.limit.auditSolo");
      if (detail.reasonCode === "group_plan_limit_end") return t("group.plan.limit.auditEnd");
      return t("execution.auditTodo");
    case "execution.todo.paused":
      return t("execution.auditPause");
    case "execution.continuation.limited":
      return t("execution.auditContinuationLimited", { used: detail.used ?? 0 });
    case "execution.continuation.restored":
      return t(
        detail.restore === "resumed"
          ? "runtime.auditContinuationResumed"
          : detail.restore === "discarded"
            ? "runtime.auditContinuationDiscarded"
            : detail.restore === "kept"
              ? "runtime.auditContinuationKept"
              : "runtime.auditContinuationDropped",
      );
    case "runtime.drain_failed":
      return t("runtime.auditDrainFailed");
    case "runtime.commands_paused":
      return t(
        detail.reasonCode === "recovered"
          ? "runtime.auditCommandsRecovered"
          : detail.reasonCode === "stuck"
            ? "runtime.auditCommandsStuck"
            : "runtime.auditCommandsPaused",
      );
    case "runtime.force_release":
      return t(
        detail.reasonCode === "released"
          ? "runtime.auditForceReleased"
          : detail.reasonCode === "refused"
            ? "runtime.auditForceRefused"
            : "runtime.auditForceRequested",
      );
    case "execution.task.changed":
      return t("execution.auditTask");
    case "autocheck.changed":
    case "autocheck.finished":
      return autoCheckSummary(entry, t);
    case "exec.started":
    case "exec.finished":
    case "exec.background.started":
      return auditOperation({ ...detail, toolName: detail.toolName ?? "run_command" }, t);
    case "exec.promoted_to_background":
      return t("background.promoted");
    case "exec.background.stopped":
      return t("background.audit.stopped");
    case "image.loaded":
      return t("externalImage.audit", { domain: detail.target ?? "" });
    case "file.sent":
      return auditOperation({ ...detail, toolName: "send_file" }, t);
    case "file.written":
      return auditOperation({ ...detail, toolName: detail.toolName ?? "write_file" }, t);
    case "file.read":
      return auditOperation({ ...detail, toolName: "read_file" }, t);
    case "file.revealed":
      return auditOperation({ ...detail, toolName: "reveal_in_folder" }, t);
    case "web.fetched":
      return auditOperation({ ...detail, toolName: "web_fetch", target: detail.domain }, t);
    case "grant.created":
    case "grant.revoked":
      return t("audit.describe.permission", { operation });
    case "provider.imported":
      return t("audit.providerImport.applied");
    case "oauth.changed":
      return auditAuth(detail, t);
    case "permissions.changed":
      return t("audit.permissions.updated");
    case "network.changed":
      return t(
        detail.reasonCode === "proxy_enabled"
          ? "audit.proxy.enabled"
          : detail.reasonCode === "proxy_disabled"
            ? "audit.proxy.disabled"
            : "audit.proxy.updated",
      );
    case "search.sent":
      return t("audit.describe.search", { provider: auditProvider(detail, t) });
    case "browser.takeover":
      return t("botBrowser.audit.takeover", {
        minutes: Math.max(1, Math.round((detail.durationMs ?? 0) / 60_000)),
        domain: detail.domain ?? "—",
      });
    case "browser.data_cleared":
      return t("botBrowser.audit.cleared");
    case "computer.handoff":
      return t(`audit.computerHandoff.${detail.handoff ?? "shown"}`);
    case "browser.tab_closed":
      return t("botBrowser.audit.tabClosed", { domain: detail.domain ?? "—" });
    case "browser.user_opened":
      return t("botBrowser.audit.userOpened", { domain: detail.domain ?? "—" });
    case "browser.user_browser":
      return t("botBrowser.audit.userBrowser", {
        browser: USER_BROWSER_NAMES[detail.browser ?? ""] ?? "browser",
        domain: detail.domain ?? "—",
      });
    case "browser.local_opened":
      return t("botBrowser.audit.localOpened", { target: detail.target ?? "localhost" });
    case "pi.managed":
      return t(piManagedKey(detail.reasonCode), { target: safeAuditText(detail.target) });
    case "pi.dispatched":
      return t("audit.pi.dispatched", {
        target: safeAuditText(detail.target),
        title: safeAuditText(detail.taskTitle),
      });
    case "team.created":
    case "team.exported": {
      const counts = {
        bots: detail.botCount ?? 0,
        groups: detail.groupCount ?? 0,
        skills: detail.skillCount ?? 0,
        files: detail.fileCount ?? 0,
        scripts: detail.scriptCount ?? 0,
      };
      if (entry.kind === "team.exported") return t("builtin.audit.exported", counts);
      const reason = detail.reasonCode;
      return t(
        reason === "role" || reason === "template" || reason === "profession"
          ? `builtin.audit.created.${reason}`
          : "builtin.audit.created.import",
        counts,
      );
    }
    case "skill.downloaded":
      return t("skills.audit.downloaded", { host: safeAuditText(detail.skillDownload?.host) });
    case "skill.changed":
      if (detail.reasonCode === "imported" && detail.fileCount !== undefined)
        return t("skills.audit.importedPackage", {
          name: safeAuditText(detail.target),
          files: detail.fileCount,
          scripts: detail.scriptCount ?? 0,
        });
      return t(skillAuditKey(detail.reasonCode), { name: safeAuditText(detail.target) });
    case "credential.saved":
    case "credential.updated":
    case "credential.deleted":
    case "credential.revealed":
    case "credential.filled":
      return t(`credentials.audit.${entry.kind.slice("credential.".length) as "saved"}`, {
        site: detail.domain ?? "—",
        label: detail.target ?? "—",
      });
    case "group.task.quiet":
      return t("audit.summary.group.task.quiet");
    case "collaboration.queued":
      if (isInternalAudit(entry))
        return title && targetBot
          ? t("audit.describe.wake", { title, targetBot })
          : t("audit.describe.internal");
      if (!targetBot) return t("audit.describe.collaboration");
      if (detail.collaborationAction === "assign")
        return t("audit.describe.assign", {
          actor,
          targetBot,
          title: title || t("audit.task.unknown"),
        });
      if (detail.collaborationAction === "return")
        return t("audit.describe.return", {
          actor,
          targetBot,
          title: title || t("audit.task.unknown"),
        });
      if (detail.collaborationAction !== "ask") return t("audit.describe.collaboration");
      return t("audit.describe.ask", {
        actor,
        targetBot,
        topic: title ? t("audit.describe.topic", { title }) : "",
      });
    case "collaboration.cancelled":
    case "collaboration.completed":
      if (!title)
        return t(cancelled ? "audit.describe.cancelGeneric" : "audit.describe.completeGeneric");
      if (detail.actor === "user")
        return t(cancelled ? "audit.describe.userCancel" : "audit.describe.userComplete", {
          title,
        });
      if (detail.actor === "system")
        return t(cancelled ? "audit.describe.systemCancel" : "audit.describe.systemComplete", {
          title,
        });
      return t(
        cancelled
          ? "audit.describe.cancel"
          : detail.botRole === "coordinator"
            ? "audit.describe.coordinatorComplete"
            : "audit.describe.complete",
        { actor, title },
      );
    default:
      return safeAuditText(entry.summary);
  }
}
export function auditResult(
  entry: AuditEntry,
  t: T,
): { text: string; tone: "ok" | "warn" | "danger" | "muted" } {
  if (isFileCheckpoint(entry)) return checkpointAuditResult(entry, t);
  if (isRoutineAuditKind(entry.kind)) return routineAuditResult(entry, t);
  const detail = entry.detail;
  if (detail.offlineRunner) {
    const outcome = detail.offlineRunner.outcome;
    return outcome === "done"
      ? { text: t("audit.result.completed"), tone: "ok" }
      : outcome === "failed"
        ? { text: t("audit.result.failed"), tone: "danger" }
        : outcome === "denied"
          ? { text: t("activity.deniedUnknown"), tone: "danger" }
          : { text: t("audit.toolJournal.result.unknown"), tone: "warn" };
  }
  if (isDeliveryEvidence(entry)) return { text: t("audit.result.recorded"), tone: "muted" };
  if (entry.kind === "tool.journal.started")
    return {
      text: t(
        detail.reasonCode === "journal_retry"
          ? "audit.toolJournal.result.retry"
          : detail.reasonCode === "journal_redo"
            ? "audit.toolJournal.result.redo"
            : "audit.toolJournal.result.recorded",
      ),
      tone: "muted",
    };
  if (entry.kind === "tool.journal.finished")
    return detail.reasonCode === "journal_failed"
      ? { text: t("audit.result.failed"), tone: "danger" }
      : { text: t("activity.done"), tone: "muted" };
  if (entry.kind === "tool.journal.replay_blocked")
    return {
      text: t(
        detail.reasonCode === "journal_replay_running"
          ? "audit.toolJournal.result.running"
          : detail.reasonCode === "journal_replay_unknown"
            ? "audit.toolJournal.result.unknown"
            : "audit.toolJournal.result.notRepeated",
      ),
      tone: detail.reasonCode === "journal_replay_unknown" ? "warn" : "muted",
    };
  if (entry.kind === "tool.journal.unknown")
    return { text: t("audit.toolJournal.result.unknown"), tone: "warn" };
  if (connectorEvent(entry) === "failed") return { text: t("audit.result.failed"), tone: "danger" };
  if (entry.kind === "connector.called" && detail.category === "send_out") {
    const code = detail.reasonCode;
    if (code === "draft_duplicate") return { text: t("draft.duplicateSkipped"), tone: "muted" };
    if (code === "draft_sent") return { text: t("draft.status.sent"), tone: "ok" };
    if (code === "draft_discarded" || code === "draft_cancelled")
      return { text: t("draft.status.discarded"), tone: "muted" };
    if (code === "draft_unknown") return { text: t("draft.status.unknown"), tone: "warn" };
    if (code === "draft_failed") return { text: t("draft.status.failed"), tone: "danger" };
    return {
      text: t(code === "draft_sending" ? "draft.status.sending" : "draft.status.pending"),
      tone: "warn",
    };
  }
  if (entry.kind === "messages.read")
    return detail.reasonCode === "done"
      ? { text: t("activity.done"), tone: "ok" }
      : {
          text: t(detail.reasonCode === "stopped" ? "audit.result.stopped" : "activity.failed"),
          tone: "warn",
        };
  if (entry.kind === "image.started") return { text: t("activity.running"), tone: "muted" };
  if (entry.kind === "image.finished") {
    const reasonCode = detail.reasonCode ?? detail.reason;
    if (reasonCode === "done") return { text: t("activity.done"), tone: "ok" };
    if (reasonCode === "aborted") return { text: t("audit.result.stopped"), tone: "warn" };
    const reason = auditImageReason(detail, t);
    return !isKnownImageReason(detail)
      ? { text: t("media.audit.unknownResult"), tone: "muted" }
      : { text: reason, tone: "danger" };
  }
  if (entry.kind === "approval.paused")
    return { text: t("execution.pause.approval"), tone: "warn" };
  if (entry.kind === "approval.requested") return { text: t("activity.waiting"), tone: "warn" };
  if (entry.kind === "approval.resolved") {
    if (detail.reasonCode === "workspace_folder_added")
      return { text: t("policy.reason.workspace_folder_added"), tone: "muted" };
    // Allowed by the conversation's YOLO switch (a card it let through, or no card at all).
    if (detail.reasonCode === "yolo" && detail.decision === "allow")
      return { text: t("yolo.audit.allowed"), tone: "warn" };
    if (detail.status === "expired" || detail.status === "auto_denied")
      return { text: t("audit.result.expired"), tone: "warn" };
    if (detail.status === "cancelled") return { text: t("audit.result.cancelled"), tone: "muted" };
    if (detail.status === "allowed" || detail.decision === "allow")
      return {
        text: t(
          detail.actor === "user"
            ? "activity.allowed"
            : detail.actor === "automatic"
              ? "activity.autoAllowed"
              : "activity.allowedUnknown",
        ),
        tone: detail.actor === "user" ? "ok" : "muted",
      };
    if (detail.status === "denied" || detail.decision === "deny")
      return {
        text: t(detail.actor === "user" ? "activity.denied" : "activity.deniedUnknown"),
        tone: "danger",
      };
    return { text: t("audit.result.recorded"), tone: "muted" };
  }
  if (entry.kind === "exec.finished") {
    if (detail.stopped || detail.timedOut)
      return {
        text: t(detail.stopped ? "audit.result.stopped" : "audit.result.timedOut"),
        tone: "warn",
      };
    if (typeof detail.exitCode !== "number")
      return { text: t("audit.result.recorded"), tone: "muted" };
    // An exit code alone no longer decides the tone. grep with no matches exits 1 and is
    // recorded as such, so the record must say "no matches" instead of "failed".
    if (detail.noMatches) return { text: t("activity.noMatches"), tone: "muted" };
    const success = detail.exitCode === 0;
    return {
      text:
        typeof detail.exitCode === "number"
          ? t(success ? "activity.exitDone" : "activity.exitFailed", { code: detail.exitCode })
          : t("activity.failed"),
      tone: success ? "muted" : "danger",
    };
  }
  if (entry.kind === "exec.started") return { text: t("activity.running"), tone: "muted" };
  if (entry.kind === "exec.promoted_to_background")
    return { text: t("background.promoted"), tone: "muted" };
  if (entry.kind === "exec.background.started")
    return { text: t("background.running"), tone: "muted" };
  if (entry.kind === "exec.background.stopped")
    return {
      text: backgroundReason(detail.reasonCode, t),
      tone: detail.reasonCode === "exposed" || detail.reasonCode === "failed" ? "warn" : "muted",
    };
  if (entry.kind === "policy.denied")
    return {
      text: t(
        ["invalid_input", "unknown_tool"].includes(entry.detail.reasonCode ?? "")
          ? "activity.failed"
          : "audit.result.blocked",
      ),
      tone: "danger",
    };
  if (
    entry.kind === "provider.imported" ||
    entry.kind === "file.sent" ||
    entry.kind === "file.written" ||
    entry.kind === "file.read" ||
    entry.kind === "file.revealed" ||
    entry.kind === "web.fetched"
  )
    return { text: t("activity.done"), tone: "muted" };
  if (entry.kind === "collaboration.cancelled")
    return { text: t("audit.result.cancelled"), tone: "muted" };
  if (entry.kind === "collaboration.completed")
    return {
      text: t(
        detail.collaborationAction === "cancel"
          ? "audit.result.cancelled"
          : "audit.result.completed",
      ),
      tone: "muted",
    };
  if (entry.kind === "collaboration.queued")
    return {
      text: t(
        detail.collaborationAction === "assign"
          ? "audit.result.assigned"
          : detail.collaborationAction === "return"
            ? "audit.result.returned"
            : detail.collaborationAction === "ask"
              ? "audit.result.reminded"
              : "audit.result.queued",
      ),
      tone: "muted",
    };
  // These two events carry persisted mixed-language summaries; result column is decided by event identity.
  if (entry.kind === "group.task.quiet") return { text: t("audit.result.recorded"), tone: "muted" };
  if (entry.kind.startsWith("group.workflow."))
    return { text: t("audit.result.changed"), tone: "muted" };
  if (entry.kind === "skill.downloaded") {
    const reason = detail.reasonCode;
    return {
      text: t(
        reason === "ok"
          ? "activity.done"
          : reason === "skill_link_cancelled"
            ? "audit.result.cancelled"
            : "skills.audit.downloadFailed",
      ),
      tone: reason === "ok" ? "ok" : reason === "skill_link_cancelled" ? "muted" : "danger",
    };
  }
  if (entry.kind === "git.install") {
    const reason = detail.reasonCode;
    if (reason === "started") return { text: t("activity.running"), tone: "muted" };
    if (reason === "cancelled") return { text: t("audit.result.cancelled"), tone: "muted" };
    return reason === "installed"
      ? { text: t("activity.done"), tone: "ok" }
      : { text: t("activity.failed"), tone: "danger" };
  }
  if (entry.kind === "grant.created" || entry.kind === "grant.revoked")
    return {
      text: t(entry.kind === "grant.created" ? "audit.result.remembered" : "audit.result.revoked"),
      tone: "muted",
    };
  if (entry.kind === "network.changed") return { text: t("network.saved"), tone: "muted" };
  if (entry.kind === "browser.takeover")
    return { text: t("botBrowser.audit.handedBack"), tone: "muted" };
  if (entry.kind === "browser.data_cleared")
    return { text: t("botBrowser.audit.clearedResult"), tone: "muted" };
  if (entry.kind === "browser.tab_closed")
    return { text: t("botBrowser.audit.tabClosedResult"), tone: "muted" };
  if (entry.kind === "browser.local_opened" || entry.kind === "browser.user_opened")
    return { text: t("botBrowser.audit.localOpenedResult"), tone: "muted" };
  if (
    entry.kind === "skill.changed" ||
    entry.kind === "pi.managed" ||
    entry.kind === "pi.dispatched" ||
    entry.kind === "team.created" ||
    entry.kind === "team.exported"
  )
    return { text: t("audit.result.changed"), tone: "muted" };
  if (entry.kind === "autocheck.finished") {
    const code = detail.reasonCode ?? "";
    const known = ["passed", "failed", "timeout", "blocked", "stopped"].includes(code);
    return {
      text: known ? t(`autoCheck.audit.${code as "passed"}`) : t("audit.result.recorded"),
      tone: code === "passed" ? "ok" : code === "failed" || code === "timeout" ? "danger" : "muted",
    };
  }
  if (
    entry.kind === "autocheck.changed" ||
    entry.kind === "bot.updated" ||
    entry.kind === "builtin.updated"
  )
    return { text: t("audit.result.changed"), tone: "muted" };
  if (entry.kind === "computer.handoff")
    return {
      text: t("audit.result.recorded"),
      tone: detail.handoff === "shown" ? "warn" : detail.handoff === "continued" ? "ok" : "muted",
    };
  if (entry.kind === "yolo.changed")
    return {
      text: t("audit.result.changed"),
      tone:
        detail.reasonCode === "yolo_on" || detail.reasonCode === "yolo_unisolated_commands_on"
          ? "warn"
          : "muted",
    };
  if (entry.kind.startsWith("credential."))
    return {
      text:
        entry.kind === "credential.filled" && detail.reasonCode !== "filled"
          ? t("activity.failed")
          : t("credentials.audit.result"),
      tone:
        entry.kind === "credential.filled" && detail.reasonCode !== "filled" ? "danger" : "muted",
    };
  if (entry.kind === "image.loaded" || entry.kind === "search.sent")
    return { text: t("audit.result.sent"), tone: "muted" };
  if (detail.authEvent === "oauth.connected")
    return { text: t("audit.result.connected"), tone: "ok" };
  if (detail.authEvent === "oauth.disconnected")
    return { text: t("audit.result.disconnected"), tone: "muted" };
  if (detail.authEvent === "oauth.failed") return { text: t("activity.failed"), tone: "danger" };
  if (detail.authEvent === "oauth.reauth_required")
    return { text: t("audit.result.reauth"), tone: "warn" };
  return {
    text: t(
      detail.authEvent?.startsWith("oauth.risk_acknowledged")
        ? "audit.result.confirmed"
        : "audit.result.changed",
    ),
    tone: "muted",
  };
}
/** Automatic check records: switch / rounds / folder commands, and each check round. */
function autoCheckSummary(entry: AuditEntry, t: T): string {
  const detail = entry.detail;
  const folder = safeAuditText(detail.target) || "—";
  const command = safeAuditText(detail.command) || "—";
  if (entry.kind === "autocheck.finished")
    return t("autoCheck.audit.finished", { round: detail.round ?? 0, command });
  switch (detail.reasonCode) {
    case "autocheck_on":
      return t("autoCheck.audit.on");
    case "autocheck_off":
      return t("autoCheck.audit.off");
    case "autocheck_rounds":
      return t("autoCheck.audit.rounds", { rounds: detail.round ?? 0 });
    case "command_saved":
    case "proposal_accepted":
      return t("autoCheck.audit.saved", { folder, command });
    case "command_skipped":
      return t("autoCheck.audit.skipped", { folder });
    case "command_forgotten":
      return t("autoCheck.audit.forgotten", { folder });
    case "proposal_declined":
      return t("autoCheck.audit.declined", { folder });
    default:
      return safeAuditText(entry.summary);
  }
}
export function auditDays<TEntry extends { at: string }>(
  entries: readonly TEntry[],
  language: string,
  t: T,
  now = new Date(),
) {
  const today = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, { label: string; entries: TEntry[] }>();
  for (const entry of entries) {
    const date = new Date(entry.at);
    const key = date.toDateString();
    let group = groups.get(key);
    if (!group) {
      group = {
        label:
          key === today
            ? t("workspace.topicGroup.today")
            : key === yesterday.toDateString()
              ? t("activity.yesterday")
              : date.toLocaleDateString(language, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
        entries: [],
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.entries()];
}

const skillAuditReasons = [
  "created",
  "imported",
  "updated",
  "removed",
  "enabled",
  "disabled",
  "proposed",
  "drafted",
  "accepted",
  "declined",
  "builtin_merged",
  "builtin_archived",
  "builtin_merge_skipped",
  "builtin_updated",
  "builtin_replaced",
  "builtin_renamed",
  "builtin_kept",
] as const;
// Only known reason codes pick a sentence; anything else stays generic instead of echoing it.
function skillAuditKey(reason: string | undefined): TranslationKey {
  const known = skillAuditReasons.find((value) => value === reason);
  return known ? `skills.audit.${known}` : "skills.audit.changed";
}

const PI_MANAGED = [
  "bot_created",
  "bot_updated",
  "bot_archived",
  "bot_restored",
  "group_created",
  "group_members_added",
  "group_members_removed",
  "group_archived",
  "group_restored",
] as const;
function piManagedKey(code: string | undefined): TranslationKey {
  return (PI_MANAGED as readonly string[]).includes(code ?? "")
    ? (`audit.pi.${code as (typeof PI_MANAGED)[number]}` as const)
    : "audit.pi.changed";
}
