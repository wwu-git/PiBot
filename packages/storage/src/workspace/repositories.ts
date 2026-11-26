// Persist application settings and shared workspace records in SQLite.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  attachmentContinuationOf,
  ImageDeliverySchema,
  type KernelMethodResults,
  LIVE_ISLAND_KINDS,
  MessageSchema,
  SettingsSchema,
  UserQuestionPauseSchema,
} from "@pibot/protocol-base";
import { BotsRepo } from "../bots/bots.ts";
import { AttachmentsRepo } from "../conversations/attachments.ts";
import { ConversationsRepo, visibleImport } from "../conversations/conversations.ts";
import { routineTopicReference } from "../conversations/routine-topic-reference.ts";
import { SidebarRepo } from "../conversations/sidebar.ts";
import { transaction } from "../database/database.ts";
import { RunEventsRepo } from "../runs/run-events.ts";
import { ToolCallsRepo } from "../runs/tool-calls.ts";

export type Settings = KernelMethodResults["settings.get"];
export type Bot = KernelMethodResults["bots.list"][number];
export type Message = KernelMethodResults["chat.history"][number];
export type JsonValue = Message["usage"];

export const DEFAULT_BROWSER_EXTENSION_PREFERENCE = "user";

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  defaultModel: null,
  auxiliaryModel: null,
  acpDefaultBotId: null,
  backgroundCommandLimitMinutes: 120,
  commandLogRetention: {},
  memoryDreamEnabled: false,
  memoryDreamLocalOnly: false,
  memoryDreamCostUsd: 0.05,
  memoryExtractionDailyCostUsd: 0.5,
  memoryExtractionDailyTokens: 2_000_000,
  language: "system",
  theme: "system",
  chatFontSize: "medium",
  liveIsland: true,
  liveIslandContent: "full",
  liveIslandKinds: [...LIVE_ISLAND_KINDS],
  onboardingCompleted: false,
  browserExtensionPreference: DEFAULT_BROWSER_EXTENSION_PREFERENCE,
  openAtLogin: false,
  showTrayIcon: true,
  closeToTrayHintShown: false,
  yoloUnisolatedCommands: false,
  strictSandbox: false,
  sandboxOutsideCommands: [],
  sandboxAutoOutsideCommands: [],
  sandboxAutoWritePaths: [],
  sandboxAutoLocalServices: [],
  sandboxAutoSystemServices: [],
});
/** Optional keys without a default: read back only once written. */
const OPTIONAL_KEYS = [
  "userAvatar",
  "personalTodoView",
  "personalTodoStatuses",
  "yoloUnisolatedCommandsAt",
] as const;

export class SettingsRepo {
  constructor(private readonly db: DatabaseSync) {}

  get({ initializeDefaultModel = true } = {}): Settings {
    // Older databases never persisted this default; a missing key must retain their enabled state.
    const values = { ...DEFAULT_SETTINGS, openAtLogin: true };
    let hasDefaultModel = false;
    // get() reads a fixed key list, so a settings field missing from it is written but never read
    // back (once the to-do view switch and remembered system services were lost).
    const keys = [...Object.keys(DEFAULT_SETTINGS), ...OPTIONAL_KEYS];
    for (const row of this.db
      .prepare(`SELECT key,value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`)
      .all(...keys)) {
      const key = String(row.key);
      if (key === "defaultModel") hasDefaultModel = true;
      if (
        Object.hasOwn(DEFAULT_SETTINGS, key) ||
        (OPTIONAL_KEYS as readonly string[]).includes(key)
      ) {
        Object.assign(values, { [key]: JSON.parse(String(row.value)) });
      }
    }
    if (!hasDefaultModel) {
      // Persist even null: changing Pi later must not silently change the app default.
      const pi = new BotsRepo(this.db).getMain();
      values.defaultModel =
        pi?.modelProvider && pi.modelId
          ? {
              provider: pi.modelProvider,
              id: pi.modelId,
              thinkingLevel: pi.thinkingLevel,
              thinkingPreference: pi.thinkingPreference ?? null,
            }
          : null;
      if (initializeDefaultModel)
        this.db
          .prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING")
          .run("defaultModel", JSON.stringify(values.defaultModel));
    }
    return SettingsSchema.parse(values);
  }

