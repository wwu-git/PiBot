import { CategorySchema, isPiManagerCategory, type TeamPreview as Preview } from "@pibot/protocol";
import { avatarColors, avatarEyes, avatarShapes, useRpc, useT } from "@pibot/renderer-kit";
import { Avatar, Button, IconTile } from "@pibot/ui";
import { useState } from "react";
import { TeamSourceSkill } from "./TeamSourceSkill.tsx";
import styles from "./teams.module.css";

type PreviewFile = NonNullable<Preview["files"]>[number];
type Category = (typeof CategorySchema.options)[number];

/** One supporting file; a text file can be opened exactly as it would be saved. */
function FileRow({ preview, file }: { preview: Preview; file: PreviewFile }) {
  const t = useT();
  const { peer } = useRpc();
  const [text, setText] = useState<string | null>();
  const [open, setOpen] = useState(false);
  const show = () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (text !== undefined || !peer) return;
    void peer
      .call("teams.previewFile", {
        previewId: preview.previewId,
        ref: file.ref,
        skill: file.skill,
        path: file.path,
      })
      .then((result) => setText(result.text))
      .catch(() => setText(null));
  };
  return (
    <li>
      <span className={styles.file}>
        {file.path} · {file.bytes.toLocaleString()} B
      </span>
      {file.text ? (
        <Button variant="ghost" disabled={!peer} onClick={show}>
          {t(open ? "teams.hide" : "teams.view")}
        </Button>
      ) : (
        <span className={styles.note}> · {t("teams.binary")}</span>
      )}
      {open && text !== undefined && <pre className={styles.code}>{text ?? t("teams.binary")}</pre>}
    </li>
  );
}

