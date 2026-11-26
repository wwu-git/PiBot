import { z } from "zod";
import { AvatarImageSchema } from "../bots/app-profile.ts";
import { UiNavigationSchema } from "../bots/navigation.ts";
import { IdSchema } from "../core/ids.ts";

/** What a busy Bot is doing, as the live island groups it (and the user filters it). */
export const LiveIslandKindSchema = z.enum(["chat", "group", "routine", "waiting"]);
export type LiveIslandKind = z.infer<typeof LiveIslandKindSchema>;
export const LIVE_ISLAND_KINDS = LiveIslandKindSchema.options;
/** `full`: avatar, name and task; `avatars`: only the avatars and a count. */
export const LiveIslandContentSchema = z.enum(["full", "avatars"]);

const label = z.string().min(1).max(64);
/**
 * One busy Bot on the island. Metadata only: the Bot, its avatar, and a short title the
 * program already shows elsewhere (plan step, group task, routine name, approval card title).
 * Message bodies, file contents and secrets never travel here.
 */
export const LiveActivityItemSchema = z.strictObject({
  /** Stable while the same work goes on, so the island keeps its place across updates. */
  key: z.string().min(1).max(200),
  botId: IdSchema,
  botName: z.string().min(1).max(200),
  avatar: z.strictObject({
    shape: label,
    color: label,
    eyes: label,
    image: AvatarImageSchema.nullable(),
  }),
  kind: LiveIslandKindSchema,
  /** Plain short text; null when the work has no title yet (the island names the kind). */
  title: z.string().min(1).max(200).nullable(),
  /** Approval cards carry their title in both UI languages. */
  localizedTitle: z
    .strictObject({ zh: z.string().min(1).max(200), en: z.string().min(1).max(200) })
    .optional(),
  startedAt: z.iso.datetime(),
  target: UiNavigationSchema,
});
export type LiveActivityItem = z.infer<typeof LiveActivityItemSchema>;
export const LiveActivitySchema = z.strictObject({
  items: z.array(LiveActivityItemSchema).max(20),
});
export type LiveActivity = z.infer<typeof LiveActivitySchema>;
