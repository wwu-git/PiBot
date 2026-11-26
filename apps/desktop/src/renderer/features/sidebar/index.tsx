import { activeComputerState, computerStateText, useComputerStates } from "@pibot/computer-use/ui";
import { type MethodResults, RpcError, RpcErrorCodes, type SidebarEntry } from "@pibot/protocol";
import { useAction, useNavigation, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { useRoutineNavigation } from "@pibot/routines/ui";
import { Button, Icon, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { useRuntimeHealth } from "../../app/runtime-health.ts";
import { AppMenu } from "../app-menu/AppMenu.tsx";
import { CommandPauseBanner } from "../runtime/CommandPause.tsx";
import { ForceRelease } from "../runtime/ForceRelease.tsx";
import { updateBot } from "../settings/operations.ts";
import { newChatDialog } from "../workspace/new-chat/new-chat-dialog.ts";
import { AcpConnection } from "./AcpConnection.tsx";
import { ConversationMenu, type MenuAction } from "./ConversationMenu.tsx";
import { ConversationRow } from "./ConversationRow.tsx";
import { navigationError } from "./conversation-navigation.ts";
import { EntryDialog, type EntryDialogTarget } from "./EntryDialog.tsx";
import { NewMenu, type NewMenuAction } from "./NewMenu.tsx";
import { summaryPreview } from "./preview.ts";
import { SearchResults } from "./SearchResults.tsx";
import { SidebarArchive } from "./SidebarArchive.tsx";
import styles from "./sidebar.module.css";
import { useConversationNavigation } from "./use-conversation-navigation.ts";

export function Sidebar() {
  const t = useT();
  const data = useWorkspace();
  const { peer } = useRpc();
  const runtimeHealth = useRuntimeHealth();
  const { view, navigate, openWorkspace, openAudit, showDialog } = useNavigation();
  const { openRoutines } = useRoutineNavigation();
  const task = useAction();
  const [menu, setMenu] = useState<{
    entry: SidebarEntry;
    x: number;
    y: number;
    opener: HTMLElement;
  }>();
  const [dialog, setDialog] = useState<EntryDialogTarget>();
  const [newMenu, setNewMenu] = useState<{ opener: HTMLElement; x: number; y: number }>();
  const chooseNew = (action: NewMenuAction) => {
    if (action === "bot" || action === "group") showDialog(() => newChatDialog(action));
    else if (action === "import") openWorkspace({ name: "team" });
    else setDialog({ kind: "create" });
  };
  const [editing, setEditing] = useState<string>();
  /** A taken Bot name, shown under the rename field that stays open. */
  const [renameError, setRenameError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MethodResults["search.query"]>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchingMore, setSearchingMore] = useState(false);
  const searchedQuery = useRef("");
  const searchRevision = useRef(0);
  const [importRevision, setImportRevision] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    return peer?.on("import.progress", ({ state, removed }) => {
      const hidden = state === "undoing" && removed?.topics === 0 && removed.messages === 0;
      if (!hidden && state !== "completed") return;
      searchRevision.current++;
      setImportRevision((value) => value + 1);
    });
  }, [peer]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: import publication invalidates the current query without changing its text.
  useEffect(() => {
    let active = true;
    const revision = ++searchRevision.current;
    setResults(undefined);
    setSearchError(false);
    setSearchingMore(false);
    setSearching(!!query.trim());
    searchedQuery.current = query.trim();
    if (!peer || !query.trim()) return;
    const timer = setTimeout(() => {
      void peer
        .call("search.query", { query: query.trim(), limit: 50 })
        .then((result) => {
          if (active && revision === searchRevision.current) setResults(result);
        })
        .catch(() => {
          if (active && revision === searchRevision.current) setSearchError(true);
        })
        .finally(() => {
          if (active && revision === searchRevision.current) setSearching(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [peer, query, importRevision]);
  // Older message matches arrive page by page; a page for a query the user has since changed is dropped.
  const searchOlder = () => {
    const cursor = results?.nextCursor;
    if (!peer || !cursor || searchingMore) return;
    const asked = searchedQuery.current;
    const revision = searchRevision.current;
    setSearchingMore(true);
    void peer
      .call("search.query", { query: asked, limit: 50, cursor })
      .then((page) => {
        if (revision !== searchRevision.current) return;
        setResults((current) => {
          if (!current) return current;
          const seen = new Set(current.messages.map((message) => message.id));
          const owners = new Set((current.conversations ?? []).map((owner) => owner.id));
          return {
            ...current,
            messages: [...current.messages, ...page.messages.filter((m) => !seen.has(m.id))],
            conversations: [
              ...(current.conversations ?? []),
              ...(page.conversations ?? []).filter((owner) => !owners.has(owner.id)),
            ],
            nextCursor: page.nextCursor ?? null,
          };
        });
      })
      .catch(() => {
        if (revision === searchRevision.current) setSearchError(true);
      })
      .finally(() => {
        if (revision === searchRevision.current) setSearchingMore(false);
      });
  };
  const computerStates = useComputerStates();
  const conversations = useConversationNavigation(query, task);
  const { open, openMessage } = conversations;
  const choose = (entry: SidebarEntry, action: MenuAction) => {
    if (!peer) return;
    if (action === "move" || action === "delete") {
      setDialog({ kind: action, entry });
      return;
    }
    if (action === "profile") {
      openWorkspace({ name: "profile", botId: entry.conversationKey.slice(3) });
      return;
    }
    if (action === "rename") {
      setRenameError(undefined);
      setEditing(entry.conversationKey);
      return;
    }
    void task.run(async () => {
      if (action === "copy") {
        const conversationId = data.summaries[entry.conversationKey]?.conversationId;
        if (!conversationId) {
          setNotice(t("workspace.copyMissing"));
          return;
        }
        await navigator.clipboard.writeText(conversationId);
        setNotice(t("workspace.copied"));
        return;
      }
      await peer.call("sidebar.update", {
        conversationKey: entry.conversationKey,
        ...(action === "pin"
          ? { pinnedAt: entry.pinnedAt ? null : new Date().toISOString() }
          : action === "read"
            ? { unread: !entry.unread }
            : { hiddenAt: new Date().toISOString() }),
      });
      await data.refresh();
    });
  };
  const renderEntry = (entry: SidebarEntry) => {
    const [kind, id] = entry.conversationKey.split(":");
    const bot = data.bots.find((b) => b.id === id),
      group = data.groups.find((g) => g.id === id);
    if (!bot && !group) return null;
    const summary = data.summaries[entry.conversationKey];
    const statuses = Object.values(data.statuses).filter((s) =>
      kind === "group" ? s.groupId === id : s.botId === id && !s.groupId,
    );
    const needs =
      entry.waitingForPlan ||
      data.inbox.some((item) =>
        kind === "group"
          ? item.kind === "approval" &&
            (item.conversationId === group?.conversationId ||
              statuses.some(
                (s) =>
                  s.runId === item.approval.runId &&
                  s.botId === item.approval.botId &&
                  s.conversationId === item.conversationId,
              ))
          : item.kind === "approval"
            ? item.approval.botId === id && item.conversationKind === "dm"
            : item.kind === "memory" && item.proposal.botId === id,
      );
    const status = needs
      ? "waiting"
      : statuses.some((s) => s.state === "running")
        ? "running"
        : statuses.some((s) => s.state === "queued")
          ? "queued"
          : undefined;
    return (
      <ConversationRow
        key={entry.conversationKey}
        entry={entry}
        bot={bot}
        group={group}
        members={data.bots}
        time={summary?.updatedAt ?? bot?.updatedAt ?? group?.updatedAt}
        pinned={!!entry.pinnedAt}
        selected={
          view.name === "chat" &&
          (kind === "group"
            ? view.groupId === id
            : !view.groupId && (view.botId === id || (!view.botId && bot?.isMain === true)))
        }
        preview={
          id &&
          (kind === "group" ? data.uncertainGroups.includes(id) : data.uncertainBots?.includes(id))
            ? t(data.detailsLoading ? "group.loadingRunPreview" : "group.partialRuns")
            : summary
              ? summaryPreview(summary, t)
              : (bot?.description ?? group?.announcement ?? "")
        }
        failed={summary?.failed}
        status={status}
        activity={(() => {
          const computer =
            kind !== "group" && id ? activeComputerState(computerStates.get(id)) : undefined;
          return computer && computerStateText(computer, t);
        })()}
        busy={task.busy}
        editing={editing === entry.conversationKey}
        renameError={editing === entry.conversationKey ? renameError : undefined}
        open={() => open(entry.conversationKey)}
        menu={(position) => setMenu({ entry, ...position })}
        stopEditing={() => {
          setRenameError(undefined);
          setEditing(undefined);
        }}
        rename={async (value) => {
          if (!peer) return;
          setRenameError(undefined);
          const result = await task.run(async () => {
            if (kind === "group")
              return peer.call("groups.update", { groupId: id as string, name: value });
            try {
              return await updateBot(peer, { botId: id as string, name: value });
            } catch (error) {
              if (error instanceof RpcError && error.code === RpcErrorCodes.botNameTaken)
                return "name_taken" as const;
              throw error;
            }
          });
          if (result === "name_taken") {
            setRenameError(t("workspace.nameTaken", { name: value }));
            return;
          }
          if (result) {
            setEditing(undefined);
            void data.refresh();
          }
        }}
      />
    );
  };
  const regular = data.entries.filter((e) => !e.pinnedAt);
  return (
    <nav className={styles.sidebar} aria-label={t("sidebar.chats")}>
      <div className={styles.titlebar}>
        <div className={styles.topActions}>
          <Button
            variant="ghost"
            aria-label={t("workspace.new")}
            title={t("workspace.new")}
            aria-haspopup="menu"
            aria-expanded={!!newMenu}
            aria-controls={newMenu ? "sidebar-new-menu" : undefined}
            data-new-menu-trigger
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setNewMenu(
                newMenu
                  ? undefined
                  : { opener: event.currentTarget, x: rect.left, y: rect.bottom + 6 },
              );
            }}
          >
            <Icon name="plus" />
          </Button>
        </div>
      </div>
      {runtimeHealth.reason === "interactive_drain_failed" && (
        <div role="alert" className={styles.health}>
          <IconTile icon="warning" tone="red" size="sm" />
          <span>{t("runtime.drainFailedGlobal")}</span>
          <ForceRelease />
        </div>
      )}
      <CommandPauseBanner className={styles.health} />
      <div className={styles.search}>
        <Icon name="search" size={15} className={styles.searchIcon} />
        <input
          ref={search}
          aria-label={t("workspace.search")}
          placeholder={t("common.search")}
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <div className={styles.shortcuts}>
        <Button
          variant="ghost"
          className={styles.shortcut}
          data-tone="amber"
          data-empty={!data.inboxCount || undefined}
          title={t("workspace.inbox")}
          aria-label={`${t("workspace.inbox")} · ${data.inboxCount}`}
          aria-current={view.name === "inbox" ? "page" : undefined}
          onClick={() => openWorkspace({ name: "inbox" })}
        >
          <span className={styles.pendingDot} />
          <span className={styles.shortcutLabel}>{t("workspace.inboxShort")}</span>
          <span className={styles.count}>{data.inboxCount}</span>
        </Button>
        <Button
          variant="ghost"
          className={styles.shortcut}
          data-tone="orange"
          title={t("activity.routines")}
          aria-label={t("activity.routines")}
          data-routines-trigger
          aria-current={view.name === "routines" ? "page" : undefined}
          onClick={() => openRoutines()}
        >
          <Icon name="clock" size={14} />
          <span className={styles.shortcutLabel}>{t("workspace.routinesShort")}</span>
        </Button>
        <Button
          variant="ghost"
          className={styles.shortcut}
          data-tone="teal"
          data-audit-trigger
          aria-current={view.name === "audit" ? "page" : undefined}
          title={t("audit.title")}
          aria-label={t("audit.title")}
          onClick={() => openAudit()}
        >
          <Icon name="audit" size={14} />
          <span className={styles.shortcutLabel}>{t("workspace.auditShort")}</span>
        </Button>
      </div>
      <div className={styles.scroll}>
        {!query.trim() && !data.loading && !data.entries.length && !data.error && (
          <p className={styles.empty}>{t("workspace.empty")}</p>
        )}
        {data.loading && (
          <p role="status" className={styles.empty}>
            {t("common.loading")}
          </p>
        )}
        {query.trim() ? (
          <SearchResults
            query={query.trim()}
            results={results}
            searching={searching}
            error={searchError}
            searchingMore={searchingMore}
            searchOlder={searchOlder}
            busy={task.busy}
            open={open}
            openMessage={openMessage}
          />
        ) : (
          <>
            {/* WeChat-style pinning: pinned chats are ordinary rows at the top of the same list. */}
            {data.entries.some((e) => e.pinnedAt) && (
              <div className={styles.pinnedBlock}>
                {data.entries.filter((e) => e.pinnedAt).map(renderEntry)}
              </div>
            )}
            {regular
              .filter((e) => !e.groupId || !data.sections.some((s) => s.id === e.groupId))
              .map(renderEntry)}
            {data.sections.map((section) => (
              <section key={section.id} className={styles.section}>
                <div className={styles.sectionHeading}>
                  <Button
                    variant="ghost"
                    aria-expanded={!section.collapsed}
                    disabled={task.busy}
                    onClick={() => {
                      if (peer)
                        void task.run(async () => {
                          await peer.call("sidebar.groups.update", {
                            id: section.id,
                            collapsed: !section.collapsed,
                          });
                          await data.refresh();
                        });
                    }}
                  >
                    <Icon
                      name="chevron"
                      size={13}
                      className={styles.sectionChevron}
                      style={{ transform: section.collapsed ? "rotate(-90deg)" : undefined }}
                    />
                    <span className={styles.sectionName}>{section.name}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    className={styles.sectionSettings}
                    aria-label={`${section.name} · ${t("workspace.sectionMenu")}`}
                    title={`${section.name} · ${t("workspace.sectionMenu")}`}
                    onClick={() => setDialog({ kind: "section", section })}
                  >
                    <Icon name="more" size={16} />
                  </Button>
                </div>
                {!section.collapsed &&
                  regular.filter((e) => e.groupId === section.id).map(renderEntry)}
              </section>
            ))}
            {data.hasMoreSections && (
              <Button variant="ghost" onClick={() => void data.moreSections()}>
                {t("workspace.more")}
              </Button>
            )}
            {data.hasMore && (
              <Button variant="ghost" onClick={() => void data.more()}>
                {t("workspace.more")}
              </Button>
            )}
          </>
        )}
        {!query.trim() && <SidebarArchive />}
        {data.error && (
          <p role="alert" className={styles.danger}>
            {t("workspace.sidebarLoadFailed")}{" "}
            <Button variant="ghost" disabled={data.refreshing} onClick={() => void data.refresh()}>
              {t("common.retry")}
            </Button>
          </p>
        )}
        {data.detailsError && (
          <p role="alert" className={styles.danger}>
            {t("workspace.sidebarDetailsFailed")}{" "}
            <Button variant="ghost" disabled={data.refreshing} onClick={() => void data.refresh()}>
              {t("common.retry")}
            </Button>
          </p>
        )}
        {conversations.slow && (
          <p role="status" className={styles.note}>
            {t("workspace.sidebarOpening")}
          </p>
        )}
        {conversations.error && (
          <p role="alert" className={styles.danger}>
            {t(conversations.error)}{" "}
            <Button variant="ghost" onClick={conversations.retry}>
              {t("common.retry")}
            </Button>
          </p>
        )}
        {task.error && !navigationError(task.error) && (
          <p role="alert" className={styles.danger}>
            {t(task.error)}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {data.unavailable && <p className={styles.note}>{t("workspace.unavailable")}</p>}
      </div>
      <div className={styles.footer}>
        <AcpConnection />
        <div className={styles.footerActions}>
          <AppMenu />
          <Button
            variant="secondary"
            className={styles.connect}
            data-connectors-trigger
            aria-current={view.name === "connectors" ? "page" : undefined}
            onClick={() => navigate({ name: "connectors" })}
          >
            <IconTile icon="link" tone="blue" size="lg" />
            <span className={styles.connectText}>
              <span className={styles.connectTitle}>{t("workspace.connectApps")}</span>
              <span className={styles.connectHint}>{t("workspace.connectHint")}</span>
            </span>
            <Icon name="chevronRight" size={14} className={styles.connectChevron} />
          </Button>
        </div>
      </div>
      {menu && (
        <ConversationMenu
          {...menu}
          main={data.bots.find((b) => `dm:${b.id}` === menu.entry.conversationKey)?.isMain ?? false}
          group={menu.entry.conversationKey.startsWith("group:")}
          close={() => setMenu(undefined)}
          choose={(action) => choose(menu.entry, action)}
        />
      )}
      {newMenu && <NewMenu {...newMenu} close={() => setNewMenu(undefined)} choose={chooseNew} />}
      {dialog && (
        <EntryDialog key={dialog.kind} target={dialog} close={() => setDialog(undefined)} />
      )}
    </nav>
  );
}
