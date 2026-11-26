import type { Bot } from "@pibot/protocol";
import { BotAvatar, useT } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { type ReactNode, useState } from "react";
import appStyles from "../app-menu.module.css";
import { MenuPopover } from "../MenuPopover.tsx";
import styles from "./conversation-import.module.css";
import type { Destination, FolderTarget, Plan } from "./import-state.ts";

const MENU_WIDTH = 300;

/** A chip that opens the app menu right-aligned under it, kept inside the dialog. */
function ChipMenu({
  label,
  chip,
  disabled,
  children,
}: {
  label: string;
  chip: ReactNode;
  disabled?: boolean;
  children(close: () => void): ReactNode;
}) {
  const [menu, setMenu] = useState<{ opener: HTMLElement; x: number; y: number }>();
  const close = () => setMenu(undefined);
  return (
    <>
      <button
        type="button"
        className={styles.chip}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        disabled={disabled}
        onClick={(event) => {
          if (menu) return close();
          const box = event.currentTarget.getBoundingClientRect();
          const frame = event.currentTarget.closest("dialog")?.getBoundingClientRect();
          const left = frame ? frame.left + 8 : 8;
          const right = frame ? frame.right - 8 : window.innerWidth - 8;
          const x = Math.max(left, Math.min(box.right - MENU_WIDTH, right - MENU_WIDTH));
          setMenu({ opener: event.currentTarget, x, y: box.bottom + 6 });
        }}
      >
        {chip}
        <Icon name="chevron" size={13} className={styles.caret} />
      </button>
      {menu && (
        <MenuPopover {...menu} label={label} close={close}>
          {children(close)}
        </MenuPopover>
      )}
    </>
  );
}

function MenuItem({
  lead,
  name,
  note,
  current,
  onClick,
}: {
  lead: ReactNode;
  name: ReactNode;
  note?: ReactNode;
  current: boolean;
  onClick(): void;
}) {
  return (
    <Button
      variant="ghost"
      role="menuitem"
      className={appStyles.profile}
      aria-current={current || undefined}
      onClick={onClick}
    >
      {lead}
      <span className={styles.menuItem}>
        {name}
        {note && <small>{note}</small>}
      </span>
      {current && <Icon name="check" size={16} className={styles.check} />}
    </Button>
  );
}

/** One line of a Bot's role for the menu; the first line of its description. */
function roleLine(bot: Bot) {
  return bot.description?.split(/\r?\n/u)[0]?.slice(0, 80) || undefined;
}

/**
 * Where something goes: 关于你 (every Bot can use it) or one Bot. Without `aboutYou` it is the
 * plain Bot choice used for project, chat and role owners.
 */
export function DestinationChip({
  value,
  bots,
  aboutYou = false,
  label,
  disabled,
  onChange,
}: {
  value: Destination;
  bots: readonly Bot[];
  aboutYou?: boolean;
  label: string;
  disabled?: boolean;
  onChange(value: Destination): void;
}) {
  const t = useT();
  const bot = bots.find(({ id }) => id === value);
  const user = aboutYou && value === "user";
  return (
    <ChipMenu
      label={label}
      disabled={disabled}
      chip={
        <>
          {user ? (
            <IconTile icon="user" tone="pink" size="sm" className={styles.person} />
          ) : (
            <BotAvatar bot={bot} unknown={!bot} size={18} />
          )}
          <span className={styles.chipLabel}>
            {user ? t("appMenu.aboutYou") : (bot?.name ?? t("conversationImport.selectBot"))}
          </span>
        </>
      }
    >
      {(close) => {
        const choose = (next: Destination) => {
          close();
          onChange(next);
        };
        return (
          <>
            {aboutYou && (
              <>
                <MenuItem
                  lead={<IconTile icon="user" tone="pink" size="lg" className={styles.person} />}
                  name={t("appMenu.aboutYou")}
                  note={t("conversationImport.aboutYouNote")}
                  current={value === "user"}
                  onClick={() => choose("user")}
                />
                <div className={appStyles.separator} />
                <div className={styles.menuLabel}>{t("conversationImport.onlyOneBot")}</div>
              </>
            )}
            {bots.map((item) => (
              <MenuItem
                key={item.id}
                lead={<BotAvatar bot={item} size={30} />}
                name={item.name}
                note={roleLine(item)}
                current={item.id === value}
                onClick={() => choose(item.id)}
              />
            ))}
          </>
        );
      }}
    </ChipMenu>
  );
}

