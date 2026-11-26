// Dispatches and settles one leased extraction, including its fixed-code health and audit receipts.
import type { DatabaseSync } from "node:sqlite";
import type { MemoryDraftRequest, MemoryDraftUsage } from "@pibot/agent";
import type { BrainRedactor } from "@pibot/brain/kit";
import type { Message } from "@pibot/protocol-base";
import {
  BackgroundTaskHealthRepo,
  BotsRepo,
  correctionTopic,
  type MemoryExtraction,
  type MemoryExtractionsRepo,
  memoryMaintenanceUsage,
  SettingsRepo,
  transaction,
} from "@pibot/storage";
import { correctionBody, correctionSource, ordinarySource } from "./memory-correction.ts";
import {
  type ExtractionSource,
  extractionPrompt,
  groupExtractionInstruction,
} from "./memory-extraction.ts";
import { extractionErrorCode } from "./memory-extraction-result.ts";
import { settleExtraction } from "./memory-extraction-settlement.ts";
import { logMemoryAttempt } from "./memory-maintenance-log.ts";
import type { MemoryService } from "./memory-service.ts";

interface Model {
  provider: string;
  id: string;
}
export interface MemoryExtractionAttemptDeps {
  db: DatabaseSync;
  redactor: BrainRedactor;
  logger: { warn(message: string): void; info?(message: string): void };
  memory: MemoryService;
  healthChanged?(): void;
  statusChanged?(botId: string): void;
  isBotIdle(botId: string, correction?: boolean): boolean;
  publishReply?(message: Message, botId: string): void;
  isPaused(): boolean;
  draftMemories?: (
    request: MemoryDraftRequest,
  ) => Promise<{ draft: unknown; tokens: number; costUsd?: number }>;
}

export function dayStart(now = new Date()): string {
  const value = new Date(now);
  value.setHours(0, 0, 0, 0);
  return value.toISOString();
}

