import type { DatabaseSync } from "node:sqlite";
import {
  ConversationSchema,
  type FolderSelection,
  type KernelMethodParams,
  type KernelMethodResults,
  KernelMethods,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { ConversationsRepo, importProjection, visibleImportedRows } from "./conversations.ts";
import { TopicFoldersRepo } from "./topic-folders.ts";

export class TopicsRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(
    params: KernelMethodParams["topics.list"],
    currentId: string | undefined,
  ): KernelMethodResults["topics.list"] {
    const {
      botId,
      before,
      limit = 50,
      query = "",
      archived = false,
      withMessages = false,
      currentOnly = false,
    } = KernelMethods["topics.list"].params.parse(params);
    if (currentOnly && !currentId) return [];
    const cursor = before ? new ConversationsRepo(this.db).get(before) : undefined;
    if (
      before &&
      (cursor?.kind !== "dm" ||
        cursor.botId !== botId ||
        new ConversationsRepo(this.db).isInternal(before))
    )
      return [];
    const cursorAt = cursor && (withMessages ? this.lastMessageAt(cursor.id) : cursor.updatedAt);
    if (before && !cursorAt) return [];
    // Constant fragment, never user input; each topic's newest message is one index seek on
    // messages_conversation_created, so the scan stays bounded by this Bot's topics.
    const sortAt = withMessages
      ? "(SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=c.id)"
      : "c.updated_at";
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT c.id,c.kind,c.bot_id AS botId,c.pi_session_file AS piSessionFile,
      c.routine_id AS routineId,c.workplace_folder_id AS workplaceFolderId,c.workplace_revision AS workplaceRevision,c.group_id AS groupId,c.thread_of AS threadOf,c.title,c.archived_at AS archivedAt,
      c.created_at AS createdAt,c.updated_at AS updatedAt,c.import_source AS importSource,wf.name AS workplaceFolderName,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS messageCount,
      ${sortAt} AS sortAt
      FROM conversations c LEFT JOIN working_folders wf ON wf.bot_id=c.bot_id AND wf.id=c.workplace_folder_id
      WHERE c.kind='dm' AND c.bot_id=? AND (CASE WHEN ? THEN c.archived_at IS NOT NULL ELSE c.archived_at IS NULL END) AND c.internal_task_id IS NULL
      AND ${visibleImportedRows("c.import_id")}
      AND (? OR c.routine_id IS NOT NULL OR c.import_id IS NOT NULL OR c.id=? OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id) OR EXISTS(SELECT 1 FROM conversation_retries cr WHERE cr.conversation_id=c.id AND cr.state='done'))
      AND instr(lower(c.title),lower(?))>0 AND (?=0 OR c.id=?)) t
      WHERE t.sortAt IS NOT NULL AND (? IS NULL OR t.sortAt<? OR (t.sortAt=? AND t.id<?))
      ORDER BY t.sortAt DESC,t.id DESC LIMIT ?`)
      .all(
        botId,
        archived ? 1 : 0,
        archived ? 1 : 0,
        currentId ?? null,
        query,
        currentOnly ? 1 : 0,
        currentId ?? null,
        before ?? null,
        cursorAt ?? null,
        cursorAt ?? null,
        before ?? null,
        limit,
      );
    return KernelMethods["topics.list"].result.parse(
      rows.map(({ sortAt: _sortAt, importSource, ...row }) => ({
        ...row,
        ...importProjection(importSource),
        isCurrent: row.id === currentId,
        workplaceFolderName:
          typeof row.workplaceFolderName === "string"
            ? row.workplaceFolderName.slice(0, 1000)
            : null,
        workplaceBusy: this.busy(String(row.id)),
      })),
    );
  }

  private lastMessageAt(topicId: string): string | undefined {
    const row = this.db
      .prepare("SELECT MAX(created_at) AS at FROM messages WHERE conversation_id=?")
      .get(topicId);
    return row?.at == null ? undefined : String(row.at);
  }

  // Prepared once per repo: list() asks this for every row (up to 200 per page), so per-call
  // prepares multiplied the statement compiles by the page size.
  private busyStatements?: ReturnType<DatabaseSync["prepare"]>[];
  busy(topicId: string): boolean {
    this.busyStatements ??= [
      "SELECT 1 FROM task_instances WHERE source_conversation_id=? AND status IN ('queued','running','stopping') LIMIT 1",
      `SELECT 1 FROM runs WHERE conversation_id=? AND status IN ('queued','running','waiting') LIMIT 1`,
      `SELECT 1 FROM unattended_runs WHERE (conversation_id=? OR definition_id=(SELECT routine_id FROM conversations WHERE id=?)) AND status IN ('scheduled','running','waiting') LIMIT 1`,
      `SELECT 1 FROM approvals a JOIN messages m ON m.id=a.message_id WHERE m.conversation_id=? AND a.status='pending' LIMIT 1`,
    ].map((sql) => this.db.prepare(sql));
    const [tasks, runs, unattended, approvals] = this.busyStatements;
    return (
      !!tasks?.get(topicId) ||
      !!runs?.get(topicId) ||
      !!unattended?.get(topicId, topicId) ||
      !!approvals?.get(topicId)
    );
  }

  /**
   * Replaces the topic's folders (primary + read-only references). Binding is metadata:
   * updated_at / page ordering stay; refused while the topic has active work.
   */
  setFolders(
    botId: string,
    topicId: string,
    selection: FolderSelection,
    options?: { acpSession?: true },
  ) {
    return transaction(this.db, () => {
      const topic = new ConversationsRepo(this.db).get(topicId);
      if (
        topic?.kind !== "dm" ||
        topic.botId !== botId ||
        topic.archivedAt ||
        new ConversationsRepo(this.db).isInternal(topicId)
      )
        throw new TypeError("Unknown topic");
      if (topic.readOnly) throw new TypeError("import_topic_read_only");
      if (this.busy(topicId)) throw new TypeError("topic_workplace_busy");
      new TopicFoldersRepo(this.db).set(botId, topicId, selection, options);
      const updated = new ConversationsRepo(this.db).get(topicId);
      if (!updated) throw new Error("Topic disappeared during transaction");
      return updated;
    });
  }

  /** Sets the primary folder and keeps the other references (`null`, older "inherit", is `home`). */
  setWorkplace(botId: string, topicId: string, folderId: string | null) {
    return transaction(this.db, () => {
      const current = new TopicFoldersRepo(this.db).selection(topicId);
      const primary = folderId ?? "home";
      return this.setFolders(botId, topicId, {
        primary,
        readonly: current.readonly.filter((id) => id !== primary),
        writable: (current.writable ?? []).filter((id) => id !== primary),
      });
    });
  }

  rename(botId: string, topicId: string, title: string) {
    const topic = new ConversationsRepo(this.db).get(topicId);
    if (
      topic?.kind !== "dm" ||
      topic.botId !== botId ||
      topic.archivedAt ||
      new ConversationsRepo(this.db).isInternal(topicId)
    )
      throw new TypeError("Unknown topic");
    // A rename is metadata, not activity: retain ordering and existing page cursors.
    this.db
      .prepare("UPDATE conversations SET title=? WHERE id=? AND bot_id=? AND kind='dm'")
      .run(title, topicId, botId);
    return ConversationSchema.parse({ ...topic, title });
  }
}
