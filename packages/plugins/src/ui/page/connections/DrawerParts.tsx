import { useSettings } from "@pibot/renderer-kit";
import { Icon, type IconName } from "@pibot/ui";
import { type CSSProperties, type ReactNode, useState } from "react";
import pageStyles from "./connections.module.css";
import styles from "./drawer.module.css";
import { letterTone, monogram } from "./Faces.tsx";

/** The connection's letter tile, the same colour it has on its card. */
export function ConnectionTile({ name }: { name: string }) {
  return (
    <span className={styles.tile} data-tone={letterTone(name)} aria-hidden="true">
      {monogram(name)}
    </span>
  );
}

/** Tile, name with its status, one line, chips, and the actions on the right. */
export function DrawerHero({
  name,
  note,
  status,
  chips,
  actions,
}: {
  name: string;
  note?: ReactNode;
  status?: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.hero}>
      <ConnectionTile name={name} />
      <div className={styles.heroText}>
        <span className={styles.heroName}>
          {name}
          {status}
        </span>
        {note && <span className={styles.heroNote}>{note}</span>}
        {chips && <span className={styles.chips}>{chips}</span>}
      </div>
      {actions && <div className={styles.heroActions}>{actions}</div>}
    </div>
  );
}

export interface DrawerTab<T extends string> {
  value: T;
  label: string;
  count?: number | string;
}

/** The Connections page's segmented tabs, sized for the drawer. */
export function DrawerTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: readonly DrawerTab<T>[];
  value: T;
  onChange(value: T): void;
}) {
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.value === value),
  );
  return (
    <div
      className={`${pageStyles.tabs} ${styles.tabs}`}
      role="tablist"
      aria-label={label}
      style={{ "--seg-count": tabs.length, "--seg-index": index } as CSSProperties}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
        const tab = tabs[next];
        if (tab) onChange(tab.value);
        event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          tabIndex={tab.value === value ? 0 : -1}
          className={pageStyles.tab}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count !== undefined && <span className={pageStyles.count}>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * One setting as a labelled input box. A secret is masked with a show toggle and carries the
 * key-store note; the value is never echoed anywhere else.
 */
export function DrawerField({
  id,
  label,
  required,
  secret,
  note,
  error,
  icon,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  note?: ReactNode;
  error?: ReactNode;
  icon?: IconName;
  children: ReactNode;
}) {
  const { t } = useSettings();
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
        {required && <small>{t("connections.drawer.required")}</small>}
      </label>
      <div className={styles.inputBox}>
        {(icon || secret) && <Icon name={icon ?? "key"} size={16} />}
        {children}
      </div>
      {error && (
        <span role="alert" className={styles.fieldError}>
          {error}
        </span>
      )}
      {note && <span className={styles.fieldNote}>{note}</span>}
      {secret && <span className={styles.fieldNote}>{t("connections.drawer.secretNote")}</span>}
    </div>
  );
}

/** A password input with its eye toggle; showing never leaves this input. */
export function SecretInput({
  id,
  label,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange(value: string): void;
}) {
  const { t } = useSettings();
  const [shown, setShown] = useState(false);
  return (
    <>
      <input
        id={id}
        type={shown ? "text" : "password"}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="new-password"
        spellCheck={false}
        maxLength={16384}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button
        type="button"
        className={styles.eye}
        aria-pressed={shown}
        aria-label={t(shown ? "connections.drawer.hideSecret" : "connections.drawer.showSecret", {
          name: label,
        })}
        title={t(shown ? "connections.drawer.hideSecret" : "connections.drawer.showSecret", {
          name: label,
        })}
        onClick={() => setShown((value) => !value)}
      >
        <Icon name={shown ? "hide" : "eye"} size={16} />
      </button>
    </>
  );
}
