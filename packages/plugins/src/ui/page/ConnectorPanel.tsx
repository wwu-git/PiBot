import { useSettingsDialog, useT } from "@pibot/renderer-kit";
import { CloseButton } from "@pibot/ui";
import { type ReactNode, useId } from "react";
import styles from "./connectors.module.css";

export function ConnectorPanel({
  title,
  children,
  close,
  busy = false,
  footer,
}: {
  title: string;
  children: ReactNode;
  close(): void;
  busy?: boolean;
  /** Actions that stay visible below the scrolling body (取消 / 连接). */
  footer?: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const modal = useSettingsDialog(close);
  const requestClose = () => {
    if (!busy) modal.close();
  };
  return (
    <dialog
      ref={modal.dialog}
      className={styles.panel}
      data-closing={modal.closing || undefined}
      aria-labelledby={id}
      onKeyDown={modal.trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <header className={styles.panelHeader}>
        <h2 id={id}>{title}</h2>
        <CloseButton label={t("common.cancel")} disabled={busy} onClick={requestClose} />
      </header>
      <div className={styles.panelBody}>{children}</div>
      {footer && <footer className={styles.panelFooter}>{footer}</footer>}
    </dialog>
  );
}
