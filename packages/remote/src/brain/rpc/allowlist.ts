import { type Methods, RpcError, RpcErrorCodes } from "@pibot/protocol";
import {
  restrictSettingsParams,
  settingsPhoneEvents,
  settingsPhoneMethods,
} from "./settings-allowlist.ts";
import { todoPhoneMethods, todoPhoneReads } from "./todos-allowlist.ts";

export const phoneMethods = [
  "bots.list",
  "groups.list",
  "endpoints.list",
  "devices.endpoints",
  "sidebar.list",
  // Reading a chat on the phone clears its unread mark on every client.
  "sidebar.read",
  "topics.list",
  "groups.topics.list",
  "chat.history",
  "groups.topics.history",
  "chat.send",
  "chat.abort",
  "chat.runs",
  "execution.tasks.list",
  "execution.tasks.get",
  "execution.tasks.history",
  "execution.tasks.cancel",
  "groups.tasks",
  "groups.execution.tasks",
  "groups.tasks.history",
  "groups.tasks.summary",
  // The group chat's task progress sheet: the current plan card and its live step states (the
  // desktop task panel's reads), and the two actions that panel offers. Narrowed below.
  "groups.plan.current",
  "groups.plan.progress",
  "groups.workflow.resolve",
  "groups.plan.resolve",
  // Maintainers 2026-11-20: the sheet's pause / continue button (only `paused`, narrowed below).
  "groups.update",
  "continuations.list",
  "continuations.resume",
  "routines.runs",
  "routines.history",
  "routines.summary",
  "routines.pauseAll",
  "routines.resumeAll",
  "routines.runNow",
  "runs.retry",
  // The work receipt under a reply and in task detail (counts and labels, no content).
  "runs.receipt",
  // The default Pi's hand-off receipts under its reply (names, status, a short excerpt).
  "teams.dispatches",
  "approvals.pending",
  "approvals.resolve",
  "inbox.list",
  "inbox.counts",
  "devices.self",
  "remote.session.update",
  "events.resume",
  // Version handshake on connect, so the phone can say which side to update.
  "app.about",
  // The desktop chat controls carried to the phone.
  "topics.switch",
  "topics.create",
  "groups.topics.switch",
  "groups.topics.create",
  "topics.workplace.get",
  "topics.workplace.set",
  "topics.workplace.update",
  "workplaces.pick",
  "workplaces.list",
  "workplaces.browse",
  "execution.get",
  "execution.set",
  "execution.todo.get",
  "execution.budget.get",
  "execution.question.answer",
  "changes.turn",
  "changes.checkpoints.get",
  "changes.checkpoints.restore",
  "conversations.yolo.get",
  "conversations.yolo.set",
  "chat.append",
  "chat.retryPreview",
  "chat.retryFromMessage",
  "chat.compact",
  "chat.compact.cancel",
  // Read-only previews of conversation files and of a run's changes.
  // preview.open / office.open stay out: they open files on the computer.
  "remote.preview.read",
  "office.preview",
  "changes.diff",
  "changes.lines",
  // Watch and drive the computer's Bot browser. The phone never opens
  // pages itself; downloads, uploads, clearing data, cookies and the raw overlay input stay off.
  "browser.tabs",
  "remote.browser.frame",
  "remote.browser.stop",
  "remote.browser.takeover",
  "remote.browser.input",
  "remote.browser.navigate",
  // Share into a conversation (chunked upload kept for this session) and
  // report the phone's data switches. Desktop → phone calls are not phone methods.
  "remote.share.upload",
  "remote.phoneData.state",
  // The computer's run records, read-only and last 3 days only (window,
  // page sizes and the log page are enforced in records-limits.ts). backgroundCommands.stop/open
  // and runs.revealLog/openLog stay off: they act on the computer.
  "audit.list",
  "backgroundCommands.page",
  "runs.readLog",
  "endpoints.capability.set",
  // The phone's offline sync source and the import of its offline chats. The settings
  // methods (remote.offline.get/set/deliver) stay off: only the computer grants a phone models.
  "remote.offline.manifest",
  "remote.runnerControl.pull",
  "remote.offline.snapshot",
  "remote.offline.upload",
  // Bot and group settings; limits live in settings-allowlist.ts.
  ...settingsPhoneMethods,
  // Maintainers 2026-11-20: the phone's To-dos tab; see todos-allowlist.ts.
  ...todoPhoneMethods,
] as const satisfies readonly (keyof typeof Methods)[];
const methodTable = Object.freeze(Object.fromEntries(phoneMethods.map((method) => [method, true])));
/**
 * Phone requests that only read (or, like sidebar.read, only clear an unread mark). They are not
 * audited one by one: the background sync alone issues dozens per connect and buried the real
 * records. Writes, refusals and failures are always audited (AGENTS.md: approvals, execution,
 * outbound sends).
 */