  set(patch: Partial<Settings>): Settings {
    const parsed = SettingsSchema.partial().parse(patch);
    return transaction(this.db, () => {
      const insert = this.db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined) insert.run(key, JSON.stringify(value));
      }
      return this.get();
    });
  }

  remove(key: keyof Settings): boolean {
    return this.db.prepare("DELETE FROM settings WHERE key = ?").run(key).changes > 0;
  }
}

const messageColumns = `id, conversation_id AS conversationId, role, content, status,
  run_id AS runId, error_code AS errorCode, usage, bot_id AS botId, mentions,
  routine_trigger AS routineTrigger, task_result_id AS taskResultId,
  (SELECT thread_conversation_id FROM group_tasks WHERE id=messages.task_result_id) AS taskResultThreadId,
  created_at AS createdAt, updated_at AS updatedAt`;

function parseMessage(row: Record<string, unknown>): Message {
  const { taskResultId, taskResultThreadId, ...fields } = row;
  return MessageSchema.parse({
    ...fields,
    routineTrigger:
      fields.routineTrigger == null ? undefined : JSON.parse(String(fields.routineTrigger)),
    ...(taskResultId && taskResultThreadId
      ? { taskResult: { taskId: taskResultId, threadId: taskResultThreadId } }
      : {}),
    usage: row.usage === null ? null : JSON.parse(String(row.usage)),
    mentions: JSON.parse(String(row.mentions)),
  });
}

export type CreateMessage = Pick<Message, "conversationId" | "role" | "content" | "status"> &
  Partial<
    Pick<
      Message,
      "runId" | "errorCode" | "usage" | "botId" | "mentions" | "taskResult" | "routineTrigger"
    >
  > & {
    id?: string;
    markUnread?: boolean;
    /** A phone's offline message keeps the time it was written; default now. */
    createdAt?: string;
  };
export type MessagePatch = Partial<
  Pick<Message, "content" | "status" | "runId" | "errorCode" | "usage">
>;

