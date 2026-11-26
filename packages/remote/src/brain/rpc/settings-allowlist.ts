import { IdSchema, type Methods, RpcError, RpcErrorCodes } from "@pibot/protocol";

/**
 * Bot and group settings on the phone. The same brain methods the desktop
 * profile and group panels call, so both sides stay in sync through the existing change events.
 * Secrets, credentials, providers, imports, duplicate/archive/delete, avatar upload, file open and
 * new folders stay desktop-only by not being listed here.
 */
export const settingsPhoneMethods = [
  "bots.profile",
  "bots.update",
  "models.list",
  "memory.list",
  "memory.status",
  "memory.dream.last",
  "memory.remove",
  "skills.list",
  "skills.get",
  "skills.setEnabled",
  "routines.list",
  "routines.get",
  "routines.setEnabled",
  "permissions.get",
  "permissions.set",
  "grants.list",
  "grants.revoke",
  "connectors.list",
  "connectors.get",
  "connectors.update",
  "groups.get",
  "groups.create",
  "groups.update",
  "groups.addMember",
  "groups.removeMember",
  "groups.memory.list",
  "groups.memory.remove",
  "groups.execution.get",
  "groups.execution.set",
] as const satisfies readonly (keyof typeof Methods)[];
// Keep Dream completion desktop-only because older phones reject unknown replay events.
export const settingsPhoneEvents = [
  "skills.changed",
  "memory.changed",
  "memory.status.changed",
  "permissions.changed",
  "connectors.changed",
  "groups.resources.changed",
] as const;
/** Request-only mark the phone adds after its own local unlock; stripped before dispatch. */
export const PHONE_UNLOCK_KEY = "phoneUnlock";

// Every settings write names the keys it may carry. A key added to a desktop schema later stays
// desktop-only until it is reviewed here, instead of silently reaching the phone.
const writableKeys: Partial<Record<(typeof settingsPhoneMethods)[number], readonly string[]>> = {
  "bots.update": [
    "botId",
    "name",
    "description",
    "avatarShape",
    "avatarColor",
    "avatarEyes",
    "systemPrompt",
    "norms",
    "expectedNorms",
    "modelProvider",
    "modelId",
    "thinkingLevel",
    "memoryMode",
  ],
  "permissions.set": ["botId", "levels", "network", PHONE_UNLOCK_KEY],
  "connectors.update": ["id", "expectedRevision", "access"],
  "groups.create": ["name", "botIds", "coordinatorBotId", "announcement", "autoRoundLimit"],
  // The phone's group settings, plus pausing or continuing the group from its plan sheet.
  "groups.update": [
    "groupId",
    "name",
    "announcement",
    "coordinatorBotId",
    "autoRoundLimit",
    "paused",
  ],
  // Budget limits change what a run may spend; they stay with the desktop budget editor.
  "groups.execution.set": ["groupId", "expectedVersion", "mode"],
  "skills.setEnabled": ["skillId", "enabled"],
  "skills.get": ["skillId"],
};
const unavailable = () => new RpcError(RpcErrorCodes.invalidParams, "remote_parameter_unavailable");

/** Synchronous shape limits, applied with the rest of the phone whitelist before dispatch. */
export function restrictSettingsParams(method: string, input: Record<string, unknown>) {
  const keys = writableKeys[method as keyof typeof writableKeys];
  if (keys && Object.keys(input).some((key) => input[key] !== undefined && !keys.includes(key)))
    throw unavailable();
  // Only models the computer already has configured; adding or browsing others stays there.
  if (method === "models.list" && input.availableOnly !== true) throw unavailable();
  // Bot-scoped only: the global defaults and group overrides are computer settings.
  if (method === "permissions.set" && typeof input.botId !== "string") throw unavailable();
  if (
    method === "memory.status" &&
    (typeof input.botId !== "string" || input.scope !== undefined || input.ownerId !== undefined)
  )
    throw unavailable();
  if (method === "skills.list" && input.groupId !== undefined) throw unavailable();
  // A phone edit must not silently overwrite norms the computer replaced meanwhile.
  if (method === "bots.update" && input.norms !== undefined && input.expectedNorms === undefined)
    throw unavailable();
  const mark = input[PHONE_UNLOCK_KEY];
  if (mark !== undefined && (method !== "permissions.set" || mark !== true)) throw unavailable();
}

const identity = new Set([
  "botId",
  "groupId",
  "id",
  "skillId",
  "expectedNorms",
  "expectedVersion",
  "expectedRevision",
  PHONE_UNLOCK_KEY,
]);
const writes = new Set<string>([
  "bots.update",
  "memory.remove",
  "skills.setEnabled",
  "routines.setEnabled",
  "permissions.set",
  "grants.revoke",
  "connectors.update",
  "groups.create",
  "groups.update",
  "groups.addMember",
  "groups.removeMember",
  "groups.memory.remove",
  "groups.execution.set",
]);
export interface PhoneWriteFacts {
  /** Changed field names only; persona, norms and memory text never enter the audit. */
  fields: string[];
  botId?: string;
  groupId?: string;
  targetBotId?: string;
}
const fieldName = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
/**
 * Audit facts for a phone settings write; undefined for reads and the other phone methods. Refused
 * requests arrive unvalidated, so only well-formed names and IDs are kept.
 */
export function settingsWriteFacts(method: string, params: unknown): PhoneWriteFacts | undefined {
  if (!writes.has(method)) return undefined;
  const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const fields: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || identity.has(key) || !fieldName.test(key)) continue;
    // Permission levels are named per category so a widening is visible in the record.
    if (key === "levels" && value && typeof value === "object")
      for (const category of Object.keys(value))
        if (fieldName.test(category)) fields.push(`levels.${category}`);
    if (key !== "levels") fields.push(key);
  }
  const text = (key: string) => IdSchema.safeParse(input[key]).data;
  const member = method === "groups.addMember" || method === "groups.removeMember";
  if (member) fields.push(method === "groups.addMember" ? "members.add" : "members.remove");
  const botId = text("botId");
  const groupId = text("groupId");
  return {
    fields: fields.slice(0, 40),
    ...(botId && !member ? { botId } : {}),
    ...(botId && member ? { targetBotId: botId } : {}),
    ...(groupId ? { groupId } : {}),
  };
}
