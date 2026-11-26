import { type createTranslator, type Language, type TranslationKey, zh } from "@pibot/i18n";
import type { Approval, ToolCallRecord } from "@pibot/protocol";
import { policyCodeText, policyStepText } from "../approvals/explanation.ts";
import type { LiveRunActivity } from "./activity-types.ts";
import { computerToolKey } from "./computer-names.ts";

const names: Record<string, TranslationKey> = {
  task_status: "tool.task_status",
  finish_task: "tool.finish_task",
  assign_task: "tool.assign_task",
  ask_bot: "tool.ask_bot",
  personal_todo: "tool.personal_todo",
  ask_user: "tool.ask_user",
  memory_add: "tool.memory_add",
  memory_update: "tool.memory_update",
  memory_remove: "tool.memory_remove",
  memory_search: "tool.memory_search",
  memory_read: "tool.memory_read",
  code_navigate: "tool.code_navigate",
  code_outline: "tool.code_outline",
  code_symbols: "tool.code_symbols",
  code_map: "tool.code_map",
  review_read: "tool.review_read",
  delivery_evidence: "tool.delivery_evidence",
  image_result: "tool.image_result",
  apply_patch: "tool.apply_patch",
  connection_needed: "tool.connection_needed",
  connector_discover: "tool.connector_discover",
  connector_call: "tool.connector_call",
  routine_propose: "tool.routine_propose",
  routine_query: "tool.routine_query",
  routine_flag_attention: "tool.routine_flag_attention",
  calendar_list_events: "tool.calendar_list_events",
  calendar_create_event: "tool.calendar_create_event",
  contacts_count: "tool.contacts_count",
  contacts_search: "tool.contacts_search",
  contacts_create: "tool.contacts_create",

  tool_discover: "tool.tool_discover",
  group_plan: "tool.group_plan",
  todo_pause: "tool.todo_pause",
  todo_list: "agentWork.readPlan",
  todo_update: "agentWork.updatePlan",
  task_spawn: "agentWork.spawnTask",
  task_message: "agentWork.messageTask",
  task_wait: "agentWork.waitTask",
  task_cancel: "agentWork.cancelTask",
  review_start: "agentWork.startReview",
  browser_network: "browserDebug.networkLog",
  browser_request: "browserDebug.request",
  browser_secret: "browserDebug.reveal",
  browser_debug: "browserDebug.title",
  browser_inspect: "browserDebug.select",
  read_messages: "tool.read_messages",
  image_generation: "media.audit.operation",
  list_dir: "tool.list_dir",
  find_files: "tool.find_files",
  search_text: "tool.search_text",
  read_file: "tool.read_file",
  office_inspect: "tool.office_inspect",
  office_read: "tool.office_read",
  office_create: "tool.office_create",
  office_edit: "tool.office_edit",
  office_preview: "tool.office_preview",
  office_render: "tool.office_render",
  office_validate: "tool.office_validate",
  office_capabilities: "tool.office_capabilities",
  office_convert: "tool.office_convert",

  send_file: "tool.send_file",
  reveal_in_folder: "tool.reveal_in_folder",
  local_network: "tool.local_network",
  project_notes: "tool.project_notes",
  write_file: "tool.write_file",
  edit_file: "tool.edit_file",
  run_command: "tool.run_command",
  background_command: "tool.background_command",
  write_stdin: "tool.write_stdin",
  web_fetch: "tool.web_fetch",
  web_search: "tool.web_search",
  review_finding: "tool.review_finding",
  skill_propose: "skills.tool.propose",
  check_command_propose: "tool.check_command_propose",
  phone_media: "tool.phone_media",
  phone_media_get: "tool.phone_media_get",
  phone_sms_code: "tool.phone_sms_code",
  phone_calls: "tool.phone_calls",
  phone_notifications: "tool.phone_notifications",
  execution_targets: "tool.execution_targets",
  workplace_use_runner: "tool.workplace_use_runner",
  delegate_to_agent: "tool.delegate_to_agent",
  team_list: "tool.team_list",
  bot_manage: "tool.bot_manage",
  group_manage: "tool.group_manage",
  send_to_bot: "tool.send_to_bot",
  send_to_group: "tool.send_to_group",
};
// A finished phone read names what came back ("读取了手机照片 3 张"), written by the
// brain in the run's language; the row shows that sentence instead of the generic tool name.
const summaryLabels = new Set([
  "phone_media",
  "phone_media_get",
  "phone_sms_code",
  "phone_calls",
  "phone_notifications",
  "execution_targets",
  "workplace_use_runner",
  // The finished row names the agent and how its work ended.
  "delegate_to_agent",
  // The default Pi's management and hand-off steps name what they changed or whom they asked.
  "bot_manage",
  "group_manage",
  "send_to_bot",
  "send_to_group",
]);
/** A row label taken from the tool's own summary (a skill use, a finished phone read). */
export function toolSummaryLabel(tool: { tool: string; status: string; summary: string }) {
  if (tool.tool === "read_file" && /^(?:用了技能「.+」|Used skill ".+")$/.test(tool.summary))
    return tool.summary;
  return summaryLabels.has(tool.tool) && tool.status === "done" && tool.summary
    ? tool.summary
    : undefined;
}

