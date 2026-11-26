import { SettingsRow, SettingsSection, useT } from "@pibot/renderer-kit";
import { Button, Icon, Switch } from "@pibot/ui";
import styles from "./conversation-import.module.css";
import { DestinationChip, FolderChip } from "./DestinationMenus.tsx";
import { type Plan, type Preview, type ProjectChoice, sameFolder } from "./import-state.ts";
import type { ImportDraft } from "./use-import-draft.ts";

type Project = NonNullable<Preview["projects"]>[number];

/** Unnamed ChatGPT projects are numbered in the order the export lists them. */
export function projectName(project: Project, preview: Preview, t: ReturnType<typeof useT>) {
  if (project.name) return project.name;
  const index = (preview.projects ?? []).filter(({ name }) => !name).indexOf(project) + 1;
  return t(
    preview.source === "chatgpt"
      ? "conversationImport.unnamedProject"
      : "conversationImport.unnamedProjectOther",
    { n: index },
  );
}

export function ProjectRows({
  draft,
  preview,
  plan,
  disabled,
}: {
  draft: ImportDraft;
  preview: Preview;
  plan: Plan;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <SettingsSection
      title={t("conversationImport.tab.projects")}
      action={<span className={styles.hint}>{t("conversationImport.projectsHint")}</span>}
    >
      {(preview.projects ?? []).map((project) => {
        const choice = draft.projects[project.key];
        if (!choice) return null;
        const name = projectName(project, preview, t);
        const note = [
          project.topics ? t("conversationImport.projectChats", { count: project.topics }) : "",
          project.knowledge
            ? t("conversationImport.projectKnowledge", { count: project.knowledge })
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={project.key} className={styles.item} data-off={!choice.on || undefined}>
            <SettingsRow
              icon="folder"
              tone={choice.on ? "orange" : "neutral"}
              label={<span dir="auto">{name}</span>}
              note={note}
            >
              <Switch
                label={t("conversationImport.includeProject", { name })}
                checked={choice.on}
                disabled={disabled}
                onCheckedChange={(on) => draft.setProject(project.key, { on })}
              />
            </SettingsRow>
            {choice.on && (
              <div className={styles.dest}>
                <span className={styles.meta}>{t("conversationImport.into")}</span>
                <FolderChip
                  value={choice.folder}
                  plan={plan}
                  target={plan.projects.find(({ key }) => key === project.key)}
                  disabled={disabled}
                  onChange={(folder) => draft.setProject(project.key, { folder })}
                  onPick={() => draft.pickFolder(project.key)}
                />
                <span className={styles.meta}>{t("conversationImport.to")}</span>
                <DestinationChip
                  value={choice.botId}
                  bots={draft.bots}
                  label={t("conversationImport.projectBot", { name })}
                  disabled={disabled}
                  onChange={(botId) => draft.setProject(project.key, { botId })}
                />
                {project.knowledge > 0 && (
                  <>
                    <span className={styles.break} />
                    <AgentsLine
                      choice={choice}
                      toggle={() => draft.setProject(project.key, { open: !choice.open })}
                    />
                  </>
                )}
              </div>
            )}
            {choice.on && choice.open && choice.diff && (
              <DiffPanel
                choice={choice}
                confirm={() => draft.setProject(project.key, { confirmed: true, open: false })}
              />
            )}
          </div>
        );
      })}
    </SettingsSection>
  );
}

function current(choice: ProjectChoice) {
  return choice.diff && choice.diffFor && sameFolder(choice.diffFor, choice.folder)
    ? choice.diff
    : undefined;
}

function AgentsLine({ choice, toggle }: { choice: ProjectChoice; toggle(): void }) {
  const t = useT();
  const diff = current(choice);
  if (choice.folder.kind === "home")
    return <span className={styles.meta}>{t("conversationImport.agentsNeedsFolder")}</span>;
  if (!diff)
    return (
      <span className={styles.meta} role="status">
        {t(
          choice.diffFailed
            ? "conversationImport.agentsFailed"
            : "conversationImport.agentsChecking",
        )}
      </span>
    );
  const created = !!diff.create;
  return (
    <>
      <span className={styles.meta}>
        {created
          ? t("conversationImport.agentsNew")
          : t("conversationImport.agentsAppend", { count: diff.lines })}
      </span>
      {choice.confirmed && (
        <span className={styles.confirmed}>
          <Icon name="check" size={13} />
          {t("conversationImport.agentsConfirmed")}
        </span>
      )}
      <button type="button" className={styles.link} aria-expanded={choice.open} onClick={toggle}>
        {t(
          choice.open
            ? "conversationImport.hideDiff"
            : created
              ? "conversationImport.viewContent"
              : "conversationImport.viewChanges",
        )}
      </button>
    </>
  );
}

function DiffPanel({ choice, confirm }: { choice: ProjectChoice; confirm(): void }) {
  const t = useT();
  const diff = current(choice);
  if (!diff) return null;
  const body = diff.diff
    .split("\n")
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "))
    .map((line) => (line.startsWith("+") ? `+ ${line.slice(1)}` : line))
    .join("\n");
  return (
    <section className={styles.diff} aria-label={t("conversationImport.projectDiff")}>
      <p className={styles.diffPath} dir="auto">
        {diff.path}
        {diff.create ? ` · ${t(`conversationImport.create.${diff.create}`)}` : ""}
      </p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the diff. */}
      <pre tabIndex={0}>{body}</pre>
      <div className={styles.diffFoot}>
        <span>{t("conversationImport.writeLogged")}</span>
        <Button disabled={choice.confirmed} onClick={confirm}>
          {t("conversationImport.confirmWrite")}
        </Button>
      </div>
    </section>
  );
}
