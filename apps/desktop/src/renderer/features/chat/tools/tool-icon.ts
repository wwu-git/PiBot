import type { IconName } from "@pibot/ui";

// One icon per kind of tool so a long step list reads at a glance. Only marks that
// already exist in packages/ui; a class without a fitting mark keeps the neutral gear rather
// than gaining a new drawing.
const icons: Record<string, IconName> = {
  read_file: "file",
  office_read: "file",
  office_inspect: "file",
  office_capabilities: "file",
  project_notes: "file",

  write_file: "edit",
  edit_file: "edit",
  apply_patch: "edit",
  office_create: "edit",
  office_edit: "edit",
  review_finding: "edit",

  list_dir: "folder",
  find_files: "folder",
  reveal_in_folder: "folder",

  search_text: "search",
  code_navigate: "search",
  code_outline: "search",
  code_symbols: "search",
  code_map: "search",

  run_command: "terminal",
  background_command: "terminal",
  write_stdin: "terminal",
  check_command_propose: "terminal",

  web_fetch: "globe",
  web_search: "globe",
  local_network: "globe",
  browser_debug: "globe",
  browser_inspect: "globe",

  // Plans, tasks and routines: work the agent tracks rather than an outside system.
  todo_list: "check",
  todo_update: "check",
  todo_pause: "check",
  personal_todo: "check",
  group_plan: "check",
  task_status: "check",
  task_spawn: "check",
  task_message: "check",
  task_wait: "check",
  task_cancel: "check",
  assign_task: "check",
  finish_task: "check",
  delivery_evidence: "check",
  review_start: "audit",
  routine_propose: "clock",
  routine_query: "clock",
  routine_flag_attention: "clock",

  ask_user: "message",
  ask_bot: "message",
  read_messages: "message",
  send_file: "message",
  phone_sms_code: "message",
  phone_calls: "message",
  phone_notifications: "message",
  execution_targets: "folder",
  workplace_use_runner: "folder",
  delegate_to_agent: "bot",
  team_list: "users",
  bot_manage: "users",
  group_manage: "users",
  send_to_bot: "arrow",
  send_to_group: "arrow",

  image_generation: "image",
  image_result: "image",
  phone_media: "image",
  phone_media_get: "image",
  office_preview: "image",
  office_render: "image",

  // Computer use: a person-handing-over mark.
  screenshot: "hand",
  ui_tree: "hand",
  ui_action: "hand",
  pointer: "hand",
  keys: "hand",
  open_app: "hand",
  open_file: "hand",

  // Skills, plugins, connectors and the tools they expose.
  skill_propose: "puzzle",
  tool_discover: "puzzle",
  connection_needed: "puzzle",
  connector_discover: "puzzle",
  connector_call: "puzzle",
  calendar_list_events: "puzzle",
  calendar_create_event: "puzzle",
  contacts_count: "puzzle",
  contacts_search: "puzzle",
  contacts_create: "puzzle",

  // Memory is a kept note; the pin is the closest existing mark. Searches and reads borrow the
  // marks of their read-only counterparts so a memory lookup scans as an ordinary read step.
  memory_add: "pin",
  memory_update: "pin",
  memory_remove: "pin",
  memory_search: "search",
  memory_read: "file",
};

/**
 * Icon for a tool name from the run log. Names come from the agent and connected tools, so an
 * unrecognised one falls back instead of assuming the map has an entry.
 */
export function toolIcon(tool: string): IconName {
  if (Object.hasOwn(icons, tool)) return icons[tool] ?? "settings";
  // The computer extension also registers every tool once more with a "computer_" prefix.
  const bare = tool.startsWith("computer_") ? tool.slice("computer_".length) : undefined;
  if (bare && Object.hasOwn(icons, bare)) return icons[bare] ?? "settings";
  if (tool.startsWith("browser_")) return "globe";
  return "settings";
}
