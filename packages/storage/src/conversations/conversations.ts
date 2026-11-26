import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ConversationSchema,
  type FolderSelection,
  FolderSelectionSchema,
  IdSchema,
  type Page,
  PageSchema,
  type Conversation as ProtocolConversation,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";
import { TopicFoldersRepo } from "./topic-folders.ts";

export type Conversation = ProtocolConversation;
export type DmConversation = Conversation & { kind: "dm"; botId: string };
const columns =
  "id,kind,bot_id AS botId,pi_session_file AS piSessionFile,group_id AS groupId,thread_of AS threadOf,routine_id AS routineId,workplace_folder_id AS workplaceFolderId,workplace_revision AS workplaceRevision,title,archived_at AS archivedAt,created_at AS createdAt,updated_at AS updatedAt,import_source AS importSource";

// Staged imports and batches being removed are invisible even while their rows still exist.
export function visibleImportedRows(column: "import_id" | "c.import_id") {
  return `(${column} IS NULL OR ${column} IN (
    SELECT id FROM import_jobs WHERE state='completed' AND cleanup_phase IS NULL))`;
}

export const visibleImport = visibleImportedRows("import_id");

export function importProjection(source: unknown) {
  return typeof source === "string" ? { readOnly: true as const, importSource: source } : {};
}

