import { type createTranslator, policyReasonKey, type TranslationKey } from "@pibot/i18n";
import type { Approval, PolicyStep } from "@pibot/protocol";
import { auditReasonKeys } from "../audit/facts.ts";

const reasonKeys: Record<string, TranslationKey> = {
  host_ssh_not_enabled: "policy.reason.host_ssh_not_enabled",
  host_ssh_identity_required: "policy.reason.host_ssh_identity_required",
  host_ssh_unsupported: "policy.reason.host_ssh_unsupported",
  host_ssh_unsupported_syntax: "policy.reason.host_ssh_unsupported_syntax",
  ssh_config_private: "policy.reason.ssh_config_private",
  host_ssh_unsupported_target: "policy.reason.host_ssh_unsupported_target",
  host_ssh_configuration_unavailable: "policy.reason.host_ssh_configuration_unavailable",
  host_ssh_unsupported_configuration: "policy.reason.host_ssh_unsupported_configuration",
  host_ssh_config_strict_host_key: "policy.reason.host_ssh_config_strict_host_key",
  host_ssh_config_option: "policy.reason.host_ssh_config_option",
  host_ssh_config_user: "policy.reason.host_ssh_config_user",
  host_ssh_config_identity_outside_ssh: "policy.reason.host_ssh_config_identity_outside_ssh",

  host_ssh_unverified: "policy.reason.host_ssh_unverified",
  host_ssh_static_identity: "facts.value.host_ssh_static_identity",
  git_configuration_confirmation_required: "policy.reason.git_configuration_confirmation_required",
  git_configuration_unsupported: "policy.reason.git_configuration_unsupported",
  git_configuration_unverified: "policy.reason.git_configuration_unverified",
  git_configuration_project_setter: "policy.reason.git_configuration_project_setter",
  git_configuration_global_setter: "policy.reason.git_configuration_global_setter",
  git_configuration_sensitive_project_setter:
    "policy.reason.git_configuration_sensitive_project_setter",
  git_entry_confirmation_required: "policy.reason.git_entry_confirmation_required",
  git_entry_include_unknown: "policy.reason.git_entry_include_unknown",
  git_entry_layout_unsupported: "policy.reason.git_entry_layout_unsupported",
  git_entry_scan_incomplete: "policy.reason.git_entry_scan_incomplete",
  git_entry_compound: "policy.reason.git_entry_compound",
  git_entry_dynamic: "policy.reason.git_entry_dynamic",
  git_entry_unsupported_target: "policy.reason.git_entry_unsupported_target",
  consent_scope_narrowed: "policy.reason.consent_scope_narrowed",
  readonly_isolation_required: "policy.reason.readonly_isolation_required",
  read_ai_config_once: "policy.reason.read_ai_config_once",
  bot_skill: "policy.reason.bot_skill",
  bot_attachment: "policy.reason.bot_attachment",
  category_unavailable: "policy.reason.category_unavailable",
  pi_manager_main_only: "policy.reason.pi_manager_main_only",
  connector_metadata: "policy.reason.connector_metadata",
  connector_draft_only: "policy.reason.connector_draft_only",
  routine_preauth_unavailable: "policy.reason.routine_preauth_unavailable",
  permission_never: "policy.reason.permission_never",
  permission_ask: "policy.reason.permission_ask",
  permission_always: "policy.reason.permission_always",
  permission_level: "policy.reason.permission_level",
  outside_workplace: "policy.reason.outside_workplace",
  inside_workplace: "policy.reason.inside_workplace",
  outside_workplace_write_denied: "policy.reason.outside_workplace_write_denied",
  outside_workplace_write: "policy.reason.outside_workplace_write",
  protected_path: "policy.reason.protected_path",
  outside_workplace_send_denied: "policy.reason.outside_workplace_send_denied",
  readonly_workplace: "policy.reason.readonly_workplace",
  workspace_readonly: "policy.reason.workspace_readonly",
  workspace_snapshot: "policy.reason.workspace_snapshot",
  workplace_roots: "policy.reason.workplace_roots",
  sensitive_path: "policy.reason.sensitive_path",
  read_ai_config: "policy.reason.read_ai_config",
  ai_config_requires_approval: "policy.reason.ai_config_requires_approval",
  invalid_workplace: "policy.reason.invalid_workplace",
  path_or_url_unresolved: "policy.reason.path_or_url_unresolved",
  domain_not_allowed: "policy.reason.domain_not_allowed",
  local_network_denied: "policy.reason.local_network_denied",
  invalid_image_recipient: "policy.reason.invalid_image_recipient",
  configured_image_service: "policy.reason.configured_image_service",
  paid_generation_confirmation: "policy.reason.paid_generation_confirmation",
  configured_search_endpoint: "policy.reason.configured_search_endpoint",
  own_local_service: "policy.reason.own_local_service",
  private_network_confirmation: "policy.reason.private_network_confirmation",
  private_network_run_approved: "policy.reason.private_network_run_approved",
  private_network_only: "policy.reason.private_network_only",
  network_state_read: "policy.reason.network_state_read",
  dangerous_operation: "policy.reason.dangerous_operation",
  command_network_confirmation: "policy.reason.command_network_confirmation",
  command_install_confirmation: "policy.reason.command_install_confirmation",
  command_background_confirmation: "policy.reason.command_background_confirmation",
  sandboxed_command: "policy.reason.sandboxed_command",
  privilege_escalation_denied: "policy.reason.privilege_escalation_denied",
  incomplete_analysis: "policy.reason.incomplete_analysis",
  windows_requires_approval: "policy.reason.windows_requires_approval",
  windows_ordinary_command: "policy.reason.windows_ordinary_command",
  windows_read_only: "policy.reason.windows_read_only",
  windows_unisolated: "policy.reason.windows_unisolated",
  outside_sandbox_once: "policy.reason.outside_sandbox_once",
  outside_sandbox_strict: "policy.reason.outside_sandbox_strict",
  sandbox_outside_command: "policy.reason.sandbox_outside_command",
  outside_sandbox_no_block: "policy.reason.outside_sandbox_no_block",
  local_service: "policy.reason.local_service",
  system_service_once: "policy.reason.system_service_once",
  local_service_once: "policy.reason.local_service_once",
  outside_sandbox_unsupported: "policy.reason.outside_sandbox_unsupported",
  runner_command_protection_unavailable: "policy.reason.runner_command_protection_unavailable",
  isolation_unavailable: "policy.reason.isolation_unavailable",
  grant_matched: "policy.reason.grant_matched",
  grant_not_matched: "policy.reason.grant_not_matched",
  grant_unavailable: "policy.reason.grant_unavailable",
  confirmation_required: "policy.reason.confirmation_required",
  current_policy_decision: "policy.reason.current_policy_decision",
  yolo: "policy.reason.yolo",
  secret_yolo: "policy.reason.secret_yolo",
  secret_grant_required: "policy.reason.secret_grant_required",
  secret_grant_matched: "policy.reason.secret_grant_matched",
  secret_connector_config: "policy.reason.secret_connector_config",
  secret_write_out: "policy.reason.secret_write_out",
  connector_unavailable: "policy.reason.connector_unavailable",
  connector_tool_denied: "policy.reason.connector_tool_denied",
  connector_confirmation_required: "policy.reason.connector_confirmation_required",
  connector_read_only_mode: "policy.reason.connector_read_only_mode",
  connector_access: "policy.reason.connector_access",
  connector_ask_before_use: "policy.reason.connector_ask_before_use",
  connector_read: "policy.reason.connector_read",
  connector_write_draft: "policy.reason.connector_write_draft",
  user_send_confirmation: "policy.reason.user_send_confirmation",
  bot_send_confirmation: "policy.reason.bot_send_confirmation",
  search_disclosure_required: "policy.reason.search_disclosure_required",
  search_provider_disclosure_required: "policy.reason.search_provider_disclosure_required",
  search_disclosed: "policy.reason.search_disclosed",
  browser_no_page: "policy.reason.browser_no_page",
  browser_login_no_account: "policy.reason.browser_login_no_account",
  browser_login_first: "policy.reason.browser_login_first",
  browser_login_choose: "policy.reason.browser_login_choose",
  browser_login_run_approved: "policy.reason.browser_login_run_approved",
  browser_site_approved: "policy.reason.browser_site_approved",
  browser_submit: "policy.reason.browser_submit",
  computer_coordinates_need_grant: "policy.reason.computer_coordinates_need_grant",
  computer_always_list: "policy.reason.computer_always_list",
  computer_app_not_in_always_list: "policy.reason.computer_app_not_in_always_list",
  app_blocked: "policy.reason.app_blocked",
  computer_run_grant: "policy.reason.computer_run_grant",
  computer_grant_required: "policy.reason.computer_grant_required",
  routine_preauth: "policy.reason.routine_preauth",
  routine_preauth_eligible: "policy.reason.routine_preauth_eligible",
  routine_preauth_valid: "policy.reason.routine_preauth_valid",
  routine_preauth_matched: "policy.reason.routine_preauth_matched",
  routine_preauth_not_matched: "policy.reason.routine_preauth_not_matched",
  routine_resumed_allowed: "policy.reason.routine_resumed_allowed",
  routine_resumed_denied: "policy.reason.routine_resumed_denied",
  group_permission_scope: "policy.reason.group_permission_scope",
  task_frozen_permissions: "policy.reason.task_frozen_permissions",
  plan_readonly: "policy.reason.plan_readonly",
  task_conversation_scope: "policy.reason.task_conversation_scope",
  changed: "policy.reason.changed",
  project_notes_confirmation: "policy.reason.project_notes_confirmation",
  workspace_folder_added: "policy.reason.workspace_folder_added",
  batch_file_consent: "policy.reason.batch_file_consent",
  search_read_list_consent: "policy.reason.search_read_list_consent",
  patch_batch_consent: "policy.reason.patch_batch_consent",
  managed_image_consent: "policy.reason.managed_image_consent",
  image_single_file_consent: "policy.reason.image_single_file_consent",
  connector_direct_write: "policy.reason.connector_direct_write",
  draft_automatic_authorized: "policy.reason.draft_automatic_authorized",
  draft_confirmation_required: "policy.reason.draft_confirmation_required",
  derived_consent_required: "policy.reason.derived_consent_required",
  approval_user_allowed: "policy.reason.approval_user_allowed",
  approval_user_denied: "policy.reason.approval_user_denied",
  approval_expired: "policy.reason.approval_expired",
  approval_cancelled: "policy.reason.approval_cancelled",
  remember_secret_checked: "policy.reason.remember_secret_checked",
  remember_grant_checked: "policy.reason.remember_grant_checked",
  docker_access: "policy.reason.docker_access",
  docker_permission_required: "policy.reason.docker_permission_required",
  docker_explicit_required: "policy.reason.docker_explicit_required",
  docker_unsupported: "policy.reason.docker_unsupported",
  docker_network_unsupported: "policy.reason.docker_network_unsupported",
  docker_command_invalid: "policy.reason.docker_command_invalid",
  docker_endpoint_unavailable: "policy.reason.docker_endpoint_unavailable",
  docker_secret_unsupported: "policy.reason.docker_secret_unsupported",
  background_routine: "policy.reason.background_routine",
  background_limit: "policy.reason.background_limit",
  background_bot_limit: "policy.reason.background_bot_limit",
  message_scope_unavailable: "policy.reason.message_scope_unavailable",
  scoped_tool_metadata: "policy.reason.scoped_tool_metadata",
  bot_owned_memory: "policy.reason.bot_owned_memory",
  memory_after_untrusted: "policy.reason.memory_after_untrusted",
  memory_sensitive: "policy.reason.memory_sensitive",
  own_background_commands: "policy.reason.own_background_commands",
  readonly_command: "policy.reason.readonly_command",
  public_web_read: "policy.reason.public_web_read",
  conversation_web_read: "policy.reason.conversation_web_read",
  run_grant_matched: "policy.reason.run_grant_matched",
  paid_grant_matched: "policy.reason.paid_grant_matched",
  routine_paid_preapproved: "policy.reason.routine_paid_preapproved",
  own_browser_tabs: "policy.reason.own_browser_tabs",
  validated_group_collaboration: "policy.reason.validated_group_collaboration",
  user_confirmation_required: "policy.reason.user_confirmation_required",
  permission_narrowed: "policy.reason.permission_narrowed",
  invalid_tool_input: "policy.reason.invalid_tool_input",
  tool_authorization_refused: "policy.reason.tool_authorization_refused",
  stopped: "policy.reason.stopped",
};