export interface ToolPaths {
  home?: string;
  current?: string;
}

export function toolNameKey(tool: string): TranslationKey {
  return Object.hasOwn(names, tool)
    ? (names[tool] ?? "tool.unknown")
    : (computerToolKey(tool) ?? "tool.unknown");
}

/**
 * A connection tool in words: the bundled label for built-in tool names, then the tool's
 * bundled display translation, then the tool's own name (the MCP description is untrusted).
 */
export function connectorToolLabel(
  tool: { tool: string; label?: { zh: string; en: string } },
  language: Language,
  t: ReturnType<typeof createTranslator>,
) {
  const key = `connectors.tool.${tool.tool}`;
  if (Object.hasOwn(zh, key)) return t(key as TranslationKey);
  return tool.label?.[language] || tool.tool;
}

/** Unknown tools use a neutral action rather than exposing an internal identifier. */
export function toolDisplayName(tool: string, t: ReturnType<typeof createTranslator>) {
  return t(toolNameKey(tool));
}

export interface RunActivityText {
  waiting(seconds: number): string;
  preparing(tool: string, characters: string, seconds: number): string;
  executing(tool: string, seconds: number): string;
  /** An image run reports its one paid request as executing `image_generation`. */
  generatingImage(seconds: number): string;
}

/** `chat.activity` tool value while an external agent starts: `agent_start:<name>`. */
export const AGENT_START_TOOL = "agent_start:";

/** One presentation path for desktop and phone; elapsed time is always client-local. */
export function runActivityText(
  activity: LiveRunActivity,
  now: number,
  t: ReturnType<typeof createTranslator>,
  text: RunActivityText,
) {
  const seconds = Math.max(0, Math.floor((now - activity.startedAt) / 1000));
  if (activity.phase === "waiting_model")
    return activity.readingWindow ? t("chat.readingWindow") : text.waiting(seconds);
  if (activity.phase === "executing_tool" && activity.tool === "ui_tree")
    return t("chat.readingWindow");
  // An external agent's program is starting (Windows can take a minute); the tool field
  // carries its name so older clients still read it as a running step.
  if (activity.phase === "executing_tool" && activity.tool.startsWith(AGENT_START_TOOL))
    return t("chat.startingAgent", {
      name: activity.tool.slice(AGENT_START_TOOL.length),
      seconds: String(seconds),
    });
  // Reusing executing_tool keeps older clients readable ("Running Image generation").
  if (activity.phase === "executing_tool" && activity.tool === "image_generation")
    return text.generatingImage(seconds);
  const tool = toolDisplayName(activity.tool, t);
  return activity.phase === "preparing_tool"
    ? text.preparing(tool, activity.characters.toLocaleString(), seconds)
    : text.executing(tool, seconds);
}

