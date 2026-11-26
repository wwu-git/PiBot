import type { ImportHistoryItem } from "@pibot/protocol";
import { SettingsRow, SettingsSection, useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import styles from "./conversation-import.module.css";
import type { Status } from "./import-state.ts";

const PAGE = 8;

/** Past batches, newest first, refreshed by the batches' own progress events. */
function useImportHistory() {
  const { peer } = useRpc();
  const [items, setItems] = useState<ImportHistoryItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    async (before?: number, signal?: AbortSignal) => {
      if (!peer) return;
      try {
        const page = await peer.call(
          "import.history",
          { limit: PAGE, ...(before === undefined ? {} : { before }) },
          { signal },
        );
        if (signal?.aborted) return;
        setItems((current) => (before === undefined ? page.items : [...current, ...page.items]));
        setNext(page.next);
        setFailed(false);
      } catch {
        // The list is a convenience; the import itself works without it.
        if (!signal?.aborted) setFailed(true);
      }
    },
    [peer],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load]);
  useRpcEvent(
    "import.progress",
    useCallback((status: Status) => {
      setItems((current) =>
        current.map((item) =>
          item.importId === status.importId
            ? { ...item, ...status, createdAt: item.createdAt }
            : item,
        ),
      );
    }, []),
  );
  return { items, next, failed, more: () => next !== null && void load(next) };
}

/** 导入记录: each finished batch can still be undone, with the same rules as right after it. */
export function ImportHistory({
  undo,
  disabled,
}: {
  undo(status: ImportHistoryItem): void;
  disabled: boolean;
}) {
  const t = useT();
  const history = useImportHistory();
  if (!history.items.length) return null;
  return (
    <SettingsSection
      title={t("conversationImport.history.title")}
      action={<span className={styles.hint}>{t("conversationImport.history.hint")}</span>}
    >
      {history.items.map((item) => {
        const date = item.createdAt?.slice(0, 10);
        const counts = [
          t("conversationImport.allChats", { count: item.topics }),
          ...(item.memories
            ? [t("conversationImport.summary.memories", { count: item.memories })]
            : []),
          ...(item.projectFiles
            ? [t("conversationImport.history.files", { count: item.projectFiles })]
            : []),
          ...(item.keptProjectFiles
            ? [t("conversationImport.projectKept", { count: item.keptProjectFiles })]
            : []),
          ...(item.keptFolders
            ? [t("conversationImport.foldersKept", { count: item.keptFolders })]
            : []),
        ];
        const cleaning = !!item.cleanup || item.state === "undoing";
        const undoable = item.state === "completed" || cleaning;
        return (
          <div key={item.importId} className={styles.item}>
            <SettingsRow
              icon="download"
              tone={item.state === "completed" ? "teal" : "neutral"}
              label={
                date
                  ? t("conversationImport.history.label", {
                      source: t(`conversationImport.source.${item.source}`),
                      date,
                    })
                  : t(`conversationImport.source.${item.source}`)
              }
              note={`${counts.join(" · ")} · ${t(
                cleaning
                  ? item.cleanupBlocked
                    ? "conversationImport.cleanupBlocked"
                    : "conversationImport.state.undoing"
                  : `conversationImport.state.${item.state}`,
              )}`}
            >
              {undoable && (
                <Button variant="secondary" disabled={disabled} onClick={() => undo(item)}>
                  {t(
                    cleaning
                      ? "conversationImport.retryCleanup"
                      : "conversationImport.history.undo",
                  )}
                </Button>
              )}
            </SettingsRow>
          </div>
        );
      })}
      {history.next !== null && (
        <div className={styles.more}>
          <Button variant="ghost" disabled={disabled} onClick={history.more}>
            {t("conversationImport.history.more")}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