function parseConversation({ importSource, ...row }: Record<string, unknown>) {
  return ConversationSchema.parse({ ...row, ...importProjection(importSource) });
}
export class ConversationsRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): Conversation | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM conversations WHERE id=? AND ${visibleImport}`)
      .get(id);
    return row ? parseConversation(row) : undefined;
  }
  isInternal(id: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM conversations WHERE id=? AND internal_task_id IS NOT NULL")
      .get(id);
  }
  // Legacy list remains DM-only and insertion-ordered; paginated topics use topics().
  list(botId?: string): DmConversation[] {
    const rows =
      botId === undefined
        ? this.db
            .prepare(
              `SELECT ${columns} FROM conversations WHERE kind='dm' AND internal_task_id IS NULL AND ${visibleImport} ORDER BY rowid`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT ${columns} FROM conversations WHERE kind='dm' AND bot_id=? AND internal_task_id IS NULL AND ${visibleImport} ORDER BY rowid`,
            )
            .all(botId);
    return rows.map((r) => parseConversation(r) as DmConversation);
  }
  topics(botId: string, page: Page = {}): DmConversation[] {
    return readPage(this.db, "conversations", columns, "updated_at", page, [
      ["bot_id", botId],
      ["kind", "dm"],
      ["archived_at", null],
      ["internal_task_id", null],
      ["import_id", null],
    ]).map((r) => parseConversation(r) as DmConversation);
  }
  /**
   * Every new topic owns its folders from the start: the given selection (a new-topic draft)
   * or the previous topic's, written in the same transaction as the topic row.
   */
  create(input: {
    botId: string;
    piSessionFile?: string | null;
    workplace?: FolderSelection;
  }): DmConversation {
    IdSchema.parse(input.botId);
    const now = new Date().toISOString();
    const folders = new TopicFoldersRepo(this.db);
    const value = {
      id: randomUUID(),
      kind: "dm" as const,
      botId: input.botId,
      piSessionFile: input.piSessionFile ?? null,
      groupId: null,
      threadOf: null,
      routineId: null,
      workplaceFolderId: null as string | null,
      workplaceRevision: 0,
      title: "",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return transaction(this.db, () => {
      const selection = input.workplace
        ? FolderSelectionSchema.parse(input.workplace)
        : folders.initial(value.botId);
      folders.validate(value.botId, selection);
      value.workplaceFolderId = selection.primary;
      this.db
        .prepare(
          "INSERT INTO conversations(id,kind,bot_id,pi_session_file,created_at,updated_at,workplace_folder_id) VALUES (?,'dm',?,?,?,?,?)",
        )
        .run(value.id, value.botId, value.piSessionFile, now, now, selection.primary);
      folders.insertReadonly(value.botId, value.id, selection.readonly);
      folders.insertWritable(value.botId, value.id, selection.writable ?? []);
      if (value.piSessionFile)
        new BotSessionsRepo(this.db).set(value.botId, value.id, value.piSessionFile);
      this.db
        .prepare(
          "INSERT INTO sidebar_entries(conversation_key,bot_id) VALUES (?,?) ON CONFLICT DO NOTHING",
        )
        .run(`dm:${value.botId}`, value.botId);
      return value;
    });
  }
  createGroup(groupId: string, threadOf?: string): Conversation {
    IdSchema.parse(groupId);
    if (threadOf) {
      const parent = this.get(threadOf);
      if (parent?.kind !== "group" || parent.groupId !== groupId)
        throw new TypeError("Invalid thread parent");
    }
    const now = new Date().toISOString(),
      id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO conversations(id,kind,group_id,thread_of,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, threadOf ? "thread" : "group", groupId, threadOf ?? null, now, now);
    if (!threadOf)
      this.db
        .prepare(
          "INSERT INTO group_current_topics(group_id,conversation_id) VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET conversation_id=excluded.conversation_id",
        )
        .run(groupId, id);
    return this.get(id) as Conversation;
  }
  forGroup(groupId: string): Conversation | undefined {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM conversations WHERE kind='group' AND group_id=? ORDER BY id=(SELECT conversation_id FROM group_current_topics WHERE group_id=?) DESC,archived_at IS NULL DESC,updated_at DESC,id DESC LIMIT 1`,
      )
      .get(groupId, groupId);
    return row ? parseConversation(row) : undefined;
  }
  threads(groupId: string, page: Page = {}): Conversation[] {
    return readPage(this.db, "conversations", columns, "created_at", page, [
      ["group_id", groupId],
      ["kind", "thread"],
    ]).map(parseConversation);
  }
  switchTopic(botId: string, topicId: string): DmConversation {
    const topic = this.get(topicId);
    if (
      topic?.kind !== "dm" ||
      topic.botId !== botId ||
      topic.archivedAt ||
      this.isInternal(topicId)
    )
      throw new TypeError("Unknown topic");
    if (topic.readOnly) return topic as DmConversation;
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`topic:${botId}`, JSON.stringify(topicId));
    return topic as DmConversation;
  }
  currentDmIfPresent(botId: string): DmConversation | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(`topic:${botId}`);
    const id = row ? JSON.parse(String(row.value)) : undefined,
      topic = id ? this.get(id) : undefined;
    // Archiving the selected topic starts a draft; it must not silently select older history.
    if (topic?.kind === "dm" && topic.botId === botId && topic.archivedAt) return undefined;
    return topic?.kind === "dm" &&
      topic.botId === botId &&
      !topic.archivedAt &&
      !topic.readOnly &&
      !this.isInternal(topic.id)
      ? (topic as DmConversation)
      : this.latestChatTopic(botId);
  }
  /**
   * Without a stored choice the newest topic is current, but never a routine's own topic: Mac
   * acceptance 2026-11-20, creating a routine (a new, newest topic) pulled the Pi chat away from
   * the topic the user was in. A Bot with only routine topics still gets the newest one.
   */
  private latestChatTopic(botId: string): DmConversation | undefined {
    const recent = this.topics(botId, { limit: 50 });
    return recent.find((item) => !item.routineId) ?? recent[0];
  }
  currentDm(botId: string): DmConversation {
    return this.currentDmIfPresent(botId) ?? this.ensureDm(botId);
  }
  update(id: string, patch: { piSessionFile: string | null }): Conversation | undefined {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return undefined;
      if (current.kind !== "dm") throw new TypeError("Group sessions require BotSessionsRepo");
      this.db
        .prepare("UPDATE conversations SET pi_session_file=?,updated_at=? WHERE id=?")
        .run(patch.piSessionFile, new Date().toISOString(), id);
      const sessions = new BotSessionsRepo(this.db);
      if (patch.piSessionFile) sessions.set(current.botId as string, id, patch.piSessionFile);
      else sessions.remove(current.botId as string, id);
      return this.get(id);
    });
  }
  ensureDm(botId: string): DmConversation {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(`SELECT ${columns} FROM conversations
        WHERE kind='dm' AND bot_id=? AND internal_task_id IS NULL AND archived_at IS NULL
          AND import_id IS NULL ORDER BY rowid LIMIT 1`)
        .get(botId);
      return row ? (parseConversation(row) as DmConversation) : this.create({ botId });
    });
  }
  archive(id: string): void {
    this.db
      .prepare("UPDATE conversations SET archived_at=?,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), new Date().toISOString(), id);
  }
  restore(id: string): void {
    this.db
      .prepare("UPDATE conversations SET archived_at=NULL,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }
  remove(id: string): boolean {
    return transaction(this.db, () => {
      if (this.get(id)?.readOnly)
        this.db
          .prepare("DELETE FROM messages WHERE conversation_id=? AND import_id IS NOT NULL")
          .run(id);
      this.db.prepare("DELETE FROM bot_sessions WHERE conversation_id=?").run(id);
      return this.db.prepare("DELETE FROM conversations WHERE id=?").run(id).changes > 0;
    });
  }
}
export class BotSessionsRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(botId: string, conversationId: string): string | undefined {
    const r = this.db
      .prepare("SELECT pi_session_file FROM bot_sessions WHERE bot_id=? AND conversation_id=?")
      .get(botId, conversationId);
    return r ? String(r.pi_session_file) : undefined;
  }
  set(botId: string, conversationId: string, file: string): void {
    IdSchema.parse(botId);
    IdSchema.parse(conversationId);
    if (!file) throw new TypeError("Empty session path");
    const c = new ConversationsRepo(this.db).get(conversationId);
    if (
      !c ||
      (c.kind === "dm"
        ? c.botId !== botId
        : !this.db
            .prepare(
              "SELECT 1 FROM group_members WHERE group_id=? AND bot_id=? AND left_at IS NULL",
            )
            .get(c.groupId as string, botId))
    )
      throw new TypeError("Session Bot does not belong to conversation");
    this.db
      .prepare(
        "INSERT INTO bot_sessions(bot_id,conversation_id,pi_session_file) VALUES (?,?,?) ON CONFLICT(bot_id,conversation_id) DO UPDATE SET pi_session_file=excluded.pi_session_file",
      )
      .run(botId, conversationId, file);
  }
  list(conversationId: string, page: Page = {}): { botId: string; piSessionFile: string }[] {
    const { before, limit = 50 } = PageSchema.parse(page);
    return this.db
      .prepare(
        "SELECT bot_id AS botId,pi_session_file AS piSessionFile FROM bot_sessions WHERE conversation_id=? AND (? IS NULL OR bot_id>?) ORDER BY bot_id LIMIT ?",
      )
      .all(conversationId, before ?? null, before ?? null, limit)
      .map((r) => ({ botId: String(r.botId), piSessionFile: String(r.piSessionFile) }));
  }
  remove(botId: string, conversationId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM bot_sessions WHERE bot_id=? AND conversation_id=?")
        .run(botId, conversationId).changes > 0
    );
  }
}
