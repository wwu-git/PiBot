// Selects the primary text model for memory organization.
import type { DatabaseSync } from "node:sqlite";
import { BotsRepo, SettingsRepo } from "@pibot/storage";

/**
 * Both automatic organization and owner sorting follow the same route: the Bot's own model, else
 * the default it follows. draftMemories tries the auxiliary model setting first and falls back to
 * this one; preferring the default here failed every Bot once the default became unusable.
 */
export function organizationModel(db: DatabaseSync, botId: string) {
  const bot = new BotsRepo(db).get(botId);
  if (!bot || bot.archivedAt) return undefined;
  // An image Bot's own model only draws; organizing memories needs the text default.
  const { defaultModel, auxiliaryModel } = new SettingsRepo(db).get();
  if (bot.imageMode) return defaultModel ?? auxiliaryModel ?? undefined;
  return bot.modelProvider && bot.modelId
    ? { provider: bot.modelProvider, id: bot.modelId }
    : (defaultModel ?? auxiliaryModel ?? undefined);
}
