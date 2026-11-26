import { type ReactNode, useRef } from "react";
import { menuKeys, useMenuPopover } from "../workspace/profile/use-menu-popover.ts";
import styles from "./app-menu.module.css";

/** The app menu's floating card; the import dialog's destination menus reuse it. */
export function MenuPopover({
  opener,
  x,
  y,
  close,
  label,
  children,
}: {
  opener: HTMLElement;
  x: number;
  y: number;
  close(): void;
  label?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuPopover(ref, opener, x, y, close);
  return (
    <div
      ref={ref}
      popover="manual"
      role="menu"
      aria-label={label}
      className={styles.menu}
      onKeyDown={(event) => menuKeys(event, close)}
    >
      {children}
    </div>
  );
}
