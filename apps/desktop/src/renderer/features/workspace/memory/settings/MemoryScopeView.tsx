// Shares the owner-scoped memory list between profile, project and About You views.
import type { MemoryOwner } from "@pibot/protocol";
import { SettingsSection, useSettings } from "@pibot/renderer-kit";
import { Button, IconTile, SegmentedControl } from "@pibot/ui";
import { MemoryMaintenanceNotice } from "../MemoryMaintenanceNotice.tsx";
import { MemoryProposalReview } from "../MemoryProposalReview.tsx";
import { useMemoryMaintenance } from "../use-memory-maintenance.ts";
import { MemoryEditor } from "./MemoryEditor.tsx";
import { MemoryEntry } from "./MemoryEntry.tsx";
import { MemoryPagination } from "./MemoryPagination.tsx";
import { MemoryTransfer } from "./MemoryTransfer.tsx";
import { MemoryUndo } from "./MemoryUndo.tsx";
import styles from "./memory-settings.module.css";
import { useMemoryScope } from "./use-memory-scope.ts";

export function MemoryScopeView({ owner }: { owner: MemoryOwner }) {
  const { t, language } = useSettings();
  const maintenance = useMemoryMaintenance(undefined, owner.scope === "user");
  const {
    peer,
    data,
    state,
    setState,
    itemsCursor,
    proposalsCursor,
    undoCursor,
    loading,
    busy,
    disabled,
    failed,
    operationError,
    clearing,
    setClearing,
    toast,
    adding,
    setAdding,
    showUndo,
    setShowUndo,
    operation,
    change,
    reload,
    setTransferBusy,
  } = useMemoryScope(owner);
  const proposalsBefore = proposalsCursor.before;
  const undoBefore = undoCursor.before;
  const presentation = new Map(data?.presentation?.map((entry) => [entry.id, entry] as const));
  return (
    <div className={styles.list} data-memory-scope={owner.scope} data-memory-owner={owner.ownerId}>
      <div className={styles.lead}>
        {/* The project dialog already says who shares it; the Bot / group line contradicted it. */}
        {owner.scope !== "project" && (
          <p>
            {t(owner.scope === "user" ? "memorySettings.aboutYouLead" : "memorySettings.panelLead")}
            {maintenance &&
              !maintenance.issue &&
              maintenance.lastSavedAt &&
              ` ${t("memorySettings.maintenance.healthy", {
                time: new Date(maintenance.lastSavedAt).toLocaleString(language),
              })}`}
          </p>
        )}
        <Button variant="pill" disabled={disabled} onClick={() => setAdding(true)}>
          {t("memorySettings.add")}
        </Button>
      </div>
      {maintenance?.issue && <MemoryMaintenanceNotice issue={maintenance.issue} />}
      {adding && (
        <MemoryEditor
          busy={disabled}
          cancel={() => setAdding(false)}
          save={(text, category) => change({ action: "import", text, category })}
        />
      )}
      {data?.needsOrganization && <p className={styles.meta}>{t("memorySettings.organize")}</p>}
      {(failed || operationError) && (
        <p className={styles.error} role="alert">
          {t(operationError ?? "memorySettings.failed")}{" "}
          <Button variant="ghost" disabled={loading || disabled} onClick={reload}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {loading && <p role="status">{t("common.loading")}</p>}
      {data && (data.proposals.length > 0 || proposalsBefore) && (
        <SettingsSection
          title={t(owner.scope === "group" ? "group.memoryPending" : "memorySettings.pending")}
          bare
        >
          <div className={styles.list}>
            {data.proposals.map((proposal) => (
              <article className={`${styles.card} ${styles.proposal}`} key={proposal.id}>
                <MemoryProposalReview
                  proposal={proposal}
                  memories={data.items}
                  loading={loading}
                  busy={disabled || loading}
                  retry={reload}
                  showSource
                  resolve={(accept) =>
                    void operation(async (signal) => {
                      if (owner.scope === "group")
                        await peer?.call(
                          "groups.memory.resolve",
                          { groupId: owner.ownerId, proposalId: proposal.id, accept },
                          { signal, timeoutMs: 30_000 },
                        );
                      else
                        await peer?.call(
                          "memory.resolve",
                          { proposalId: proposal.id, accept },
                          { signal, timeoutMs: 30_000 },
                        );
                    })
                  }
                />
                <p className={styles.meta}>
                  {new Date(proposal.createdAt).toLocaleString(language)}
                </p>
              </article>
            ))}
          </div>
          <MemoryPagination
            cursor={proposalsCursor}
            next={data.proposals.length === 50 ? data.proposals.at(-1)?.id : null}
            disabled={disabled || loading}
          />
        </SettingsSection>
      )}
      <section aria-label={t("memorySettings.title")} className={styles.list}>
        {/* Same four categories the editor offers and the chat card names. */}
        {(["about_you", "work", "how_to", "other"] as const).map((category) => {
          const items =
            data?.items.filter((memory) => (memory.category ?? "other") === category) ?? [];
          if (!items.length) return null;
          return (
            <section key={category} className={styles.group}>
              {(category !== "about_you" || owner.scope === "user") && (
                <h2>{t(`workspace.category.${category}`)}</h2>
              )}
              <div className={styles.groupCard}>
                {items.map((memory) => (
                  <MemoryEntry
                    key={memory.id}
                    memory={memory}
                    owner={owner}
                    busy={disabled || loading}
                    change={change}
                    presentation={presentation.get(memory.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {data && !loading && !data.items.length && !adding && (
          <div className={styles.empty}>
            <IconTile icon="star" tone="violet" size="lg" className={styles.emptyMark} />
            <strong>
              {t(
                state === "archived"
                  ? "memorySettings.emptyArchive"
                  : owner.scope === "user"
                    ? "memorySettings.emptyUser"
                    : "memorySettings.empty",
              )}
            </strong>
            {/* The chat hint and 添加 belong to the active list, not to an empty archive. */}
            {state !== "archived" && (
              <>
                <p>{t("memorySettings.emptyGuide")}</p>
                <Button
                  variant="primary"
                  className={`${styles.save} ${styles.toneFill}`}
                  disabled={disabled}
                  onClick={() => setAdding(true)}
                >
                  {t("memorySettings.addOne")}
                </Button>
              </>
            )}
          </div>
        )}
        <MemoryPagination
          cursor={itemsCursor}
          next={data?.items.length === 50 ? data.items.at(-1)?.id : null}
          disabled={disabled || loading}
        />
      </section>
      {showUndo && data && (data.undoable.length > 0 || data.undoNext || undoBefore) && (
        <MemoryUndo
          data={data}
          cursor={undoCursor}
          disabled={disabled || loading}
          undo={(proposalId) => {
            void operation(async (signal) => {
              if (owner.scope === "group")
                await peer?.call(
                  "memory.manage",
                  {
                    scope: owner.scope,
                    ownerId: owner.ownerId,
                    confirmed: true,
                    change: { action: "undo", proposalId },
                  },
                  { signal, timeoutMs: 30_000 },
                );
              else
                await peer?.call(
                  "memory.resolve",
                  { proposalId, accept: false },
                  { signal, timeoutMs: 30_000 },
                );
            });
          }}
        />
      )}
      <div className={styles.footer}>
        {!!data?.archivedCount && (
          <SegmentedControl
            label={t("memorySettings.archiveView")}
            value={state}
            disabled={disabled || loading}
            options={[
              {
                value: "active",
                label: t("memorySettings.activeCount", { count: data.activeCount }),
              },
              {
                value: "archived",
                label: t("memorySettings.archivedCount", { count: data.archivedCount }),
              },
            ]}
            onValueChange={(value) => {
              setState(value === "archived" ? "archived" : "active");
              itemsCursor.reset();
            }}
          />
        )}
        {state === "archived" && !data?.archivedCount && (
          <Button
            variant="ghost"
            onClick={() => {
              setState("active");
              itemsCursor.reset();
            }}
          >
            {t("memorySettings.active")}
          </Button>
        )}
        <MemoryTransfer
          owner={owner}
          busy={busy || !peer}
          changed={reload}
          onBusyChange={setTransferBusy}
        >
          {!!data?.unusedCount && (
            <p className={styles.meta}>
              {t("memorySettings.unusedSummary", { count: data.unusedCount })}
            </p>
          )}
          <Button variant="ghost" disabled={disabled} onClick={() => setShowUndo(!showUndo)}>
            <IconTile icon="undo" tone="teal" size="sm" />
            {t("memorySettings.undoable")}
          </Button>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              setState(state === "all" ? "active" : "all");
              itemsCursor.reset();
            }}
          >
            <IconTile icon="audit" tone="neutral" size="sm" />
            {t(state === "all" ? "memorySettings.active" : "memorySettings.all")}
          </Button>
          <Button
            variant="ghost"
            className={styles.danger}
            disabled={disabled || loading || !data || data.activeCount + data.archivedCount === 0}
            onClick={() => setClearing(data?.revision)}
          >
            <IconTile icon="trash" tone="red" size="sm" />
            {t("memorySettings.clear")}
          </Button>
        </MemoryTransfer>
      </div>
      {clearing !== undefined && (
        <fieldset
          className={`${styles.card} ${styles.confirm}`}
          aria-label={t("memorySettings.clear")}
        >
          <p>{t("memorySettings.clearConfirm")}</p>
          <div className={styles.toolbar}>
            <Button variant="ghost" disabled={disabled} onClick={() => setClearing(undefined)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="pill"
              className={styles.dangerFill}
              disabled={disabled}
              onClick={() => void change({ action: "clear", expectedRevision: clearing })}
            >
              {t("memorySettings.clear")}
            </Button>
          </div>
        </fieldset>
      )}
      {toast && (
        <div className={styles.toast} role="status" data-memory-toast>
          <span>{t("memorySettings.deleted")}</span>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => void change({ action: "undo", proposalId: toast })}
          >
            {t("workspace.undo")}
          </Button>
        </div>
      )}
    </div>
  );
}
