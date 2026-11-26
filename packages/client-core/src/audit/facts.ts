import { type createTranslator, policyReasonKey, type TranslationKey } from "@pibot/i18n";
import type { AuditDetail, AuditEntry } from "@pibot/protocol";
import { checkpointAuditResult, isFileCheckpoint } from "./checkpoint.ts";
import { isRoutineAuditKind, routineAuditReason } from "./routine-audit.ts";

export type AuditT = ReturnType<typeof createTranslator>;
export function safeAuditText(value: string | undefined, limit = 200): string {
  const text = (value ?? "")
    .replace(/https?:\/\/[^\s]+/giu, (site) => {
      try {
        return new URL(site).hostname;
      } catch {
        return "";
      }
    })
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}
function leaf(value: string | undefined) {
  return safeAuditText(
    value
      ?.replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1),
  );
}
const gitInstallReasons = ["denied", "no_elevation", "failed", "timeout", "cancelled"] as const;
/** The Git install's failure reason in the reader's language; undefined for an unknown code. */
export function gitInstallReason(detail: Pick<AuditDetail, "reasonCode">, t: AuditT) {
  const code = gitInstallReasons.find((reason) => reason === detail.reasonCode);
  return code ? t(`changes.git.reason.${code}`) : undefined;
}
export function auditTool(detail: AuditDetail): string | undefined {
  return detail.toolName ?? detail.category;
}
export function auditTarget(detail: AuditDetail): string {
  const tool = auditTool(detail);
  if (tool === "run_command" || detail.programs) {
    return (detail.programs ?? (detail.target ? detail.target.split(",") : []))
      .slice(0, 3)
      .map((value) => leaf(value))
      .filter((name) => /^[\p{L}\p{N}_.+-]+$/u.test(name))
      .join(", ");
  }
  if (
    tool === "web" ||
    tool === "web_fetch" ||
    tool === "image_generation" ||
    detail.domain ||
    detail.url
  ) {
    const value = detail.target ?? detail.domain ?? detail.url;
    if (!value) return "";
    try {
      const site = new URL(value.includes("://") ? value : `https://${value}`);
      return ["http:", "https:"].includes(site.protocol) ? safeAuditText(site.hostname) : "";
    } catch {
      return "";
    }
  }
  // Legacy full commands and URL queries are deliberately excluded from the display contract.
  return leaf(detail.target ?? detail.path);
}
const operationKeys: Record<string, TranslationKey> = {
  git_install: "audit.git.operation",
  tool_discover: "tool.tool_discover",
  connector_discover: "tool.connector_discover",
  image_generation: "media.audit.operation",
  send_file: "tool.send_file",
  reveal_in_folder: "tool.reveal_in_folder",
  run_command: "audit.operation.run",
  read_file: "audit.operation.read",
  browser_open: "botBrowser.audit.open",
  office_inspect: "tool.office_inspect",
  office_read: "tool.office_read",
  office_create: "tool.office_create",
  office_edit: "tool.office_edit",
  office_convert: "tool.office_convert",
  office_preview: "tool.office_preview",
  office_render: "tool.office_render",
  office_capabilities: "tool.office_capabilities",
  list_dir: "audit.operation.list",
  write_file: "audit.operation.write",
  edit_file: "audit.operation.edit",
  web: "audit.operation.web",
  web_fetch: "audit.operation.web",
  web_search: "audit.operation.search",
  send_out: "audit.operation.send",
  computer: "audit.operation.computer",
  read_ai_config: "audit.operation.config",
  read_messages: "tool.read_messages",
  memory_add: "audit.operation.memory",
  memory_update: "audit.operation.memory",
  memory_remove: "audit.operation.memory",
  assign_task: "audit.operation.assign",
  ask_bot: "audit.operation.ask",
  finish_task: "audit.operation.complete",
};
/**
 * The changes panel's own Git writes (commit, discard, branch / tag, sync) have no tool label; their
 * free-text target ("2 files", "hunk") is English, so the 记录 page read 「执行操作 2 files」.
 */
