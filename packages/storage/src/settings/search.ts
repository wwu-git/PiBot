import type { DatabaseSync } from "node:sqlite";
import { type KernelMethodResults, KernelMethods } from "@pibot/protocol-base";
import { z } from "zod";
import { BotsRepo } from "../bots/bots.ts";
import { ChatSearchIndex } from "../conversations/chat-search-index.ts";
import {
  type Conversation,
  ConversationsRepo,
  visibleImportedRows,
} from "../conversations/conversations.ts";
import { GroupsRepo } from "../groups/groups.ts";
import { MessagesRepo } from "../workspace/repositories.ts";

// One page may scan for at most this long, so a rare word in a large history answers with what it
// found so far plus a cursor instead of holding the brain; "load more" continues from there.
const PAGE_BUDGET_MS = 120;
const SCAN_CHUNK = 400;

const visible = `c.archived_at IS NULL AND c.internal_task_id IS NULL
  AND ${visibleImportedRows("c.import_id")}
  AND (c.bot_id IS NULL OR EXISTS(SELECT 1 FROM bots b WHERE b.id=c.bot_id AND b.archived_at IS NULL))`;
const order = "ORDER BY m.created_at DESC,m.rowid DESC";
const seek = "AND (m.created_at,m.rowid)<($at,$row)";

const CursorSchema = z.strictObject({ at: z.string().max(64), row: z.number().int() });
type Cursor = z.infer<typeof CursorSchema>;
type Position = { id: unknown; at: unknown; row: unknown };
type Scanned = Position & { hit: unknown };

const encode = ({ at, row }: Position) =>
  Buffer.from(JSON.stringify({ at: String(at), row: Number(row) })).toString("base64url");
function decode(cursor: string | undefined): Cursor | undefined {
  if (cursor === undefined) return undefined;
  // Only this repository issues cursors; a malformed one is a caller bug, reported as such.
  return CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
}

export class SearchRepo {
  constructor(private readonly db: DatabaseSync) {}
  query(input: {
    query: string;
    limit?: number;
    cursor?: string;
  }): KernelMethodResults["search.query"] {
    const { query, limit = 50, cursor } = KernelMethods["search.query"].params.parse(input),
      pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const from = decode(cursor);
    const bots = new BotsRepo(this.db),
      groups = new GroupsRepo(this.db),
      messages = new MessagesRepo(this.db);
    // Chats are few and fully listed on the first page; later pages only continue the messages.
    const botRows = from
      ? []
      : this.db
          .prepare(
            "SELECT id FROM bots WHERE archived_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC,id DESC LIMIT ?",
          )
          .all(pattern, limit);
    const groupRows = from
      ? []
      : this.db
          .prepare(
            "SELECT id FROM groups WHERE name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC,id DESC LIMIT ?",
          )
          .all(pattern, limit);
    const topics = from
      ? []
      : this.db
          .prepare(
            `SELECT id FROM conversations c WHERE ${visible} AND kind IN ('dm','group') AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC,id DESC LIMIT ?`,
          )
          .all(pattern, limit);
    const page =
      Array.from(query).length >= 3 && !new ChatSearchIndex(this.db).pending()
        ? this.indexed(query, limit, from)
        : this.scanned(pattern, limit, from);
    const conversations = new ConversationsRepo(this.db),
      found = page.ids.map((id) => messages.get(id)).filter((m) => m !== undefined),
      pick = ({ id, kind, botId, groupId, title, readOnly, importSource }: Conversation) => ({
        id,
        kind,
        botId,
        groupId,
        title,
        ...(readOnly ? { readOnly, importSource } : {}),
      });
    return {
      topics: topics
        .map((row) => conversations.get(String(row.id)))
        .filter((topic) => topic !== undefined)
        .map(pick),
      conversations: [...new Set(found.map((m) => m.conversationId))]
        .map((id) => conversations.get(id))
        .filter((conversation) => conversation !== undefined)
        .map(pick),
      bots: botRows.map((r) => bots.get(String(r.id))).filter((b) => b !== undefined),
      groups: groupRows.map((r) => groups.get(String(r.id))).filter((g) => g !== undefined),
      messages: found,
      nextCursor: page.next,
    };
  }

  /** Three or more characters: the trigram index of chats (redacted text) finds every match. */
  private indexed(query: string, limit: number, from: Cursor | undefined) {
    const rows = this.db
      .prepare(
        `SELECT m.id,m.created_at AS at,m.rowid AS row FROM chat_search_fts
        JOIN chat_search_documents d ON d.rowid=chat_search_fts.rowid
        JOIN messages m ON m.id=d.message_id JOIN conversations c ON c.id=m.conversation_id
        WHERE chat_search_fts MATCH $match AND ${visible} ${from ? seek : ""} ${order} LIMIT $limit`,
      )
      .all({
        $match: `body:"${query.replaceAll('"', '""')}"`,
        $limit: limit + 1,
        ...(from ? { $at: from.at, $row: from.row } : {}),
      }) as Position[];
    const hits = rows.slice(0, limit);
    const last = hits.at(-1);
    return {
      ids: hits.map((r) => String(r.id)),
      next: rows.length > limit && last ? encode(last) : null,
    };
  }

  /**
   * One or two characters (trigrams cannot match them), or the index is still being built: walk
   * messages newest first in chunks within the page budget.
   */
  private scanned(pattern: string, limit: number, from: Cursor | undefined) {
    const first = this.db.prepare(
      `SELECT m.id,m.created_at AS at,m.rowid AS row,m.content LIKE $pattern ESCAPE '\\' AS hit
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE ${visible} ${order} LIMIT ${SCAN_CHUNK}`,
    );
    const next = this.db.prepare(
      `SELECT m.id,m.created_at AS at,m.rowid AS row,m.content LIKE $pattern ESCAPE '\\' AS hit
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE ${visible} ${seek} ${order} LIMIT ${SCAN_CHUNK}`,
    );
    const start = performance.now();
    const ids: string[] = [];
    let at: Position | undefined = from && { id: "", ...from };
    for (;;) {
      const rows = (
        at
          ? next.all({ $pattern: pattern, $at: String(at.at), $row: Number(at.row) })
          : first.all({ $pattern: pattern })
      ) as Scanned[];
      for (const row of rows) {
        if (ids.length === limit) {
          // A further match in what was already read proves there is more; stop at the last shown.
          if (row.hit) return { ids, next: at ? encode(at) : null };
          continue;
        }
        at = row;
        if (row.hit) ids.push(String(row.id));
      }
      if (rows.length < SCAN_CHUNK) return { ids, next: null };
      if (ids.length === limit || performance.now() - start >= PAGE_BUDGET_MS)
        return { ids, next: at ? encode(at) : null };
    }
  }
}
