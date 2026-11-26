import type { Bot } from "@pibot/protocol";
import { Avatar, type AvatarProps } from "@pibot/ui";

export const avatarShapes = [
  "blob",
  "pill",
  "drop",
  "pebble",
  "flower",
  "cloud",
  "ghost",
  "cat",
  "hex",
  "circle",
  "bean",
  "tri",
] as const;
export const avatarColors = [
  "orange",
  "amber",
  "blue",
  "violet",
  "pink",
  "teal",
  "green",
  "brown",
  "ink",
  "gray",
] as const;
export const avatarEyes = ["marks", "dot", "oval", "pixel", "sleepy"] as const;
/** Stored avatar fields are free strings; unknown values fall back the same way everywhere. */
export function botAvatarLook(
  bot?: { avatarShape?: string; avatarColor?: string; avatarEyes?: string },
  unknown?: boolean,
) {
  if (unknown && !bot) return { shape: "circle", color: "gray", eyes: "sleepy" } as const;
  return {
    shape: avatarShapes.find((v) => v === bot?.avatarShape) ?? "blob",
    color: avatarColors.find((v) => v === bot?.avatarColor) ?? "violet",
    eyes: avatarEyes.find((v) => v === bot?.avatarEyes) ?? "marks",
  };
}
export type BotAvatarSource = Pick<
  Bot,
  "name" | "avatarShape" | "avatarColor" | "avatarEyes" | "avatarImage"
>;

export function BotAvatar({
  bot,
  unknown,
  ...props
}: { bot?: BotAvatarSource; unknown?: boolean } & Omit<AvatarProps, "shape" | "color" | "eyes">) {
  return (
    <Avatar
      {...props}
      image={bot?.avatarImage}
      {...botAvatarLook(bot, unknown)}
      label={props.label ?? bot?.name ?? "Pi"}
    />
  );
}
