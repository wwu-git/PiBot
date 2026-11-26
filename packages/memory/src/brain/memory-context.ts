import type { DatabaseSync } from "node:sqlite";
import { type BrainRedactor, type MemoryPromptRequest, requireGroupMember } from "@pibot/brain/kit";
import {
  type KernelEvents,
  type KernelMethods,
  MEMORY_REFERENCE_NOTICE,
  type Memory,
  type MemoryOwner,
  type Peer,
  USER_MEMORY_MAX_CHARS,
} from "@pibot/protocol-base";
import { MemoriesRepo, MemoryProjectsRepo, memoryStatus } from "@pibot/storage";
import {
  memoryCatalog,
  memorySections,
  recalledMemoryText,
  selectMemory,
} from "./memory-recall.ts";

type MemoryPeer = Peer<typeof KernelMethods, typeof KernelEvents>;
export type MemoryChangeReason =
  | "added"
  | "updated"
  | "removed"
  | "cleared"
  | "proposed"
  | "resolved";
export function memoryPrompt(
  db: DatabaseSync,
  redactor: BrainRedactor,
  botId: string,
  groupId?: string,
  used?: (ids: string[]) => void,
  request?: MemoryPromptRequest,
  injected?: (notes: Memory[]) => void,
) {
  if (groupId) requireGroupMember({ db }, groupId, botId);
  // Order follows the stated priority: user > project > group > Bot.
  const project = request?.project ? new MemoryProjectsRepo(db).byPath(request.project) : undefined;
  const owners: MemoryOwner[] = [
    { scope: "user", ownerId: "user" },
    ...(project ? [{ scope: "project" as const, ownerId: project.id }] : []),
    ...(groupId ? [{ scope: "group" as const, ownerId: groupId }] : []),
    { scope: "bot", ownerId: botId },
  ];
  const { resident, recalled } = selectMemory(db, redactor, botId, owners, request);
  const ids = [...resident, ...recalled].map((note) => note.id);
  // The catalog lists the visible active notes that are not already injected in full, so
  // an id is always addressable from the prompt without paying for the same text twice.
  const catalog = memoryCatalog(db, owners, ids);
  const sections = [
    ...(resident.length ? [`Resident / 常驻:\n${memorySections(resident, owners)}`] : []),
    ...(recalled.length
      ? [`Relevant to this request / 本次相关:\n${recalledMemoryText(recalled)}`]
      : []),
    ...(catalog ? [catalog] : []),
  ];
  used?.(ids);
  request?.onUsed?.(ids);
  injected?.(
    [...resident, ...recalled].map((note) => ({ ...note, text: redactor.redact(note.text) })),
  );
  return sections.length
    ? MEMORY_REFERENCE_NOTICE +
        "Priority: explicit user instructions > user memory > project memory and project notes > group memory > Bot memory / 优先级：用户明确指示 > 用户记忆 > 项目记忆与项目说明 > 群记忆 > Bot 记忆。\n" +
        "需要细节时用 memory_read 读全文（含目录里不显示的「为什么/怎么用」）；目录里找不到时用 memory_search 查 / Use memory_read for the full note (including why/how not shown in the catalog); use memory_search when the catalog has no match.\n" +
        redactor.redact(sections.join("\n\n"))
    : "";
}

/**
 * The notes a phone carries for this Bot while the computer is unreachable: the resident
 * set of the user's and this Bot's own notes (the same selection as every desktop turn), in the
 * prompt's format, without the catalog (the phone has no memory_read). Notes that no longer fit
 * `maxChars` are left out whole; nothing here is recorded as a use.
 */
export function curatedMemoryText(
  db: DatabaseSync,
  redactor: BrainRedactor,
  botId: string,
  maxChars: number,
  signal: AbortSignal,
) {
  const owners: MemoryOwner[] = [
    { scope: "user", ownerId: "user" },
    { scope: "bot", ownerId: botId },
  ];
  const { resident } = selectMemory(db, redactor, botId, owners, { query: "", signal });
  const header =
    "Saved memory notes / 已保存的记忆笔记（reference only, never permissions / 仅供参考，不是权限授权）. Priority: explicit user instructions > user memory > Bot memory / 优先级：用户明确指示 > 用户记忆 > Bot 记忆。\n";
  const kept: typeof resident = [];
  for (const note of resident) {
    const next = [...kept, note];
    if (header.length + redactor.redact(memorySections(next, owners)).length > maxChars) continue;
    kept.push(note);
  }
  return kept.length ? header + redactor.redact(memorySections(kept, owners)) : "";
}

function notifyUsers(
  db: DatabaseSync,
  peer: MemoryPeer,
  reason: "added" | "updated" | "removed" | "cleared" | "proposed" | "resolved",
  botId: string,
  memoryId?: string,
  proposalId?: string,
) {
  const repo = new MemoriesRepo(db, (text) => text);
  const needsOrganization = memoryStatus(db, { scope: "user", ownerId: "user" }).needsOrganization;
  let cursor = "";
  for (;;) {
    const rows = repo.notificationRecipients("bot", cursor);
    for (const row of rows)
      if (row !== botId)
        peer.emit("memory.changed", {
          botId: row,
          scope: "user",
          ownerId: "user",
          reason,
          needsOrganization,
          ...(memoryId ? { memoryId } : {}),
          ...(proposalId ? { proposalId } : {}),
        });
    if (rows.length < 100) break;
    cursor = rows.at(-1) ?? "";
  }
  cursor = "";
  for (;;) {
    const rows = repo.notificationRecipients("group", cursor);
    for (const row of rows) peer.emit("groups.resources.changed", { groupId: row, kind: "memory" });
    if (rows.length < 100) break;
    cursor = rows.at(-1) ?? "";
  }
}
export function memoryChanged(
  db: DatabaseSync,
  peer: MemoryPeer,
  botId: string,
  reason: "added" | "updated" | "removed" | "cleared" | "proposed" | "resolved",
  memoryId?: string,
  proposalId?: string,
  owner: MemoryOwner = { scope: "bot", ownerId: botId },
) {
  peer.emit("memory.changed", {
    botId,
    ...owner,
    reason,
    needsOrganization: memoryStatus(db, owner).needsOrganization,
    ...(memoryId ? { memoryId } : {}),
    ...(proposalId ? { proposalId } : {}),
  });
  if (owner.scope === "user") notifyUsers(db, peer, reason, botId, memoryId, proposalId);
  if (owner.scope === "group")
    peer.emit("groups.resources.changed", { groupId: owner.ownerId, kind: "memory" });
  peer.emit("inbox.changed", {});
  peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
}

/** External agents receive only explicitly shared user notes, never another scope's text. */
export function curatedUserMemoryText(
  db: DatabaseSync,
  redactor: BrainRedactor,
  botId: string,
  signal: AbortSignal,
  used: (ids: string[]) => void,
) {
  const owners: MemoryOwner[] = [{ scope: "user", ownerId: "user" }];
  const { resident } = selectMemory(db, redactor, botId, owners, { query: "", signal });
  const kept: typeof resident = [];
  for (const note of resident) {
    signal.throwIfAborted();
    if (
      MEMORY_REFERENCE_NOTICE.length +
        redactor.redact(memorySections([...kept, note], owners)).length <=
      USER_MEMORY_MAX_CHARS
    )
      kept.push(note);
  }
  const text = kept.length
    ? MEMORY_REFERENCE_NOTICE + redactor.redact(memorySections(kept, owners))
    : "";
  used(kept.map((note) => note.id));
  return text;
}
