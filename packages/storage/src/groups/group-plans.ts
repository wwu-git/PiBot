// Plan cards retain verification provenance for bounded, idempotent startup recovery.
import type { DatabaseSync } from "node:sqlite";
import {
  type GroupPlanAttempts,
  GroupPlanAttemptsSchema,
  type GroupPlanCard,
  GroupPlanCardSchema,
  type Message,
} from "@pibot/protocol-base";
import { MessagesRepo } from "../workspace/repositories.ts";

/** Plans are versioned message metadata, separate from the engine's durable step ledger. */
export class GroupPlansRepo {
  private readonly messages: MessagesRepo;
  constructor(private readonly db: DatabaseSync) {
    this.messages = new MessagesRepo(db);
  }
  get(messageId: string): { message: Message; card: GroupPlanCard } | undefined {
    const message = this.messages.get(messageId);
    const usage = message?.usage;
    const card = GroupPlanCardSchema.safeParse(
      usage && typeof usage === "object" && !Array.isArray(usage) ? usage.groupPlan : undefined,
    );
    return message && card.success ? { message, card: card.data } : undefined;
  }
  forCycle(conversationId: string, cycleId: string) {
    const row = this.db
      .prepare(`SELECT id FROM messages WHERE conversation_id=?
      AND json_extract(usage,'$.groupPlan.cycleId')=?
      ORDER BY rowid DESC LIMIT 1`)
      .get(conversationId, cycleId);
    return row ? this.get(String(row.id)) : undefined;
  }
  /** The card a plan was started from, by the card's own id, within the conversation it was posted in. */
  byCardId(conversationId: string, cardId: string) {
    const row = this.db
      .prepare(`SELECT id FROM messages WHERE conversation_id=?
      AND json_extract(usage,'$.groupPlan.id')=?
      ORDER BY rowid DESC LIMIT 1`)
      .get(conversationId, cardId);
    return row ? this.get(String(row.id)) : undefined;
  }
  forVerification(conversationId: string, cycleId: string, sourceRunId: string) {
    const row = this.db
      .prepare(`SELECT id FROM messages WHERE conversation_id=?
      AND json_extract(usage,'$.groupPlan.cycleId')=?
      AND json_extract(usage,'$.groupPlan.verification.sourceRunId')=?
      ORDER BY rowid DESC LIMIT 1`)
      .get(conversationId, cycleId, sourceRunId);
    return row ? this.get(String(row.id)) : undefined;
  }
  pendingVerifications(after = "") {
    return this.db
      .prepare(`WITH recent AS MATERIALIZED (
        SELECT m.id, m.usage, c.cycle_id FROM groups g
        JOIN group_cycles c ON c.group_id=g.id
        JOIN conversations topic ON topic.id=(
          SELECT id FROM conversations WHERE group_id=g.id AND kind='group'
          ORDER BY id=(SELECT conversation_id FROM group_current_topics WHERE group_id=g.id) DESC,
            archived_at IS NULL DESC,updated_at DESC,id DESC LIMIT 1
        )
        JOIN messages m ON m.rowid IN (
          SELECT rowid FROM messages WHERE conversation_id=topic.id
          ORDER BY created_at DESC LIMIT 200
        )
      ) SELECT id AS messageId,
      json_extract(usage,'$.groupPlan.originRunId') AS sourceRunId,
      json_extract(usage,'$.groupPlan.verification.workflowRunId') AS workflowRunId
      FROM recent WHERE id>?
        AND json_extract(usage,'$.groupPlan.cycleId')=cycle_id
        AND json_extract(usage,'$.groupPlan.status') IN ('ready','starting')
        AND json_extract(usage,'$.groupPlan.verification.sourceRunId')=json_extract(usage,'$.groupPlan.originRunId')
      ORDER BY id LIMIT 50`)
      .all(after)
      .map((row) => ({
        messageId: String(row.messageId),
        sourceRunId: String(row.sourceRunId),
        workflowRunId: row.workflowRunId ? String(row.workflowRunId) : undefined,
      }));
  }
  /** Recover the gap between completing a plan and saving its verification card. */
  completedVerificationPlans(since: string, after = ""): string[] {
    return this.db
      .prepare(`WITH recent AS MATERIALIZED (
        SELECT m.usage, c.cycle_id, g.id AS group_id FROM groups g
        JOIN group_cycles c ON c.group_id=g.id
        JOIN conversations topic ON topic.id=(
          SELECT id FROM conversations WHERE group_id=g.id AND kind='group'
          ORDER BY id=(SELECT conversation_id FROM group_current_topics WHERE group_id=g.id) DESC,
            archived_at IS NULL DESC,updated_at DESC,id DESC LIMIT 1
        )
        JOIN messages m ON m.rowid IN (
          SELECT rowid FROM messages WHERE conversation_id=topic.id
          ORDER BY created_at DESC LIMIT 200
        )
      ) SELECT DISTINCT w.id FROM recent r JOIN group_workflow_runs w
        ON w.id=json_extract(r.usage,'$.groupPlan.id')
      WHERE w.id>? AND w.status='passed' AND w.finished_at>=?
        AND w.cycle_id=r.cycle_id AND w.group_id=r.group_id
      ORDER BY w.id LIMIT 50`)
      .all(after, since)
      .map((row) => String(row.id));
  }
  attempts(groupId: string, cycleId: string, botId: string, originRunId?: string): number {
    // Only admitted plans and explicit user rewrite requests count; rejected tool calls do not.
    const row = this.db
      .prepare(`SELECT
      (SELECT COUNT(*) FROM messages m JOIN runs r ON r.id=json_extract(m.usage,'$.groupPlan.originRunId')
       WHERE r.group_id=? AND r.cycle_id=? AND r.bot_id=? AND (? IS NULL OR r.id=?)
       AND m.conversation_id=r.conversation_id AND json_extract(m.usage,'$.groupPlan.cycleId')=r.cycle_id
       AND json_extract(m.usage,'$.groupPlan.startFailure') IS NULL) +
      (SELECT COUNT(*) FROM audit_log a JOIN runs r ON r.id=a.run_id
       WHERE r.group_id=? AND r.cycle_id=? AND r.bot_id=? AND (? IS NULL OR r.id=?)
       AND a.kind='execution.todo.changed' AND json_extract(a.detail,'$.actor')='user'
       AND json_extract(a.detail,'$.reasonCode')='modify'
       AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=r.conversation_id
         AND json_extract(m.usage,'$.groupPlan.cycleId')=r.cycle_id
         AND json_extract(m.usage,'$.groupPlan.id')=json_extract(a.detail,'$.target'))) AS count`)
      .get(
        groupId,
        cycleId,
        botId,
        originRunId ?? null,
        originRunId ?? null,
        groupId,
        cycleId,
        botId,
        originRunId ?? null,
        originRunId ?? null,
      );
    return Number(row?.count ?? 0);
  }
  attemptState(groupId: string, cycleId: string): GroupPlanAttempts | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`group-plan-attempts:${groupId}`);
    if (!row) return undefined;
    const state = GroupPlanAttemptsSchema.parse(JSON.parse(String(row.value)));
    return state.cycleId === cycleId ? state : undefined;
  }
  saveAttemptState(groupId: string, state: GroupPlanAttempts) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`group-plan-attempts:${groupId}`, JSON.stringify(GroupPlanAttemptsSchema.parse(state)));
  }
  create(conversationId: string, botId: string, input: GroupPlanCard): Message {
    const card = GroupPlanCardSchema.parse(input);
    return this.messages.create({
      conversationId,
      botId,
      role: "assistant",
      status: "done",
      content: "",
      usage: { groupPlan: card },
    });
  }
  update(messageId: string, input: GroupPlanCard): GroupPlanCard {
    const card = GroupPlanCardSchema.parse(input);
    const current = this.get(messageId);
    if (!current || current.card.id !== card.id) throw new Error("group_plan_missing");
    this.messages.update(messageId, { usage: { groupPlan: card } });
    return card;
  }
}
