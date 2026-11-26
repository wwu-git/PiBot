export const GIT_CONFIGURATION_CONFIRMATION_REASON = "git_configuration_confirmation_required";
export const GIT_HOOK_CONFIRMATION_REASON = "git_hook_confirmation_required";
export const GIT_HOOKS_PATH_CONFIRMATION_REASON = "git_hooks_path_confirmation_required";
export const OUTSIDE_WRITE_REASON = "outside_workplace_write";
/**
 * Maintainers 2026-11-14: a local-network target (router page, device on the LAN) is asked each time,
 * per target and task; never remembered, preauthorized or answered by YOLO.
 */
export const PRIVATE_NETWORK_REASON = "private_network_confirmation";
/**
 * Owner decision 2026-11-24: a Bot marked `confirmEverySend` asks before each outward send. No
 * grant, connection consent, routine pre-approval or YOLO answers it, and it is never remembered.
 */
export const BOT_SEND_CONFIRMATION_REASON = "bot_send_confirmation";

export const WINDOWS_READ_ONLY = "windows_read_only";
export const WINDOWS_ORDINARY_COMMAND = "windows_ordinary_command";
export const WINDOWS_REQUIRES_APPROVAL = "windows_requires_approval";
