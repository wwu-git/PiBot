// Keep global permission controls and their explanations consistent.
import type { TranslationKey } from "@pibot/i18n";
import type { Category, Level, PermissionLevels } from "@pibot/protocol";
import { SettingsRow, useT } from "@pibot/renderer-kit";
import { type IconName, SegmentedControl, type Tone } from "@pibot/ui";
import type { ReactNode } from "react";
import yoloStyles from "../../chat/status/yolo.module.css";

const order: Level[] = ["never", "ask", "always"];

/**
 * Settings rows keep a one-line note; the category's full explanation moves behind ⓘ.
 * Categories whose standard note is already one line keep it as is.
 */
const SHORT: Partial<Record<Category, TranslationKey>> = {
  read_file: "permissions.short.read_file",
  write_file: "permissions.short.write_file",
  web: "permissions.short.web",
  computer: "permissions.short.computer",
  connector: "permissions.short.connector",
  send_out: "permissions.short.send_out",
  read_ai_config: "permissions.short.read_ai_config",
  read_messages: "permissions.short.read_messages",
};

/** One global default level, as a three-way (or, for computer use, two-way) segmented switch. */
/** Each operation keeps the same mark and colour wherever permissions are listed. */
export const CATEGORY_LOOK: Record<Category, [IconName, Tone]> = {
  run_command: ["terminal", "orange"],
  connector: ["plug", "amber"],
  computer: ["hand", "pink"],
  read_file: ["file", "blue"],
  list_dir: ["folder", "amber"],
  write_file: ["edit", "pink"],
  read_ai_config: ["key", "violet"],
  read_messages: ["message", "teal"],
  send_out: ["send", "violet"],
  web: ["globe", "green"],
  agent_delegation: ["bot", "teal"],
  bot_management: ["users", "violet"],
  work_dispatch: ["arrow", "blue"],
};

export function LevelRow({
  category,
  levels,
  disabled,
  note,
  info = false,
  unisolated = false,
  change,
}: {
  category: Category;
  levels: PermissionLevels;
  disabled: boolean;
  /** Replaces the category's standard one-line note (e.g. with the isolation state). */
  note?: ReactNode;
  /** Short note, long explanation behind ⓘ. */
  info?: boolean;
  unisolated?: boolean;
  change(category: Category, level: Level): void;
}) {
  const t = useT();
  const windowsCommand = category === "run_command" && window.pibot.platform === "win32";
  const short = info ? SHORT[category] : undefined;
  const long = t(
    windowsCommand ? "permissions.info.run_command.windows" : `permissions.note.${category}`,
  );
  return (
    <SettingsRow
      icon={CATEGORY_LOOK[category][0]}
      tone={CATEGORY_LOOK[category][1]}
      label={
        <>
          {t(`permissions.category.${category}`)}{" "}
          {unisolated && <span className={yoloStyles.badge}>{t("permissions.unisolated")}</span>}
        </>
      }
      note={note ?? (short ? t(short) : long)}
      info={info && (note !== undefined || short) ? long : undefined}
    >
      <SegmentedControl<Level>
        label={t(`permissions.category.${category}`)}
        value={windowsCommand && levels[category] === "always" ? "ask" : levels[category]}
        disabled={disabled}
        // "Always" for computer needs a per-Bot app list, so the global default stops at
        // "ask" (an older stored "always" stays visible).
        options={order
          .filter(
            (value) =>
              value !== "always" ||
              (category !== "read_ai_config" &&
                category !== "send_out" &&
                (category !== "computer" || levels.computer === "always")),
          )
          .map((value) => ({
            value,
            label: t(`permissions.level.${value}`),
            disabled: windowsCommand && value === "always",
            title:
              windowsCommand && value === "always"
                ? t("permissions.windowsAlwaysUnavailable")
                : undefined,
          }))}
        onValueChange={(value) => change(category, value)}
      />
    </SettingsRow>
  );
}
