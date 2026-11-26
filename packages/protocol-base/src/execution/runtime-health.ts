import { z } from "zod";
import { LiveActivitySchema } from "../app/live-island.ts";
import { IdSchema } from "../core/ids.ts";

const _botId = z.strictObject({ botId: IdSchema });
const noParams = z.union([z.undefined(), z.strictObject({})]);
/**
 * A run or the interactive client could not be drained, so the Bot(s) stay busy until
 * Pi Bot restarts. `healthy` and `reason` travel together; `botIds` is empty for a global failure.
 */
export const RuntimeHealthSchema = z
  .strictObject({
    healthy: z.boolean(),
    reason: z.enum(["run_drain_failed", "interactive_drain_failed"]).nullable(),
    botIds: z.array(IdSchema).max(128),
  })
  .refine((value) => value.healthy === (value.reason === null));
export type RuntimeHealth = z.infer<typeof RuntimeHealthSchema>;
/**
 * New commands are paused because Pi Bot could not confirm a previous command stopped:
 * `retrying` while automatic checks run, `stuck` once they ran out (check again, or restart).
 * Separate from `RuntimeHealth`, which is sticky until restart; this clears on its own.
 */
export const CommandPauseSchema = z.strictObject({
  paused: z.enum(["retrying", "stuck"]).nullable(),
});
export type CommandPause = z.infer<typeof CommandPauseSchema>;
export const RuntimeMethods = {
  // The UI pulls the current health once on (re)connect so a missed event is not final.
  "runtime.health.get": { params: noParams, result: RuntimeHealthSchema },
  // A user-confirmed release of the sessions whose drain failed. `confirmed` is a
  // literal so no caller can ask for it implicitly; without `botId` it targets the client-wide
  // interactive drain. The result is the health after the attempt, which may still be unhealthy.
  "runtime.forceRelease": {
    params: z.strictObject({ botId: IdSchema.optional(), confirmed: z.literal(true) }),
    result: RuntimeHealthSchema,
  },
  "runtime.commands.get": { params: noParams, result: CommandPauseSchema },
  // The person asked to check again. The brain re-checks with the same proof as its automatic
  // checks; nothing is released without it, so the result may still be paused.
  "runtime.commands.recheck": { params: noParams, result: CommandPauseSchema },
} as const;
export const RuntimeEvents = {
  /** Authoritative snapshot, including parked approvals, deduplicated by run ID. */
  "runtime.activeRuns": z.strictObject({ count: z.number().int().nonnegative().safe() }),
  /** Busy Bots for the live island: a full snapshot, throttled and sent only when it changed. */
  "runtime.liveActivity": LiveActivitySchema,
  // A drain failure is sticky; `botIds` names the Bots whose sessions stayed open.
  "runtime.health": RuntimeHealthSchema,
  "runtime.commands": CommandPauseSchema,
} as const;
