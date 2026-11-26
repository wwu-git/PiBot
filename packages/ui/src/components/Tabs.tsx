import type { CSSProperties, KeyboardEvent } from "react";
import styles from "./Tabs.module.css";

export interface TabOption<T extends string> {
  value: T;
  label: string;
  /** A count after the label ("项目 3"); absent hides it. */
  count?: number;
}

export interface TabsProps<T extends string> {
  label: string;
  tabs: readonly TabOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Layout only (width, margins); the look stays the shared one. */
  className?: string;
}

/**
 * Equal tabs with a sliding selection block (Connections, the import preview). Arrow keys,
 * Home and End move between tabs as a tablist expects.
 */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onValueChange,
  className,
}: TabsProps<T>) {
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.value === value),
  );
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    const tab = tabs[next];
    if (!tab) return;
    onValueChange(tab.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };
  return (
    <div
      className={className ? `${styles.tabs} ${className}` : styles.tabs}
      role="tablist"
      aria-label={label}
      style={{ "--seg-count": tabs.length, "--seg-index": index } as CSSProperties}
      onKeyDown={keys}
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          tabIndex={tab.value === value ? 0 : -1}
          className={styles.tab}
          onClick={() => onValueChange(tab.value)}
        >
          {tab.label}
          {tab.count !== undefined && <span className={styles.count}>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