export function TeamPreview({ preview }: { preview: Preview }) {
  const t = useT();
  const mapping = new Map(preview.models.map((model) => [model.ref, model]));
  const names = new Map(preview.template.bots.map((bot) => [bot.ref, bot.name]));
  const files = preview.files ?? [];
  const scripts = files.filter((file) => file.script);
  const categories = (list: Category[]) =>
    list
      .map((category) => t(`permissions.category.${category}`))
      .join(t("skills.message.paramSeparator"));
  return (
    <div className={styles.preview}>
      <p className={styles.warn}>
        <IconTile icon="warning" tone="amber" size="sm" />
        {t("teams.untrusted")}
      </p>
      <p className={styles.note}>{t("teams.review")}</p>
      <p className={styles.note}>{t("teams.permissions")}</p>
      {!!preview.permissionNotes?.length && (
        <div className={`${styles.card} ${styles.notesCard}`}>
          <p className={styles.note}>{t("teams.permissionNotes")}</p>
          <ul className={styles.list}>
            {preview.permissionNotes.flatMap((note) => {
              const bot = names.get(note.ref) ?? note.ref;
              return [
                ...(note.lowered.length
                  ? [t("teams.lowered", { bot, categories: categories(note.lowered) })]
                  : []),
                ...(note.relaxed.length
                  ? [t("teams.relaxed", { bot, categories: categories(note.relaxed) })]
                  : []),
                ...(note.network ? [t("teams.networkDropped", { bot })] : []),
              ].map((line) => <li key={line}>{line}</li>);
            })}
          </ul>
        </div>
      )}
      <h2 className={styles.heading}>
        {t("teams.count", {
          bots: preview.template.bots.length,
          groups: preview.template.groups.length,
        })}
      </h2>
      {preview.template.bots.map((bot) => {
        const model = mapping.get(bot.ref);
        const botFiles = files.filter((file) => file.ref === bot.ref);
        return (
          <section key={bot.ref} className={styles.card}>
            <div className={styles.botHeading}>
              <Avatar
                size={32}
                label={bot.name}
                shape={avatarShapes.find((v) => v === bot.avatarShape) ?? "blob"}
                color={avatarColors.find((v) => v === bot.avatarColor) ?? "violet"}
                eyes={avatarEyes.find((v) => v === bot.avatarEyes) ?? "marks"}
              />
              <h3 className={styles.heading}>{bot.name}</h3>
            </div>
            {bot.role && (
              <p className={styles.note}>
                {t("builtin.profile.role", {
                  name: bot.role.name ?? bot.role.id,
                  version: bot.role.version,
                })}
              </p>
            )}
            <p className={styles.text}>{bot.description || t("teams.noDescription")}</p>
            {!!bot.skills?.length && (
              <p className={styles.text}>
                {t("skills.teamPreview", {
                  count: bot.skills.length,
                  names: bot.skills
                    .map((skill) => ("name" in skill ? skill.name : skill.folder))
                    .join(t("skills.message.paramSeparator")),
                })}
              </p>
            )}
            <div className={styles.mapping}>
              <div>
                {t("teams.preferred")}:{" "}
                {bot.model ? `${bot.model.provider} / ${bot.model.id}` : t("teams.noPreference")}
                {" · "}
                {t("workspace.thinking")}: {t(`models.thinking.${bot.thinkingLevel}`)}
              </div>
              <div>
                {t("teams.resolved")}:{" "}
                {model?.resolved
                  ? `${model.resolved.provider} / ${model.resolved.id}`
                  : t("teams.noModel")}
                {" · "}
                {t("workspace.thinking")}: {t(`models.thinking.${model?.thinkingLevel ?? "off"}`)}
              </div>
              {!model?.available && (
                <p className={styles.note}>
                  {t(model?.resolved ? "teams.fallback" : "teams.noModelNote")}
                </p>
              )}
            </div>
            <div className={styles.mapping}>
              {CategorySchema.options
                .filter((category) => !isPiManagerCategory(category))
                .map((category) => (
                  <div key={category}>
                    {t(`permissions.category.${category}`)}:{" "}
                    {bot.permissionOverrides[category] === undefined
                      ? t("workspace.inherit")
                      : t(`permissions.level.${bot.permissionOverrides[category]}`)}
                  </div>
                ))}
            </div>
            <h4 className={styles.heading}>{t("workspace.persona")}</h4>
            <div className={styles.persona}>{bot.systemPrompt || t("teams.emptyPersona")}</div>
            {bot.norms && (
              <>
                <h4 className={styles.heading}>{t("teams.norms")}</h4>
                <div className={styles.persona}>{bot.norms}</div>
              </>
            )}
            {bot.skills?.map((skill) =>
              "reimport" in skill ? (
                <TeamSourceSkill key={skill.folder} skill={skill} />
              ) : "body" in skill ? (
                <details key={skill.name}>
                  <summary>{skill.name} · SKILL.md</summary>
                  <div className={styles.persona}>{skill.body}</div>
                </details>
              ) : null,
            )}
            {!!botFiles.length && (
              <>
                <h4 className={styles.heading}>{t("teams.files", { count: botFiles.length })}</h4>
                <ul className={styles.list}>
                  {botFiles.map((file) => (
                    <FileRow key={`${file.skill}/${file.path}`} preview={preview} file={file} />
                  ))}
                </ul>
              </>
            )}
          </section>
        );
      })}
      {!!scripts.length && (
        <section className={styles.card}>
          <h3 className={styles.heading}>{t("teams.scripts", { count: scripts.length })}</h3>
          <ul className={styles.list}>
            {scripts.map((file) => (
              <li key={`${file.ref}/${file.skill}/${file.path}`}>
                {names.get(file.ref) ?? file.ref} · {file.skill} · {file.path}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!preview.skippedFiles && (
        <p className={styles.note}>{t("teams.skippedFiles", { count: preview.skippedFiles })}</p>
      )}
      {preview.template.groups.map((group, index) => (
        // Template snapshots are immutable throughout this preview, including duplicate group names.
        // biome-ignore lint/suspicious/noArrayIndexKey: the array never changes within this snapshot.
        <section key={`${index}:${group.name}`} className={styles.card}>
          <div className={styles.groupHeading}>
            <IconTile icon="users" tone="teal" />
            <h3 className={styles.heading}>{group.name}</h3>
          </div>
          <div>
            {t("teams.members")}: {group.members.map((id) => names.get(id) ?? id).join(" · ")}
          </div>
          <div>
            {t("workspace.coordinator")}: {names.get(group.coordinator) ?? group.coordinator}
          </div>
          <div>{t("teams.rounds", { count: group.autoRoundLimit })}</div>
          <p className={styles.text}>{group.announcement || t("teams.noAnnouncement")}</p>
        </section>
      ))}
    </div>
  );
}