export type ProjectTargets = Plan["projects"][number];

/** How a folder target reads on its chip and in the menu. */
export function folderLabel(
  folder: FolderTarget,
  plan: Plan,
  target: ProjectTargets | undefined,
  t: ReturnType<typeof useT>,
) {
  if (folder.kind === "folder")
    return plan.folders.find(({ id }) => id === folder.folderId)?.display ?? "";
  if (folder.kind === "source") return target?.source ?? "";
  if (folder.kind === "home") return t("folders.home");
  if (!target) return "";
  return target.newExists
    ? target.newDisplay
    : t("conversationImport.folderNew", { path: target.newDisplay });
}

/** 放进 [folder ▾]: used work folders, the project's own folder, ~/Documents/<name>, or pick. */
export function FolderChip({
  value,
  plan,
  target,
  disabled,
  onChange,
  onPick,
}: {
  value: FolderTarget;
  plan: Plan;
  target?: ProjectTargets;
  disabled?: boolean;
  onChange(value: FolderTarget): void;
  onPick(): void;
}) {
  const t = useT();
  const folderTile = <IconTile icon="folder" tone="orange" size="lg" />;
  return (
    <ChipMenu
      label={t("conversationImport.folderMenu")}
      disabled={disabled}
      chip={
        <>
          <Icon
            name={value.kind === "home" ? "home" : "folder"}
            size={15}
            className={styles.folderIcon}
          />
          <span className={styles.chipLabel} dir="auto">
            {folderLabel(value, plan, target, t)}
          </span>
        </>
      }
    >
      {(close) => {
        const choose = (next: FolderTarget) => {
          close();
          onChange(next);
        };
        return (
          <>
            {target && (
              <MenuItem
                lead={
                  <IconTile icon={target.newExists ? "folder" : "plus"} tone="orange" size="lg" />
                }
                name={folderLabel({ kind: "new" }, plan, target, t)}
                note={t(
                  target.newExists
                    ? "conversationImport.folderExists"
                    : "conversationImport.folderCreate",
                )}
                current={value.kind === "new"}
                onClick={() => choose({ kind: "new" })}
              />
            )}
            {target?.source && (
              <MenuItem
                lead={folderTile}
                name={target.source}
                note={t("conversationImport.folderSource")}
                current={value.kind === "source"}
                onClick={() => choose({ kind: "source" })}
              />
            )}
            <MenuItem
              lead={<IconTile icon="home" tone="violet" size="lg" />}
              name={t("folders.home")}
              note={t("conversationImport.folderHomeNote")}
              current={value.kind === "home"}
              onClick={() => choose({ kind: "home" })}
            />
            {plan.folders.length > 0 && (
              <>
                <div className={appStyles.separator} />
                <div className={styles.menuLabel}>{t("conversationImport.folderUsed")}</div>
                {plan.folders.map((folder) => (
                  <MenuItem
                    key={folder.id}
                    lead={folderTile}
                    name={folder.name}
                    note={folder.display}
                    current={value.kind === "folder" && value.folderId === folder.id}
                    onClick={() => choose({ kind: "folder", folderId: folder.id })}
                  />
                ))}
              </>
            )}
            <div className={appStyles.separator} />
            <MenuItem
              lead={<IconTile icon="search" tone="blue" size="lg" />}
              name={t("conversationImport.folderPick")}
              current={false}
              onClick={() => {
                close();
                onPick();
              }}
            />
          </>
        );
      }}
    </ChipMenu>
  );
}
