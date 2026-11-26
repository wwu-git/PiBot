import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "./conversation-import.module.css";
import type { useImportJob } from "./use-import-job.ts";

type Props = {
  running: ReturnType<typeof useImportJob>;
  restart(): void;
  openInbox(): void;
  openTopics(botId: string): void;
  close(): void;
};

export function ImportProgress({ running, restart, openInbox, openTopics, close }: Props) {
  const t = useT();
  const { job, busy, connected, error, cancel, undo } = running;
  if (!job) return null;
  const { status } = job;
  if (!status)
    return (
      <p className={styles.intro} role="status">
        {t(connected ? "conversationImport.confirmingNote" : "conversationImport.reconnectNote")}
      </p>
    );
  const retryCleanup = status.cleanupBlocked || (status.state === "undoing" && !status.cleanup);
  const closeable =
    status.state === "undone" || status.state === "failed" || status.state === "cancelled";
  const showProjectApproval =
    job.hasProject && (status.state === "running" || status.state === "undoing");
  return (
    <>
      <p role="status" className={styles.intro}>
        {t("conversationImport.resultCounts", {
          source: t(`conversationImport.source.${status.source}`),
          topics: status.topics,
          messages: status.messages,
        })}
        {status.state === "completed" && job.elapsedMs !== undefined
          ? ` · ${t("conversationImport.elapsed", { count: Math.max(1, Math.round(job.elapsedMs / 1000)) })}`
          : ""}
      </p>
      {status.state === "completed" &&
      (status.memories || status.persona || status.projectFiles || status.folders) ? (
        <div className={styles.card}>
          {!!status.memories && (
            <p>{t("conversationImport.addedMemories", { count: status.memories })}</p>
          )}
          {status.persona && <p>{t("conversationImport.personaChanged")}</p>}
          {!!status.folders && (
            <p>{t("conversationImport.foldersCreated", { count: status.folders })}</p>
          )}
          {!!status.projectFiles && (
            <p>{t("conversationImport.projectChanged", { count: status.projectFiles })}</p>
          )}
        </div>
      ) : null}
      {status.removed && (
        <p role="status" className={styles.intro}>
          {t("conversationImport.removed", {
            topics: status.removed.topics,
            messages: status.removed.messages,
          })}
        </p>
      )}
      {(!!status.keptProjectFiles || !!status.keptFolders) && (
        <div className={styles.card}>
          {!!status.keptProjectFiles && (
            <p>{t("conversationImport.projectKept", { count: status.keptProjectFiles })}</p>
          )}
          {!!status.keptFolders && (
            <p>{t("conversationImport.foldersKept", { count: status.keptFolders })}</p>
          )}
        </div>
      )}
      {showProjectApproval && (
        <div className={styles.card}>
          <p>
            {t(
              status.cleanup || status.state === "undoing"
                ? "conversationImport.compensationNote"
                : "conversationImport.projectApproval",
            )}
          </p>
          <Button variant="secondary" onClick={openInbox}>
            {t("conversationImport.openInbox")}
          </Button>
        </div>
      )}
      {status.state === "running" && !status.cleanup && job.cancelRequested && (
        <p role="status" className={styles.intro}>
          {t("conversationImport.cancelling")}
        </p>
      )}
      {status.reason && (
        <p role="alert" className={styles.error}>
          {t(`conversationImport.error.${status.reason}`)}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      <div className={styles.actions}>
        {status.state === "running" && !status.cleanup && !job.cancelRequested && (
          <Button variant="secondary" disabled={!!busy || !connected} onClick={cancel}>
            {t("conversationImport.cancel")}
          </Button>
        )}
        {status.state === "completed" && (
          <>
            <Button variant="ghost" disabled={!!busy} onClick={restart}>
              {t("conversationImport.another")}
            </Button>
            <Button variant="secondary" disabled={!!busy || !connected} onClick={undo}>
              {t("conversationImport.undo")}
            </Button>
            {status.topics > 0 && job.botId && (
              <Button disabled={!!busy} onClick={() => openTopics(job.botId)}>
                {t("conversationImport.viewTopics")}
              </Button>
            )}
            {(status.topics === 0 || !job.botId) && (
              <Button disabled={!!busy} onClick={close}>
                {t("appMenu.close")}
              </Button>
            )}
          </>
        )}
        {retryCleanup && (
          <Button variant="secondary" disabled={!!busy || !connected} onClick={undo}>
            {t("conversationImport.retryCleanup")}
          </Button>
        )}
        {closeable && (
          <Button disabled={!!busy} onClick={restart}>
            {t("conversationImport.another")}
          </Button>
        )}
      </div>
    </>
  );
}
