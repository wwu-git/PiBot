/*
 * Main ↔ live-island window contract. The island page has no script of its own; its sandboxed
 * preload draws what main sends and reports clicks and its measured size. Both directions are
 * parsed with these schemas where they arrive.
 */
import { z } from "zod";

export const LIVE_ISLAND_STATE = "pibot-island:state";
export const LIVE_ISLAND_READY = "pibot-island:ready";
export const LIVE_ISLAND_ACTION = "pibot-island:action";

const line = z.string().min(1).max(400);
export const IslandItemSchema = z.strictObject({
  key: z.string().min(1).max(200),
  name: line,
  text: line,
  /** Accessible name of the row's open button. */
  open: line,
  avatar: z.strictObject({
    shape: z.string().max(64),
    color: z.string().max(64),
    eyes: z.string().max(64),
    image: z
      .string()
      .max(200_000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u)
      .nullable(),
  }),
  startedAt: z.number().int().nonnegative(),
});
export const IslandStateSchema = z.strictObject({
  theme: z.enum(["light", "dark"]),
  mode: z.enum(["full", "avatars"]),
  labels: z.strictObject({
    previous: line,
    next: line,
    /** Templates with `{count}`. */
    working: line,
    seconds: line,
    minutes: line,
    hours: line,
  }),
  items: z.array(IslandItemSchema).min(1).max(20),
});
export type IslandState = z.infer<typeof IslandStateSchema>;
export const IslandActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open"), key: z.string().min(1).max(200) }),
  // The pill's laid-out size, so the window covers only the pill and not the screen around it.
  z.strictObject({
    kind: z.literal("size"),
    width: z.number().int().min(1).max(1200),
    height: z.number().int().min(1).max(200),
  }),
]);
export type IslandAction = z.infer<typeof IslandActionSchema>;

export type IslandSupport = "supported" | "wayland" | "no_display";
/**
 * Whether this session can keep a small non-focusable window on top at a chosen position.
 * Electron runs natively on Wayland there, and Wayland lets neither place nor raise windows.
 */
export function liveIslandSupport(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): IslandSupport {
  if (platform !== "linux") return "supported";
  if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) return "wayland";
  return env.DISPLAY ? "supported" : "no_display";
}