const phoneReads = new Set<string>([
  "bots.list",
  "groups.list",
  "endpoints.list",
  "devices.endpoints",
  "sidebar.list",
  "sidebar.read",
  "topics.list",
  "groups.topics.list",
  "chat.history",
  "groups.topics.history",
  "chat.runs",
  "execution.tasks.list",
  "execution.tasks.get",
  "execution.tasks.history",
  "groups.tasks",
  "groups.execution.tasks",
  "groups.tasks.history",
  "groups.tasks.summary",
  "groups.plan.current",
  "groups.plan.progress",
  "continuations.list",
  "routines.runs",
  "routines.history",
  "routines.summary",
  "runs.receipt",
  "teams.dispatches",
  "approvals.pending",
  "inbox.list",
  "inbox.counts",
  "devices.self",
  "events.resume",
  "app.about",
  "topics.workplace.get",
  "workplaces.list",
  "workplaces.browse",
  "execution.get",
  "execution.todo.get",
  "execution.budget.get",
  "changes.turn",
  "changes.checkpoints.get",
  "conversations.yolo.get",
  "chat.retryPreview",
  "remote.preview.read",
  "office.preview",
  "changes.diff",
  "changes.lines",
  "browser.tabs",
  "remote.phoneData.state",
  "bots.profile",
  "models.list",
  "memory.list",
  "skills.list",
  "skills.get",
  "routines.list",
  "routines.get",
  "permissions.get",
  "grants.list",
  "connectors.list",
  "connectors.get",
  "groups.get",
  "groups.memory.list",
  "groups.execution.get",
  // Run records.
  "audit.list",
  "backgroundCommands.page",
  "runs.readLog",
  // Key deliveries inside a manifest answer are audited one by one by the offline service.
  "remote.offline.manifest",
  "remote.runnerControl.pull",
  "remote.offline.snapshot",
  ...todoPhoneReads,
]);
export const isPhoneRead = (method: string) => phoneReads.has(method);
export const isPhoneMethod = (method: string) => Object.hasOwn(methodTable, method);
const phoneEvents = Object.freeze([
  "chat.message",
  "chat.delta",
  "chat.activity",
  "chat.done",
  "chat.error",
  "chat.status",
  "chat.tool",
  "approval.requested",
  "approval.resolved",
  "teams.dispatch.changed",
  "execution.task.changed",
  "execution.todo.changed",
  "execution.changed",
  "execution.budget.changed",
  "continuations.pending",
  "groups.changed",
  "group.task",
  "group.paused",
  "groups.execution.changed",
  // The task progress sheet re-reads the plan when its card changes (start, replan, status).
  "groups.plan.changed",
  "routines.changed",
  "routine.run",
  "inbox.changed",
  "sidebar.changed",
  "endpoints.changed",
  "devices.changed",
  "bots.changed",
  "conversations.yolo.changed",
  "changes.changed",
  "execution.question.answered",
  "browser.state",
  // The records page and its background sync refresh on these.
  "backgroundCommands.changed",
  // Pull the offline manifest again, or clear everything offline for this computer.
  "remote.offline.changed",
  "remote.interactive",
  // Settings pages refetch on these.
  ...settingsPhoneEvents,
]);
export const isPhoneEvent = (method: string) => (phoneEvents as readonly string[]).includes(method);
export function restrictPhoneParams(method: string, params: unknown) {
  const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const denied = (keys: string[]) => {
    if (keys.some((key) => input[key] !== undefined))
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");
  };
  if (
    method === "workplaces.pick" &&
    (typeof input.location !== "string" ||
      !/^runner:[a-f0-9]{64}$/.test(input.location) ||
      typeof input.path !== "string" ||
      input.create !== undefined ||
      input.association !== undefined)
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");
  if (method === "topics.workplace.update") denied(["acpSession"]);
  // Attachments arrive only as `attachmentIds` of this session's uploads (gateway.ts
  // checks each); inline data would bypass the frame-sized upload and its accounting.
  if (method === "chat.send")
    denied(["attachments", "workplace", "initialMode", "replyToMessageId"]);
  if (method === "runs.retry") {
    denied(["model", "thinkingLevel"]);
    // A phone cannot attest that local side effects have been inspected on this computer.
    if (input.verifiedSideEffects)
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_side_effect_verification_required");
  }
  if (method === "approvals.resolve")
    denied(["rememberSecrets", "preauthorize", "connectorConsent"]);
  // The phone retries a step that waits for the user, as the desktop decision card does; skip,
  // reassign and the final acceptance change what the plan delivers and stay on the computer.
  if (method === "groups.workflow.resolve" && (input.action !== "retry" || input.ownerBotId))
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");
  // Only "check" (continue a start the user already confirmed, cut off before it was admitted).
  // Starting, relaxing checks and modifying a plan need the full card and stay on the computer.
  if (method === "groups.plan.resolve" && input.decision !== "check")
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");
  // Budget limits are settings; the phone only switches between execute and plan.
  if (method === "execution.set") denied(["limits"]);
  if (method === "chat.append") denied(["attachments", "attachmentIds"]);
  // Choosing folders opens a dialog on the computer; a phone topic inherits the current folders.
  if (method === "groups.topics.create") denied(["selectFolder", "folderChoiceId", "selection"]);
  // A phone sees a diff only through a run's own recorded snapshots (the same authority as the
  // { runId, path } preview source), never the working tree or arbitrary commits of a folder.
  if ((method === "changes.diff" || method === "changes.lines") && input.scope !== "turn")
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");
  if (method === "changes.lines" && typeof input.count === "number" && input.count > 500)
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");
  // Smaller pages keep an office page under the phone frame limit (a page may be up to 2 MB).
  if (method === "office.preview" && (typeof input.limit !== "number" || input.limit > 50))
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");
  // A row may contain 2,000 UUIDs; 10 rows fit the phone response frame even at full scope.
  if (method === "endpoints.list" && (typeof input.limit !== "number" || input.limit > 10))
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");
  if (method === "endpoints.capability.set" && input.expected === undefined)
    throw new RpcError(RpcErrorCodes.invalidParams, "endpoint_snapshot_required");
  // Settings writes carry only reviewed keys; the unlock mark only on permissions.set.
  restrictSettingsParams(method, input);
}
