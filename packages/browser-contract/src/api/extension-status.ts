import { BrowserExtensionStatusSchema } from "@pibot/protocol-base";
import { z } from "zod";

export { BrowserExtensionStatusSchema };

const empty = z.union([z.undefined(), z.strictObject({})]);
export const BrowserExtensionMethods = {
  "browserExtension.status": { params: empty, result: BrowserExtensionStatusSchema },
  "browserExtension.setPreference": {
    params: z.strictObject({
      preference: z.enum(["user", "bot"]),
      /** "Connect here": take the extension over from another Pi Bot or the main install. */
      takeOver: z.literal(true).optional(),
    }),
    result: BrowserExtensionStatusSchema,
  },
  /**
   * The desktop's report that a run's page action fell back from the user's browser to the Bot
   * browser (the extension went away): one grey line in that run's topic.
   */
  "browserExtension.fallback": {
    params: z.strictObject({ botId: z.uuid(), runId: z.uuid() }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "browserExtension.record": {
    params: z.strictObject({
      botId: z.uuid(),
      runId: z.uuid().optional(),
      browser: z.enum(["chrome", "edge", "brave", "chromium", "firefox", "unknown"]),
      action: z.string().min(1).max(32),
      domain: z.string().max(253),
    }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;

export const BrowserExtensionEvents = {
  "browserExtension.changed": BrowserExtensionStatusSchema,
} as const;
