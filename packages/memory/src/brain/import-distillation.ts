// Explicit import extracts only additive Bot notes under the shared maintenance budget.
import type { CapabilityContext } from "@pibot/brain/kit";
import { RpcError } from "@pibot/protocol-base";
import { BotsRepo, memoryMaintenanceUsage, SettingsRepo, transaction } from "@pibot/storage";
import { parseExtractionDraft } from "./memory-extraction.ts";
import { dayStart } from "./memory-extraction-attempt.ts";

const MAX_TOKENS = 9216;
type ImportPort = NonNullable<
  Parameters<CapabilityContext["memory"]["provide"]>[0]["importDistillation"]
>;

export function createImportDistillation(
  { db, agent, redactor }: Pick<CapabilityContext, "db" | "agent" | "redactor">,
  workersIdle: () => boolean,
): ImportPort & { idle(): boolean } {
  let busy = false;

  function estimate(botId: string) {
    const bot = new BotsRepo(db).get(botId);
    const modelId = bot?.modelId;
    if (
      !agent.draftMemories ||
      !bot ||
      bot.archivedAt ||
      bot.modelProvider !== "ollama" ||
      !modelId ||
      /cloud/i.test(modelId)
    )
      return undefined;
    return { modelId, maxTokens: MAX_TOKENS, costUsd: 0 as const };
  }

  function reserve(importId: string) {
    transaction(db, () => {
      const settings = new SettingsRepo(db).get();
      const used = memoryMaintenanceUsage(db, dayStart()).tokens;
      if (used + MAX_TOKENS > (settings.memoryExtractionDailyTokens ?? 2_000_000))
        throw new RpcError(-32602, "import_distillation_budget");
      db.prepare("INSERT INTO import_memory_usage(import_id,at,tokens) VALUES(?,?,?)").run(
        importId,
        new Date().toISOString(),
        MAX_TOKENS,
      );
    });
  }

  return {
    idle: () => !busy,
    estimate,
    async run({ importId, botId, modelId, text }, signal) {
      if (busy || !workersIdle()) throw new RpcError(-32602, "import_distillation_busy");
      if (estimate(botId)?.modelId !== modelId || !agent.draftMemories)
        throw new RpcError(-32602, "import_distillation_unavailable");
      signal.throwIfAborted();
      busy = true;
      let reserved = false;
      let dispatched = false;
      try {
        reserve(importId);
        reserved = true;
        const result = await agent.draftMemories({
          text,
          model: { provider: "ollama", id: modelId },
          useLocalOllama: true,
          signal,
          budget: { tokens: MAX_TOKENS, costUsd: 0 },
          onUsage: () => {
            dispatched = true;
          },
        });
        signal.throwIfAborted();
        db.prepare("UPDATE import_memory_usage SET tokens=? WHERE import_id=?").run(
          result.tokens || MAX_TOKENS,
          importId,
        );
        return parseExtractionDraft(result.draft)
          .candidates.filter(({ action }) => action === "add")
          .map(({ text, category }) => ({
            text: redactor.redact(text),
            category: category ?? "work",
          }));
      } finally {
        busy = false;
        if (reserved && !dispatched)
          db.prepare("DELETE FROM import_memory_usage WHERE import_id=?").run(importId);
      }
    },
  };
}
