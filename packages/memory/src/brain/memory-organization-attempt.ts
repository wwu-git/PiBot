// Applies one automatic organization draft as proposals and records its actual model route.

import type { MemoryDraftUsage } from "@pibot/agent";
import {
  AuditRepo,
  BackgroundTaskHealthRepo,
  BotsRepo,
  type MemoryOrganization,
  type MemoryOrganizationsRepo,
  memoryMaintenanceUsage,
  SettingsRepo,
} from "@pibot/storage";
import { dayStart } from "./memory-extraction-attempt.ts";
import { organizationInstruction, parseOrganizationDraft } from "./memory-organization.ts";
import { organizationErrorDetails } from "./memory-organization-errors.ts";
import { organizationModel } from "./memory-organization-model.ts";
import type { OrganizationDeps } from "./memory-organization-queue.ts";

interface Model {
  provider: string;
  id: string;
}

export class MemoryOrganizationAttempt {
  private readonly bots: BotsRepo;
  private readonly settings: SettingsRepo;
  private readonly health: BackgroundTaskHealthRepo;

  constructor(
    private readonly deps: OrganizationDeps,
    private readonly repo: MemoryOrganizationsRepo,
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

  private model(botId: string): Model | undefined {
    return organizationModel(this.deps.db, botId);
  }

  async process(row: MemoryOrganization, signal: AbortSignal) {
    const bot = this.bots.get(row.botId);
    if (!bot || bot.archivedAt) {
      this.repo.finish(row.id, { status: "skipped" });
      return;
    }
    const model = this.model(row.botId);
    if (!model || !this.deps.draftMemories) {
      // Keep the job retryable while exposing the configuration problem in health.
      this.health.fail("memory_organization", row.botId, "no_model");
      this.repo.finish(row.id, { status: "skipped", error: "no_model" });
      return;
    }
    let catalog: { text: string; ids: string[] };
    try {
      catalog = this.deps.memory.organizationCatalog(row.botId, row.scope, row.ownerId);
    } catch {
      // The owner disappeared (group left, Bot archived) between enqueue and now.
      this.repo.finish(row.id, { status: "skipped" });
      return;
    }
    if (!catalog.ids.length) {
      this.repo.finish(row.id, { status: "skipped", memoryCount: 0 });
      return;
    }
    try {
      const { result, actualModel } = await this.draft(
        row,
        catalog.text,
        model,
        this.deps.draftMemories,
        signal,
      );
      signal.throwIfAborted();
      const { proposals } = parseOrganizationDraft(result.draft, new Set(catalog.ids));
      let created = 0;
      for (const proposal of proposals) {
        try {
          created += this.deps.memory.applyOrganization(
            row.botId,
            row.scope,
            row.ownerId,
            proposal,
          );
        } catch {
          // One note that vanished or changed under us must not discard the other proposals.
        }
      }
      this.audit(row, actualModel, created);
      this.repo.finish(row.id, {
        status: "done",
        modelProvider: actualModel.provider,
        modelId: actualModel.id,
        tokens: result.tokens,
        costUsd: result.costUsd ?? 0,
        proposals: created,
        memoryCount: catalog.ids.length,
      });
      this.health.recover("memory_organization", row.botId);
    } catch (error) {
      const code = signal.aborted ? "aborted" : organizationErrorDetails(error).error;
      // Missing model or refused credentials are configuration states; they must not burn the day.
      if (code === "no_model" || code === "auth_failed") {
        if (!signal.aborted) this.health.fail("memory_organization", row.botId, code);
        this.repo.finish(row.id, {
          status: "skipped",
          memoryCount: catalog.ids.length,
          error: code,
        });
        return;
      }
      if (!signal.aborted) this.health.fail("memory_organization", row.botId, code);
      this.repo.finish(row.id, {
        status: "failed",
        memoryCount: catalog.ids.length,
        error: code,
      });
    }
  }

  private async draft(
    row: MemoryOrganization,
    text: string,
    model: Model,
    draftMemories: NonNullable<OrganizationDeps["draftMemories"]>,
    signal: AbortSignal,
  ) {
    const used = memoryMaintenanceUsage(this.deps.db, dayStart());
    const limit = this.limit();
    let usage: MemoryDraftUsage | undefined;
    const draft = (chosen: Model) =>
      draftMemories({
        model: chosen,
        text: this.deps.redactor.redact(text),
        instruction: organizationInstruction(),
        signal,
        budget: {
          tokens: Math.max(0, limit.tokens - used.tokens),
          costUsd: Math.max(0, limit.costUsd - used.costUsd),
        },
        onUsage: (receipt: MemoryDraftUsage) => {
          this.repo.recordUsage(row.id, receipt);
          usage = receipt;
        },
      });
    // Like extraction: a Bot model that is gone or refused falls back once to the main model in
    // Settings only before a reservation, which is the dispatch boundary.
    const fallback = this.settings.get().defaultModel ?? undefined;
    let usedModel = model;
    const result = await draft(model).catch((error: unknown) => {
      const { error: code } = organizationErrorDetails(error);
      if (
        (code !== "no_model" && code !== "auth_failed") ||
        usage ||
        !fallback ||
        (fallback.provider === model.provider && fallback.id === model.id) ||
        signal.aborted
      )
        throw error;
      usedModel = { provider: fallback.provider, id: fallback.id };
      return draft(usedModel);
    });

    const actualModel = usage ? { provider: usage.modelProvider, id: usage.modelId } : usedModel;
    return { result, actualModel };
  }

  private audit(row: MemoryOrganization, model: Model, proposals: number) {
    new AuditRepo(this.deps.db, this.deps.redactor).append({
      botId: row.botId,
      kind: "memory.changed",
      summary: "Memory organized into proposals / 记忆整理提议已生成",
      detail: {
        actor: "automatic",
        reasonCode: "memory_organized",
        memoryScope: row.scope,
        memoryOwnerId: row.ownerId,
        modelId: model.id,
        revision: proposals,
      },
    });
  }
}
