import { type Bot, type MethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { Caller } from "../chat/controls/scope.ts";

// Plain RPC sequences behind the phone's Bot and group settings: the same brain methods
// the desktop profile and group panels call. Hooks add state and cancellation; the dev settings
// scenario calls these directly against the desktop's real phone gateway.

export type BotPatch = Omit<MethodParams["bots.update"], "botId">;
export type PermissionPatch = Omit<MethodParams["permissions.set"], "botId" | "groupId">;
export type GroupPatch = Omit<MethodParams["groups.update"], "groupId">;

/** Optional sections degrade to "unavailable" instead of hiding the whole page. */
async function optional<T>(read: Promise<T>, signal?: AbortSignal) {
  try {
    return await read;
  } catch (error) {
    if (signal?.aborted) throw error;
    // An older computer may refuse a newer method; the page still shows what it can read.
    return undefined;
  }
}
export async function readBotSettings(
  c: Caller,
  botId: string,
  signal?: AbortSignal,
  page?: string,
) {
  const profile = await c.call("bots.profile", { botId }, signal);
  const [models, skills, routines, scoped, global, grants, connectors, dream] = await Promise.all([
    page === "model"
      ? optional(c.call("models.list", { availableOnly: true }, signal), signal)
      : undefined,
    page === "skills" || page === "skill"
      ? optional(c.call("skills.list", { botId, limit: 200 }, signal), signal)
      : undefined,
    page === "routines"
      ? optional(c.call("routines.list", { botId, limit: 200 }, signal), signal)
      : undefined,
    page === "permissions"
      ? optional(c.call("permissions.get", { botId }, signal), signal)
      : undefined,
    page === "permissions"
      ? optional(c.call("permissions.get", undefined, signal), signal)
      : undefined,
    page === "permissions"
      ? optional(c.call("grants.list", { botId, limit: 50 }, signal), signal)
      : undefined,
    page === "connectors" ? optional(readConnectors(c, botId, signal), signal) : undefined,
    page === "memory" ? optional(c.call("memory.dream.last", {}, signal), signal) : undefined,
  ] as const);
  const resourcesUnavailable =
    (page === "model" && !models) ||
    ((page === "skills" || page === "skill") && !skills) ||
    (page === "routines" && !routines) ||
    (page === "permissions" && (!scoped || !global || !grants)) ||
    (page === "connectors" && !connectors);
  return {
    resourcesUnavailable,
    profile,
    models,
    skills,
    routines: routines?.filter((routine) => !routine.deletedAt),
    permissions: scoped && global ? { scoped, global } : undefined,
    grants: grants?.filter((grant) => !grant.revokedAt),
    connectors,
    dream,
  };
}
export type BotSettings = Awaited<ReturnType<typeof readBotSettings>>;
/** Connectors this Bot can use, with their access; same filter as the desktop profile. */
async function readConnectors(c: Caller, botId: string, signal?: AbortSignal) {
  const page = await c.call("connectors.list", { limit: 50 }, signal);
  const details = await Promise.all(
    page.items.map((row) => c.call("connectors.get", { id: row.id }, signal)),
  );
  return details.filter((row) => row.access.mode !== "selected" || row.access.bots.includes(botId));
}

export const updateBot = (c: Caller, botId: string, patch: BotPatch, signal?: AbortSignal) =>
  c.call("bots.update", { botId, ...patch }, signal);
/**
 * Local unlock before an irreversible settings change (safety, maintainers 2026-10-22): the
 * request is sent only after the phone verified its owner; a cancelled or failed unlock throws and
 * nothing reaches the computer. Tightening a permission stays one tap; these cannot be undone.
 */
export type Unlock = (signal?: AbortSignal) => Promise<void>;
async function afterUnlock<T>(
  unlock: Unlock,
  signal: AbortSignal | undefined,
  send: () => Promise<T>,
): Promise<T> {
  await unlock(signal);
  signal?.throwIfAborted();
  return send();
}
export const removeMemory = (
  c: Caller,
  botId: string,
  id: string,
  unlock: Unlock,
  signal?: AbortSignal,
) => afterUnlock(unlock, signal, () => c.call("memory.remove", { botId, id }, signal));
export const setSkillEnabled = (
  c: Caller,
  skillId: string,
  enabled: boolean,
  signal?: AbortSignal,
) => c.call("skills.setEnabled", { skillId, enabled }, signal);
export const readSkill = (c: Caller, skillId: string, signal?: AbortSignal) =>
  c.call("skills.get", { skillId }, signal);
export const setRoutineEnabled = (c: Caller, id: string, enabled: boolean, signal?: AbortSignal) =>
  c.call("routines.setEnabled", { id, enabled }, signal);
export const runRoutineNow = (c: Caller, id: string, signal?: AbortSignal) =>
  c.call("routines.runNow", { id }, signal);
export const revokeGrant = (c: Caller, id: string, signal?: AbortSignal) =>
  c.call("grants.revoke", { id }, signal);

export const unlockRequired = (error: unknown) =>
  error instanceof RpcError &&
  error.code === RpcErrorCodes.unsupported &&
  error.message === "remote_unlock_required";
/**
 * Tightening goes straight through. The computer decides what counts as widening; only when it
 * answers `remote_unlock_required` does the phone run its local unlock and resend the same change
 * with the unlock mark. This function is the app's only sender of that mark.
 */
export async function setPermissions(
  c: Caller,
  botId: string,
  patch: PermissionPatch,
  unlock: Unlock,
  signal?: AbortSignal,
) {
  try {
    return await c.call("permissions.set", { botId, ...patch }, signal);
  } catch (error) {
    if (!unlockRequired(error)) throw error;
  }
  await unlock(signal);
  signal?.throwIfAborted();
  const marked = { botId, ...patch, phoneUnlock: true as const };
  return c.call("permissions.set", marked as MethodParams["permissions.set"], signal);
}
/**
 * Stops this Bot using a connector: removes it from a selected list, or turns "every Bot" into a
 * list of the others. The desktop gateway refuses anything that would give a Bot more access.
 */
export function revokeConnector(
  c: Caller,
  connector: { id: string; revision: number; access: { mode: string; bots: string[] } },
  botId: string,
  allBotIds: readonly string[],
  signal?: AbortSignal,
) {
  const bots =
    connector.access.mode === "all"
      ? allBotIds.filter((id) => id !== botId)
      : connector.access.bots.filter((id) => id !== botId);
  return c.call(
    "connectors.update",
    {
      id: connector.id,
      expectedRevision: connector.revision,
      access: { mode: "selected", bots },
    },
    signal,
  );
}

export async function readGroupSettings(c: Caller, groupId: string, signal?: AbortSignal) {
  const [group, bots, memory, execution] = await Promise.all([
    c.call("groups.get", { groupId }, signal),
    listBots(c, signal),
    optional(c.call("groups.memory.list", { groupId }, signal), signal),
    optional(c.call("groups.execution.get", { groupId }, signal), signal),
  ]);
  return { group, bots, memory, execution };
}
export type GroupSettings = Awaited<ReturnType<typeof readGroupSettings>>;
export const updateGroup = (c: Caller, groupId: string, patch: GroupPatch, signal?: AbortSignal) =>
  c.call("groups.update", { groupId, ...patch }, signal);
export const addMember = (c: Caller, groupId: string, botId: string, signal?: AbortSignal) =>
  c.call("groups.addMember", { groupId, botId }, signal);
export const removeMember = (
  c: Caller,
  groupId: string,
  botId: string,
  unlock: Unlock,
  signal?: AbortSignal,
) => afterUnlock(unlock, signal, () => c.call("groups.removeMember", { groupId, botId }, signal));
export const removeGroupMemory = (
  c: Caller,
  groupId: string,
  id: string,
  unlock: Unlock,
  signal?: AbortSignal,
) =>
  afterUnlock(unlock, signal, () =>
    c.call("groups.memory.remove", { groupId, id, confirmed: true }, signal),
  );
export const setGroupMode = (
  c: Caller,
  groupId: string,
  expectedVersion: number,
  mode: "execute" | "plan",
  signal?: AbortSignal,
) => c.call("groups.execution.set", { groupId, expectedVersion, mode }, signal);
export const createGroup = (c: Caller, name: string, botIds: string[], signal?: AbortSignal) =>
  c.call("groups.create", { name, botIds }, signal);
/** Every active Bot, page by page (a connector's "every other Bot" must not miss one). */
export async function listBots(c: Caller, signal?: AbortSignal) {
  const rows: Bot[] = [];
  for (let page = 0; page < 10; page++) {
    const batch = await c.call("bots.list", { limit: 200, before: rows.at(-1)?.id }, signal);
    rows.push(...batch);
    if (batch.length < 200) return rows.filter((bot) => !bot.archivedAt);
  }
  throw new Error("invalid");
}

/** A versioned / expected-value write lost to a newer change from the computer. */
export function settingsConflict(error: unknown) {
  if (!(error instanceof RpcError)) return false;
  return (
    error.code === RpcErrorCodes.connectorStale ||
    error.message === "bot_norms_changed" ||
    error.message === "execution_version_changed"
  );
}