function changesOperation(tool: string, detail: AuditDetail, t: AuditT): string | undefined {
  if (tool === "changes.commit") {
    const count = detail.fileCount ?? Number(/^(\d+) files$/.exec(detail.target ?? "")?.[1]);
    return Number.isInteger(count)
      ? t("audit.operation.changesCommitFiles", { count })
      : t("audit.operation.changesCommit");
  }
  if (tool === "changes.discard") {
    const file = leaf(detail.path);
    const label = t("audit.operation.changesDiscard");
    return file ? `${label} ${file}` : label;
  }
  if (tool === "changes.refWrite") return t("audit.operation.changesRef");
  if (tool === "changes.sync") return t("audit.operation.changesSync");
  return undefined;
}
export function auditOperation(detail: AuditDetail, t: AuditT): string {
  const changes = changesOperation(auditTool(detail) ?? "", detail, t);
  if (changes) return changes;
  // A connection's own tool (e.g. post_note) has no label; its policy category still says what it was.
  const label = t(
    operationKeys[auditTool(detail) ?? ""] ??
      (detail.category === "send_out" ? "audit.operation.send" : "audit.operation.generic"),
  );
  const target = auditTarget(detail);
  return target ? `${label} ${target}` : label;
}
/**
 * One table for every reason code the audit page or a tool row can name. Exported so the
 * approval card's code lookup (approvals/explanation.ts) shares it instead of keeping a second,
 * smaller copy that silently lost codes such as browser_local_file_unavailable.
 */
