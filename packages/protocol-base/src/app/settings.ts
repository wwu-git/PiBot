// Share persisted settings and desktop bootstrap contracts across processes.
import { z } from "zod";
import { AvatarImageSchema } from "../bots/app-profile.ts";
import { IdSchema } from "../core/ids.ts";
import {
  OutsideCommandPatternSchema,
  OutsideCommandPatternsSchema,
} from "../execution/sandbox-block.ts";
import { DefaultModelSchema } from "../providers/providers.ts";
import { LiveIslandContentSchema, LiveIslandKindSchema } from "./live-island.ts";

export { DesktopStateSchema } from "./desktop-state.ts";

const name = z.string().min(1);
/** Reading size of the conversation view only; the rest of the app keeps its own type scale. */
export const ChatFontSizeSchema = z.enum(["small", "medium", "large"]);
export type ChatFontSize = z.infer<typeof ChatFontSizeSchema>;
export const SettingsSchema = z.strictObject({
  personalTodoView: z.enum(["list", "calendar"]).optional(),
  /** Open / Completed filter shared by the list and the calendar; at least one stays on. */
  personalTodoStatuses: z
    .array(z.enum(["open", "done"]))
    .min(1)
    .max(2)
    .optional(),
  userAvatar: AvatarImageSchema.nullable().optional(),
  defaultModel: DefaultModelSchema.nullable().optional(),
  auxiliaryModel: DefaultModelSchema.pick({ provider: true, id: true }).nullable().optional(),
  /** Bot selected for a new ACP session; stale/archived ids fall back to the main Bot. */
  acpDefaultBotId: IdSchema.nullable().optional(),
  commandLogRetention: z
    .record(
      IdSchema,
      z.strictObject({
        days: z.number().int().min(1).max(3650),
        megabytes: z.number().int().min(1).max(10000),
      }),
    )
    .optional(),
  backgroundCommandLimitMinutes: z.number().int().min(30).max(1440).optional(),
  /** Hard daily budget for background memory extraction across all Bots. */
  memoryDreamEnabled: z.boolean().optional(),
  memoryDreamLocalOnly: z.boolean().optional(),
  memoryDreamCostUsd: z.number().min(0).max(100).optional(),
  memoryExtractionDailyCostUsd: z.number().min(0).max(100).optional(),
  /**
   * The fallback budget for models without a catalog price (custom providers, local
   * models). Without it a priced cap would never apply to them; default is 2,000,000 tokens.
   */
  memoryExtractionDailyTokens: z.number().int().min(0).max(100_000_000).optional(),
  language: z.enum(["system", "zh", "en"]),
  theme: z.enum(["system", "light", "dark"]),
  /** Optional so a brain or settings row written before the option still parses. */
  chatFontSize: ChatFontSizeSchema.optional(),
  /** Live island (desktop only). All optional so rows written before it still parse. */
  liveIsland: z.boolean().optional(),
  liveIslandContent: LiveIslandContentSchema.optional(),
  /**
   * Ignored: the island now shows only while Pi Bot is not in front. Kept so a row written by a
   * development build that still offered "always" parses.
   */
  liveIslandWhen: z.enum(["always", "background"]).optional(),
  /** Which kinds of work appear; an empty list shows nothing. */
  liveIslandKinds: z
    .array(LiveIslandKindSchema)
    .max(4)
    .refine((kinds) => new Set(kinds).size === kinds.length)
    .optional(),
  onboardingCompleted: z.boolean(),
  openAtLogin: z.boolean(),
  showTrayIcon: z.boolean(),
  closeToTrayHintShown: z.boolean(),
  /** Prefer the user's connected browser over the isolated Bot browser. */
  browserExtensionPreference: z.enum(["user", "bot"]).optional(),
  /**
   * Consent to YOLO auto-approval of eligible Windows commands, which run without isolation.
   * Both the active conversation's YOLO and this consent are required.
   */
  yoloUnisolatedCommands: z.boolean().optional(),
  /** Recorded by the Windows consent flow; legacy consent has no reliable timestamp. */
  yoloUnisolatedCommandsAt: z.iso.datetime().nullable().optional(),
  /**
   * When on, a command the sandbox blocked is never offered a run outside it; the
   * user only sees why it was blocked. macOS / Linux only.
   */
  strictSandbox: z.boolean().optional(),
  /** Commands the user runs outside the sandbox, still confirmed every time. */
  sandboxOutsideCommands: OutsideCommandPatternsSchema.optional(),
  sandboxAutoOutsideCommands: z
    .array(
      z.strictObject({
        pattern: OutsideCommandPatternSchema,
        folder: z.string().min(1).max(4096),
        source: z.literal("auto"),
        createdAt: z.number().int().nonnegative(),
      }),
    )
    .max(256)
    .optional(),
  sandboxAutoWritePaths: z
    .array(
      z.strictObject({
        folder: z.string().min(1).max(4096),
        program: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        createdAt: z.number().int().nonnegative(),
      }),
    )
    .max(256)
    .optional(),
  sandboxAutoSystemServices: z
    .array(
      z.strictObject({
        folder: z.string().min(1).max(4096),
        program: z.string().min(1).max(256),
        service: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
        createdAt: z.number().int().nonnegative(),
      }),
    )
    .max(256)
    .optional(),
  sandboxAutoLocalServices: z
    .array(
      z.strictObject({
        folder: z.string().min(1).max(4096),
        program: z.string().min(1).max(256),
        target: z.union([
          z
            .string()
            .regex(/^(?:127\.0\.0\.1|localhost|::1):[1-9]\d{0,4}$/)
            .refine((value) => Number(value.slice(value.lastIndexOf(":") + 1)) <= 65535),
          z
            .string()
            .refine(
              (value) =>
                value.startsWith("/") &&
                [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127),
            ),
        ]),
        createdAt: z.number().int().nonnegative(),
      }),
    )
    .max(256)
    .optional(),
});
export const BrainBootstrapSchema = z.strictObject({
  dataDir: name,
  resourcesDir: name,
  version: name,
  platform: z.enum(["darwin", "win32", "linux"]),
  dev: z.boolean(),
  independent: z.boolean().optional(),
  /** Sanitized login-shell PATH, injected by the desktop host. */
  terminalPath: z.array(z.string().min(1).max(4096)).max(256).optional(),
});
export const BrainTerminalPathSchema = z.strictObject({
  type: z.literal("terminal_path"),
  path: z.array(z.string().min(1).max(4096)).max(256),
});
/**
 * Brain → owner liveness while the child is still starting. The desktop watchdog used
 * to see only host RPC traffic, so a slow startup phase that calls no host method looked dead.
 * Only the phase identifier crosses the port; no paths, counts or user data.
 */
export const BrainStartupProgressSchema = z.strictObject({
  type: z.literal("startup-progress"),
  phase: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_.-]*$/),
});
export type Settings = z.infer<typeof SettingsSchema>;
