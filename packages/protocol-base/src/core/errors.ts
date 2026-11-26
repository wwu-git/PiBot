import { z } from "zod";

export const AgentErrorCodeSchema = z.enum([
  "permission_denied",
  "image_input_required",
  "image_mode_mismatch",
  "image_unsupported",
  // The image service sent nothing back before the generation cap; distinct from a user stop.
  "image_timeout",
  // The image service answered with a link whose image could not be downloaded or was not an image.
  "image_url_unavailable",
  "no_model",
  "auth_failed",
  "claude_subscription_unsupported",
  "subscription_unsupported",
  "chatgpt_reconnect_required",
  "openai_approval_required",
  // A ChatGPT plan request was refused (401/403): its sign-in or the plan's access, not a key.
  "chatgpt_plan_denied",
  // OpenAI says this account, workspace or policy may not use its plan in apps (403
  // subscription_sharing_user_not_eligible): signing in again does not change it.
  "chatgpt_plan_not_eligible",
  "billing",
  "network",
  "proxy_unavailable",
  "proxy_auth_failed",
  "proxy_credentials_unavailable",
  "proxy_unsupported",
  "rate_limited",
  "quota_exhausted",
  "output_limit",
  "provider_error",
  // The provider is overloaded or temporarily unavailable (529/503): retry later or switch model.
  "provider_overloaded",
  // The provider rejected the request itself (400/404/422): retrying the same request will not help.
  "provider_rejected",
  "compaction_failed",
  "compaction_timeout",
  "context_overflow",
  "session_unavailable",
  "budget_exhausted",
  "repeated_operation",
  "computer_stalled",
  "task_unavailable",
  // The task's recorded working folder is no longer the same folder (identity changed).
  "task_workplace_changed",
  "aborted",
  "internal",
  // A listener failed while consuming a model event. Keep this distinct from provider failures so
  // a routine can report a stable diagnostic instead of the unhelpful bare `internal` code.
  "session_event_handler_failed",
  // The run was stopped by the program before any request (not by the user).
  "context_too_large",
  "context_unavailable",
  "tool_catalog_changed",
  // The run's working folder is missing or unreadable; the user must associate it again.
  "workplace_unavailable",
  // A folder on an execution target that is offline, revoked, dropped mid-call, or a
  // workspace mixing devices each needs a different next step, so they are not one "internal".
  "runner_offline",
  "runner_update_required",
  "runner_revoked",
  "runner_disconnected",
  "workplace_mixed_locations",
  "group_workspace_unavailable",
  "group_workspace_unsupported",
  // External agents: the program, its adapter or its sandbox cannot start; the agent itself
  // is not signed in (the user signs in in the agent's own terminal command); Windows needs the
  // per-agent "run unisolated" confirmation first; the agent broke the protocol or exited.
  "agent_unavailable",
  // The topic's folder cannot be used by the agent (the Bot's default folder can).
  "agent_folder_required",
  "agent_login_required",
  "agent_unconfirmed",
  "agent_auth_failed",
  "agent_quota",
  "agent_rate_limited",
  "agent_model_unavailable",
  "agent_failed",
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;

/**
 * The external agent never started for this send (sign-in, folder, confirmation, program,
 * attachment). The message explains what to do; there is no work to show a receipt for and
 * nothing to "investigate" in a follow-up.
 */
export const AGENT_SETUP_ERROR_CODES: ReadonlySet<string> = new Set<AgentErrorCode>([
  "agent_unavailable",
  "agent_folder_required",
  "agent_login_required",
  "agent_unconfirmed",
  "image_unsupported",
]);