export class MemoryExtractionAttempt {
  private readonly bots: BotsRepo;
  private readonly settings: SettingsRepo;
  private readonly health: BackgroundTaskHealthRepo;
  constructor(
    private readonly deps: MemoryExtractionAttemptDeps,
    private readonly repo: MemoryExtractionsRepo,
  ) {
    this.bots = new BotsRepo(deps.db);
    this.settings = new SettingsRepo(deps.db);
    this.health = new BackgroundTaskHealthRepo(deps.db, deps.healthChanged);
  }
  limit() {
    const settings = this.settings.get();
    return {
      costUsd: settings.memoryExtractionDailyCostUsd ?? 0.5,
      tokens: settings.memoryExtractionDailyTokens ?? 2_000_000,
    };
  }
  /**
   * The model this Bot actually chats with: its own, else the default it follows. The auxiliary
   * model setting is tried first inside draftMemories, which falls back to this one. Preferring
   * the default here made every Bot's extraction fail with no_model once the default became
   * unusable (maintainers 2026-11-15: default on the official ChatGPT plan OpenAI refuses, while Pi ran
   * fine on the Codex sign-in), and the inbox filled with failure cards.
   */
  private model(botId: string): Model | undefined {
    const bot = this.bots.get(botId);
    // An image Bot's own model only draws (e.g. seedream), so it is never among the text models
    // extraction can run on and every attempt failed with no_model (maintainers 2026-11-18, 小图). It
    // uses the default model its sibling Bots chat with instead.
    const { defaultModel, auxiliaryModel } = this.settings.get();
    if (bot?.imageMode) return defaultModel ?? auxiliaryModel ?? undefined;
    return bot?.modelProvider && bot.modelId
      ? { provider: bot.modelProvider, id: bot.modelId }
      : (defaultModel ?? auxiliaryModel ?? undefined);
  }
  private permitted(row: MemoryExtraction): boolean {
    const bot = this.bots.get(row.botId);
    // An external agent keeps its own memory; its chats never go to Pi Bot's model.
    if (!bot || bot.archivedAt || !bot.memoryExtraction || bot.kind === "agent") return false;
    const topic = this.deps.db
      .prepare(`SELECT bot_id,group_id FROM conversations WHERE id=?`)
      .get(row.conversationId);
    if (!topic || topic.group_id !== row.groupId) return false;
    return row.groupId
      ? !!this.deps.db
          .prepare(
            `SELECT 1 FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.group_id=? AND gm.bot_id=? AND gm.left_at IS NULL AND g.coordinator_bot_id=? AND g.archived_at IS NULL`,
          )
          .get(row.groupId, row.botId, row.botId)
      : topic.bot_id === row.botId;
  }
  async process(row: MemoryExtraction, signal: AbortSignal) {
    const start = performance.now();
    try {
      await this.extract(row, signal);
    } catch (error) {
      this.failed(row, signal, error);
    } finally {
      logMemoryAttempt(this.deps, "extraction", row, start);
    }
  }
  private async extract(row: MemoryExtraction, signal: AbortSignal) {
    const skip = (error: string, coverageMessageId?: string) =>
      this.repo.finish(row.id, { status: "skipped", error, coverageMessageId });
    if (!this.permitted(row)) {
      skip("extraction_disabled_or_scope_changed");
      return;
    }
    const automated = this.repo.automatedReason(row.conversationId);
    if (automated) {
      skip(automated, this.repo.watermark(row.conversationId)?.messageId);
      return;
    }
    const urgent = row.reason === "correction";
    const correction =
      urgent &&
      row.sourceMessageId &&
      correctionTopic(this.deps.db, row.conversationId, row.sourceMessageId)
        ? correctionSource(
            this.deps.db,
            row.conversationId,
            row.sourceMessageId,
            row.botId,
            row.groupId,
          )
        : undefined;
    if (urgent && !correction) {
      skip("correction_source_unavailable");
      return;
    }
    const newest = this.repo.watermark(row.conversationId);
    if (
      row.reason !== "correction" &&
      newest &&
      this.repo.covered(row.conversationId, newest.messageId)
    ) {
      skip("already_covered");
      return;
    }
    const source = correction ?? ordinarySource(this.deps.db, row);
    if (!source) {
      skip("no_new_human_content");
      return;
    }
    const model = this.model(row.botId);
    const draftMemories = this.deps.draftMemories;
    if (!model || !draftMemories) {
      // A missing model used to be silent forever; a streak makes the inbox say it.
      this.health.fail("memory_extraction", row.botId, "no_model");
      skip("no_model");
      return;
    }
    const result = await this.draft(row, source, model, draftMemories, signal);
    signal.throwIfAborted();
    if (!this.deps.isBotIdle(row.botId, urgent)) {
      this.repo.defer(row, "bot_busy");
      return;
    }
    if (!this.permitted(row)) {
      skip("extraction_disabled_or_scope_changed");
      return;
    }
    this.finish(row, source, result, correction);
  }
  private finish(
    row: MemoryExtraction,
    source: ExtractionSource,
    result: { draft: unknown; tokens: number; costUsd?: number },
    correction?: ReturnType<typeof correctionSource>,
  ) {
    if (correction) {
      const current = correctionSource(
        this.deps.db,
        row.conversationId,
        correction.subjectMessageId,
        row.botId,
        row.groupId,
      );
      if (current?.replyId !== correction.replyId || current.text !== correction.text) {
        this.repo.defer(row, "source_changed");
        return;
      }
      const message = transaction(this.deps.db, () =>
        settleExtraction(
          this.deps,
          this.repo,
          this.health,
          row,
          source,
          result,
          correction.replyId,
        ),
      );
      if (message) this.publishReply(message, row.botId);
    } else {
      if (this.repo.watermark(row.conversationId)?.messageId !== source.watermarkId) {
        this.repo.defer(row, "source_changed");
        return;
      }
      transaction(this.deps.db, () =>
        settleExtraction(this.deps, this.repo, this.health, row, source, result),
      );
    }
  }
  private publishReply(message: Message, botId: string) {
    try {
      this.deps.publishReply?.(message, botId);
    } catch {
      // The receipt is already durable and can be recovered by reading history.
      this.deps.logger.warn(
        JSON.stringify({ module: "memory", reasonCode: "memory_receipt_publish_failed" }),
      );
    }
  }
  private draft(
    row: MemoryExtraction,
    source: ExtractionSource,
    model: Model,
    draftMemories: NonNullable<MemoryExtractionAttemptDeps["draftMemories"]>,
    signal: AbortSignal,
  ) {
    const catalog = this.deps.memory.extractionCatalog(row.botId, row.groupId);
    const redact = (value: string) => this.deps.redactor.redact(value);
    const text =
      row.reason === "correction"
        ? correctionBody(redact(source.text), redact(catalog))
        : redact(extractionPrompt(catalog, source.text, source.truncated));
    const used = memoryMaintenanceUsage(this.deps.db, dayStart());
    const limit = this.limit();
    let reserved = false;
    const draft = (chosen: Model) =>
      draftMemories({
        model: chosen,
        text,
        ...(row.groupId ? { instruction: groupExtractionInstruction() } : {}),
        signal,
        budget: {
          tokens: Math.max(0, limit.tokens - used.tokens),
          costUsd: Math.max(0, limit.costUsd - used.costUsd),
        },
        onUsage: (usage: MemoryDraftUsage) => {
          this.repo.recordUsage(row.id, usage);
          reserved = true;
        },
      });
    // The Bot's own model may be gone or its key invalid while the main model in Settings still
    // works. A reservation means dispatch may have occurred, so never retry that call.
    const fallback = this.settings.get().defaultModel ?? undefined;
    return draft(model).catch((error: unknown) => {
      const code = extractionErrorCode(error);
      if (
        (code !== "no_model" && code !== "auth_failed") ||
        reserved ||
        !fallback ||
        (fallback.provider === model.provider && fallback.id === model.id) ||
        signal.aborted
      )
        throw error;
      return draft({ provider: fallback.provider, id: fallback.id });
    });
  }
  private failed(row: MemoryExtraction, signal: AbortSignal, error: unknown) {
    const code = extractionErrorCode(error);
    if (signal.aborted) {
      this.repo.defer(row, this.deps.isPaused() ? "worker_stopped" : "bot_preempted");
      return;
    }
    if (code === "budget_exhausted") {
      this.repo.defer(row, code);
      return;
    }
    if (code === "no_model" || code === "auth_failed") {
      this.health.fail("memory_extraction", row.botId, code);
      this.repo.finish(row.id, { status: "skipped", error: code });
      return;
    }
    this.health.fail("memory_extraction", row.botId, code);
    this.repo.finish(row.id, { status: "failed", error: code });
  }
}