/** Unknown codes stay generic: no backend identifier or untrusted text is shown. */
export function policyStepText(step: PolicyStep, t: ReturnType<typeof createTranslator>) {
  const key = Object.hasOwn(reasonKeys, step.code) ? reasonKeys[step.code] : undefined;
  const text = t(key ?? policyReasonKey(step.code) ?? `policy.axis.${step.axis}`);
  return step.axis === "level" && step.level && step.source
    ? `${text} (${t("policy.level", { source: t(`policy.source.${step.source}`), level: t(`policy.level.${step.level}`) })})`
    : text;
}

/**
 * A card-less refusal keeps only its code. A code the policy table knows names the reason;
 * anything else stays unnamed so no backend identifier reaches the row.
 */
export function policyCodeText(code: string, t: ReturnType<typeof createTranslator>) {
  // A tool row's own refusal code is often only in the audit table (e.g.
  // browser_local_file_unavailable); both tables are read so a code is named wherever it appears.
  const key = Object.hasOwn(reasonKeys, code)
    ? reasonKeys[code]
    : Object.hasOwn(auditReasonKeys, code)
      ? auditReasonKeys[code]
      : undefined;
  const translated = key ?? policyReasonKey(code);
  return translated ? t(translated) : undefined;
}

export function approvalExplanation(
  approval: Pick<Approval, "explanation" | "draft">,
  t: ReturnType<typeof createTranslator>,
) {
  const chain = approval.explanation ?? [];
  const explain = (step: PolicyStep) =>
    approval.draft?.operation === "calendar_create" &&
    [
      "connector_draft_only",
      "connector_write_draft",
      "user_send_confirmation",
      "bot_send_confirmation",
      "draft_confirmation_required",
    ].includes(step.code)
      ? t("draft.calendar.confirmation")
      : policyStepText(step, t);
  const last = chain.findLast(
    (step) =>
      ["allow", "ask", "deny"].includes(step.effect) && step.code !== "current_policy_decision",
  );
  return {
    summary: last
      ? t(
          last.effect === "deny"
            ? "policy.whyDenied"
            : last.effect === "allow"
              ? "policy.whyAllowed"
              : "policy.whyAsk",
          { reason: explain(last) },
        )
      : "",
    label: t("policy.details"),
    steps: chain.map((step) =>
      t("policy.step", {
        reason: explain(step),
        effect: t(`policy.effect.${step.effect}`),
      }),
    ),
  };
}
