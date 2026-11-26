import { useSettingsDialog, useT } from "@pibot/renderer-kit";
import { CloseButton, type IconName, IconTile, type Tone } from "@pibot/ui";
import { type CSSProperties, type ReactNode, useId } from "react";
import dialogStyles from "../settings/dialog.module.css";
import styles from "./app-menu.module.css";

export function AppDialog({
  title,
  kind,
  mark,
  busy,
  canClose,
  close: onClose,
  children,
}: {
  title: string;
  kind?: "about-you" | "provider-import" | "conversation-import";
  /** The dialog's coloured mark; its tone also washes the top of the dialog. */
  mark?: { icon: IconName; tone: Exclude<Tone, "neutral" | "red"> };
  busy?: boolean;
  canClose?(): boolean;
  close(): void;
  children: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const { dialog, closing, close, trapFocus } = useSettingsDialog(onClose);
  const requestClose = () => {
    if (!busy && canClose?.() !== false) close();
  };
  return (
    <dialog
      ref={dialog}
      // biome-ignore lint/a11y/noRedundantRoles: Keep the explicit dialog role required by product accessibility checks.
      role="dialog"
      aria-modal="true"
      aria-busy={busy || undefined}
      aria-labelledby={id}
      className={`${dialogStyles.dialog} ${styles.dialog}`}
      data-closing={closing || undefined}
      data-app-dialog={kind}
      style={mark ? ({ "--dialog-c": `var(--avatar-${mark.tone})` } as CSSProperties) : undefined}
      tabIndex={-1}
      onKeyDown={trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        if (busy) return;
        // Escape with a ⋯ menu open closes the menu only. A click on macOS may leave focus on the
        // dialog rather than in the menu, so the menu's own key handler never saw the key.
        const menu = event.currentTarget.querySelector<HTMLDetailsElement>("details[open]");
        if (menu) {
          menu.open = false;
          menu.querySelector("summary")?.focus();
          return;
        }
        requestClose();
      }}
    >
      <header className={styles.header}>
        <h1 id={id}>
          {mark && <IconTile icon={mark.icon} tone={mark.tone} size="lg" />}
          {title}
        </h1>
        <CloseButton label={t("appMenu.close")} onClick={requestClose} disabled={busy} />
      </header>
      <div className={styles.content}>{children}</div>
    </dialog>
  );
}
