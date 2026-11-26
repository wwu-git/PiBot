import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { RunsRepo, transaction } from "@pibot/storage";
import { revealAttachment } from "../../conversations/attachments/attachment-reveal.ts";
import { revealOverflow } from "../../conversations/attachments/overflow-reveal.ts";
import type { ChatService } from "../../conversations/chat/chat.ts";
import { abortable } from "../../core/abort.ts";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import type { LocalService } from "../../local-service.ts";

interface StartupContext {
  handle: KernelRegisterRpc;
  groups: GroupOrchestrationPort;
  chat: ChatService;
  local: LocalService | undefined;
}
export function registerChatRpc(ctx: StartupContext) {
  ctx.handle("chat.history", async ({ botId, topicId, groupId, threadId, before, limit }) => {
    if (groupId) {
      if (threadId && topicId && threadId !== topicId)
        throw new RpcError(-32602, "Wrong group topic");
      return topicId && !threadId
        ? ctx.groups.topics.history({ groupId, topicId, before, limit })
        : ctx.groups.history(groupId, threadId, { before, limit });
    }
    if (!botId) throw new RpcError(-32602, "Invalid chat target");
    return ctx.chat.history(botId, topicId, { before, limit });
  });
  ctx.handle("chat.revealAttachment", async (params) => {
    if (!ctx.local) throw new RpcError(RpcErrorCodes.unsupported, "attachment_reveal_unsupported");
    const signal = AbortSignal.any([ctx.local.shutdown.signal, AbortSignal.timeout(10_000)]);
    return abortable(revealAttachment(ctx.local.deps, params, signal), signal);
  });
  ctx.handle("chat.revealOverflow", async ({ messageId }) => {
    if (!ctx.local) throw new RpcError(RpcErrorCodes.unsupported, "attachment_reveal_unsupported");
    const signal = AbortSignal.any([ctx.local.shutdown.signal, AbortSignal.timeout(10_000)]);
    return abortable(revealOverflow(ctx.local.deps, messageId, signal), signal);
  });
  ctx.handle("chat.attachment", async ({ id }) => ctx.chat.attachments.image(id));
  ctx.handle("chat.attachmentPreview", async ({ id }) => ctx.chat.attachments.preview(id));
  ctx.handle("chat.openAttachment", async ({ id }) => {
    await ctx.chat.attachments.open(id);
    return { ok: true };
  });
  ctx.handle(
    "chat.send",
    async (
      {
        botId,
        topicId,
        newTopic,
        initialMode,
        replyToMessageId,
        groupId,
        threadId,
        text,
        attachments,
        attachmentIds,
        workplace,
        mentions,
      },
      { source, phone },
    ) => {
      if (groupId)
        return ctx.groups.send(
          {
            groupId,
            topicId,
            threadId,
            text,
            attachments,
            attachmentIds,
            mentions,
            replyToMessageId,
          },
          undefined,
          undefined,
          { inputOrigin: source === "acp" ? "acp" : phone ? "phone" : "user" },
        );
      if (!botId) throw new RpcError(-32602, "Invalid chat target");
      return ctx.chat.send(
        botId,
        text,
        attachments,
        attachmentIds,
        topicId,
        newTopic,
        workplace,
        initialMode,
        replyToMessageId,
        { inputOrigin: source === "acp" ? "acp" : phone ? "phone" : "user" },
      );
    },
  );
  ctx.handle("chat.abort", async ({ runId }) => {
    const local = ctx.local;
    if (local)
      transaction(local.deps.db, () => {
        const runs = new RunsRepo(local.deps.db),
          run = runs.get(runId);
        if (run && runs.requestUserStop(runId))
          local.approvals.audit.append({
            botId: run.botId,
            runId,
            kind: "run.interrupted",
            summary: "User requested stop / 用户请求停止",
            detail: {
              actor: "user",
              reasonCode: "user_stop_requested",
              conversationId: run.conversationId,
            },
          });
      });
    await ctx.chat.abort(runId);
    return { ok: true };
  });
  ctx.handle("chat.append", async (params) => ctx.chat.append(params));
  ctx.handle("chat.appendStatus", async (params) => ctx.chat.appendStatus(params));
  ctx.handle("chat.appendMode", (params) => ctx.chat.appendMode(params));
  ctx.handle("groups.appendMode", (params) => ctx.chat.appendGroupMode(params));
  ctx.handle("groups.append", async (params) => ctx.chat.appendGroup(params));
  ctx.handle("groups.appendStatus", async (params) => ctx.chat.appendGroupStatus(params));
}