export function toolTarget(tool: string, summary: string) {
  const prefix = `${tool}: `;
  if (summary.startsWith(prefix)) return summary.slice(prefix.length);
  if (tool === "project_notes" || tool === "write_file" || tool === "edit_file") {
    // Historical write results keep a basename, not its original parent directories.
    const written = /^(?:写入了 (.+)（\d+ 字节）|Wrote (.+) \(\d+ bytes\))$/.exec(summary);
    return written?.[1] ?? written?.[2];
  }
  return undefined;
}

const windows = (path: string) => /^[a-z]:[\\/]|^\\\\/i.test(path);
function normalized(path: string) {
  const value = windows(path) ? path.replaceAll("\\", "/") : path;
  const drive = /^[a-z]:\//i.exec(value)?.[0];
  const unc = windows(path) && value.startsWith("//");
  const prefix = drive ?? (unc ? "//" : "/");
  const parts: string[] = [];
  for (const part of value.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > (unc ? 2 : 0)) parts.pop();
    } else parts.push(part);
  }
  return prefix + parts.join("/");
}

function relativeTo(path: string, root: string) {
  const value = normalized(path);
  const base = normalized(root);
  const compare = windows(path) || windows(root) ? value.toLowerCase() : value;
  const parent = windows(path) || windows(root) ? base.toLowerCase() : base;
  if (compare === parent) return "";
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return compare.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

/** Display shortening only: these strings never determine permissions or file-open targets. */
export function displayToolTarget(tool: string, target: string, paths: ToolPaths) {
  if (
    ![
      "list_dir",
      "read_file",
      "reveal_in_folder",
      "write_file",
      "edit_file",
      "office_inspect",
      "office_read",
      "office_create",
      "office_edit",
      "office_preview",
      "office_render",
      "office_convert",
    ].includes(tool)
  )
    return target;
  if (!target.startsWith("/") && !windows(target)) return target;
  // Comparison normalizes separators; the row should still read like the user's own path (observed
  // on Windows: step titles showed `.cache/report.html` with forward slashes).
  const native = windows(target) || windows(paths.home ?? "") || windows(paths.current ?? "");
  const shown = (value: string) => (native ? value.replaceAll("/", "\\") : value);
  const home = paths.home ? relativeTo(target, paths.home) : undefined;
  if (home !== undefined) return home ? `~${native ? "\\" : "/"}${shown(home)}` : "~";
  const current = paths.current ? relativeTo(target, paths.current) : undefined;
  if (current !== undefined) return current ? shown(current) : ".";
  const chars = Array.from(target);
  return chars.length > 80 ? `${chars.slice(0, 40).join("")}…${chars.slice(-30).join("")}` : target;
}

/** Compatibility with the existing backend refusal receipt; never infer refusal from today's mode. */
export function isPlanReadOnly(
  tool: Pick<ToolCallRecord, "status" | "summary"> & { output?: string },
) {
  return (
    tool.status === "blocked" &&
    (tool.output ?? tool.summary) ===
      "当前话题为只读规划模式，此操作不会执行；切换到执行模式后重试 / This topic is in read-only Plan mode; switch to execution mode before retrying this operation"
  );
}

function stepOutcome(
  status?: ToolCallRecord["status"],
  approvalStatus?: Approval["status"],
  exitCode?: number | null,
) {
  // Explicit rejection is a user decision, including legacy drafts recorded as tool errors.
  if (approvalStatus === "denied") return "denied";
  // Other durable terminal states win over intermediate approval snapshots.
  if (status === "blocked") return "denied";
  if (status === "aborted") return "aborted";
  // The step's own status decides. grep's "no matches" is recorded as a done step that
  // exits 1, so a non-zero code alone no longer means failure; only a record without a status (an
  // older draft) still falls back to it.
  if (status === "error") return "failed";
  if (status === undefined && typeof exitCode === "number" && exitCode !== 0) return "failed";
  if (approvalStatus === "auto_denied") return "denied";
  if (approvalStatus === "cancelled" || approvalStatus === "expired") return "aborted";
  return undefined;
}

/**
 * A refused step names the short, localized policy reason (e.g. "only the workplace is
 * writable") instead of only "Denied". Codes come from the approval chain, so an unknown code
 * falls back to its axis text: no raw message, path or backend identifier reaches the row.
 */
export function toolDenialReason(
  tool: Pick<ToolCallRecord, "status" | "denialReason"> & {
    approval?: Pick<Approval, "status" | "explanation">;
  },
  t: ReturnType<typeof createTranslator>,
) {
  // A final execution check takes precedence over a previously approved card.
  if (tool.status === "error" && tool.denialReason)
    return policyCodeText(tool.denialReason, t) ?? t("policy.reason.execution_check_failed");
  const refused =
    tool.status === "blocked" ||
    tool.approval?.status === "denied" ||
    tool.approval?.status === "auto_denied";
  if (!refused) return undefined;
  const last = tool.approval?.explanation?.findLast(
    (step) => ["deny", "ask"].includes(step.effect) && step.code !== "current_policy_decision",
  );
  // A refusal that never had a card stores its own code; a known policy code names the
  // reason, an unknown one leaves the row as plain "Denied".
  return last ? policyStepText(last, t) : policyCodeText(tool.denialReason ?? "", t);
}

export function toolGroupSummary(
  tools: (Pick<ToolCallRecord, "tool" | "status" | "exitCode"> & {
    approval?: Pick<Approval, "status" | "explanation">;
    summary?: string;
    output?: string;
  })[],
  t: ReturnType<typeof createTranslator>,
  unmatched: Approval[] = [],
  /** Maintainers 2026-11-13: the slim line under a direct chat's sentence — 「7 步 · 列目录、运行命令 3」. */
  short = false,
) {
  const counts = new Map<TranslationKey, number>();
  const outcomes = { failed: 0, denied: 0, aborted: 0 };
  for (const tool of tools) {
    const name = toolNameKey(tool.tool);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const outcome = tool.approval?.explanation?.some(
      (entry) => entry.code === "workspace_folder_added",
    )
      ? "aborted"
      : tool.summary &&
          isPlanReadOnly({ status: tool.status, summary: tool.summary, output: tool.output })
        ? undefined
        : stepOutcome(tool.status, tool.approval?.status, tool.exitCode);
    if (outcome) outcomes[outcome]++;
  }
  for (const approval of unmatched) {
    const outcome = stepOutcome(undefined, approval.status);
    if (outcome) outcomes[outcome]++;
  }
  const types = [...counts].map(([name, count]) =>
    short
      ? count === 1
        ? t(name)
        : t("tool.fold.typeShort", { tool: t(name), count })
      : t("tool.group.count", { tool: t(name), count }),
  );
  const summary = tools.length
    ? t(
        short
          ? tools.length === 1
            ? "tool.fold.summaryShortOne"
            : "tool.fold.summaryShort"
          : tools.length === 1
            ? "tool.fold.summaryOne"
            : "tool.fold.summary",
        { count: tools.length, types: types.join(t("tool.group.separator")) },
      )
    : "";
  return [
    summary,
    ...(unmatched.length ? [t("tool.fold.approvals", { count: unmatched.length })] : []),
    ...(["failed", "denied", "aborted"] as const).flatMap((outcome) =>
      outcomes[outcome] ? [t(`tool.fold.${outcome}`, { count: outcomes[outcome] })] : [],
    ),
  ]
    .filter(Boolean)
    .join(" · ");
}
