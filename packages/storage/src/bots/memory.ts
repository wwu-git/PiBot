import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Memory,
  type MemoryOwner,
  MemoryPatchSchema,
  type MemoryProposal,
  MemoryProposalSchema,
  MemorySchema,
  type Page,
  PageSchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";
import { makeMemoryRoom } from "./memory-maintenance.ts";
import {
  normalizeMemory,
  SimilarMemoryError,
  sameMemoryRevision,
  similarMemoryId,
} from "./memory-search.ts";

const columns =
  "id,scope,owner_id AS ownerId,bot_id AS botId,text,category,kind,why,how,source_message_id AS sourceMessageId,sources_json,created_at AS createdAt,updated_at AS updatedAt,confirmed_at AS confirmedAt,expires_at AS expiresAt,archived_at AS archivedAt,last_used_at AS lastUsedAt,use_count AS useCount";
// A proposal knows only the message it was read from; its topic is joined here so review screens
// can name and reopen it without a second round trip.
const sourceColumns = ["id", "group_id", "title"]
  .map(
    (column) =>
      `(SELECT c.${column} FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=message_id) AS ${
        column === "id"
          ? "sourceConversationId"
          : column === "group_id"
            ? "sourceGroupId"
            : "sourceTitle"
      }`,
  )
  .join(",");
const proposalColumns =
  "id,scope,owner_id AS ownerId,bot_id AS botId,text,category,message_id AS messageId,CASE WHEN action='remove' AND move_target_bot_id IS NOT NULL THEN 'move' ELSE action END AS action,memory_id AS memoryId,resolved_memory_id AS resolvedMemoryId,status,created_at AS createdAt,expires_at AS expiresAt,project_path AS projectPath,project_diff AS projectDiff,project_expected_hash AS projectExpectedHash,move_target_bot_id AS moveTargetBotId,(SELECT b.name FROM bots b WHERE b.id=scoped_memory_proposals.move_target_bot_id) AS moveTargetBotName,move_target_memory_id AS moveTargetMemoryId,move_target_text AS moveTargetText,move_target_why AS moveTargetWhy,move_target_how AS moveTargetHow," +
  sourceColumns;
