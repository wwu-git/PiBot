import type { DatabaseSync } from "node:sqlite";
import type { SessionEvent } from "@pibot/agent";
import type {
  AgentErrorCode,
  KernelEvents,
  KernelMethods,
  Message,
  Peer,
} from "@pibot/protocol-base";
import { ChatAdditionsRepo, MessagesRepo, RunsRepo, transaction } from "@pibot/storage";
import type { BrainRedactor } from "../../core/privacy.ts";
import type { ChatRun } from "../../runtime/queue/chat-run.ts";

// At a native user-input boundary, tools/approvals and the persistent run pointer
// move together to the next reply. The execution and JSONL owner never change.
export class ChatReplies {
  private readonly messages: MessagesRepo;
  private readonly additions: ChatAdditionsRepo;
  private readonly ids: string[];
  private current: string;
  private nextSegment = false;
  // Set at replyStart, cleared when the segment row exists; see openSegment().
  private pendingSegment = false;
  private replyTo?: string;
  private dirty = false;
  private modelReplyPending = true;
  private newReply = false;
  private progressTextStart = 0;
  /** The pending segment is a new model reply after visible text, not an addition. */
  private turnSegment = false;
  /** The next model reply continues text cut at the output limit, in the same message. */
  private holdTurn = false;
  /** The current message ran tool steps before saying anything (maintainers 2026-11-13, see delta). */
  private toolsBeforeText = false;
  private stream: ReturnType<BrainRedactor["stream"]>;
  content = "";
  /** Everything this run has said so far, across segments (group plan confirmation reads it). */
  runContent = "";

