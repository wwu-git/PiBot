import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { ProviderImportPreviewSchema } from "../providers/import-link.ts";

export const BotPanelTabSchema = z.enum(["details", "topics", "memory", "permissions"]);
export const BotNavigationSchema = z
  .strictObject({
    botId: IdSchema,
    tab: BotPanelTabSchema,
    conversationId: IdSchema.optional(),
    messageId: IdSchema.optional(),
  })
  .refine((target) => target.messageId === undefined || target.conversationId !== undefined);
export type BotNavigation = z.infer<typeof BotNavigationSchema>;
/**
 * Pages the tray / menu-bar menu opens that belong to no single Bot (menu of 2026-10-28). The
 * main process does not know which Bot is the main one, so `new-chat` arrives without a Bot and
 * the brain fills it in; without one the window opens "New Bot".
 */
export const ShellNavigationSchema = z.discriminatedUnion("view", [
  z.strictObject({ view: z.literal("inbox") }),
  z.strictObject({ view: z.literal("provider-import"), preview: ProviderImportPreviewSchema }),
  z.strictObject({ view: z.enum(["settings", "about", "updates"]) }),
  z.strictObject({ view: z.literal("new-chat"), botId: IdSchema.optional() }),
  // A group chat, optionally one task's thread (the live island opens a busy group step).
  z.strictObject({ view: z.literal("group"), groupId: IdSchema, threadId: IdSchema.optional() }),
  z.strictObject({
    view: z.literal("role-import"),
    kind: z.enum(["role", "group"]),
    // A role-library id (a slug such as backend-dev), not a database id.
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    version: z.number().int().min(1).max(100000),
  }),
]);
export const UiNavigationSchema = z.union([BotNavigationSchema, ShellNavigationSchema]);
export type UiNavigation = z.infer<typeof UiNavigationSchema>;
