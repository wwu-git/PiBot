import type { DatabaseSync } from "node:sqlite";
import {
  AgentErrorCodeSchema,
  GroupTaskSchema,
  type KernelMethodParams,
  type KernelMethodResults,
} from "@pibot/protocol-base";
import { ConversationsRepo } from "../conversations/conversations.ts";
import { GroupHandoffsRepo } from "./group-handoffs.ts";

export class GroupTaskSourcesRepo {
  constructor(private readonly db: DatabaseSync) {}
  bind(taskId: string, runId: string) {
    this.db
      .prepare(`INSERT OR IGNORE INTO group_task_sources(task_id,kind,message_id,conversation_id,batch_message_id)
      SELECT t.id,'coordinator',r.message_id,
      r.conversation_id,r.message_id FROM group_tasks t JOIN runs r ON r.id=? AND r.group_id=t.group_id
        AND r.bot_id=t.created_by_bot_id AND EXISTS(SELECT 1 FROM conversations c
          WHERE c.id=r.conversation_id AND c.kind='group' AND c.group_id=t.group_id)
      WHERE t.id=?`)
      .run(runId, taskId);
  }
  bindUser(taskId: string, messageId: string) {
    this.db
      .prepare(`INSERT OR IGNORE INTO group_task_sources(task_id,kind,message_id,conversation_id,batch_message_id)
      SELECT t.id,'user',m.id,m.conversation_id,m.id FROM group_tasks t
      JOIN messages m ON m.id=? AND m.role='user'
      JOIN conversations c ON c.id=m.conversation_id AND c.kind='group' AND c.group_id=t.group_id
      JOIN conversations thread ON thread.id=t.thread_conversation_id AND thread.thread_of=c.id
      WHERE t.id=?`)
      .run(messageId, taskId);
  }
  decorate(row: Record<string, unknown>) {
    const source = this.db
      .prepare(`SELECT s.kind,s.message_id AS messageId,
      s.conversation_id AS conversationId,s.batch_message_id AS batchMessageId,
      m.created_at AS createdAt,m.id IS NOT NULL AS available,
      (SELECT r.task_id FROM runs r JOIN group_tasks parent ON parent.id=r.task_id AND parent.group_id=t.group_id
       WHERE r.group_id=t.group_id AND r.message_id=s.batch_message_id AND r.bot_id=t.created_by_bot_id
       AND r.task_id<>t.id ORDER BY r.created_at,r.id LIMIT 1) AS parentTaskId
      FROM group_task_sources s JOIN group_tasks t ON t.id=s.task_id
      LEFT JOIN messages m ON m.id=s.message_id AND m.conversation_id=s.conversation_id
        AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=m.conversation_id AND c.group_id=t.group_id)
      WHERE s.task_id=?`)
      .get(String(row.id));
    const handoff = new GroupHandoffsRepo(this.db).view(String(row.id));
    return GroupTaskSchema.parse({
      ...row,
      ...(handoff ? { handoff } : {}),
      activity: this.activity(
        String(row.id),
        String(row.groupId),
        String(row.assigneeBotId),
        String(row.threadConversationId),
        row.status === "open",
      ),
      source: source
        ? { ...source, available: source.available === 1 }
        : {
            kind: "unknown",
            messageId: null,
            conversationId: null,
            batchMessageId: null,
            createdAt: null,
            available: false,
          },
    });
  }
  hasPendingAssignments(taskId: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM group_tasks child JOIN group_task_sources s ON s.task_id=child.id AND s.kind='coordinator'
      JOIN runs dispatch ON dispatch.message_id=s.batch_message_id AND dispatch.group_id=child.group_id AND dispatch.bot_id=child.created_by_bot_id
      JOIN group_tasks parent ON parent.id=dispatch.task_id AND parent.group_id=child.group_id
      JOIN conversations thread ON thread.id=child.thread_conversation_id AND thread.thread_of=(SELECT thread_of FROM conversations WHERE id=parent.thread_conversation_id)
      WHERE parent.id=? AND child.id<>parent.id AND child.status='open' LIMIT 1`)
      .get(taskId);
  }
  hasPendingExecutions(taskId: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM task_instances execution JOIN group_tasks assignment ON assignment.id=?
      WHERE execution.bot_id=assignment.assignee_bot_id AND execution.deleted_at IS NULL AND execution.archived_at IS NULL
      AND execution.status IN ('queued','running','stopping')
      AND json_extract(execution.authority_json,'$.source.groupId')=assignment.group_id
      AND (json_extract(execution.authority_json,'$.source.taskId')=assignment.id OR execution.source_conversation_id=assignment.thread_conversation_id) LIMIT 1`)
      .get(taskId);
  }
  hasPendingChildren(taskId: string) {
    return this.hasPendingAssignments(taskId) || this.hasPendingExecutions(taskId);
  }
  private activity(
    taskId: string,
    groupId: string,
    botId: string,
    threadId: string,
    open: boolean,
  ) {
    const waiting = this.db
      .prepare(`SELECT c.bot_id FROM runs c JOIN runs p ON p.id=c.parent_run_id
      WHERE p.task_id=? AND c.group_id=? AND c.kind='wake' AND c.trigger_key LIKE 'tool:%'
      AND c.status IN ('queued','running') ORDER BY c.created_at DESC,c.id DESC LIMIT 1`)
      .get(taskId, groupId);
    if (waiting) return { state: "waiting", waitingForBotId: String(waiting.bot_id) };
    const run = this.db
      .prepare(`SELECT id,status,automatic,error_code,message_id FROM runs WHERE task_id=? AND group_id=?
      ORDER BY (status='running') DESC,(status='queued') DESC,created_at DESC,id DESC LIMIT 1`)
      .get(taskId, groupId);
    const approval =
      run &&
      this.db
        .prepare("SELECT 1 FROM approvals WHERE run_id=? AND status='pending' LIMIT 1")
        .get(String(run.id));
    if (approval) return { state: "waiting", waitingForUser: true };
    if (run?.status === "running") return { state: "running" };
    if (this.hasPendingAssignments(taskId)) return { state: "waiting", waitingForTasks: true };
    const children = this.db
      .prepare(`SELECT 1 FROM task_instances WHERE bot_id=?
      AND deleted_at IS NULL AND archived_at IS NULL AND status IN ('queued','running','stopping')
      AND json_extract(authority_json,'$.source.groupId')=?
      AND (json_extract(authority_json,'$.source.taskId')=? OR source_conversation_id=?) LIMIT 1`)
      .get(botId, groupId, taskId, threadId);
    if (children) return { state: "waiting", waitingForChildren: true };
    const paused = this.db
      .prepare(`SELECT g.paused,COALESCE(c.limited,0) AS limited FROM groups g
      LEFT JOIN group_cycles c ON c.group_id=g.id WHERE g.id=?`)
      .get(groupId);
    if (
      run?.status === "aborted" ||
      (run?.automatic === 1 && (paused?.paused === 1 || paused?.limited === 1))
    )
      return { state: "paused" };
    if (run?.status === "queued") return { state: "waiting" };
    return run?.status === "error"
      ? {
          state: "error",
          failure: {
            runId: String(run.id),
            code: AgentErrorCodeSchema.safeParse(run.error_code).data ?? "internal",
          },
        }
      : open && run?.status === "done"
        ? this.contextFull(taskId, String(run.message_id))
        : { state: "open" };
  }
  /** An open task whose last turn stopped with a full context says so, with its plan step. */
  private contextFull(taskId: string, messageId: string) {
    const pause = this.db
      .prepare(`SELECT json_extract(usage,'$.executionPause.observation') AS observation,
        json_extract(usage,'$.executionPause.reads') AS reads FROM messages WHERE id=?`)
      .get(messageId);
    if (pause?.observation !== "compaction_no_progress") return { state: "open" };
    const step = this.db
      .prepare(
        "SELECT workflow_run_id,step_id FROM group_workflow_steps WHERE task_id=? AND status='blocked' LIMIT 1",
      )
      .get(taskId);
    return {
      state: "open",
      stop: {
        code: "context_full",
        ...(typeof pause.reads === "string" && pause.reads
          ? { reading: pause.reads.slice(0, 300) }
          : {}),
        ...(step
          ? { workflowRunId: String(step.workflow_run_id), stepId: String(step.step_id) }
          : {}),
      },
    };
  }
  summary(
    params: KernelMethodParams["groups.tasks.summary"],
  ): KernelMethodResults["groups.tasks.summary"] {
    // A quiet task was a plain reply, so it counts as neither open nor closed progress.
    const counts = this.db
      .prepare(`SELECT COALESCE(SUM(t.status='open'),0) AS openCount,
      COALESCE(SUM(t.status<>'open'),0) AS closedCount FROM group_tasks t
      LEFT JOIN group_task_sources s ON s.task_id=t.id WHERE t.group_id=? AND t.thread_conversation_id IN (SELECT id FROM conversations WHERE thread_of=?) AND t.quiet_at IS NULL AND (? IS NULL OR s.kind=?)`)
      .get(
        params.groupId,
        new ConversationsRepo(this.db).forGroup(params.groupId)?.id ?? "",
        params.origin ?? null,
        params.origin ?? null,
      );
    const ids = [...new Set(params.messageIds ?? [])];
    // A member can close its task before the owning run and program checks settle.
    // A continued or retried plan step gets a new task and cancels the one it replaces; the
    // replaced task is not another piece of work (a 2-step plan read "2 / 3").
    const batches = ids.length
      ? this.db
          .prepare(`SELECT s.batch_message_id AS messageId,COUNT(*) AS count,
      SUM(t.status='done' AND NOT EXISTS (
        SELECT 1 FROM runs active WHERE active.task_id=t.id AND active.status IN ('queued','running')
      ) AND NOT EXISTS (
        SELECT 1 FROM group_workflow_steps step WHERE step.task_id=t.id AND step.status NOT IN ('passed','skipped')
      )) AS done FROM group_tasks t JOIN group_task_sources s ON s.task_id=t.id
      WHERE t.group_id=? AND t.quiet_at IS NULL AND s.batch_message_id IN (${ids.map(() => "?").join(",")})
        AND NOT (t.status='cancelled' AND EXISTS (
          SELECT 1 FROM group_task_handoffs h JOIN group_workflow_steps replaced
            ON replaced.workflow_run_id=json_extract(h.spec,'$.workflowStep.workflowRunId')
            AND replaced.step_id=json_extract(h.spec,'$.workflowStep.stepId')
          WHERE h.task_id=t.id AND replaced.task_id IS NOT NULL AND replaced.task_id<>t.id))
      GROUP BY s.batch_message_id`)
          .all(params.groupId, ...ids)
      : [];
    const collaborations = ids.length
      ? this.db
          .prepare(`SELECT p.message_id AS messageId,
      c.id AS runId,c.bot_id AS targetBotId,CASE WHEN t.id IS NOT NULL THEN c.conversation_id ELSE NULL END AS threadId,c.status
      FROM runs c JOIN runs p ON p.id=c.parent_run_id AND p.group_id=c.group_id
      LEFT JOIN group_tasks t ON t.id=c.task_id AND t.group_id=c.group_id
      WHERE c.group_id=? AND c.kind='wake' AND c.trigger_key LIKE 'tool:%'
      AND p.message_id IN (${ids.map(() => "?").join(",")}) ORDER BY c.created_at,c.id LIMIT 200`)
          .all(params.groupId, ...ids)
      : [];
    return {
      openCount: Number(counts?.openCount ?? 0),
      closedCount: Number(counts?.closedCount ?? 0),
      batches: batches.map((r) => ({
        messageId: String(r.messageId),
        count: Number(r.count),
        done: Number(r.done),
      })),
      collaborations: collaborations.map((r) => ({
        messageId: String(r.messageId),
        targetBotId: String(r.targetBotId),
        runId: String(r.runId),
        threadId: r.threadId === null ? null : String(r.threadId),
        status: r.status as "queued" | "running" | "done" | "error" | "aborted",
      })),
    };
  }
}