  constructor(
    private readonly db: DatabaseSync,
    private readonly run: ChatRun,
    private readonly peer: Peer<typeof KernelMethods, typeof KernelEvents>,
    private readonly redactor: BrainRedactor,
    private readonly setMessage: (messageId: string) => void,
    private readonly runActivity: (
      messageId: string,
      activity: Extract<SessionEvent, { type: "activity" }>["activity"],
    ) => void = () => {},
    /** Each model reply after visible text becomes its own message (chat runs only). */
    private readonly splitTurns = false,
  ) {
    this.messages = new MessagesRepo(db);
    this.additions = new ChatAdditionsRepo(db);
    this.current = run.messageId;
    this.ids = [this.current];
    // Acceptance order can differ from native steering order; retries need the real input.
    if (!run.groupId) {
      const inputId = new RunsRepo(db).get(run.runId)?.userMessageId;
      const input = inputId && this.messages.get(inputId);
      const initial = this.messages.get(this.current);
      if (
        initial &&
        input &&
        input.role === "user" &&
        input.runId === run.runId &&
        input.conversationId === run.conversationId
      ) {
        const usage = initial.usage;
        this.messages.update(initial.id, {
          usage: {
            ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
            chatReplyTo: input.id,
          },
        });
      }
    }
    this.stream = redactor.stream();
  }
  private publish(message: Message) {
    if (this.run.executionTaskId) return;
    this.peer.emit("chat.message", {
      botId: this.run.botId,
      conversationId: message.conversationId,
      runId: this.run.runId,
      messageId: message.id,
      message,
    });
  }
  private emit(text: string) {
    if (!text || this.run.executionTaskId || this.isResult()) return;
    this.peer.emit("chat.delta", {
      botId: this.run.botId,
      conversationId: this.run.conversationId,
      ...(this.run.groupId ? { groupId: this.run.groupId } : {}),
      ...(this.run.threadId ? { threadId: this.run.threadId } : {}),
      runId: this.run.runId,
      messageId: this.current,
      text,
      ...(this.newReply ? { newReply: true } : {}),
    });
    this.newReply = false;
  }
  event(event: SessionEvent) {
    if (event.type === "activity") {
      // a waiting hint alone must not create a bubble, so only a real tool step
      // (or the first text below) opens a deferred continuation segment.
      // A turn segment waits for words; tool steps of a text-less reply stay on the
      // message that said what it was about to do.
      if (this.pendingSegment && !this.turnSegment && event.activity.phase === "preparing_tool")
        this.openSegment();
      if (event.activity.phase === "preparing_tool" && !this.content.trim())
        this.toolsBeforeText = true;
      this.runActivity(this.current, event.activity);
    } else if (event.type === "delta") {
      // Leading blank lines of a new turn would otherwise trail the previous message.
      if (this.pendingSegment && this.turnSegment && !event.text.trim()) return;
      // Maintainers 2026-11-13: a message reads "what I'm about to do, then the steps". Steps run
      // before any words keep their own message, and the words start the next one, so the chat
      // can always draw a message's steps under its text.
      if (
        this.splitTurns &&
        !this.pendingSegment &&
        this.toolsBeforeText &&
        !this.content.trim() &&
        event.text.trim() &&
        !this.isResult()
      ) {
        this.turnSegment = true;
        this.replyTo = undefined;
        this.flush();
        this.checkpoint();
        this.openSegment();
      }
      if (this.pendingSegment && event.text) this.openSegment();
      if (this.modelReplyPending) {
        this.progressTextStart = this.content.length;
        this.newReply = this.progressTextStart > 0;
        this.modelReplyPending = false;
      }
      this.content += event.text;
      this.runContent += event.text;
      this.dirty = true;
      this.emit(this.stream.push(event.text));
    } else if (event.type === "addition") {
      const message = this.additions.state(event.id, "received");
      if (message) this.publish(message);
      this.nextSegment = true;
      this.replyTo = event.id;
    } else if (event.type === "replyStart") {
      this.modelReplyPending = true;
      if (!this.nextSegment) {
        if (this.holdTurn) {
          this.holdTurn = false;
          return;
        }
        if (this.splitTurns && !this.pendingSegment && this.content.trim() && !this.isResult()) {
          this.turnSegment = true;
          this.pendingSegment = true;
          this.replyTo = undefined;
          this.flush();
          this.checkpoint();
        }
        return;
      }
      this.nextSegment = false;
      this.turnSegment = false;
      // a continuation that never produces text or a tool step must not leave an
      // empty bubble. Its segment row is created on the first real output (openSegment), and
      // until then the run's reply pointer stays on the previous, already written reply.
      this.pendingSegment = true;
      this.flush();
      this.checkpoint();
    }
  }
  /**
   * Materializes the continuation segment requested by replyStart. Deferred because an empty
   * continuation would otherwise publish and persist an empty assistant bubble.
   */
  private isResult() {
    return !!this.run.groupId && !this.run.threadId && this.messages.hasResultMessage(this.current);
  }
  private openSegment() {
    this.pendingSegment = false;
    const previous = this.current;
    const message = transaction(this.db, () => {
      const message = this.messages.create({
        conversationId: this.run.conversationId,
        botId: this.run.botId,
        runId: this.run.runId,
        role: "assistant",
        status: "streaming",
        content: "",
        usage: this.turnSegment
          ? { chatSegment: true, chatTurn: true }
          : { chatSegment: true, chatReplyTo: this.replyTo ?? null },
        markUnread: false,
      });
      if (!new RunsRepo(this.db).reply(this.run.runId, message.id))
        throw new Error("Reply owner changed");
      this.setMessage(message.id);
      const previousUsage = this.messages.get(previous)?.usage;
      this.messages.update(previous, {
        status: "done",
        usage: {
          ...(previousUsage && typeof previousUsage === "object" && !Array.isArray(previousUsage)
            ? previousUsage
            : {}),
          stopReason: "continued",
        },
      });
      return message;
    });
    this.turnSegment = false;
    this.toolsBeforeText = false;
    this.current = message.id;
    this.run.messageId = message.id;
    this.ids.push(message.id);
    this.content = "";
    this.progressTextStart = 0;
    this.newReply = false;
    this.stream = this.redactor.stream();
    this.publish(message);
    const previousMessage = this.messages.get(previous);
    if (previousMessage) this.publish(previousMessage);
  }
  /** A reply cut at the output limit keeps going in the same message. */
  continueSameReply() {
    this.holdTurn = true;
  }
  /**
   * The next prompt of this run (an automatic-check follow-up) answers in a new reply
   * segment, so the check result sits between the two replies. Same path as a user addition.
   */
  segment() {
    this.nextSegment = true;
    this.replyTo = undefined;
  }
  flush() {
    this.emit(this.stream.finish());
  }
  checkpoint() {
    if (!this.dirty) return;
    const message = this.messages.get(this.current);
    if (message && !message.taskResult) {
      const content = this.redactor.redact(this.content);
      const prefix = this.redactor.redact(this.content.slice(0, this.progressTextStart));
      // A secret spanning replies can change prefix length: keep the complete safe text then.
      const progressTextStart = content.startsWith(prefix) ? prefix.length : 0;
      const usage = message.usage;
      this.messages.update(this.current, {
        content,
        usage: {
          ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
          progressTextStart,
        },
      });
    }
    this.dirty = false;
  }
  finish(
    status: "done" | "error" | "aborted",
    usage: Message["usage"],
    code?: AgentErrorCode,
    completed = status === "done",
  ) {
    this.checkpoint();
    const updates: Message[] = [];
    for (const id of this.ids) {
      const message = this.messages.get(id);
      if (!message) continue;
      if (id !== this.current && message.status === "done") {
        updates.push(message);
        continue;
      }
      this.messages.update(id, {
        status,
        errorCode: code ?? null,
        usage:
          id === this.run.messageId
            ? {
                ...(message.usage &&
                typeof message.usage === "object" &&
                !Array.isArray(message.usage)
                  ? message.usage
                  : {}),
                ...(usage && typeof usage === "object" && !Array.isArray(usage)
                  ? usage
                  : { usage }),
              }
            : { chatSegment: true, stopReason: status },
      });
      const updated = this.messages.get(id);
      if (updated) updates.push(updated);
    }
    return [...updates, ...this.additions.finish(this.run.runId, completed)];
  }
  pause(pause: {
    reason: string;
    summary: string;
    groupPlanId?: string;
    stall?: import("@pibot/protocol-base").ExecutionStall;
    observation?: "promised_without_tools" | "compaction_no_progress";
    /** What the run was reading when it stopped; already redacted and capped by the caller. */
    reads?: string;
    question?: import("@pibot/protocol-base").UserQuestion;
  }) {
    const message = this.messages.get(this.current);
    if (!message) return;
    this.messages.update(message.id, {
      usage: {
        ...(message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
          ? message.usage
          : {}),
        executionPause: {
          reason: pause.reason,
          ...(pause.groupPlanId ? { groupPlanId: pause.groupPlanId } : {}),
          summary: this.redactor.redact(pause.summary).slice(0, 500),
          ...(pause.stall ? { stall: pause.stall } : {}),
          ...(pause.observation ? { observation: pause.observation } : {}),
          ...(pause.reads ? { reads: this.redactor.redact(pause.reads).slice(0, 300) } : {}),
          ...(pause.question ? { question: pause.question } : {}),
        },
      },
    });
  }
  publishUpdates(messages: Message[]) {
    // Terminal bookkeeping may add presentation facts in the same transaction as run.finish.
    for (const message of messages) this.publish(this.messages.get(message.id) ?? message);
  }
  interruptAdditions() {
    for (const message of this.additions.finish(this.run.runId, false)) this.publish(message);
  }
}
