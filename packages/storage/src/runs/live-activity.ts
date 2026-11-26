import type { DatabaseSync } from "node:sqlite";
import {
  type LiveActivityItem,
  LiveActivityItemSchema,
  type UiNavigation,
} from "@pibot/protocol-base";

const MAX_ITEMS = 20;
const MAX_TITLE = 200;

// The avatar image lives in settings (see BotsRepo); everything else is a bots column.
const BOT = `b.name AS botName,b.avatar_shape AS shape,b.avatar_color AS color,b.avatar_eyes AS eyes,
  (SELECT value FROM settings WHERE key='avatar:bot:' || b.id) AS image`;
const PLACE = `c.kind AS placeKind,c.group_id AS placeGroupId,c.bot_id AS placeBotId,c.routine_id AS routineId`;

// The IN list repeats the runs_unfinished partial-index predicate so SQLite uses it (as
// RunsRepo.activeCount does); queued runs have not started any work yet.
const RUNS = `SELECT r.id AS runId,r.bot_id AS botId,r.conversation_id AS conversationId,r.group_id AS groupId,
  r.kind,COALESCE(r.started_at,r.created_at) AS startedAt,${BOT},${PLACE},
  (SELECT t.title FROM group_tasks t WHERE t.id=r.task_id) AS taskTitle,
  (SELECT ro.name FROM routine_runs rr JOIN routines ro ON ro.id=rr.routine_id WHERE rr.run_id=r.id) AS routineName,
  (SELECT e.plan_json FROM execution_todo e WHERE e.bot_id=r.bot_id AND e.conversation_id=r.conversation_id) AS plan
  FROM runs r JOIN bots b ON b.id=r.bot_id AND b.archived_at IS NULL
  LEFT JOIN conversations c ON c.id=r.conversation_id
  WHERE r.status IN ('queued','running','waiting') AND r.status != 'queued'
  AND (c.id IS NULL OR (c.archived_at IS NULL AND c.internal_task_id IS NULL))
  ORDER BY startedAt,r.id LIMIT 100`;

const APPROVALS = `SELECT a.id,a.bot_id AS botId,a.run_id AS runId,a.message_id AS messageId,a.created_at AS startedAt,
  COALESCE(a.conversation_id,r.conversation_id) AS conversationId,${BOT},${PLACE},
  json_extract(a.request,'$.title') AS title,
  json_extract(a.request,'$.localized.zh.title') AS titleZh,
  json_extract(a.request,'$.localized.en.title') AS titleEn
  FROM approvals a JOIN bots b ON b.id=a.bot_id AND b.archived_at IS NULL
  LEFT JOIN runs r ON r.id=a.run_id
  LEFT JOIN conversations c ON c.id=COALESCE(a.conversation_id,r.conversation_id)
  WHERE a.status='pending' ORDER BY a.created_at,a.id LIMIT ${MAX_ITEMS}`;

type Row = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : null);
/** One line, bounded; the island never shows more than a short title. */
function short(value: unknown): string | null {
  const line = text(value)?.replace(/\s+/gu, " ").trim();
  if (!line) return null;
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/** The plan step in progress, else the plan's goal: what the run's progress line shows. */
function planTitle(plan: unknown): string | null {
  const raw = text(plan);
  if (!raw) return null;
  try {
    const body = JSON.parse(raw) as {
      goal?: unknown;
      items?: { title?: unknown; status?: unknown }[];
    };
    const step = Array.isArray(body.items)
      ? body.items.find((item) => item?.status === "in_progress")
      : undefined;
    return short(step?.title) ?? short(body.goal);
  } catch {
    // A plan row this build cannot read only costs the island its title.
    return null;
  }
}

function avatar(row: Row) {
  let image: string | null = null;
  try {
    image = row.image == null ? null : (JSON.parse(String(row.image)) as string);
  } catch {
    // An unreadable stored image falls back to the drawn avatar, as in the Bot list.
    image = null;
  }
  return {
    shape: String(row.shape),
    color: String(row.color),
    eyes: String(row.eyes),
    image,
  };
}

/** Where a click goes: the DM topic, the group (task thread), or a safe page. */
function target(row: Row, botId: string, messageId?: string): UiNavigation {
  const conversationId = text(row.conversationId);
  const groupId = text(row.placeGroupId);
  if (conversationId && row.placeKind === "dm" && row.placeBotId === botId)
    return {
      botId,
      tab: "topics",
      conversationId,
      ...(messageId ? { messageId } : {}),
    };
  if (conversationId && groupId && row.placeKind === "thread")
    return { view: "group", groupId, threadId: conversationId };
  if (groupId) return { view: "group", groupId };
  return messageId ? { view: "inbox" } : { view: "new-chat", botId };
}

/**
 * Busy Bots for the live island, read from committed run and approval state: running or waiting
 * runs (direct chats, group steps, routines) and pending approval cards. Only names and short
 * titles leave; message text, tool input and file contents are never selected.
 */
export class LiveActivityRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): LiveActivityItem[] {
    const items: LiveActivityItem[] = [];
    const waitingRuns = new Set<string>();
    const waitingPlaces = new Set<string>();
    for (const row of this.db.prepare(APPROVALS).all()) {
      const botId = String(row.botId);
      const zh = short(row.titleZh);
      const en = short(row.titleEn);
      const parsed = LiveActivityItemSchema.safeParse({
        key: `approval:${String(row.id)}`,
        botId,
        botName: short(row.botName) ?? botId,
        avatar: avatar(row),
        kind: "waiting",
        title: short(row.title),
        ...(zh && en ? { localizedTitle: { zh, en } } : {}),
        startedAt: row.startedAt,
        target: target(row, botId, String(row.messageId)),
      });
      if (!parsed.success) continue;
      items.push(parsed.data);
      waitingRuns.add(String(row.runId));
      if (row.conversationId) waitingPlaces.add(`${botId}:${String(row.conversationId)}`);
    }
    const seen = new Set<string>();
    for (const row of this.db.prepare(RUNS).all()) {
      if (items.length >= MAX_ITEMS) break;
      const botId = String(row.botId);
      const place = `${botId}:${String(row.conversationId)}`;
      // The approval card already stands for this work; a Bot's child runs share its topic.
      if (waitingRuns.has(String(row.runId)) || waitingPlaces.has(place) || seen.has(place))
        continue;
      seen.add(place);
      const routine = row.kind === "routine" || row.routineId != null;
      const group = !routine && row.groupId != null;
      const parsed = LiveActivityItemSchema.safeParse({
        key: `run:${place}`,
        botId,
        botName: short(row.botName) ?? botId,
        avatar: avatar(row),
        kind: routine ? "routine" : group ? "group" : "chat",
        title: routine
          ? short(row.routineName)
          : group
            ? (short(row.taskTitle) ?? planTitle(row.plan))
            : planTitle(row.plan),
        startedAt: row.startedAt,
        target: target(row, botId),
      });
      if (parsed.success) items.push(parsed.data);
    }
    return items;
  }
}
