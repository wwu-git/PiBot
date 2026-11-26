// Registers memory services and owns the lifetime of the maintenance workers.
import type { BrainCapability } from "@pibot/brain/kit";
import { registerGroupMemoryRpc } from "./group-memory-service.ts";
import { createImportDistillation } from "./import-distillation.ts";
import { MemoryDream } from "./memory-dream.ts";
import { MemoryExtractionQueue } from "./memory-extraction-queue.ts";
import { registerMemoryImport } from "./memory-import.ts";
import { registerMemoryStatus } from "./memory-maintenance-status.ts";
import { registerMemoryManagement } from "./memory-management.ts";
import { MemoryOrganizationQueue } from "./memory-organization-queue.ts";
import { proposeScopeMoves } from "./memory-scope-moves.ts";
import { MemoryService, registerMemoryRpc } from "./memory-service.ts";
import { executeMemoryReadTool, executeMemoryTool } from "./memory-tools.ts";

export function memoryCapability(): BrainCapability {
  return {
    id: "memory",
    register(ctx) {
      const memory = new MemoryService(ctx.db, ctx.peer, ctx.redactor, () =>
        ctx.logger.warn(
          JSON.stringify({ module: "memory", reasonCode: "memory_usage_write_failed" }),
        ),
      );
      registerMemoryRpc(ctx.rpc.handle, memory);
      registerMemoryStatus(ctx.rpc.handle, ctx.db, memory);
      const statusChanged = (botId: string) => ctx.peer.emit("memory.status.changed", { botId });
      // Serialize maintenance model calls so their results count toward the shared daily budget
      // before another worker spends it.
      let extraction: MemoryExtractionQueue | undefined;
      let dream: MemoryDream | undefined;
      const importDistillation = createImportDistillation(
        ctx,
        () =>
          ctx.chat.queue.isIdle() &&
          organization.idle() &&
          (extraction?.idle() ?? true) &&
          (dream?.idle() ?? true),
      );
      const healthChanged = () => ctx.peer.emit("inbox.changed", {});
      const organization = new MemoryOrganizationQueue({
        db: ctx.db,
        redactor: ctx.redactor,
        logger: ctx.logger,
        memory,
        healthChanged,
        statusChanged,
        automatic: () => !dream?.enabled(),
        isIdle: () =>
          ctx.chat.queue.isIdle() &&
          (extraction?.idle() ?? true) &&
          (dream?.idle() ?? true) &&
          importDistillation.idle(),
        draftMemories: ctx.agent.draftMemories?.bind(ctx.agent),
      });
      ctx.rpc.handle("memory.sortIntoPlace", async ({ runId }, { signal }) =>
        organization.sortIntoPlace(runId, signal, (value) =>
          ctx.peer.emit("memory.sortProgress", value),
        ),
      );
      ctx.rpc.handle("memory.cancelSortIntoPlace", async ({ runId }) => {
        await organization.cancelSortIntoPlace(runId);
        return { ok: true as const };
      });
      extraction = new MemoryExtractionQueue({
        db: ctx.db,
        redactor: ctx.redactor,
        logger: ctx.logger,
        memory,
        healthChanged,
        statusChanged,
        isIdle: () => organization.idle() && (dream?.idle() ?? true) && importDistillation.idle(),
        isBotIdle: (botId, correction) => ctx.chat.queue.isBotIdle(botId, correction),
        onAvailable: (listener) => ctx.chat.queue.onAvailable(listener),
        publishReply: (message, botId) => {
          if (!message.runId) return;
          ctx.peer.emit("chat.message", {
            botId,
            conversationId: message.conversationId,
            runId: message.runId,
            messageId: message.id,
            message,
          });
        },
        onBotWork: (listener) => ctx.chat.queue.onBotWork(listener),
        draftMemories: ctx.agent.draftMemories?.bind(ctx.agent),
      });
      dream = new MemoryDream({
        db: ctx.db,
        memory,
        redactor: ctx.redactor,
        logger: ctx.logger,
        isIdle: () =>
          ctx.chat.queue.isIdle() &&
          organization.idle() &&
          (extraction?.idle() ?? true) &&
          importDistillation.idle() &&
          ctx.local.background.isIdle(),
        interrupt: ctx.sleep.interrupt,
        activity: ctx.host.memoryDreamActivity,
        draftMemories: ctx.agent.draftMemories?.bind(ctx.agent),
        finished: (id) => ctx.peer.emit("memory.dream.finished", { id }),
      });
      const memoryDream = dream;
      const releaseDreamWork = ctx.chat.queue.onBotWork(() => memoryDream.userWork());
      ctx.sleep.participate({ idle: () => memoryDream.idle() });
      ctx.rpc.handle("memory.dream.last", async () => memoryDream.last());
      ctx.rpc.handle("memory.dream.run", async (_, { signal }) => memoryDream.run(true, signal));
      ctx.rpc.handle("memory.dream.changes", async ({ id }, { signal }) =>
        memoryDream.changes(id, signal),
      );
      ctx.rpc.handle("memory.dream.undo", async ({ id }, { signal }) =>
        memoryDream.undo(id, signal),
      );
      memoryDream.start();
      extraction.start();
      organization.start();
      // Maintainers 2026-11-11: offer to hand Bot work facts back from the shared user scope. Pure SQL
      // and pattern checks over at most a few hundred notes; idempotent per note, so every start
      // may run it and only notes never asked about before produce proposals.
      try {
        const moved = proposeScopeMoves(memory, ctx.db);
        if (moved.notes || moved.failed)
          ctx.logger.info?.(
            JSON.stringify({
              module: "memory",
              reasonCode: "memory_scope_moves_proposed",
              ...moved,
            }),
          );
      } catch {
        // Only a proposal pass: a failure leaves every note where it is and is retried next start.
        ctx.logger.warn(
          JSON.stringify({ module: "memory", reasonCode: "memory_scope_moves_failed" }),
        );
      }
      registerMemoryManagement(ctx.rpc.handle, ctx.db, ctx.peer, ctx.redactor, memory);
      registerMemoryImport(ctx.rpc.handle, ctx.host);
      registerGroupMemoryRpc(ctx.rpc.handle, memory);
      const releasePort = ctx.memory.provide({
        personal: memory,
        extraction,
        importDistillation,
        group: { prompt: (groupId, botId, request) => memory.groupPrompt(groupId, botId, request) },
      });
      const releaseTools = (["memory_add", "memory_update", "memory_remove"] as const).map((tool) =>
        ctx.tools.delegateKernel(tool, (context, call, signal, authorization) =>
          executeMemoryTool(memory, ctx.local, context, call, signal, authorization),
        ),
      );
      // Reads never ask, so they take no authorization and stay in this capability.
      const releaseReads = (["memory_search", "memory_read"] as const).map((tool) =>
        ctx.tools.delegateKernel(tool, (context, call, signal) =>
          executeMemoryReadTool(memory, ctx.local, context, call, signal),
        ),
      );
      return {
        async stop() {
          releaseDreamWork();
          await memoryDream.stop();
          await organization.stop();
          await extraction?.stop();
          memory.stop();
          for (const release of [...releaseTools, ...releaseReads].reverse()) release();
          releasePort();
        },
      };
    },
  };
}
