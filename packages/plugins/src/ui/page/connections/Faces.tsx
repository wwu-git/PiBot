import type { Bot, Group } from "@pibot/plugins-contract/full";
import { BotAvatar, type BotAvatarSource, useSettings } from "@pibot/renderer-kit";
import { GroupAvatar } from "@pibot/ui";
import type { ReactNode } from "react";
import styles from "./connections.module.css";

const SHOWN = 3;

/** Two letters for a Latin name ("GitHub" → "GH"), the first character otherwise ("日历" → "日"). */
export function monogram(name: string) {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const first = [...(words[0] ?? "?")][0] ?? "?";
  if (!/^[A-Za-z0-9]$/.test(first)) return first;
  const capitals = name.match(/[A-Z]/g);
  const second =
    words.length > 1
      ? [...(words[1] as string)][0]
      : capitals && capitals.length > 1
        ? capitals[1]
        : [...(words[0] as string)][1];
  return `${first}${second ?? ""}`.toUpperCase();
}

const LETTER_TONES = ["blue", "teal", "orange", "violet", "green", "pink", "amber"] as const;
/** A stable colour per name, so each connection keeps its letter tile's colour. */
export function letterTone(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return LETTER_TONES[hash % LETTER_TONES.length];
}

type PickerBot = BotAvatarSource & Pick<Bot, "id">;

export function GroupFace({
  group,
  bots,
  size,
}: {
  group: Group;
  bots: PickerBot[];
  size: number;
}) {
  const members = group.members
    .map((member) => bots.find((bot) => bot.id === member.botId))
    .filter((bot): bot is PickerBot => !!bot);
  if (members.length < 2)
    return (
      <span className={styles.groupTile} style={{ width: size, height: size }} aria-hidden="true">
        {[...group.name][0]}
      </span>
    );
  return (
    <GroupAvatar size={size}>
      {members.map((bot) => (
        <BotAvatar key={bot.id} bot={bot} size={size} />
      ))}
    </GroupAvatar>
  );
}

/**
 * The right side of a row when all is well: the Bots (and groups) that can use it, at most three
 * faces and a count, like the sidebar's avatars.
 */
export function Faces({
  bots,
  groups,
}: {
  bots: Bot[];
  groups: { group: Group; members: Bot[] }[];
}) {
  const { t, language } = useSettings();
  const names = [...bots.map((bot) => bot.name), ...groups.map(({ group }) => group.name)];
  const shownBots = bots.slice(0, SHOWN);
  const shownGroups = groups.slice(0, Math.max(0, SHOWN - shownBots.length));
  const rest = names.length - shownBots.length - shownGroups.length;
  const label = t("connections.faces.label", {
    names: new Intl.ListFormat(language, { type: "conjunction" }).format(names),
  });
  return (
    <span className={styles.faces} role="img" aria-label={label} title={label}>
      {shownBots.map((bot) => (
        <BotAvatar key={bot.id} bot={bot} size={22} />
      ))}
      {shownGroups.map(({ group, members }) => (
        <GroupFace key={group.id} group={group} bots={members} size={22} />
      ))}
      {rest > 0 && <small>{t("connections.faces.more", { count: rest })}</small>}
    </span>
  );
}

/** Bots and groups named by an access list, resolved against the sidebar's lists. */
export function resolveAccess(
  access: { mode: string; bots: readonly string[]; groups: readonly string[] },
  bots: Bot[],
  groups: Group[],
) {
  const all = access.mode === "all" || access.mode === "ask_first";
  return {
    bots: all ? bots : bots.filter((bot) => access.bots.includes(bot.id)),
    groups: (all ? [] : groups.filter((group) => access.groups.includes(group.id))).map(
      (group) => ({ group, members: bots }),
    ),
  };
}

/** Click-to-toggle faces: on = can use it, greyed = cannot. No checkboxes. */
export function FacePicker({
  bots,
  groups,
  isOn,
  toggle,
  disabled,
  unavailable = [],
  requestedTarget,
  isDisabled,
}: {
  bots: PickerBot[];
  groups: Group[];
  isOn(kind: "bot" | "group", id: string): boolean;
  toggle(kind: "bot" | "group", id: string): void;
  disabled: boolean;
  requestedTarget?: { kind: "bot" | "group"; id: string };
  unavailable?: { kind: "bot" | "group"; id: string; name: string }[];
  isDisabled?(kind: "bot" | "group", id: string): boolean;
}) {
  const { t } = useSettings();
  const pick = (kind: "bot" | "group", id: string, name: string, face: ReactNode) => {
    const on = isOn(kind, id);
    return (
      <button
        key={`${kind}:${id}`}
        type="button"
        className={styles.pick}
        data-on={on || undefined}
        data-requested={(requestedTarget?.kind === kind && requestedTarget.id === id) || undefined}
        aria-pressed={on}
        aria-label={t(on ? "connections.panel.can" : "connections.panel.cannot", { name })}
        disabled={disabled || isDisabled?.(kind, id)}
        title={name}
        onClick={() => toggle(kind, id)}
      >
        <span className={styles.pickFace}>{face}</span>
        <span className={styles.pickName}>{name}</span>
      </button>
    );
  };
  if (!bots.length && !groups.length && !unavailable.length)
    return <p className={styles.note}>{t("connections.panel.noBots")}</p>;
  return (
    <div className={styles.picker}>
      {bots.map((bot) => pick("bot", bot.id, bot.name, <BotAvatar bot={bot} size={30} />))}
      {groups.map((group) =>
        pick("group", group.id, group.name, <GroupFace group={group} bots={bots} size={30} />),
      )}
      {unavailable.map(({ kind, id, name }) =>
        pick(
          kind,
          id,
          name,
          <span className={styles.groupTile} aria-hidden="true">
            ?
          </span>,
        ),
      )}
    </div>
  );
}