export class MessagesRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir?: string,
  ) {}

  get(id: string): Message | undefined {
    const row = this.db
      .prepare(`SELECT ${messageColumns} FROM messages WHERE id = ? AND ${visibleImport}`)
      .get(id);
    return row ? this.withDetails([parseMessage(row)])[0] : undefined;
  }
  /** The program's own plan checkpoint only; explicit user pauses keep their original meaning. */
  clearPlanCheckpoint(runId: string, planId: string): Message[] {
    const rows = this.db
      .prepare(`UPDATE messages
      SET usage=json_remove(usage,'$.executionPause'),updated_at=?
      WHERE run_id=? AND role='assistant'
      AND json_extract(usage,'$.executionPause.reason')='checkpoint'
      AND json_extract(usage,'$.executionPause.groupPlanId')=? RETURNING id`)
      .all(new Date().toISOString(), runId, planId);
    return rows.flatMap((row) => this.get(String(row.id)) ?? []);
  }
  hasRecoveryHistory(botId: string, conversationId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM messages m
      WHERE m.conversation_id=? AND (m.bot_id=? OR m.bot_id IS NULL) AND m.role<>'user'
      AND (m.content<>'' OR m.run_id IS NULL OR NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=m.run_id)
        OR json_extract(m.usage,'$.fileCheckpoint') IS NOT NULL
        OR EXISTS(SELECT 1 FROM tool_calls t WHERE t.message_id=m.id)) LIMIT 1`)
      .get(conversationId, botId);
  }
  selection(conversationId: string, ids: string[]): Message[] {
    if (!ids.length || ids.length > 50) throw new TypeError("Invalid message selection");
    const rows = this.db
      .prepare(
        `SELECT ${messageColumns} FROM messages WHERE conversation_id=? AND ${visibleImport} AND id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at,rowid`,
      )
      .all(conversationId, ...ids);
    return this.withDetails(rows.map(parseMessage));
  }

  hasTaskResult(taskId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM group_task_results WHERE task_id=?").get(taskId);
  }
  hasResultMessage(messageId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM group_task_results WHERE message_id=?").get(messageId);
  }
  taskReply(taskId: string): string | undefined {
    return this.taskReplySource(taskId)?.text;
  }
  taskReplySource(taskId: string): { messageId: string; text: string } | undefined {
    const row = this.db
      .prepare(`SELECT m.id,m.content,m.usage FROM messages m JOIN runs r ON r.id=m.run_id
        JOIN group_tasks t ON t.id=r.task_id WHERE t.id=?
        AND m.conversation_id=t.thread_conversation_id AND r.conversation_id=m.conversation_id
        AND m.bot_id=t.assignee_bot_id AND r.bot_id=m.bot_id AND r.group_id=t.group_id
        AND m.role='assistant' AND m.status='done' AND r.status='done' AND r.stop_reason='stop'
        AND m.content<>'' AND COALESCE(json_extract(m.usage,'$.taskReply'),m.content)<>''
        ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1`)
      .get(taskId);
    if (!row) return;
    const usage = row.usage === null ? null : JSON.parse(String(row.usage));
    return {
      messageId: String(row.id),
      text: typeof usage?.taskReply === "string" ? usage.taskReply : String(row.content),
    };
  }
  publishTaskResult(
    taskId: string,
    sourceMessageId?: string,
    replaceContent = false,
    resultText?: string,
    attachmentSourceMessageId?: string | null,
  ): Message {
    return transaction(this.db, () => {
      const message = this.linkTaskResult(
        taskId,
        sourceMessageId,
        replaceContent,
        resultText,
        attachmentSourceMessageId,
      );
      this.linkThreadFiles(taskId, message.id);
      return this.get(message.id) as Message;
    });
  }
  /**
   * Mac acceptance 2026-11-20: a member's files (sent with send_file or attached by the program)
   * sit on its own messages in the task thread, often an earlier bubble than the one the result
   * names, so the group's result message showed none. Every file the assignee posted in the
   * thread is linked, oldest first, up to the per-reply limit.
   */
  private linkThreadFiles(taskId: string, targetId: string) {
    const task = this.db
      .prepare("SELECT thread_conversation_id,assignee_bot_id FROM group_tasks WHERE id=?")
      .get(taskId);
    if (!task?.thread_conversation_id) return;
    const sources = this.db
      .prepare(
        `SELECT m.id FROM messages m WHERE m.conversation_id=? AND m.bot_id=? AND m.role='assistant'
          AND m.id<>? AND (EXISTS(SELECT 1 FROM attachments a WHERE a.message_id=m.id)
            OR EXISTS(SELECT 1 FROM message_attachment_links l WHERE l.message_id=m.id))
          ORDER BY m.rowid LIMIT 50`,
      )
      .all(String(task.thread_conversation_id), String(task.assignee_bot_id), targetId);
    const attachments = new AttachmentsRepo(this.db);
    for (const row of sources) {
      try {
        attachments.link(String(row.id), targetId);
      } catch (error) {
        // The reply is full: the remaining files stay on the member's thread messages.
        if (error instanceof TypeError && error.message === "Too many attachments") break;
        // A message the link rules refuse (another Bot or group) keeps its files where they are;
        // completing the task must not fail over a card.
        if (error instanceof TypeError && error.message === "Invalid attachment link") continue;
        throw error;
      }
    }
  }
  private linkTaskResult(
    taskId: string,
    sourceMessageId?: string,
    replaceContent = false,
    resultText?: string,
    attachmentSourceMessageId?: string | null,
  ): Message {
    const task = this.db
      .prepare(
        "SELECT group_id,assignee_bot_id,thread_conversation_id,summary,status FROM group_tasks WHERE id=?",
      )
      .get(taskId);
    if (task?.status !== "done") throw new TypeError("Wrong task result identity");
    const conversation = this.db
      .prepare(
        "SELECT p.id FROM conversations p JOIN conversations t ON t.thread_of=p.id WHERE t.id=? AND p.group_id=? AND p.kind='group'",
      )
      .get(String(task.thread_conversation_id), String(task.group_id));
    if (!conversation) throw new TypeError("Wrong task result identity");
    const linked = this.db
      .prepare("SELECT message_id FROM group_task_results WHERE task_id=?")
      .get(taskId);
    if (linked) {
      const targetId = String(linked.message_id);
      this.copyDeliveryMetadata(
        attachmentSourceMessageId ?? sourceMessageId ?? this.taskAttachmentSource(taskId, task),
        targetId,
      );
      return this.get(targetId) as Message;
    }
    const content = resultText ?? String(task.summary ?? "");
    const attachmentSource = sourceMessageId
      ? undefined
      : attachmentSourceMessageId === undefined
        ? this.taskAttachmentSource(taskId, task)
        : (attachmentSourceMessageId ?? undefined);
    const message = this.resultSource(
      String(conversation.id),
      String(task.assignee_bot_id),
      content,
      sourceMessageId,
      replaceContent,
      attachmentSource,
    );
    if (!message) {
      const result = this.create({
        conversationId: String(conversation.id),
        botId: String(task.assignee_bot_id),
        role: "assistant",
        content,
        status: "done",
        taskResult: { taskId, threadId: String(task.thread_conversation_id) },
      });
      if (attachmentSource) new AttachmentsRepo(this.db).link(attachmentSource, result.id);
      this.copyDeliveryMetadata(attachmentSource, result.id);
      return this.get(result.id) as Message;
    }
    this.db
      .prepare(
        "UPDATE messages SET task_result_id=COALESCE(task_result_id,?),content=?,updated_at=? WHERE id=?",
      )
      .run(
        taskId,
        replaceContent ? content : message.content,
        new Date().toISOString(),
        message.id,
      );
    this.db
      .prepare("INSERT INTO group_task_results(task_id,message_id) VALUES (?,?)")
      .run(taskId, message.id);
    this.copyDeliveryMetadata(attachmentSource ?? sourceMessageId, message.id);
    return this.get(message.id) as Message;
  }

  private copyQuestion(sourceId: string, targetId: string) {
    const source = this.get(sourceId),
      target = this.get(targetId);
    if (!source || !target || source.botId !== target.botId) return;
    const from = new ConversationsRepo(this.db).get(source.conversationId);
    const to = new ConversationsRepo(this.db).get(target.conversationId);
    if (
      !from?.groupId ||
      !to ||
      from.threadOf !== to.id ||
      to.kind !== "group" ||
      from.groupId !== to.groupId
    )
      return;
    const usage = source.usage;
    const pause = UserQuestionPauseSchema.safeParse(
      usage && typeof usage === "object" && !Array.isArray(usage)
        ? usage.executionPause
        : undefined,
    );
    if (!pause.success || pause.data.sourceMessageId) return;
    const current =
      target.usage && typeof target.usage === "object" && !Array.isArray(target.usage)
        ? target.usage
        : {};
    this.update(target.id, {
      usage: { ...current, executionPause: { ...pause.data, sourceMessageId: source.id } },
    });
  }

  private copyDeliveryMetadata(sourceId: string | undefined, targetId: string) {
    if (!sourceId || sourceId === targetId) return;
    this.copyQuestion(sourceId, targetId);
    const source = this.get(sourceId),
      target = this.get(targetId);
    const sourceUsage =
      source?.usage && typeof source.usage === "object" && !Array.isArray(source.usage)
        ? source.usage
        : {};
    const delivery = ImageDeliverySchema.safeParse(sourceUsage.imageDelivery);
    if (
      !delivery.success ||
      !target ||
      source?.botId !== target.botId ||
      !delivery.data.workspace.every((entry) =>
        target.attachments?.some((a) => a.id === entry.attachmentId && a.kind === "image"),
      )
    )
      return;
    const targetUsage =
      target.usage && typeof target.usage === "object" && !Array.isArray(target.usage)
        ? target.usage
        : {};
    const generation =
      sourceUsage.imageGeneration === true && source?.runId
        ? this.db
            .prepare(
              "SELECT id FROM runs WHERE id=? AND bot_id=? AND message_id=? AND conversation_id=? AND status='done' AND stop_reason='stop'",
            )
            .get(source.runId, String(source.botId), source.id, source.conversationId)
        : undefined;
    this.update(targetId, {
      usage: {
        ...targetUsage,
        imageDelivery: delivery.data,
        ...(generation ? { imageArtifactSourceRunId: String(generation.id) } : {}),
      },
    });
  }

  private taskAttachmentSource(taskId: string, task: Record<string, unknown>) {
    const finished = this.db
      .prepare("SELECT finished_run_id FROM group_task_origins WHERE task_id=?")
      .get(taskId);
    // Completion records its run before publication; never guess a later reply when it is known.
    const source = finished?.finished_run_id
      ? this.db
          .prepare(
            "SELECT m.id FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=? AND m.conversation_id=? AND m.bot_id=? AND m.role='assistant' AND m.status IN ('done','streaming')",
          )
          .get(
            String(finished.finished_run_id),
            String(task.thread_conversation_id),
            String(task.assignee_bot_id),
          )
      : this.db
          .prepare(
            "SELECT m.id FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.task_id=? AND m.conversation_id=? AND m.bot_id=? AND m.role='assistant' AND m.status IN ('done','streaming') ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1",
          )
          .get(taskId, String(task.thread_conversation_id), String(task.assignee_bot_id));
    return source ? String(source.id) : undefined;
  }

  private resultSource(
    conversationId: string,
    botId: string,
    summary: string,
    sourceMessageId: string | undefined,
    replaceContent: boolean,
    attachmentSource?: string,
  ) {
    const existing = sourceMessageId ? this.get(sourceMessageId) : undefined;
    if (
      sourceMessageId &&
      (!existing ||
        existing.conversationId !== conversationId ||
        existing.botId !== botId ||
        existing.role !== "assistant" ||
        (existing.status !== "done" && !(replaceContent && existing.status === "streaming")))
    )
      throw new TypeError("Wrong task result source");
    const exact = sourceMessageId
      ? undefined
      : this.db
          .prepare(
            "SELECT id FROM messages WHERE conversation_id=? AND bot_id=? AND role='assistant' AND status='done' AND content=? ORDER BY created_at DESC,id DESC LIMIT 1",
          )
          .get(conversationId, botId, summary);
    if (existing) return existing;
    if (!exact) return undefined;
    const candidate = this.get(String(exact.id));
    const candidateAttachments = candidate?.attachments ?? [];
    const sourceIds = new Set(
      (attachmentSource ? this.get(attachmentSource)?.attachments : [])?.map((item) => item.id) ??
        [],
    );
    // Equal text does not imply equal delivery: a new image must not reuse yesterday's result.
    return candidate &&
      candidateAttachments.length === sourceIds.size &&
      candidateAttachments.every((item) => sourceIds.has(item.id))
      ? candidate
      : undefined;
  }

  create(input: CreateMessage): Message {
    return transaction(this.db, () => this.insert(input));
  }

  private insert(input: CreateMessage): Message {
    const now = new Date().toISOString();
    const conversation = this.db
      .prepare("SELECT kind,bot_id,group_id,internal_task_id FROM conversations WHERE id=?")
      .get(input.conversationId);
    if (!conversation) throw new TypeError("Unknown conversation");
    const owner = conversation.bot_id;
    if (
      owner &&
      !this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(String(owner))
    )
      throw new TypeError("Bot archived");
    const speaker = input.role === "user" ? null : (input.botId ?? conversation.bot_id ?? null);
    if (input.role === "user" && input.botId != null)
      throw new TypeError("User message cannot impersonate Bot");
    if (input.role !== "user" && !speaker) throw new TypeError("Bot speaker required");
    if (speaker && conversation.kind === "dm" && speaker !== conversation.bot_id)
      throw new TypeError("Wrong DM Bot");
    if (
      speaker &&
      conversation.group_id &&
      !this.db
        .prepare("SELECT 1 FROM group_members WHERE group_id=? AND bot_id=? AND left_at IS NULL")
        .get(String(conversation.group_id), String(speaker))
    )
      throw new TypeError("Speaker is not a member");
    for (const mention of input.mentions ?? []) {
      if (
        conversation.group_id &&
        !this.db
          .prepare("SELECT 1 FROM group_members WHERE group_id=? AND bot_id=? AND left_at IS NULL")
          .get(String(conversation.group_id), mention)
      )
        throw new TypeError("Mention is not a member");
    }
    const { markUnread, createdAt, ...fields } = input;
    const stamp = createdAt ?? now;
    const message = MessageSchema.parse({
      mentions: [],
      runId: null,
      errorCode: null,
      usage: null,
      ...fields,
      botId: speaker,
      id: input.id ?? randomUUID(),
      createdAt: stamp,
      updatedAt: stamp,
    });
    if (message.taskResult) {
      const task = this.db
        .prepare(
          "SELECT group_id,assignee_bot_id,thread_conversation_id,status FROM group_tasks WHERE id=?",
        )
        .get(message.taskResult.taskId);
      if (
        conversation.kind !== "group" ||
        message.role !== "assistant" ||
        message.status !== "done" ||
        message.runId !== null ||
        !task ||
        task.group_id !== conversation.group_id ||
        task.assignee_bot_id !== speaker ||
        task.thread_conversation_id !== message.taskResult.threadId ||
        task.status !== "done"
      )
        throw new TypeError("Wrong task result identity");
    }
    this.db
      .prepare(`INSERT INTO messages (id, conversation_id, role, content, status, run_id,
      error_code, usage, bot_id, mentions, created_at, updated_at, task_result_id, routine_trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.status,
        message.runId,
        message.errorCode,
        message.usage === null ? null : JSON.stringify(message.usage),
        message.botId ?? null,
        JSON.stringify(message.mentions ?? []),
        stamp,
        stamp,
        message.taskResult?.taskId ?? null,
        message.routineTrigger ? JSON.stringify(message.routineTrigger) : null,
      );
    if (message.taskResult)
      this.db
        .prepare("INSERT INTO group_task_results(task_id,message_id) VALUES (?,?)")
        .run(message.taskResult.taskId, message.id);
    this.db
      .prepare(
        "UPDATE conversations SET updated_at=?,title=CASE WHEN kind IN ('dm','group') AND title='' AND ?='user' THEN ? ELSE title END WHERE id=?",
      )
      .run(
        now,
        message.role,
        Array.from(message.content).slice(0, 20).join(""),
        message.conversationId,
      );
    if (conversation.group_id)
      this.db
        .prepare(
          "UPDATE conversations SET updated_at=? WHERE id=(SELECT thread_of FROM conversations WHERE id=?)",
        )
        .run(now, message.conversationId);
    const key =
      conversation.kind === "dm"
        ? `dm:${String(conversation.bot_id)}`
        : `group:${String(conversation.group_id)}`;
    const deliveryPage = attachmentContinuationOf(message);
    if (!conversation.internal_task_id && !deliveryPage)
      new SidebarRepo(this.db).activity(key, markUnread ?? message.role !== "user");
    if (
      message.runId &&
      message.status !== "streaming" &&
      !deliveryPage &&
      this.db
        .prepare("SELECT 1 FROM runs WHERE id=? AND conversation_id=?")
        .get(message.runId, message.conversationId)
    )
      new RunEventsRepo(this.db).append({
        runId: message.runId,
        conversationId: message.conversationId,
        kind: "message.finalized",
        at: message.updatedAt,
        payload: {
          messageId: message.id,
          role: message.role,
          status: message.status,
          content: message.content,
          contentLength: Buffer.byteLength(message.content, "utf8"),
          errorCode: message.errorCode,
        },
      });
    return message;
  }

  hasUserAfter(id: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM messages m JOIN messages source ON source.id=?
      WHERE m.conversation_id=source.conversation_id AND m.rowid>source.rowid
      AND m.role='user' LIMIT 1`)
      .get(id);
  }

  /**
   * A reply whose task turned out to be plain chat keeps its pause record, but the UI must not
   * read it as unfinished work. A user message arriving mid-answer continues the run in a new reply
   * segment, and a pause stays on whichever segment raised it, so marking only the run's first
   * message left "执行已暂停" on the others.
   */
  markQuietChat(runId: string, messageId: string): number {
    const { changes } = this.db
      .prepare(
        `UPDATE messages SET usage=json_set(COALESCE(usage,'{}'),'$.quietChat',json('true')),updated_at=?
        WHERE role='assistant' AND (run_id=? OR id=?)`,
      )
      .run(new Date().toISOString(), runId, messageId);
    return Number(changes);
  }
  update(id: string, patch: MessagePatch): Message | undefined {
    const parsed = MessageSchema.pick({
      content: true,
      status: true,
      runId: true,
      errorCode: true,
      usage: true,
    })
      .partial()
      .parse(patch);
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return undefined;
      const values = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => value !== undefined),
      );
      const message = MessageSchema.parse({
        ...current,
        ...values,
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare(`UPDATE messages SET content = ?, status = ?, run_id = ?, error_code = ?,
      usage = ?, updated_at = ? WHERE id = ?`)
        .run(
          message.content,
          message.status,
          message.runId,
          message.errorCode,
          message.usage === null ? null : JSON.stringify(message.usage),
          message.updatedAt,
          id,
        );
      if (
        current.status === "streaming" &&
        message.status !== "streaming" &&
        message.runId &&
        this.db
          .prepare("SELECT 1 FROM runs WHERE id=? AND conversation_id=?")
          .get(message.runId, message.conversationId)
      )
        new RunEventsRepo(this.db).append({
          runId: message.runId,
          conversationId: message.conversationId,
          kind: "message.finalized",
          at: message.updatedAt,
          payload: {
            messageId: message.id,
            role: message.role,
            status: message.status,
            content: message.content,
            contentLength: Buffer.byteLength(message.content, "utf8"),
            errorCode: message.errorCode,
          },
        });
      return message;
    });
  }

  routineTopicReference(
    conversationId: string,
    botId: string,
    beforeMessageId: string,
    sourceRunId: string,
  ) {
    return routineTopicReference(this.db, conversationId, botId, beforeMessageId, sourceRunId);
  }

  list(
    conversationId: string,
    { before, limit = 50 }: { before?: string; limit?: number } = {},
  ): Message[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new TypeError("Invalid message limit");
    let rows: Record<string, unknown>[];
    if (before !== undefined) {
      const cursor = this.db
        .prepare(
          `SELECT created_at, rowid FROM messages WHERE id = ? AND conversation_id = ? AND ${visibleImport}`,
        )
        .get(before, conversationId);
      if (!cursor) return [];
      // UUIDs do not encode order; rowid preserves insertion order for equal millisecond timestamps.
      rows = this.db
        .prepare(`SELECT ${messageColumns} FROM messages WHERE conversation_id = ? AND ${visibleImport}
        AND (created_at < ? OR (created_at = ? AND rowid < ?)) ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(
          conversationId,
          String(cursor.created_at),
          String(cursor.created_at),
          Number(cursor.rowid),
          limit,
        );
    } else {
      rows = this.db
        .prepare(`SELECT ${messageColumns} FROM messages WHERE conversation_id = ? AND ${visibleImport}
        ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(conversationId, limit);
    }
    return this.withDetails(rows.reverse().map(parseMessage));
  }

  private withDetails(messages: Message[]): Message[] {
    const ids = messages.map((message) => message.id);
    const tools = new ToolCallsRepo(this.db).forMessages(ids);
    const attachments = new AttachmentsRepo(this.db).forMessages(ids);
    return messages.map((message) => {
      const records = tools.get(message.id);
      const items = attachments.get(message.id);
      return {
        ...message,
        ...(records?.length ? { tools: records } : {}),
        ...(items ? { attachments: items } : {}),
      };
    });
  }

  remove(id: string): boolean {
    return transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM messages WHERE id=? AND import_id IS NOT NULL").get(id))
        throw new TypeError("import_topic_read_only");
      // Tool foreign keys must reject deletion before attachment files are irreversibly removed.
      if (this.db.prepare("SELECT id FROM tool_calls WHERE message_id = ? LIMIT 1").get(id)) {
        throw new TypeError("Cannot delete message with tool calls");
      }
      new AttachmentsRepo(this.db).removeFiles(id, this.dataDir);
      return this.db.prepare("DELETE FROM messages WHERE id = ?").run(id).changes > 0;
    });
  }
}

export { activeBotNameKeys, BotNameTakenError, BotsRepo, type CreateBot } from "../bots/bots.ts";
export { type Conversation, ConversationsRepo } from "../conversations/conversations.ts";