export const auditReasonKeys: Record<string, TranslationKey> = {
  browser_local_file_unavailable: "policy.reason.browser_local_file_unavailable",
  host_ssh_not_enabled: "policy.reason.host_ssh_not_enabled",
  host_ssh_identity_required: "policy.reason.host_ssh_identity_required",
  host_ssh_unsupported: "policy.reason.host_ssh_unsupported",
  host_ssh_unverified: "policy.reason.host_ssh_unverified",
  git_configuration_confirmation_required: "policy.reason.git_configuration_confirmation_required",
  git_configuration_unsupported: "policy.reason.git_configuration_unsupported",
  git_configuration_unverified: "policy.reason.git_configuration_unverified",
  git_configuration_sensitive_project_setter:
    "policy.reason.git_configuration_sensitive_project_setter",
  git_entry_confirmation_required: "policy.reason.git_entry_confirmation_required",
  git_entry_include_unknown: "policy.reason.git_entry_include_unknown",
  git_entry_layout_unsupported: "policy.reason.git_entry_layout_unsupported",
  git_entry_scan_incomplete: "policy.reason.git_entry_scan_incomplete",
  git_entry_compound: "policy.reason.git_entry_compound",
  git_entry_dynamic: "policy.reason.git_entry_dynamic",
  git_entry_unsupported_target: "policy.reason.git_entry_unsupported_target",
  outside_workplace_send_denied: "audit.reason.sendOutside",
  outside_workplace_reveal_denied: "audit.reason.revealOutside",
  reveal_not_requested: "audit.reason.revealNotRequested",
  reveal_confirmation_required: "audit.reason.revealConfirmation",
  reveal_unattended_denied: "audit.reason.revealUnattended",
  reveal_unsupported: "audit.reason.unsupported",
  outside_workplace_write_denied: "audit.reason.outside",
  outside_workplace_write: "audit.reason.outside",
  protected_path: "audit.reason.protected",
  readonly_workplace: "policy.reason.readonly_workplace",
  outside_workplace: "audit.reason.outside",
  write_outside_workplace: "audit.reason.outside",
  privilege_escalation_denied: "audit.reason.privilege",
  privilege_escalation: "audit.reason.privilege",
  domain_not_allowed: "audit.reason.network",
  network_denied: "audit.reason.network",
  local_network_denied: "audit.reason.privateNetwork",
  private_network_only: "audit.reason.privateNetwork",
  permission_never: "audit.reason.permission",
  category_unavailable: "audit.reason.unsupported",
  unsupported_category: "audit.reason.unsupported",
  path_or_url_unresolved: "audit.reason.path",
  changed: "audit.reason.changed",
  search_disclosure_required: "audit.reason.disclosure",
  approval_denied_or_expired: "audit.reason.approval",
  // The refusal records its own code, so the person's answer is named after a reload too.
  approval_user_denied: "audit.reason.userDenied",
  approval_cancelled: "audit.reason.stopped",
  approval_expired: "audit.reason.approval",
  tool_authorization_refused: "audit.reason.unauthorized",
  stopped: "audit.reason.stopped",
  invalid_input: "audit.reason.input",
  // Hidden from the default list as an internal event, but shown with its own reason when
  // the person asks to see internal events.
  tool_not_loaded: "audit.reason.notLoaded",
  unknown_tool: "audit.reason.unsupported",
  collaboration_unavailable: "audit.reason.collaboration",
  not_authorized: "audit.reason.unauthorized",
  stale: "audit.reason.stale",
  paused: "audit.reason.paused",
  limit: "audit.reason.limit",
  queue_full: "audit.reason.queue",
  stopping: "audit.reason.stopped",
  journal_started: "audit.reason.journalStarted",
  journal_retry: "audit.reason.journalRetry",
  journal_redo: "audit.reason.journalRedo",
  workspace_folder_added: "policy.reason.workspace_folder_added",
  journal_done: "audit.reason.journalDone",
  journal_failed: "audit.reason.journalFailed",
  journal_replay_done: "audit.reason.journalReplayDone",
  journal_replay_verified: "audit.reason.journalReplayVerified",
  journal_replay_running: "audit.reason.journalReplayRunning",
  journal_replay_unknown: "audit.reason.journalReplayUnknown",
  journal_unknown: "audit.reason.journalUnknown",
  journal_recovered: "audit.reason.journalRecovered",
};
export function auditReason(detail: AuditDetail, t: AuditT, kind?: string) {
  const code = detail.reasonCode ?? detail.reason ?? "";
  const known = Object.hasOwn(auditReasonKeys, code)
    ? auditReasonKeys[code]
    : policyReasonKey(code);
  if (known) return t(known);
  // Records written before the code was structured carry no reason at all. Saying the
  // safety policy blocked them was wrong for a person's own refusal, so name what happened.
  if (kind && isRefusalKind(kind))
    return t(detail.actor === "user" ? "audit.reason.userDenied" : "audit.reason.notRun");
  return t("audit.reason.unrecorded");
}

/**
 * Only a refusal deserves a "rule" line. Every other event (a template group created, a
 * group task closed quietly, a plan migrated) put a reason code in the record for bookkeeping, and
 * showing it under "rule" read as "blocked by the safety policy".
 */
