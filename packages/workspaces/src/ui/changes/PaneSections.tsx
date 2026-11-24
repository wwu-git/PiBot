import { useRpc, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { ReactNode } from "react";
import { GitInstallCard } from "../git/GitInstallCard.tsx";
import styles from "./changes.module.css";
import { formatCount } from "./diff/FileList.tsx";
import { CommitBox } from "./history/CommitBox.tsx";
import { FileCheckpoints, useCheckpointSelection } from "./history/FileCheckpoints.tsx";
import { commitTime, shortOid } from "./history/History.tsx";
import { ChangesIcon } from "./icons.tsx";
import { ListPanel } from "./ListPanel.tsx";
import { CommentsBar, Empty, Notice, Skeleton } from "./PaneParts.tsx";
import type { ChangesPaneModel } from "./use-changes-pane.ts";

/** The "N files, folders collapsed" note appears for large change sets. */
const MANY_FILES = 200;

export function ScopeList({ model }: { model: ChangesPaneModel }) {
  const { peer } = useRpc(),
    workspace = useWorkspace();
  const content = <ScopeFiles model={model} />;
  if (model.scope !== "turn" || model.readonlyRoot || !peer || !model.turn.data) return content;
  const pending = Object.values(workspace.statuses).some(
    (status) => status.runId === model.turn.runId && status.state !== "idle",
  );
  return (
    <FileCheckpoints
      key={JSON.stringify([model.target, model.turn.runId])}
      api={peer}
      target={model.target}
      runId={model.turn.runId}
      botId={model.turn.data.botId}
      capture={model.turn.data.checkpoint}
      pending={pending}
      hasFiles={model.turn.files.length > 0}
      paths={model.turn.files.map((file) => file.key)}
      restoredCount={model.turn.data.restoredCount ?? 0}
      running={model.running || model.busy || !!model.turn.error}
    >
      {model.turn.error && (
        <p role="alert">
          {model.t("changes.turn.error")}{" "}
          <Button onClick={model.turn.retry}>{model.t("common.retry")}</Button>
        </p>
      )}
      {content}
    </FileCheckpoints>
  );
}

function ScopeFiles({ model }: { model: ChangesPaneModel }) {
  const { t, scope, status } = model;
  const { language } = useSettings();
  const checkpoint = useCheckpointSelection();
  let header: ReactNode = null;
  if (scope === "history" && model.commit) {
    const commit = model.commit;
    header = (
      <div className={styles.commitHeader}>
        <button
          type="button"
          className={styles.iconGhost}
          aria-label={t("changes.history.back")}
          title={t("changes.history.back")}
          onClick={() => model.setCommit(undefined)}
        >
          <ChangesIcon name="back" />
        </button>
        <div>
          <b>
            <span className={styles.mono}>{shortOid(commit.oid)}</span> {commit.subject}
          </b>
          <span>
            {commit.author} · {commitTime(commit.time, language)} · {t("changes.history.viewOnly")}
          </span>
        </div>
      </div>
    );
  }
  const loading =
    scope === "uncommitted"
      ? model.state.partial && !model.state.capped && model.files.length < (status?.total ?? 0)
      : scope === "turn"
        ? !model.readonlyRoot && model.turn.loading && !model.turn.data
        : scope === "history" && model.commitFiles.loading;
  if (loading)
    return (
      <>
        {header}
        <Skeleton slow={false} />
      </>
    );
  if (scope === "turn" && model.readonlyRoot) {
    const primary = status?.roots.find((root) => root.role === "primary");
    return (
      <Empty title={t("changes.empty.turnReadonly")} icon="key" tone="teal">
        <span>
          {t("changes.empty.turnReadonlyBody", {
            folder: status?.root.name ?? "",
            name: model.botName,
            primary: primary?.name ?? "",
          })}
        </span>
        <Button variant="secondary" onClick={() => model.viewPrimaryTurn()}>
          {t("changes.empty.turnPrimary")}
        </Button>
      </Empty>
    );
  }
  if (scope === "turn" && model.turn.error && !model.turn.data)
    return (
      <Empty title={t("changes.turn.error")} icon="warning" tone="red">
        <Button onClick={model.turn.retry}>{t("common.retry")}</Button>
      </Empty>
    );
  if (!model.files.length) {
    if (scope === "turn" && checkpoint?.allRestored)
      return <Empty title={t("checkpoint.allRestored")} icon="undo" tone="blue" />;
    if (scope === "uncommitted")
      return (
        <Empty title={t("changes.empty.clean")}>
          {status?.git.state === "repo" && status.git.head && (
            <span>{t("changes.empty.head", { oid: shortOid(status.git.head) })}</span>
          )}
          <Button variant="secondary" onClick={() => model.setScope("history")}>
            {t("changes.empty.history")}
          </Button>
          <span className={styles.footNote}>{t("changes.empty.pillNote")}</span>
        </Empty>
      );
    if (scope === "turn")
      return model.repo ? (
        <Empty title={t("changes.empty.turn", { name: model.botName })} icon="eye" tone="blue" />
      ) : (
        <Empty title={t("changes.empty.turn", { name: model.botName })} icon="folder" tone="violet">
          {status?.git.state === "none" && status.git.reason === "not_repo" && (
            <>
              <span>{t("changes.empty.notRepo", { folder: status.root.name })}</span>
              <Button
                variant="secondary"
                disabled={model.busy}
                onClick={() => void model.sendText(t("changes.empty.initMessage"), "changes.sent")}
              >
                {t("changes.empty.init", { name: model.botName })}
              </Button>
            </>
          )}
        </Empty>
      );
    return (
      <>
        {header}
        <Empty title={t("changes.history.noFiles")} icon="file" tone="blue" />
      </>
    );
  }
  const list = (
    <ListPanel
      files={model.files}
      rows={model.rows}
      matched={model.matched}
      query={model.query}
      setQuery={model.setQuery}
      tree={model.tree}
      setTree={model.setTree}
      selected={model.selected}
      editable={model.editable}
      excluded={model.excluded}
      comments={model.commentCounts}
      findings={model.reviews.rows}
      actions={{
        ...model.listActions,
        revealSource: (file) =>
          model.scope === "turn" && model.turn.runId
            ? { runId: model.turn.runId, path: file.key }
            : { target: model.target, path: file.display },
      }}
    />
  );
  return (
    <>
      {header}
      {list}
    </>
  );
}

export function Notices({ model }: { model: ChangesPaneModel }) {
  const { t, status, scope, git } = model;
  if (!status) return null;
  const items: ReactNode[] = [];
  if (model.state.error)
    items.push(
      <Notice key="refresh" tone="warn">
        <span>{t(model.state.error)}</span>
        <button type="button" className={styles.miniAccent} onClick={() => model.source?.refresh()}>
          {t("common.retry")}
        </button>
      </Notice>,
    );
  if (git?.state === "none" && git.reason === "git_unavailable")
    // macOS and Linux offer the system install here; elsewhere the download link stays.
    items.push(
      <GitInstallCard
        key="git"
        context="changes"
        onInstalled={() => model.source?.refresh()}
        fallback={
          scope === "turn" && (
            <Notice tone="info">
              <span>{t("changes.repo.noGitBody")}</span>
              <a
                className={styles.link}
                href="https://git-scm.com/downloads"
                target="_blank"
                rel="noreferrer"
              >
                {t("changes.repo.installGit")}
              </a>
            </Notice>
          )
        }
      />,
    );
  if (scope === "uncommitted" && git?.state === "repo") {
    if (git.operation) {
      const conflicts = model.files.filter((file) => file.tag === "C").length;
      items.push(
        <Notice key="operation" tone="warn">
          <span>
            {/* English strings carry their own trailing space; Chinese sentences join directly. */}
            {t(`changes.operation.${git.operation}`)}
            {conflicts > 0 && t("changes.operation.conflicts", { count: conflicts })}
            {t("changes.operation.viewOnly")}
          </span>
        </Notice>,
      );
    }
    if (git.subdirectory)
      items.push(
        <Notice key="sub" tone="info">
          <span>{t("changes.repo.subdirectory", { path: git.subdirectory })}</span>
        </Notice>,
      );
    else if (status.root.role === "readonly")
      items.push(
        <Notice key="readonly" tone="info">
          <span>{t("changes.readonly.root")}</span>
        </Notice>,
      );
    if (status.overflow)
      items.push(
        <Notice key="overflow" tone="warn">
          <span>{t("changes.list.overflow")}</span>
        </Notice>,
      );
    else if (status.total > MANY_FILES)
      items.push(
        <Notice key="many" tone="info">
          <span>
            {t("changes.list.many", {
              count: formatCount(status.total),
              generated: formatCount(model.files.filter((file) => file.generated).length),
              name: model.botName,
            })}
          </span>
        </Notice>,
      );
    if (model.state.capped)
      items.push(
        <Notice key="partial" tone="info">
          <span>{t("changes.list.partial", { count: formatCount(model.files.length) })}</span>
        </Notice>,
      );
  }
  if (scope === "turn" && model.files.length)
    items.push(
      <Notice key="turn" tone={model.repo ? "accent" : "info"}>
        <span>
          {t(
            git?.state === "none" && git.reason === "not_repo"
              ? "changes.turn.noteNotRepo"
              : "changes.turn.note",
            {
              name: model.botName,
              count: model.turn.data?.total ?? model.files.length,
            },
          )}
          {model.turn.data?.truncated &&
            ` ${t("changes.turn.truncated", { count: model.files.length })}`}
        </span>
      </Notice>,
    );
  return <>{items.length ? <div className={styles.notices}>{items}</div> : null}</>;
}

export function Footer({ model }: { model: ChangesPaneModel }) {
  const { t, scope, git, status } = model;
  const commentBar = (model.comments.length > 0 || model.reviews.open.length > 0) &&
    scope !== "history" && (
      <CommentsBar
        count={model.comments.length}
        findings={model.reviews.open.length}
        botName={model.botName}
        sending={model.busy}
        clear={() => {
          model.updateComments(() => []);
          model.setEditing(undefined);
        }}
        send={() => void model.sendComments()}
      />
    );
  const notice = model.notice && (
    <>
      <p
        className={model.notice.error ? styles.errorText : styles.okText}
        role={model.notice.error ? "alert" : "status"}
      >
        {t(model.notice.key, { name: model.botName })}
      </p>
      {model.notice.key === "changes.error.changes_git_unavailable" && (
        <GitInstallCard context="changes" onInstalled={() => model.source?.refresh()} />
      )}
    </>
  );
  const toast = model.committed && scope === "uncommitted" && (
    <div className={styles.toast} role="status">
      <span>
        {t("changes.commit.done")}{" "}
        <span className={styles.mono}>{shortOid(model.committed.oid)}</span> ·{" "}
        {model.committed.subject}
      </span>
      <button
        type="button"
        className={styles.miniGhost}
        onClick={() => {
          model.setCommitted(undefined);
          model.setScope("history");
        }}
      >
        {t("changes.commit.view")}
      </button>
    </div>
  );
  let commit: ReactNode = null;
  if (scope === "uncommitted" && git?.state === "repo" && status) {
    const conflicted = git.operation !== null;
    if (model.editable && model.files.length)
      commit = (
        <CommitBox
          botName={model.botName}
          selected={model.files.length - model.excluded.size}
          total={model.files.length}
          authorMissing={!status.author}
          writesIsolated={git.writesIsolated}
          draft={model.draft}
          commit={model.commitNow}
        />
      );
    else if (model.files.length)
      commit = (
        <div className={styles.readonlyFoot}>
          <span>
            {model.running
              ? t("changes.readonly.running", { name: model.runningName })
              : t(`changes.readonly.${git.readOnlyReason ?? "view"}`)}
          </span>
          {conflicted && !model.running && (
            <Button
              className={styles.smallPrimary}
              disabled={model.busy}
              onClick={() => void model.sendText(t("changes.operation.message"), "changes.sent")}
            >
              {t("changes.operation.ask", { name: model.botName })}
            </Button>
          )}
        </div>
      );
  }
  if (!commentBar && !notice && !toast && !commit) return null;
  return (
    <footer className={styles.footer}>
      {commentBar}
      {notice}
      {toast}
      {commit}
    </footer>
  );
}
