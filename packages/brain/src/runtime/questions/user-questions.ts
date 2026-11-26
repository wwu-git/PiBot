import { type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import { MessagesRepo } from "@pibot/storage";
import type { ChatService } from "../../conversations/chat/chat.ts";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import type { LocalService } from "../../local-service.ts";
import { registerDismissQuestion } from "./dismiss-question.ts";
import { readUserQuestion } from "./user-question-source.ts";

/** Answers retain their persisted step owner; other cards use the normal user-send lane. */
export function registerUserQuestionRpc(
  handle: KernelRegisterRpc,
  local: LocalService,
  chat: ChatService,
  groups: GroupOrchestrationPort,
) {
  registerDismissQuestion(handle, local);
  const messages = new MessagesRepo(local.deps.db);
  const pending = new Set<string>();
  handle(
    "execution.question.answer",
    async (
      { messageId, reply }: KernelMethodParams["execution.question.answer"],
      { signal, source, phone },
    ) => {
      if (await local.collaboration?.answerPlanLimit?.(messageId, reply, signal))
        return { ok: true as const };
      const read = () => readUserQuestion(local, messageId);
      const initial = read();
      const sourceId = initial.message.id;
      if (pending.has(sourceId)) throw new RpcError(-32011, "question_busy");
      pending.add(sourceId);
      try {
        const option =
          "optionId" in reply
            ? initial.pause.question.options.find((option) => option.id === reply.optionId)
            : undefined;
        if ("optionId" in reply && !option) throw new RpcError(-32602, "question_unavailable");
        const answer = local.deps.redactor.redact(
          option ? option.label : "custom" in reply ? reply.custom : "",
        );
        if (initial.pause.answer) {
          if (initial.pause.answer.text === answer && initial.pause.answer.optionId === option?.id)
            return { ok: true as const };
          throw new RpcError(-32602, "question_already_answered");
        }
        const assertCurrent = () => {
          const current = read();
          if (
            current.pause.answer ||
            JSON.stringify(current.pause) !== JSON.stringify(initial.pause) ||
            messages.hasUserAfter(messageId) ||
            messages.hasUserAfter(sourceId)
          )
            throw new RpcError(-32602, "question_changed");
          return current;
        };
        const commit = () => {
          const current = assertCurrent();
          const answerValue = {
            text: answer,
            ...(option ? { optionId: option.id } : {}),
            answeredAt: new Date().toISOString(),
          };
          for (const message of sourceId === messageId
            ? [current.message]
            : [current.message, current.display]) {
            const usage =
              message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
                ? message.usage
                : {};
            messages.update(message.id, {
              usage: {
                ...usage,
                executionPause: {
                  ...current.pause,
                  ...(message.id !== sourceId ? { sourceMessageId: sourceId } : {}),
                  answer: answerValue,
                },
              },
            });
          }
        };
        assertCurrent();
        const text = `${initial.pause.question.prompt}\n${answer}${option ? `\n${option.description}` : ""}`;
        const continuationSignal = AbortSignal.any([
          signal,
          local.shutdown.signal,
          AbortSignal.timeout(30_000),
        ]);
        if (initial.conversation.groupId) {
          const confirmation = {
            commit,
            beforeCommit: async () => {
              assertCurrent();
            },
            signal: continuationSignal,
          };
          if (!(await groups.answerStepQuestion(sourceId, text, confirmation)))
            await groups.send(
              {
                groupId: initial.conversation.groupId,
                topicId: initial.conversation.id,
                ...(initial.conversation.threadOf ? { threadId: initial.conversation.id } : {}),
                replyToMessageId: messageId,
                text,
              },
              confirmation,
            );
        } else
          await chat.confirmRoutine(
            initial.bot.id,
            text,
            initial.conversation.id,
            commit,
            async () => {
              assertCurrent();
            },
            continuationSignal,
            // The person's own answer, from where they gave it (the default Pi's tools follow it).
            { inputOrigin: source === "acp" ? "acp" : phone ? "phone" : "user" },
          );
        local.deps.peer.emit("inbox.changed", {});
        local.deps.peer.emit("execution.question.answered", {
          botId: initial.bot.id,
          conversationIds: [...new Set([initial.message.conversationId, initial.conversation.id])],
        });
        return { ok: true as const };
      } finally {
        pending.delete(sourceId);
      }
    },
  );
}
