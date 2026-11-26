import { useT } from "@pibot/renderer-kit";
import { Button, Tabs } from "@pibot/ui";
import { Fragment, type ReactNode, useState } from "react";
import { ChatRows, MemoryRows, RoleRows } from "./ContentRows.tsx";
import styles from "./conversation-import.module.css";
import { localSources, marks, type Preview } from "./import-state.ts";
import { ProjectRows } from "./ProjectRows.tsx";
import type { ImportDraft } from "./use-import-draft.ts";

type Tab = "projects" | "memories" | "chats" | "role";

/**
 * The preview groups what will be imported by kind, each with where it goes: projects → work
 * folders and Bots, memories → 关于你 or a Bot, chats → a Bot, instructions → a Bot's role.
 */
export function ImportPreview({
  draft,
  preview,
  disabled,
  error,
  cancel,
  start,
}: {
  draft: ImportDraft;
  preview: Preview;
  disabled: boolean;
  error?: ReactNode;
  cancel(): void;
  start?: () => void;
}) {
  const t = useT();
  const { plan } = draft;
  const projectChats = (preview.projects ?? []).reduce((sum, { topics }) => sum + topics, 0);
  const otherChats = preview.topics - projectChats;
  const tabs = plan
    ? [
        ...(preview.projects?.length
          ? [
              {
                value: "projects" as const,
                label: t("conversationImport.tab.projects"),
                count: preview.projects.length,
              },
            ]
          : []),
        ...(plan.memories.length
          ? [
              {
                value: "memories" as const,
                label: t("conversationImport.tab.memories"),
                count: plan.memories.length,
              },
            ]
          : []),
        ...(otherChats > 0
          ? [
              {
                value: "chats" as const,
                label: t("conversationImport.tab.chats"),
                count: preview.topics,
              },
            ]
          : []),
        ...(plan.instructions
          ? [{ value: "role" as const, label: t("conversationImport.tab.role"), count: 1 }]
          : []),
      ]
    : [];
  const [chosen, setTab] = useState<Tab>();
  const tab = tabs.find(({ value }) => value === chosen)?.value ?? tabs[0]?.value;
  const from = preview.from?.slice(0, 10);
  const through = preview.through?.slice(0, 10);
  // The fixture source only exists in tests; it has no tile of its own.
  const source = preview.source === "fixture" ? undefined : preview.source;
  const local = !!source && localSources.has(source);
  return (
    <div className={styles.preview}>
      <div className={styles.strip}>
        <span className={styles.monogram} aria-hidden="true">
          {source ? marks[source] : "?"}
        </span>
        <span className={styles.stripText}>
          <strong>
            {t(local ? "conversationImport.sourceLocal" : "conversationImport.sourceExport", {
              source: t(`conversationImport.source.${preview.source}`),
            })}
          </strong>
          <small>
            {from && through ? `${t("conversationImport.dateRange", { from, through })} · ` : ""}
            {t("conversationImport.readLocally")}
          </small>
        </span>
      </div>
      {!plan ? (
        <p className={styles.intro} role="status">
          {t("conversationImport.loading.plan")}
        </p>
      ) : tabs.length === 0 ? (
        <p className={styles.intro}>{t("conversationImport.empty")}</p>
      ) : (
        <>
          {tabs.length > 1 && (
            <Tabs
              className={styles.tabs}
              label={t("conversationImport.preview")}
              tabs={tabs}
              value={tab ?? "projects"}
              onValueChange={setTab}
            />
          )}
          <div className={styles.panel} role={tabs.length > 1 ? "tabpanel" : undefined}>
            {tab === "projects" && (
              <ProjectRows draft={draft} preview={preview} plan={plan} disabled={disabled} />
            )}
            {tab === "memories" && <MemoryRows draft={draft} plan={plan} disabled={disabled} />}
            {tab === "chats" && (
              <>
                <ChatRows draft={draft} preview={preview} disabled={disabled} />
                <RoleRows draft={draft} plan={plan} disabled={disabled} />
              </>
            )}
            {tab === "role" && <RoleRows draft={draft} plan={plan} disabled={disabled} />}
          </div>
        </>
      )}
      <PreviewNotes preview={preview} />
      {error}
      <footer className={styles.footer}>
        <span className={styles.summary} role="status">
          <Summary draft={draft} preview={preview} />
        </span>
        <Button variant="secondary" onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button disabled={disabled || !start} onClick={start}>
          {t("conversationImport.start")}
        </Button>
      </footer>
    </div>
  );
}

/** "将导入 2 个项目、5 条记忆、186 个对话" with the numbers set in bold. */
function Summary({ draft, preview }: { draft: ImportDraft; preview: Preview }) {
  const t = useT();
  const projects = (preview.projects ?? []).filter(({ key }) => draft.projects[key]?.on);
  const projectChats = (preview.projects ?? []).reduce((sum, { topics }) => sum + topics, 0);
  const chats =
    projects.reduce((sum, { topics }) => sum + topics, 0) +
    (draft.conversations ? preview.topics - projectChats : 0);
  const memories = draft.memories.filter((memory) => draft.memoryOn(memory)).length;
  const parts = [
    ["conversationImport.summary.projects", projects.length],
    ["conversationImport.summary.memories", memories],
    ["conversationImport.summary.chats", chats],
    ["conversationImport.summary.role", draft.persona.on && draft.persona.review ? 1 : 0],
  ] as const;
  const shown = parts.filter(([, count]) => count > 0);
  if (!draft.plan) return null;
  if (!shown.length) return <>{t("conversationImport.summary.nothing")}</>;
  const marker = "\u0001";
  return (
    <>
      {t("conversationImport.summary.lead")}
      {shown.map(([key, count], index) => {
        const [before = "", after = ""] = t(key, { count: marker }).split(marker);
        return (
          <Fragment key={key}>
            {index > 0 && t("conversationImport.summary.separator")}
            {before}
            <strong>{count.toLocaleString()}</strong>
            {after}
          </Fragment>
        );
      })}
    </>
  );
}

function PreviewNotes({ preview }: { preview: Preview }) {
  const t = useT();
  const fields = [
    ["longMessages", preview.longMessages],
    ["skippedRecords", preview.skippedRecords],
    ["skippedAttachments", preview.exportDetails?.skippedAttachments],
    ["skippedFiles", preview.exportDetails?.skippedFiles],
  ] as const;
  const shown = fields.filter(([, count]) => !!count);
  return (
    <div className={styles.notes}>
      {shown.map(([name, count]) => (
        <p key={name}>{t(`conversationImport.${name}`, { count: count ?? 0 })}</p>
      ))}
      <p>{t("conversationImport.dataNote")}</p>
    </div>
  );
}
