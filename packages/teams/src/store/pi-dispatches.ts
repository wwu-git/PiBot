import type { DatabaseSync } from "node:sqlite";
import { type PiDispatch, PiDispatchSchema, type PiDispatchStatus } from "@pibot/teams-contract";

const columns = `id,tool_call_id AS toolCallId,pi_message_id AS messageId,target_kind AS targetKind,
  target_id AS targetId,target_name AS targetName,target_conversation_id AS targetConversationId,
  title,status,summary,outputs_json AS outputs,created_at AS createdAt,finished_at AS finishedAt`;

export interface OpenDispatch {
  id: string;
  messageId: string;
  kind: "bot" | "group";
  targetId: string;
  conversationId: string;
  status: "working" | "waiting";
  createdAt: string;
}

function parse(row: Record<string, unknown>): PiDispatch {
  return PiDispatchSchema.parse({ ...row, outputs: JSON.parse(String(row.outputs)) });
}

/** The default Pi's hand-offs (one per send_to_bot / send_to_group call). */
export class PiDispatchesRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    id: string;
    piBotId: string;
    piRunId: string;
    piMessageId: string;
    toolCallId: string;
    targetKind: "bot" | "group";
    targetId: string;
    targetName: string;
    title: string;
  }): void {
    this.db
      .prepare(`INSERT INTO pi_dispatches(id,pi_bot_id,pi_run_id,pi_message_id,tool_call_id,
        target_kind,target_id,target_name,title,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'working',?)`)
      .run(
        input.id,
        input.piBotId,
        input.piRunId,
        input.piMessageId,
        input.toolCallId,
        input.targetKind,
        input.targetId,
        input.targetName.slice(0, 200),
        input.title.slice(0, 80),
        new Date().toISOString(),
      );
  }

  started(id: string, conversationId: string, runId: string): void {
    this.db
      .prepare("UPDATE pi_dispatches SET target_conversation_id=?, target_run_id=? WHERE id=?")
      .run(conversationId, runId, id);
  }

  settle(id: string, status: PiDispatchStatus, summary: string, outputs: readonly string[]): void {
    this.db
      .prepare(`UPDATE pi_dispatches SET status=?, summary=?, outputs_json=?,
        finished_at=CASE WHEN ? IN ('working','waiting') THEN NULL ELSE ? END WHERE id=?`)
      .run(
        status,
        summary.slice(0, 600),
        JSON.stringify(outputs.slice(0, 10).map((name) => name.slice(0, 255))),
        status,
        new Date().toISOString(),
        id,
      );
  }

  get(id: string): PiDispatch | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM pi_dispatches WHERE id=?`).get(id);
    return row ? parse(row) : undefined;
  }

  forMessage(messageId: string): PiDispatch[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM pi_dispatches WHERE pi_message_id=? ORDER BY created_at, id LIMIT 20`,
      )
      .all(messageId)
      .map(parse);
  }

  /** Hand-offs this turn already made (the per-turn cap). */
  countForRun(runId: string): number {
    return Number(
      this.db.prepare("SELECT COUNT(*) AS n FROM pi_dispatches WHERE pi_run_id=?").get(runId)?.n ??
        0,
    );
  }

  /** Receipts still open (working or waiting for the person), oldest first, a page at a time. */
  open(limit = 50): OpenDispatch[] {
    return this.db
      .prepare(`SELECT id,pi_message_id AS messageId,target_kind AS kind,target_id AS targetId,
        target_conversation_id AS conversationId,status,created_at AS createdAt
        FROM pi_dispatches WHERE status IN ('working','waiting')
        AND target_conversation_id IS NOT NULL ORDER BY created_at LIMIT ?`)
      .all(limit)
      .map((row) => ({
        id: String(row.id),
        messageId: String(row.messageId),
        kind: row.kind === "group" ? ("group" as const) : ("bot" as const),
        targetId: String(row.targetId),
        conversationId: String(row.conversationId),
        status: row.status === "waiting" ? ("waiting" as const) : ("working" as const),
        createdAt: String(row.createdAt),
      }));
  }

  /** Hand-offs a quit cut off before their message reached the receiver. */
  abandonUnsent(): void {
    this.db
      .prepare(`UPDATE pi_dispatches SET status='failed', finished_at=?
        WHERE status='working' AND target_conversation_id IS NULL`)
      .run(new Date().toISOString());
  }

  /** A hand-off whose message never reached the receiver (refused, or the app stopped first). */
  abandon(id: string): void {
    this.db
      .prepare(`UPDATE pi_dispatches SET status='failed', finished_at=? WHERE id=?
        AND target_conversation_id IS NULL`)
      .run(new Date().toISOString(), id);
  }

  /**
   * Whether the receiver's topic waits for the person: an unanswered card, a question to the
   * person, a group plan to confirm, or a group plan paused for them.
   */
  waitingForPerson(conversationId: string, since: string, groupId: string | null): boolean {
    const topic = `(m.conversation_id=? OR m.conversation_id IN
      (SELECT id FROM conversations WHERE thread_of=?))`;
    return !!this.db
      .prepare(`SELECT 1 WHERE EXISTS (
          SELECT 1 FROM approvals a JOIN runs r ON r.id=a.run_id
          WHERE a.status='pending' AND r.created_at>=? AND (r.conversation_id=? OR r.conversation_id IN
            (SELECT id FROM conversations WHERE thread_of=?)))
        OR EXISTS (SELECT 1 FROM messages m WHERE ${topic} AND m.created_at>=?
          AND m.role='assistant'
          AND json_extract(m.usage,'$.executionPause.reason')='needs_user'
          AND json_extract(m.usage,'$.executionPause.answer') IS NULL
          AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.conversation_id=m.conversation_id
            AND newer.role='user' AND newer.rowid>m.rowid))
        OR EXISTS (SELECT 1 FROM messages m WHERE ${topic} AND m.created_at>=?
          AND json_extract(m.usage,'$.groupPlan.status') IN ('pending','ready','modify')
          AND NOT EXISTS (SELECT 1 FROM group_workflow_runs w
            WHERE w.id=json_extract(m.usage,'$.groupPlan.id')))
        OR EXISTS (SELECT 1 FROM group_workflow_runs w WHERE w.group_id=? AND w.created_at>=?
          AND w.status='waiting')`)
      .get(
        since,
        conversationId,
        conversationId,
        conversationId,
        conversationId,
        since,
        conversationId,
        conversationId,
        since,
        groupId ?? "",
        since,
      );
  }

  /** A group plan started since the hand-off is still running its steps. */
  groupPlanRunning(groupId: string, since: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM group_workflow_runs WHERE group_id=? AND created_at>=?
        AND status='running' LIMIT 1`)
      .get(groupId, since);
  }

  /** The receiver's last finished reply in the topic since the hand-off (a short excerpt). */
  lastReply(conversationId: string, since: string): string {
    const row = this.db
      .prepare(`SELECT content FROM messages WHERE conversation_id=? AND role='assistant'
        AND status='done' AND created_at>=? AND length(content)>0
        ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(conversationId, since);
    return row ? String(row.content) : "";
  }

  /** Bots and groups with a run queued, running or waiting (busy), for the team list. */
  busy(): { bots: Set<string>; groups: Set<string> } {
    const rows = this.db
      .prepare(`SELECT DISTINCT bot_id AS botId, group_id AS groupId FROM runs
        WHERE status IN ('queued','running','waiting','stopping') LIMIT 500`)
      .all();
    return {
      bots: new Set(rows.map((row) => String(row.botId))),
      groups: new Set(rows.flatMap((row) => (row.groupId === null ? [] : [String(row.groupId)]))),
    };
  }

  /** Runs in the receiver's topic since the hand-off (a group plan spreads over several). */
  topicRuns(
    conversationId: string,
    since: string,
  ): { id: string; status: string; errorCode: string | null; messageId: string }[] {
    return this.db
      .prepare(`SELECT id,status,error_code AS errorCode,message_id AS messageId FROM runs
        WHERE (conversation_id=? OR conversation_id IN (
          SELECT id FROM conversations WHERE thread_of=?)) AND created_at>=?
        ORDER BY created_at, rowid LIMIT 200`)
      .all(conversationId, conversationId, since)
      .map((row) => ({
        id: String(row.id),
        status: String(row.status),
        errorCode: row.errorCode === null ? null : String(row.errorCode),
        messageId: String(row.messageId),
      }));
  }

  /** File names attached to the receiver's replies since the hand-off. */
  outputNames(conversationId: string, since: string): string[] {
    return this.db
      .prepare(`WITH replies AS (SELECT id FROM messages WHERE role='assistant' AND created_at>=?
          AND (conversation_id=? OR conversation_id IN (SELECT id FROM conversations WHERE thread_of=?)))
        SELECT a.name AS name FROM attachments a WHERE a.message_id IN (SELECT id FROM replies)
        UNION
        SELECT a.name FROM message_attachment_links l JOIN attachments a ON a.id=l.attachment_id
        WHERE l.message_id IN (SELECT id FROM replies)
        LIMIT 10`)
      .all(since, conversationId, conversationId)
      .map((row) => String(row.name));
  }
}
