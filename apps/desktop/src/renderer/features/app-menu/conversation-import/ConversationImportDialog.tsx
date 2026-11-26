import { ProviderTile } from "@pibot/models/ui";
import { useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { AppDialog } from "../AppDialog.tsx";
import styles from "./conversation-import.module.css";
import { ImportHistory } from "./ImportHistory.tsx";
import { ImportPreview } from "./ImportPreview.tsx";
import { ImportProgress } from "./ImportProgress.tsx";
import { localSources, marks, sources, startParams } from "./import-state.ts";
import { useImportDraft } from "./use-import-draft.ts";
import { useImportJob } from "./use-import-job.ts";

export function ConversationImportDialog({ open, close }: { open: boolean; close(): void }) {
  const t = useT();
  const { peer } = useRpc();
  const { openBotPanel, openWorkspace } = useNavigation();
  const draft = useImportDraft();
  const running = useImportJob();
  // Keep the batch subscription mounted when the existing inbox opens for project approval.
  if (!open) return null;
  const { preview } = draft;
  const status = running.job?.status;
  const title = status?.cleanupBlocked
    ? "conversationImport.cleanupBlocked"
    : status?.cleanup === "discarding"
      ? "conversationImport.cleaning"
      : status
        ? (`conversationImport.state.${status.state}` as const)
        : running.job
          ? "conversationImport.confirming"
          : "conversationImport.title";
  const busy = !!draft.busy || !!running.busy || !peer;
  const params =
    preview &&
    startParams({
      preview,
      plan: draft.plan,
      botId: draft.botId,
      conversations: draft.conversations,
      projects: draft.projects,
      memories: draft.memories
        .filter((memory) => draft.memoryOn(memory))
        .map((memory) => ({ id: memory.id, target: draft.memoryTarget(memory) })),
      persona:
        draft.persona.on && draft.persona.review
          ? { reviewId: draft.persona.review.reviewId, botId: draft.persona.botId }
          : undefined,
      quote: draft.quote,
    });
  const release = () => {
    if (!running.job) draft.back();
    close();
  };
  const error = (draft.error || running.error) && (
    <p className={styles.error} role="alert">
      {t(draft.error ?? running.error ?? "conversationImport.error.internal")}
    </p>
  );
  return (
    <AppDialog
      title={t(title)}
      kind="conversation-import"
      mark={{ icon: "download", tone: "teal" }}
      busy={draft.busy === "preview" || running.busy === "start"}
      close={release}
    >
      {running.job ? (
        <ImportProgress
          running={running}
          restart={() => {
            running.clear();
            draft.back();
          }}
          openInbox={() => {
            close();
            openWorkspace({ name: "inbox" });
          }}
          openTopics={(botId) => {
            close();
            openBotPanel(botId, "topics");
          }}
          close={close}
        />
      ) : preview ? (
        <ImportPreview
          draft={draft}
          preview={preview}
          disabled={busy && draft.busy !== "project"}
          error={error}
          cancel={release}
          start={params && draft.busy !== "project" ? () => running.start(params) : undefined}
        />
      ) : (
        <>
          <p className={styles.intro}>{t("conversationImport.chooseSource")}</p>
          <fieldset
            className={styles.sources}
            aria-label={t("conversationImport.sources")}
            disabled={busy}
          >
            {sources.map((source) => (
              <ProviderTile
                key={source}
                name={t(`conversationImport.source.${source}`)}
                note={t(`conversationImport.sourceNote.${source}`)}
                group="common"
                monogram={marks[source]}
                selected={source === draft.source}
                onClick={() => draft.selectSource(source)}
              />
            ))}
          </fieldset>
          {draft.busy && (
            <p className={styles.intro} role="status">
              {t(`conversationImport.loading.${draft.busy}`)}
            </p>
          )}
          {error}
          <div className={styles.actions}>
            <Button variant="secondary" disabled={busy && !!peer} onClick={release}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy} onClick={draft.pick}>
              {t(
                localSources.has(draft.source)
                  ? "conversationImport.pickLocal"
                  : "conversationImport.pickExport",
              )}
            </Button>
          </div>
          <div className={styles.history}>
            <ImportHistory undo={running.undoPast} disabled={busy} />
          </div>
        </>
      )}
    </AppDialog>
  );
}