function isRefusalKind(kind: string) {
  return kind === "policy.denied" || kind === "approval.resolved";
}
const authKeys: Record<string, TranslationKey> = {
  "oauth.connected": "audit.auth.connected",
  "oauth.disconnected": "audit.auth.disconnected",
  "oauth.subscriptions_removed": "errors.subscription_unsupported",
  "oauth.subscription_removed": "errors.claude_subscription_unsupported",
  "oauth.chatgpt_migrated": "errors.chatgpt_reconnect_required",
  "oauth.failed": "audit.auth.failed",
  "oauth.reauth_required": "audit.auth.reauth",
  "oauth.risk_acknowledged": "audit.auth.risk",
  "oauth.risk_acknowledged_models_may_be_enabled": "audit.auth.copilotRisk",
};
export function auditProvider(detail: AuditDetail, t: AuditT) {
  const names: Record<string, string> = {
    anthropic: "Claude Pro/Max",
    "openai-codex": "ChatGPT",
    "openai-chatgpt": "ChatGPT",
    "chatgpt-codex": "ChatGPT (Codex)",
    "github-copilot": "GitHub Copilot",
    brave: "Brave",
    tavily: "Tavily",
    searxng: "SearXNG",
  };
  return (
    safeAuditText(detail.providerName ?? names[detail.providerId ?? ""]) ||
    t("audit.provider.unknown")
  );
}
export function auditAuth(detail: AuditDetail, t: AuditT) {
  return t(authKeys[detail.authEvent ?? ""] ?? "audit.auth.generic", {
    provider: auditProvider(detail, t),
  });
}
const imageReasonKeys: Record<string, TranslationKey> = {
  aborted: "audit.reason.stopped",
  // Audit records the cap as reason "timeout"; the message itself carries image_timeout.
  timeout: "errors.image_timeout",
  permission_denied: "errors.permission_denied",
  image_input_required: "errors.image_input_required",
  image_mode_mismatch: "errors.image_mode_mismatch",
  image_unsupported: "errors.image_unsupported",
  image_url_unavailable: "errors.image_url_unavailable",
  no_model: "errors.no_model",
  auth_failed: "errors.auth_failed",
  billing: "errors.billing",
  network: "errors.network",
  proxy_unavailable: "errors.proxy_unavailable",
  proxy_auth_failed: "errors.proxy_auth_failed",
  proxy_credentials_unavailable: "errors.proxy_credentials_unavailable",
  proxy_unsupported: "errors.proxy_unsupported",
  rate_limited: "errors.rate_limited",
  provider_error: "errors.provider_error",
  provider_overloaded: "errors.provider_overloaded",
  provider_rejected: "errors.provider_rejected",
  internal: "errors.internal",
};
export function isKnownImageReason(detail: AuditDetail): boolean {
  const reason = detail.reasonCode ?? detail.reason;
  return reason === "done" || Object.hasOwn(imageReasonKeys, reason ?? "");
}
export function auditImageReason(detail: AuditDetail, t: AuditT): string {
  const reason = detail.reasonCode ?? detail.reason;
  return reason === "done"
    ? t("activity.done")
    : t(imageReasonKeys[reason ?? ""] ?? "audit.reason.generic", { address: t("network.unknown") });
}
export function auditImageProvider(detail: AuditDetail, t: AuditT): string {
  return safeAuditText(detail.providerName ?? detail.providerId) || t("audit.provider.unknown");
}
export function auditFactRows(entry: AuditEntry, t: AuditT, fallbackName?: string) {
  const detail = entry.detail;
  const facts: { label: string; value: string }[] = [];
  const add = (label: TranslationKey, value: string | undefined) => {
    if (value) facts.push({ label: t(label), value: safeAuditText(value) });
  };
  if (isFileCheckpoint(entry)) {
    add("audit.detail.operator", t("audit.actor.automatic"));
    add("audit.detail.operation", t("audit.checkpoint.automatic"));
    add("audit.checkpoint.result", checkpointAuditResult(entry, t).text);
    return facts;
  }
  if (
    entry.kind === "delivery.evidence" ||
    (entry.kind === "exec.finished" && detail.toolName === "delivery_evidence")
  ) {
    add("audit.detail.operation", t("audit.result.recorded"));
    return facts;
  }
  if (entry.kind === "messages.read") {
    add("audit.detail.target", detail.target);
    add("audit.messages.count", `${detail.messageCount ?? 0} / ${detail.conversationCount ?? 0}`);
    return facts;
  }
  if (entry.kind === "image.started" || entry.kind === "image.finished") {
    // Image records have a narrow display contract; never fall back to summary or arbitrary detail fields.
    add("workspace.provider", auditImageProvider(detail, t));
    add("media.model", safeAuditText(detail.modelId) || t("media.audit.unknownModel"));
    if (detail.imageMode) add("media.mode", t(`media.mode.${detail.imageMode}`));
    if (detail.imageCount !== undefined)
      add(
        entry.kind === "image.started" ? "media.audit.references" : "media.audit.outputs",
        String(detail.imageCount),
      );
    if (detail.durationMs !== undefined)
      add(
        "activity.duration",
        t("tool.duration", { seconds: (detail.durationMs / 1000).toFixed(1) }),
      );
    if (detail.reason || detail.reasonCode) add("activity.rule", auditImageReason(detail, t));
    return facts;
  }
  add(
    "audit.detail.operator",
    detail.actor === "phone"
      ? t("audit.actor.phone")
      : detail.actor === "user"
        ? t("audit.actor.user")
        : detail.actor === "system"
          ? t("audit.actor.system")
          : detail.actor === "automatic"
            ? t("audit.actor.automatic")
            : safeAuditText(detail.botName ?? fallbackName),
  );
  add("remote.audit.device", detail.deviceId);
  if (auditTool(detail)) add("audit.detail.operation", auditOperation(detail, t));
  add(
    "audit.detail.target",
    detail.toolName === "browser_open" && detail.fileExtension ? detail.path : auditTarget(detail),
  );
  add("audit.detail.task", detail.taskTitle);
  add("audit.detail.taskSummary", detail.taskSummary);
  add("audit.detail.targetBot", detail.targetBotName);
  if (detail.botRole)
    add(
      "audit.detail.role",
      t(detail.botRole === "coordinator" ? "audit.role.coordinator" : "audit.role.assignee"),
    );
  if (entry.kind.startsWith("tool.journal.")) {
    if (detail.effectClass)
      add("audit.toolJournal.effectClass", t(`audit.toolJournal.effect.${detail.effectClass}`));
    if (detail.attempt !== undefined) add("audit.toolJournal.attempt", String(detail.attempt));
    if (detail.entryCount !== undefined)
      add("audit.toolJournal.entryCount", String(detail.entryCount));
  }
  add("activity.folder", leaf(detail.cwd));
  // A skill change's own sentence already says what happened; a second "rule" row made it
  // look like a policy refusal ("blocked by the safety policy").
  // The same went for every non-refusal event, so only refusals keep the "rule" row;
  // others show a known code as a plain note, and an unknown one says nothing at all.
  if ((detail.reason || detail.reasonCode) && entry.kind !== "skill.changed") {
    if (entry.kind === "git.install") add("audit.detail.note", gitInstallReason(detail, t));
    else if (isRoutineAuditKind(entry.kind)) add("activity.rule", routineAuditReason(entry, t));
    else if (isRefusalKind(entry.kind)) add("activity.rule", auditReason(detail, t, entry.kind));
    else {
      const code = detail.reasonCode ?? detail.reason ?? "";
      const known =
        (Object.hasOwn(auditReasonKeys, code) ? auditReasonKeys[code] : undefined) ??
        (entry.kind === "exec.finished" ? policyReasonKey(code) : undefined);
      if (known) add("audit.detail.note", t(known));
    }
  }
  if (detail.providerId || detail.providerName) add("workspace.provider", auditProvider(detail, t));
  if (detail.authEvent) add("activity.authEvent", auditAuth(detail, t));
  if (detail.category) add("audit.kind", t(`permissions.category.${detail.category}`));
  if (detail.risk) add("activity.risk", t(`activity.risk.${detail.risk}`));
  if (detail.remember !== undefined)
    add("activity.remember", t(detail.remember ? "activity.yes" : "activity.no"));
  if (detail.bytes !== undefined) add("activity.bytes", detail.bytes.toLocaleString());
  if (detail.exitCode !== undefined && detail.exitCode !== null)
    add("audit.detail.exit", String(detail.exitCode));
  if (detail.durationMs !== undefined)
    add(
      "activity.duration",
      t("tool.duration", { seconds: (detail.durationMs / 1000).toFixed(1) }),
    );
  return facts;
}
