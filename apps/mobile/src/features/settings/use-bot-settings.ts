import { Methods } from "@pibot/protocol";
import { z } from "zod";
import { useRuntime, useText } from "../../runtime/context.tsx";
import { confirmLocally } from "../../runtime/local-auth.ts";
import {
  type BotPatch,
  type BotSettings,
  listBots,
  type PermissionPatch,
  readBotSettings,
  removeMemory,
  revokeConnector,
  revokeGrant,
  runRoutineNow,
  setPermissions,
  setRoutineEnabled,
  setSkillEnabled,
  updateBot,
} from "./calls.ts";
import { useSettingsData } from "./use-settings-data.ts";

// The offline copy is parsed with the same schemas the computer's answers were checked against.
const BotSettingsSchema: z.ZodType<BotSettings> = z.object({
  resourcesUnavailable: z.boolean().optional(),
  profile: Methods["bots.profile"].result,
  dream: Methods["memory.dream.last"].result.optional(),
  models: Methods["models.list"].result.optional(),
  skills: Methods["skills.list"].result.optional(),
  routines: Methods["routines.list"].result.optional(),
  permissions: z
    .object({
      scoped: Methods["permissions.get"].result,
      global: Methods["permissions.get"].result,
    })
    .optional(),
  grants: Methods["grants.list"].result.optional(),
  connectors: z.array(Methods["connectors.get"].result).max(100).optional(),
}) as unknown as z.ZodType<BotSettings>;

/** Everything the phone's Bot settings pages show and change, for one Bot. */
export function useBotSettings(botId: string, page?: string) {
  const runtime = useRuntime(),
    t = useText();
  const state = useSettingsData({
    key: `bot:${botId}:${page ?? "profile"}`,
    read: (signal) => readBotSettings(runtime, botId, signal, page),
    schema: BotSettingsSchema,
    subscribe: (peer, refresh) => {
      const mine = (event: { botId?: string }) => {
        if (!event.botId || event.botId === botId) refresh();
      };
      return [
        peer.on("bots.changed", mine),
        peer.on("skills.changed", mine),
        peer.on("routines.changed", mine),
        peer.on("memory.changed", mine),
        peer.on("connectors.changed", refresh),
        peer.on("changes.changed", (event) => {
          if (event.reason === "folder" && event.conversationKey === `dm:${botId}`) refresh();
        }),
        peer.on("sidebar.changed", (event) => {
          if (!event.conversationKey || event.conversationKey === `dm:${botId}`) refresh();
        }),
        // Global defaults change what a following Bot gets, so they count too.
        peer.on("permissions.changed", (event) => {
          if (!event.groupId) mine(event);
        }),
      ];
    },
  });
  const bot = state.data?.profile.bot;
  return {
    ...state,
    error:
      state.error ??
      (state.data?.resourcesUnavailable ? ("settingsOptionsFailed" as const) : undefined),
    bot,
    update: (patch: BotPatch, onConflict?: () => void) =>
      state.apply((signal) => updateBot(runtime, botId, patch, signal), onConflict),
    removeMemory: (id: string) =>
      state.apply((signal) =>
        removeMemory(
          runtime,
          botId,
          id,
          (unlockSignal) => confirmLocally(t("unlockMemory"), t("cancel"), unlockSignal ?? signal),
          signal,
        ),
      ),
    setSkill: (skillId: string, enabled: boolean) =>
      state.apply((signal) => setSkillEnabled(runtime, skillId, enabled, signal)),
    setRoutine: (id: string, enabled: boolean) =>
      state.apply((signal) => setRoutineEnabled(runtime, id, enabled, signal)),
    runRoutine: (id: string) => state.apply((signal) => runRoutineNow(runtime, id, signal)),
    setPermissions: (patch: PermissionPatch) =>
      state.apply((signal) =>
        setPermissions(
          runtime,
          botId,
          patch,
          (unlockSignal) => confirmLocally(t("unlockWiden"), t("cancel"), unlockSignal ?? signal),
          signal,
        ),
      ),
    revokeGrant: (id: string) => state.apply((signal) => revokeGrant(runtime, id, signal)),
    revokeConnector: (connectorId: string) =>
      state.apply(async (signal) => {
        const row = state.data?.connectors?.find((item) => item.connector.id === connectorId);
        if (!row) throw new Error("invalid");
        // "Every Bot" becomes "every other Bot", read fresh so no other Bot loses access.
        const others =
          row.access.mode === "all" ? (await listBots(runtime, signal)).map((bot) => bot.id) : [];
        return revokeConnector(
          runtime,
          { id: row.connector.id, revision: row.connector.revision, access: row.access },
          botId,
          others,
          signal,
        );
      }),
  };
}
export type BotSettingsState = ReturnType<typeof useBotSettings>;
