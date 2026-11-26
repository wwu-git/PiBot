import type { MouseEventHandler, ReactNode } from "react";
import styles from "../models.module.css";

export function ProviderTile({
  name,
  note,
  group,
  monogram,
  selected,
  saved,
  add,
  title,
  disabled,
  onClick,
  children,
}: {
  name: ReactNode;
  note: string;
  group: string;
  monogram: string;
  selected: boolean;
  saved?: boolean;
  add?: boolean;
  title?: string;
  disabled?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${styles.tile} ${saved ? styles.configuredTile : ""}`}
      aria-pressed={selected}
      data-add={add || undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true" className={styles.monogram} data-group={group}>
        {monogram}
      </span>
      <span className={styles.tileText}>
        <strong>{name}</strong>
        <span className={styles.tileNote}>{note}</span>
      </span>
      {children}
    </button>
  );
}