/** Optional prose stored next to a note; undefined leaves the stored value untouched. */
export type MemoryNote = {
  why?: string | null;
  how?: string | null;
  projectPath?: string | null;
  projectDiff?: string | null;
  projectExpectedHash?: string | null;
};
function memory(row: Record<string, unknown>): Memory {
  const { sources_json, ...value } = row;
  return MemorySchema.parse({ ...value, sources: JSON.parse(String(sources_json)) });
}
export class MemoriesRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly redact: (text: string) => string,
    private readonly owner?: MemoryOwner,
  ) {}
  private target(botId: string): MemoryOwner {
    return this.owner ?? { scope: "bot", ownerId: botId };
  }
  list(botId: string): Memory[] {
    const o = this.target(botId);
    return this.db
      .prepare(
        `SELECT ${columns} FROM scoped_memories WHERE scope=? AND owner_id=? AND archived_at IS NULL ORDER BY created_at,id LIMIT 100`,
      )
      .all(o.scope, o.ownerId)
      .map(memory);
  }
  page(botId: string, page: Page = {}, state: "active" | "archived" | "all" = "active") {
    const o = this.target(botId);
    return readPage(this.db, "scoped_memories", columns, "created_at", page, [
      ["scope", o.scope],
      ["owner_id", o.ownerId],
      ...(state === "all" ? [] : [["(archived_at IS NULL)", state === "active" ? 1 : 0] as const]),
    ]).map(memory);
  }
  residentPage(botId: string, page: Page = {}) {
    const o = this.target(botId);
    return readPage(this.db, "scoped_memories", columns, "created_at", page, [
      ["scope", o.scope],
      ["owner_id", o.ownerId],
      ["archived_at", null],
      ...(o.scope === "user" ? [] : [["(category IN ('about_you','how_to'))", 1] as const]),
    ]).map(memory);
  }
  visible(botId: string, page: Page = {}, state: "active" | "archived" | "all" = "active") {
    const { before, limit = 100 } = PageSchema.parse(page);
    const cursor = before
      ? this.db
          .prepare(
            "SELECT created_at,id FROM scoped_memories WHERE id=? AND (scope='user' OR (scope='bot' AND owner_id=?))",
          )
          .get(before, botId)
      : undefined;
    if (before && !cursor) return [];
    return this.db
      .prepare(
        `SELECT ${columns} FROM scoped_memories WHERE (scope='user' OR (scope='bot' AND owner_id=?)) AND (?='all' OR (archived_at IS NULL)=?) AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(
        botId,
        state,
        state === "active" ? 1 : 0,
        before ?? null,
        String(cursor?.created_at ?? ""),
        String(cursor?.created_at ?? ""),
        String(cursor?.id ?? ""),
        Math.min(limit, 100),
      )
      .map(memory);
  }
  get(botId: string, id: string): Memory | undefined {
    const o = this.target(botId);
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM scoped_memories WHERE scope=? AND owner_id=? AND (id=? OR id=(SELECT target_id FROM memory_aliases WHERE id=?))`,
      )
      .get(o.scope, o.ownerId, id, id);
    return row ? memory(row) : undefined;
  }
  add(
    botId: string,
    text: string,
    sourceMessageId: string | null = null,
    category: Memory["category"] = null,
    note: MemoryNote = {},
    expiresAt: string | null = null,
  ): Memory {
    this.source(botId, sourceMessageId);
    return this.addAccepted(botId, text, sourceMessageId, category, note, expiresAt);
  }
  similar(botId: string, text: string) {
    const id = similarMemoryId(this.db, this.target(botId), this.redact(text));
    return id ? this.get(botId, id) : undefined;
  }
  private addAccepted(
    botId: string,
    text: string,
    sourceMessageId: string | null,
    category: Memory["category"],
    note: MemoryNote = {},
    expiresAt: string | null = null,
  ): Memory {
    return transaction(this.db, () => {
      const duplicate = this.similar(botId, text);
      if (duplicate) throw new SimilarMemoryError(duplicate);
      const now = new Date().toISOString();
      const o = this.target(botId);
      const value = MemorySchema.parse({
        ...o,
        id: randomUUID(),
        botId,
        text: this.redact(text),
        category,
        kind:
          category === "about_you" ? "preference" : category === "how_to" ? "method" : "decision",
        ...this.notes(note),
        sourceMessageId,
        sources: [{ botId, messageId: sourceMessageId }],
        createdAt: now,
        updatedAt: now,
        expiresAt,
      });
      this.insert(value);
      // The stored row, not the input: the insert fills confirmed_at, and an undo snapshot taken
      // from the input lacked it, so no added note ever matched its snapshot and none could be
      // undone (the chat's "remembered" card never appeared for a note the Bot saved itself).
      return this.get(botId, value.id) as Memory;
    });
  }
  // The extra fields are model- or user-written prose like the note itself, so they pass the
  // same redaction before they are stored or echoed back.
  private notes(note: MemoryNote): MemoryNote {
    // Undefined means "the caller did not mention it", so the key must be absent: merging
    // `why: undefined` over an existing note would delete what the user wrote.
    return {
      ...(note.why === undefined ? {} : { why: note.why === null ? null : this.redact(note.why) }),
      ...(note.how === undefined ? {} : { how: note.how === null ? null : this.redact(note.how) }),
    };
  }
  private insert(m: Memory) {
    const o = this.target(m.botId);
    const text = this.redact(m.text);
    if (!m.archivedAt) makeMemoryRoom(this.db, o, m.botId, m.id, text, this.redact);
    this.db
      .prepare(
        "INSERT INTO scoped_memories(id,scope,owner_id,bot_id,text,category,kind,why,how,source_message_id,sources_json,created_at,updated_at,confirmed_at,expires_at,normalized_text,archived_at,last_used_at,use_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        m.id,
        o.scope,
        o.ownerId,
        m.botId,
        text,
        m.category,
        m.kind ?? null,
        m.why ?? null,
        m.how ?? null,
        m.sourceMessageId,
        JSON.stringify(m.sources ?? [{ botId: m.botId, messageId: m.sourceMessageId }]),
        m.createdAt,
        m.updatedAt,
        m.confirmedAt ?? m.updatedAt,
        m.expiresAt ?? null,
        normalizeMemory(text),
        m.archivedAt ?? null,
        m.lastUsedAt ?? null,
        m.useCount ?? 0,
      );
  }
  update(
    botId: string,
    id: string,
    patch: {
      text?: string;
      category?: Memory["category"];
      why?: string | null;
      how?: string | null;
      expiresAt?: string | null;
    },
  ): Memory | undefined {
    return transaction(this.db, () => {
      const change = MemoryPatchSchema.parse(patch),
        prior = this.get(botId, id);
      if (!prior) return undefined;
      const m = MemorySchema.parse({
        ...prior,
        ...change,
        ...this.notes({ why: change.why, how: change.how }),
        text: change.text === undefined ? prior.text : this.redact(change.text),
        updatedAt: new Date().toISOString(),
      });
      const o = this.target(botId);
      if (!prior.archivedAt && Array.from(m.text).length > Array.from(prior.text).length)
        makeMemoryRoom(this.db, o, botId, m.id, m.text, this.redact);
      this.db
        .prepare(
          "UPDATE scoped_memories SET text=?,category=?,kind=?,why=?,how=?,updated_at=?,confirmed_at=?,expires_at=?,normalized_text=? WHERE scope=? AND owner_id=? AND id=?",
        )
        .run(
          m.text,
          m.category,
          m.kind ?? null,
          m.why ?? null,
          m.how ?? null,
          m.updatedAt,
          m.confirmedAt ?? m.updatedAt,
          m.expiresAt ?? null,
          normalizeMemory(m.text),
          o.scope,
          o.ownerId,
          m.id,
        );
      return m;
    });
  }
  archive(botId: string, id: string, archived: boolean, makeRoom = true): Memory | undefined {
    const prior = this.get(botId, id);
    if (!prior) return undefined;
    const o = this.target(botId);
    return transaction(this.db, () => {
      if (makeRoom && !archived && prior.archivedAt)
        makeMemoryRoom(this.db, o, botId, prior.id, prior.text, this.redact);
      this.db
        .prepare(
          "UPDATE scoped_memories SET archived_at=?,updated_at=? WHERE scope=? AND owner_id=? AND id=?",
        )
        .run(
          archived ? new Date().toISOString() : null,
          new Date().toISOString(),
          o.scope,
          o.ownerId,
          id,
        );
      return this.get(botId, id);
    });
  }
  remove(botId: string, id: string): boolean {
    const o = this.target(botId);
    const current = this.get(botId, id);
    if (!current) return false;
    return (
      this.db
        .prepare("DELETE FROM scoped_memories WHERE scope=? AND owner_id=? AND id=?")
        .run(o.scope, o.ownerId, current.id).changes > 0
    );
  }
  clear(botId: string): number {
    const o = this.target(botId);
    return Number(
      this.db
        .prepare("DELETE FROM scoped_memories WHERE scope=? AND owner_id=?")
        .run(o.scope, o.ownerId).changes,
    );
  }
  restore(m: Memory): Memory {
    return transaction(this.db, () => {
      const value = MemorySchema.parse({
        ...m,
        sourceMessageId: null,
        updatedAt: new Date().toISOString(),
      });
      this.insert(value);
      return this.get(m.botId, m.id) as Memory;
    });
  }
  markUndone(id: string, memoryId: string | null) {
    this.db
      .prepare(
        "UPDATE scoped_memory_proposals SET status='rejected',resolved_memory_id=? WHERE id=? AND status='accepted'",
      )
      .run(memoryId, id);
  }
  notificationRecipients(kind: "bot" | "group", before: string): string[] {
    const table = kind === "bot" ? "bots" : "groups";
    return this.db
      .prepare(
        `SELECT id FROM ${table} WHERE id>?${kind === "bot" ? " AND archived_at IS NULL" : ""} ORDER BY id LIMIT 100`,
      )
      .all(before)
      .map((row) => String(row.id));
  }
  authoredProposals(botId: string, page: Page = { limit: 200 }): MemoryProposal[] {
    return readPage(this.db, "scoped_memory_proposals", proposalColumns, "created_at", page, [
      ["bot_id", botId],
      ["(scope<>'group')", 1],
      ["status", "pending"],
    ]).map((row) => MemoryProposalSchema.parse(row));
  }
  proposal(id: string): MemoryProposal | undefined {
    const row = this.db
      .prepare(`SELECT ${proposalColumns} FROM scoped_memory_proposals WHERE id=?`)
      .get(id);
    return row ? MemoryProposalSchema.parse(row) : undefined;
  }
  proposals(
    botId: string,
    page: Page = {},
    status: MemoryProposal["status"] = "pending",
  ): MemoryProposal[] {
    const o = this.target(botId);
    return readPage(this.db, "scoped_memory_proposals", proposalColumns, "created_at", page, [
      ["scope", o.scope],
      ["owner_id", o.ownerId],
      ["status", status],
      [
        "(NOT EXISTS (SELECT 1 FROM memory_scope_moves m WHERE m.target_proposal_id=scoped_memory_proposals.id))",
        1,
      ],
    ]).map((r) => MemoryProposalSchema.parse(r));
  }
  propose(
    botId: string,
    text: string,
    messageId: string | null = null,
    change: { action: "add" | "update" | "remove"; memoryId: string | null } = {
      action: "add",
      memoryId: null,
    },
    category: Memory["category"] = null,
    note: MemoryNote = {},
    expiresAt: string | null = null,
  ): MemoryProposal {
    return transaction(this.db, () => {
      this.source(botId, messageId);
      const before = change.memoryId ? this.get(botId, change.memoryId) : undefined;
      if (change.action !== "add" && !before) throw new TypeError("Unknown owned memory");
      if (change.action === "add" && change.memoryId !== null)
        throw new TypeError("Add has no memory ID");
      const o = this.target(botId);
      if (change.action === "add") {
        const duplicate = this.similar(botId, text);
        if (duplicate) throw new SimilarMemoryError(duplicate);
      }
      if (o.scope === "group" && this.proposals(botId, { limit: 100 }).length >= 100)
        throw new TypeError("group_memory_quota");
      const p = MemoryProposalSchema.parse({
        ...o,
        ...change,
        id: randomUUID(),
        botId,
        text: this.redact(text),
        messageId,
        category,
        resolvedMemoryId: null,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt,
        projectPath: note.projectPath ?? null,
        projectDiff: note.projectDiff ?? null,
        projectExpectedHash: note.projectExpectedHash ?? null,
      });
      const notes = this.notes(note);
      this.db
        .prepare(
          "INSERT INTO scoped_memory_proposals(id,scope,owner_id,bot_id,text,category,why,how,message_id,action,memory_id,status,created_at,expires_at,project_path,project_diff,project_expected_hash,before_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)",
        )
        .run(
          p.id,
          o.scope,
          o.ownerId,
          p.botId,
          p.text,
          p.category,
          notes.why ?? null,
          notes.how ?? null,
          p.messageId,
          p.action,
          p.memoryId,
          p.createdAt,
          p.expiresAt ?? null,
          // From the parsed proposal: `notes()` keeps only why/how, so reading the project fields
          // from it stored every AGENTS.md card without its path, diff and expected hash.
          p.projectPath ?? null,
          p.projectDiff ?? null,
          p.projectExpectedHash ?? null,
          o.scope === "group" || o.scope === "user" ? JSON.stringify(before ?? null) : null,
        );
      return p;
    });
  }
  resolve(
    id: string,
    accept: boolean,
    resolution?: "archive",
  ): { proposal: MemoryProposal; memory: Memory | null } {
    return transaction(this.db, () => {
      const p = this.proposal(id);
      if (!p) throw new TypeError("Unknown proposal");
      const repo = new MemoriesRepo(this.db, this.redact, {
        scope: p.scope ?? "bot",
        ownerId: p.ownerId ?? p.botId,
      });
      if (p.status !== "pending")
        return {
          proposal: p,
          memory: p.resolvedMemoryId ? (repo.get(p.botId, p.resolvedMemoryId) ?? null) : null,
        };
      let value: Memory | null = null;
      const noteRow = this.db
        .prepare("SELECT why,how FROM scoped_memory_proposals WHERE id=?")
        .get(id) as { why?: string | null; how?: string | null } | undefined;
      // A proposal that did not carry why/how (a management edit, a remove) must leave the stored
      // values alone; only a provided value overwrites them. An empty string is how the proposal
      // encodes "clear it", because the column's NULL already means "not mentioned".
      const note: MemoryNote = {};
      if (noteRow?.why != null) note.why = noteRow.why === "" ? null : noteRow.why;
      if (noteRow?.how != null) note.how = noteRow.how === "" ? null : noteRow.how;
      if (accept) {
        if (p.action === "add")
          value = repo.addAccepted(p.botId, p.text, p.messageId, p.category, note);
        else {
          const prior = p.memoryId ? repo.get(p.botId, p.memoryId) : undefined;
          if (p.scope === "group" || p.scope === "user") {
            const row = this.db
              .prepare("SELECT before_json FROM scoped_memory_proposals WHERE id=?")
              .get(id);
            // A migrated user proposal has no provable before-image; never invent one from
            // today's value. Both human and delayed automatic acceptance must repropose it.
            const snapshot =
              row?.before_json == null
                ? null
                : MemorySchema.parse(JSON.parse(String(row.before_json)));
            if (!prior || !snapshot || !sameMemoryRevision(prior, snapshot))
              throw new TypeError(p.scope === "user" ? "memory_conflict" : "group_memory_conflict");
          }
          if (!prior) throw new TypeError("Proposal target no longer exists");
          if (resolution === "archive") {
            if (p.scope !== "bot" || p.action !== "update")
              throw new TypeError("Invalid automatic archive proposal");
            value = repo.archive(p.botId, prior.id, true) ?? null;
          } else if (p.action === "update")
            value =
              repo.update(p.botId, prior.id, {
                text: p.text,
                category: p.category,
                ...note,
              }) ?? null;
          else repo.remove(p.botId, prior.id);
        }
      }
      this.db
        .prepare(
          "UPDATE scoped_memory_proposals SET status=?,resolved_memory_id=? WHERE id=? AND status='pending'",
        )
        .run(accept ? "accepted" : "rejected", value?.id ?? null, id);
      return { proposal: this.proposal(id) as MemoryProposal, memory: value };
    });
  }
  private source(botId: string, messageId: string | null) {
    if (!this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(botId))
      throw new TypeError("Unknown active Bot");
    const o = this.target(botId);
    if (
      o.scope === "group" &&
      !this.db
        .prepare("SELECT 1 FROM group_members WHERE group_id=? AND bot_id=? AND left_at IS NULL")
        .get(o.ownerId, botId)
    )
      throw new TypeError("group_memory_unavailable");
    if (!messageId) return;
    if (o.scope === "group") {
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM messages m JOIN runs r ON r.id=m.run_id LEFT JOIN task_instances ti ON ti.run_id=r.id LEFT JOIN conversations c ON c.id=ti.source_conversation_id WHERE m.id=? AND r.bot_id=? AND (r.group_id=? OR c.group_id=?) AND m.role='assistant' AND m.status='streaming' AND r.status='running'",
          )
          .get(messageId, botId, o.ownerId, o.ownerId) &&
        // A post-hoc worker has no streaming assistant. Only its group's completed human or
        // coordinator source may use the claimed extraction; ordinary tools keep the live check.
        !this.db
          .prepare(`SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
          JOIN memory_extractions e ON e.conversation_id=c.id
          JOIN groups g ON g.id=c.group_id
          WHERE m.id=? AND m.status='done' AND c.kind='group' AND c.internal_task_id IS NULL AND c.group_id=?
          AND e.group_id=c.group_id AND e.bot_id=? AND e.status='running'
          AND ((m.role='user' AND m.bot_id IS NULL) OR (m.role='assistant' AND m.bot_id=g.coordinator_bot_id
            AND EXISTS(SELECT 1 FROM runs er WHERE er.id=m.run_id AND er.status='done'
              AND er.bot_id=g.coordinator_bot_id AND er.group_id=g.id AND er.conversation_id=c.id AND er.task_id IS NULL)))`)
          .get(messageId, o.ownerId, botId)
      )
        throw new TypeError("group_memory_unavailable");
    } else if (
      !this.db
        .prepare(
          "SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN runs r ON r.id=m.run_id LEFT JOIN task_instances ti ON ti.run_id=r.id LEFT JOIN conversations src ON src.id=ti.source_conversation_id WHERE m.id=? AND (c.bot_id=? OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=COALESCE(r.group_id,src.group_id,c.group_id) AND gm.bot_id=? AND gm.left_at IS NULL))",
        )
        .get(messageId, botId, botId)
    )
      throw new TypeError("Source message is outside Bot conversations");
  }
}
