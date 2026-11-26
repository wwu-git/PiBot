// Keeps sidebar ordering and read state consistent with durable conversation activity.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Page,
  PageSchema,
  type SidebarEntry,
  SidebarEntrySchema,
  type SidebarGroup,
  SidebarGroupSchema,
  SidebarKeySchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { defined } from "../database/paging.ts";
import { visibleImportedRows } from "./conversations.ts";
import { pendingPlanActionRows, pendingPlanRows } from "./plan-inbox.ts";

const columns = `conversation_key AS conversationKey,pinned_at AS pinnedAt,group_id AS groupId,hidden_at AS hiddenAt,unread,last_read_at AS lastReadAt,EXISTS(SELECT 1 FROM (${pendingPlanRows} UNION ALL ${pendingPlanActionRows}) pending WHERE pending.groupId=chat_group_id) AS waitingForPlan`;
const groupColumns = "id,name,position,collapsed,created_at AS createdAt";
export class SidebarRepo {
  constructor(private readonly db: DatabaseSync) {}
  archivedCount(): number {
    const row = this.db
      .prepare(`SELECT
        (SELECT COUNT(*) FROM bots WHERE archived_at IS NOT NULL) +
        (SELECT COUNT(*) FROM groups WHERE archived_at IS NOT NULL) AS count`)
      .get();
    return Number(row?.count ?? 0);
  }
  get(key: string): SidebarEntry | undefined {
    SidebarKeySchema.parse(key);
    const row = this.db
      .prepare(`SELECT ${columns} FROM sidebar_entries WHERE conversation_key=?`)
      .get(key);
    return row
      ? SidebarEntrySchema.parse({
          ...row,
          unread: row.unread === 1,
          waitingForPlan: row.waitingForPlan === 1,
        })
      : undefined;
  }
  ensure(key: string): SidebarEntry {
    SidebarKeySchema.parse(key);
    const [kind, id] = key.split(":");
    const active =
      kind === "dm"
        ? this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(id as string)
        : this.db
            .prepare("SELECT 1 FROM groups WHERE id=? AND archived_at IS NULL")
            .get(id as string);
    if (!active) throw new TypeError("Unknown active sidebar target");
    this.db
      .prepare(
        "INSERT INTO sidebar_entries(conversation_key,bot_id,chat_group_id) VALUES (?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(key, kind === "dm" ? (id as string) : null, kind === "group" ? (id as string) : null);
    return this.get(key) as SidebarEntry;
  }
  /**
   * Active Bots and groups without a sidebar row (written straight into the database by an older
   * path or a test fixture) never showed up anywhere. One idempotent statement each, keyed by the
   * primary key; hidden rows keep their hidden state. Returns how many rows were added.
   */
  repairMissing(): number {
    return transaction(this.db, () => {
      const bots = this.db
        .prepare(`INSERT INTO sidebar_entries(conversation_key,bot_id,chat_group_id)
          SELECT 'dm:' || b.id, b.id, NULL FROM bots b WHERE b.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM sidebar_entries e WHERE e.conversation_key='dm:' || b.id)
          ON CONFLICT DO NOTHING`)
        .run().changes;
      const groups = this.db
        .prepare(`INSERT INTO sidebar_entries(conversation_key,bot_id,chat_group_id)
          SELECT 'group:' || g.id, NULL, g.id FROM groups g WHERE g.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM sidebar_entries e WHERE e.conversation_key='group:' || g.id)
          ON CONFLICT DO NOTHING`)
        .run().changes;
      return Number(bots) + Number(groups);
    });
  }
  update(
    key: string,
    patch: Partial<Pick<SidebarEntry, "pinnedAt" | "groupId" | "hiddenAt" | "unread">>,
  ): SidebarEntry {
    const p = defined(
      SidebarEntrySchema.pick({ pinnedAt: true, groupId: true, hiddenAt: true, unread: true })
        .partial()
        .parse(patch),
    );
    return transaction(this.db, () => {
      const v = SidebarEntrySchema.parse({ ...this.ensure(key), ...p });
      this.db
        .prepare(
          "UPDATE sidebar_entries SET pinned_at=?,group_id=?,hidden_at=?,unread=? WHERE conversation_key=?",
        )
        .run(v.pinnedAt, v.groupId, v.hiddenAt, Number(v.unread), key);
      return v;
    });
  }
  open(key: string): SidebarEntry {
    return transaction(this.db, () => {
      this.ensure(key);
      this.db
        .prepare(
          "UPDATE sidebar_entries SET hidden_at=NULL,unread=0,last_read_at=? WHERE conversation_key=?",
        )
        .run(new Date().toISOString(), key);
      return this.get(key) as SidebarEntry;
    });
  }
  /** Read elsewhere (the phone): clears unread only; a hidden conversation stays hidden. */
  read(key: string): SidebarEntry {
    return transaction(this.db, () => {
      this.ensure(key);
      this.db
        .prepare("UPDATE sidebar_entries SET unread=0,last_read_at=? WHERE conversation_key=?")
        .run(new Date().toISOString(), key);
      return this.get(key) as SidebarEntry;
    });
  }
  activity(key: string, unread: boolean): SidebarEntry {
    return this.update(key, { hiddenAt: null, unread });
  }
  list(page: Page = {}, includeHidden = false): SidebarEntry[] {
    const { before, limit = 50 } = PageSchema.parse(page);
    // Each topic can use the end of messages_conversation_created. Aggregating the join would
    // visit old messages too, even though only one timestamp per topic can affect the order.
    const base = `WITH activity AS (
      SELECT e.*, COALESCE(
        (SELECT MAX((
          SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id
          ORDER BY m.created_at DESC LIMIT 1
        )) FROM conversations c
        WHERE c.internal_task_id IS NULL
          AND ${visibleImportedRows("c.import_id")}
          AND ((c.kind='dm' AND c.bot_id=e.bot_id) OR c.group_id=e.chat_group_id)),
        (SELECT created_at FROM bots WHERE id=e.bot_id),
        (SELECT created_at FROM groups WHERE id=e.chat_group_id),
        ''
      ) AS activityAt
      FROM sidebar_entries e WHERE (chat_group_id IS NULL OR EXISTS(SELECT 1 FROM groups g WHERE g.id=e.chat_group_id AND g.archived_at IS NULL)) AND (? OR hidden_at IS NULL) AND (bot_id IS NULL OR EXISTS(SELECT 1 FROM bots b WHERE b.id=e.bot_id AND b.archived_at IS NULL))
    ), ranked AS (SELECT *,ROW_NUMBER() OVER(ORDER BY (pinned_at IS NOT NULL) DESC,pinned_at DESC,activityAt DESC,conversation_key DESC) AS rank FROM activity)`;
    const cursor = before
      ? this.db
          .prepare(`${base} SELECT rank FROM ranked WHERE bot_id=? OR chat_group_id=?`)
          .get(Number(includeHidden), before, before)
      : undefined;
    if (before && !cursor) return [];
    const rows = this.db
      .prepare(`${base} SELECT ${columns} FROM ranked WHERE rank>? ORDER BY rank LIMIT ?`)
      .all(Number(includeHidden), cursor?.rank ?? 0, limit);
    return rows.map((r) =>
      SidebarEntrySchema.parse({
        ...r,
        unread: r.unread === 1,
        waitingForPlan: r.waitingForPlan === 1,
      }),
    );
  }
  groups(page: Page = {}): SidebarGroup[] {
    const { before, limit = 50 } = PageSchema.parse(page);
    const cursor = before ? this.group(before) : undefined;
    if (before && !cursor) return [];
    return this.db
      .prepare(
        `SELECT ${groupColumns} FROM sidebar_groups WHERE (? IS NULL OR position>? OR (position=? AND id>?)) ORDER BY position,id LIMIT ?`,
      )
      .all(before ?? null, cursor?.position ?? 0, cursor?.position ?? 0, before ?? "", limit)
      .map((r) => SidebarGroupSchema.parse({ ...r, collapsed: r.collapsed === 1 }));
  }
  group(id: string): SidebarGroup | undefined {
    const r = this.db.prepare(`SELECT ${groupColumns} FROM sidebar_groups WHERE id=?`).get(id);
    return r ? SidebarGroupSchema.parse({ ...r, collapsed: r.collapsed === 1 }) : undefined;
  }
  createGroup(name: string): SidebarGroup {
    return transaction(this.db, () => {
      const position = Number(
        this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS n FROM sidebar_groups").get()?.n,
      );
      const g = SidebarGroupSchema.parse({
        id: randomUUID(),
        name,
        position,
        collapsed: false,
        createdAt: new Date().toISOString(),
      });
      this.db
        .prepare("INSERT INTO sidebar_groups VALUES (?,?,?,?,?)")
        .run(g.id, g.name, g.position, 0, g.createdAt);
      return g;
    });
  }
  updateGroup(
    id: string,
    patch: Partial<Pick<SidebarGroup, "name" | "position" | "collapsed">>,
  ): SidebarGroup | undefined {
    const current = this.group(id);
    if (!current) return undefined;
    const p = defined(
      SidebarGroupSchema.pick({ name: true, position: true, collapsed: true })
        .partial()
        .parse(patch),
    );
    const g = SidebarGroupSchema.parse({ ...current, ...p });
    this.db
      .prepare("UPDATE sidebar_groups SET name=?,position=?,collapsed=? WHERE id=?")
      .run(g.name, g.position, Number(g.collapsed), id);
    return g;
  }
  removeGroup(id: string): boolean {
    return this.db.prepare("DELETE FROM sidebar_groups WHERE id=?").run(id).changes > 0;
  }
}
