import type {
  BringOverResult,
  BuiltinApp,
  Connector,
  PluginInstallation,
  PluginSummary,
} from "@pibot/plugins-contract/full";
import {
  hostPlatform,
  type Peer,
  useNavigation,
  useRpc,
  useRpcEvent,
  useSettings,
  useWorkspace,
} from "@pibot/renderer-kit";
import { Button, Chip, Icon, PageHeading, pageTone, Tabs } from "@pibot/ui";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppSetup } from "../setup/AppSetup.tsx";
import { CustomMcp } from "../setup/CustomMcp.tsx";
import { ImportPlugin } from "../setup/ImportPlugin.tsx";
import { UninstallPlugin } from "../setup/UninstallPlugin.tsx";
import { useConnectorOperations } from "../shell/operations.ts";
import { useConnectorPage, useConnectorRead } from "../shell/remote.ts";
import { ConnectorDetails } from "./ConnectorDetails.tsx";
import { ConnectorFeedback } from "./ConnectorFeedback.tsx";
import { ConnectorPanel } from "./ConnectorPanel.tsx";
import { runsOutsideSandbox } from "./connection-state.ts";
import { type AddChoice, AddMenu } from "./connections/AddMenu.tsx";
import {
  BringBar,
  BringOverDialog,
  BringOverSummary,
  EmptyState,
  type ListKind,
} from "./connections/BringOver.tsx";
import { ConnectionPanel, needsKey } from "./connections/ConnectionPanel.tsx";
import styles from "./connections/connections.module.css";
import { Faces, letterTone, monogram, resolveAccess } from "./connections/Faces.tsx";
import { localText } from "./connections/local-text.ts";
import { SkillImportDialog } from "./connections/SkillImport.tsx";
import { SkillsTab } from "./connections/SkillsTab.tsx";
import { TokensDialog, type TokensSlot } from "./connections/TokensDialog.tsx";
import { offeredIn, useDiscovery } from "./connections/use-discovery.ts";
import {
  type SkillEditorSlot,
  type SkillExtrasSlot,
  type SkillWriterSlot,
  WriteSkillPanel,
} from "./connections/WriteSkillPanel.tsx";
import { knowledgeError } from "./knowledge/errors.ts";
import { type KnowledgeAddRequest, KnowledgeTab } from "./knowledge/KnowledgeTab.tsx";

type Tab = "apps" | ListKind | "knowledge";
// Plugins are packages, not a separate permission kind: their MCP servers remain under MCP and
// their skills under 技能. Complete imported packages also get an app card below so a user can
// find and manage a service made by 小匠 without knowing that it is backed by MCP.
// Knowledge sources are connections too, but they are read-only mounts, hence their own tab.
const TABS: readonly Tab[] = ["apps", "mcp", "skills", "knowledge"];
const TAB_KEY = "pibot.connections.tab";

function rememberedTab(): Tab {
  try {
    const value = localStorage.getItem(TAB_KEY);
    if (value === "plugins") return "mcp";
    return TABS.includes(value as Tab) ? (value as Tab) : "apps";
  } catch {
    // Storage can be unavailable (private profile); the first tab is the documented default.
    return "apps";
  }
}

function Row({
  name,
  description,
  open,
  right,
  status,
  card,
  who,
}: {
  name: string;
  description: ReactNode;
  open?(): void;
  right: ReactNode;
  /** A status chip shown inline beside the name. */
  status?: ReactNode;
  /** Apps tab: a card in a grid with a 谁能用 strip at the bottom. */
  card?: boolean;
  /** The right side is the faces that can use it, so the strip gets its label. */
  who?: boolean;
}) {
  const { t } = useSettings();
  const content = (
    <>
      <span className={styles.icon} data-tone={letterTone(name)} aria-hidden="true">
        {monogram(name)}
      </span>
      <span className={styles.rowText}>
        <b>{name}</b>
        <div>{description}</div>
      </span>
    </>
  );
  const opener = open ? (
    <button type="button" className={styles.rowOpen} onClick={open}>
      {content}
    </button>
  ) : (
    <span className={styles.rowOpen}>{content}</span>
  );
  if (card)
    return (
      <div className={styles.appCard}>
        <div className={styles.cardTop}>
          {opener}
          {status}
        </div>
        <div className={styles.cardFoot}>
          {who && <span className={styles.who}>{t("connections.panel.who")}</span>}
          {right}
        </div>
      </div>
    );
  return (
    <div className={styles.row}>
      {opener}
      {status}
      {right}
    </div>
  );
}

function connectorTone(connector: Connector) {
  if (connector.status === "error") return "danger" as const;
  if (connector.status === "needs_auth" || connector.status === "needs_setup")
    return "warn" as const;
  if (connector.status === "ready" || connector.status === "idle") return "ok" as const;
  return "neutral" as const;
}

/**
 * What the Bots can use on this computer — apps, plugins, MCP and skills —
 * with one thing on the right of each row: the faces that can use it when all is well, or the
 * single action that is needed. Other AI tools' items are brought over from the strip or the
 * empty state; there is no online catalog. Keys moved to the footer.
 */
export function ConnectorsPage({
  secrets,
  skillWriter,
  skillEditor,
  skillExtras,
}: {
  secrets: TokensSlot;
  skillWriter: SkillWriterSlot;
  skillEditor: SkillEditorSlot;
  skillExtras: SkillExtrasSlot;
}) {
  const { t, language } = useSettings();
  const navigation = useNavigation();
  const workspace = useWorkspace();
  const link = navigation.view.connection;
  const skillLink = navigation.view.skillConnection;
  const closeSkillLink = () => navigation.navigate({ name: "connectors" });
  const { peer } = useRpc();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus({ preventScroll: true });
    return () => {
      const target =
        opener instanceof HTMLElement && opener.isConnected
          ? opener
          : document.querySelector<HTMLElement>("[data-connectors-trigger]");
      target?.focus({ preventScroll: true });
    };
  }, []);
  const [selectedTab, setTabState] = useState<Tab>(() => (skillLink ? "skills" : rememberedTab()));
  const tab = skillLink ? "skills" : selectedTab;
  const setTab = (next: Tab) => {
    if (skillLink) closeSkillLink();
    setTabState(next);
    // A details panel belongs to the tab it was opened from (second-Mac test).
    setPanel(undefined);
    setRemovedName(undefined);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Remembering the tab is a convenience only.
    }
  };
  const [showSecrets, setShowSecrets] = useState(false);
  const [snapshot, setSnapshot] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const changed = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setSnapshot((v) => v + 1);
    }, 150);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useRpcEvent("plugins.changed", changed);
  useRpcEvent("connectors.changed", changed);
  useRpcEvent("connectors.toolsChanged", changed);
  useRpcEvent("skills.changed", changed);
  useRpcEvent("groups.changed", changed);
  useRpcEvent("knowledge.changed", changed);
  const operations = useConnectorOperations(changed);
  const apps = useConnectorRead(
    useCallback((peer: Peer, signal: AbortSignal) => peer.call("apps.list", {}, { signal }), []),
  );
  // One read per list. A single failing list (a broken skills catalog was enough) used
  // to blank every tab, and the retry it offered could never succeed.
  // Each read depends on `snapshot`: adding or removing an installation, MCP server or skill bumps
  // it, and without the dependency the lists and tab counts kept showing the state from first load.
  const summariesRead = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a changed snapshot still re-reads the list, even though the call itself only sends a limit.
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        peer.call("plugins.available", { limit: 100 }, { signal }),
      [snapshot],
    ),
  );
  const installationsRead = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a changed snapshot still re-reads the list, even though the call itself only sends a limit.
    useCallback(
      (peer: Peer, signal: AbortSignal) => peer.call("plugins.list", { limit: 100 }, { signal }),
      [snapshot],
    ),
  );
  const connectorsRead = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a changed snapshot still re-reads the list, even though the call itself only sends a limit.
    useCallback(
      (peer: Peer, signal: AbortSignal) => peer.call("connectors.list", { limit: 100 }, { signal }),
      [snapshot],
    ),
  );
  // Only the count is needed for the tab, so one row is enough (the result carries the total).
  const skillCountRead = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a changed snapshot still re-reads the count, even though the call itself only sends a limit.
    useCallback(
      (peer: Peer, signal: AbortSignal) => peer.call("skills.catalog", { limit: 1 }, { signal }),
      [snapshot],
    ),
  );
  const discovery = useDiscovery(changed);
  // The knowledge tab owns its own list: it has its own codes and its own empty state, and the
  // page only needs the count for the tab label. Paged like every other list, so a person with
  // more than one page of sources still sees all of them instead of a silent cut at 100.
  const knowledge = useConnectorPage(
    useCallback(async (peer: Peer, signal: AbortSignal, cursor?: string) => {
      // The RPC names its cursor `before` (`knowledge.list`); the page helper wants `nextCursor`.
      const page = await peer.call("knowledge.list", { before: cursor, limit: 100 }, { signal });
      return { items: page.items, nextCursor: page.nextBefore };
    }, []),
    snapshot,
    true,
    knowledgeError,
  );
  // What this computer already has. Asked only while the Knowledge tab is open (the same
  // "look only when asked" rule as reading another agent's skills) and re-read with the page, so a
  // vault just added stops being offered.
  const knowledgeTab = tab === "knowledge";
  const detected = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a changed snapshot still re-reads what is added, even though the call itself only sends nothing.
    useCallback(
      async (peer: Peer, signal: AbortSignal) =>
        knowledgeTab ? await peer.call("knowledge.detect", {}, { signal }) : undefined,
      [knowledgeTab, snapshot],
    ),
    knowledgeError,
  );
  const [adding, setAdding] = useState<BuiltinApp>();
  const [importing, setImporting] = useState<{ text: string }>();
  const [customMcp, setCustomMcp] = useState(false);
  const [writingSkill, setWritingSkill] = useState(false);
  // The link dialog is its own step; a link lands in the same preview as a picked folder.
  const [linking, setLinking] = useState(false);
  const [knowledgeAdd, setKnowledgeAdd] = useState<KnowledgeAddRequest>();
  const [bringing, setBringing] = useState<{ tab?: "mcp" | "skills" }>();
  const [results, setResults] = useState<BringOverResult[]>();
  const [manage, setManage] = useState<string | undefined>(link?.connectorId);
  const [panel, setPanel] = useState<string>();
  // The summary row vanishes as soon as removal lands, so the name shown while the panel is open
  // is captured when it opens rather than looked up live (it fell back to 「扩展」 otherwise).
  const [uninstalling, setUninstalling] = useState<{
    installation: PluginInstallation;
    name?: string;
    skillCount?: number;
  }>();
  const [removedName, setRemovedName] = useState<string>();
  // A brief confirmation, not a lasting notice (maintainers 2026-10-31): it fades on its own.
  useEffect(() => {
    if (!removedName) return;
    const timer = setTimeout(() => setRemovedName(undefined), 4000);
    return () => clearTimeout(timer);
  }, [removedName]);
  useEffect(() => {
    if (link?.connectorId) setManage(link.connectorId);
    else if (link && apps.value) setAdding(apps.value.items.find((app) => app.id === link.id));
  }, [link, apps.value]);
  const appItems = apps.value?.items ?? [];
  const summaries = summariesRead.value?.items ?? [];
  const connectors = connectorsRead.value?.items ?? [];
  const installations = installationsRead.value?.items ?? [];
  const bots = workspace.bots.filter((bot) => !bot.archivedAt);
  const groups = workspace.groups.filter((group) => !group.archivedAt);
  const transitional =
    connectors.some((row) => row.status === "starting" || row.status === "stopping") ||
    installations.some((row) => row.status === "removing");
  useEffect(() => {
    if (!peer || !transitional) return;
    const poll = setInterval(changed, 5_000);
    return () => clearInterval(poll);
  }, [peer, transitional, changed]);
  const byKind = (kind: "json" | "directory") =>
    summaries.filter((summary) => summary.sourceKind === kind);
  const connectorsOf = (installationId: string) =>
    connectors.filter((connector) => connector.pluginInstallationId === installationId);
  // Application packages are shown as app cards; ordinary imported packages remain MCP/skills.
  const mcpItems = [
    ...byKind("json"),
    ...byKind("directory").filter(
      (summary) => !summary.application && connectorsOf(summary.installationId).length > 0,
    ),
  ];
  const pluginAppItems = byKind("directory").filter(
    (summary) => summary.application && connectorsOf(summary.installationId).length > 0,
  );
  const skillPackages = byKind("directory").filter(
    (summary) => !summary.application && !connectorsOf(summary.installationId).length,
  );
  const counts: Record<Tab, number | undefined> = {
    apps: apps.value ? appItems.length + pluginAppItems.length : undefined,
    plugins: undefined,
    mcp: summariesRead.value ? mcpItems.length : undefined,
    skills: skillCountRead.value?.total,
    // Only a fully loaded list is a truthful count; while pages remain the tab shows no number
    // rather than the size of the first page.
    knowledge: knowledge.value && !knowledge.next ? knowledge.value.items.length : undefined,
  };
  // A package with one connection opens that connection's drawer directly; one with several (or
  // only skills) opens the package panel that lists them.
  const openInstallation = (installationId: string) => {
    const rows = connectorsOf(installationId);
    if (rows.length === 1 && rows[0]) setManage(rows[0].id);
    else setPanel(installationId);
  };
  const startUninstall = (summary: PluginSummary) => {
    const installation = installations.find((row) => row.id === summary.installationId);
    setPanel(undefined);
    setManage(undefined);
    setRemovedName(undefined);
    if (installation)
      setUninstalling({
        installation,
        name: localText(summary.name[language], language),
        skillCount: summary.skillCount,
      });
  };
  const access = (installationId: string) =>
    summaries.find((summary) => summary.installationId === installationId)?.access;
  const choose = (choice: AddChoice) => {
    if (choice === "bringOver") setBringing({});
    else if (choice === "mcp") setCustomMcp(true);
    else if (choice === "plugin") setImporting({ text: "" });
    else if (choice === "link") setLinking(true);
    else if (choice === "skill") setWritingSkill(true);
    else {
      // Adding a source opens its own tab, which owns the folder dialog and the detail panel.
      setTab("knowledge");
      setKnowledgeAdd({ kind: choice, at: Date.now() });
    }
  };
  const faces = (installationId: string) => {
    const value = access(installationId);
    if (!value) return undefined;
    const resolved = resolveAccess(value, bots, groups);
    return resolved.bots.length || resolved.groups.length ? (
      <Faces bots={resolved.bots} groups={resolved.groups} />
    ) : undefined;
  };
  // A skills-only plugin has no connection access; who has its skills is who got a copy.
  const skillFaces = (targets: PluginSummary["skillTargets"]) => {
    if (!targets) return undefined;
    const resolved = resolveAccess({ mode: "selected", ...targets }, bots, groups);
    return resolved.bots.length || resolved.groups.length ? (
      <Faces bots={resolved.bots} groups={resolved.groups} />
    ) : undefined;
  };
  const appRow = (app: BuiltinApp) => {
    const connector = connectors.find((row) => row.appId === app.id);
    const connected = !!connector && (connector.enabled || connector.status === "stopping");
    const right = !app.supported ? (
      <span className={styles.note}>{t("connectors.appUnsupported")}</span>
    ) : connected && connector && needsKey(connector) ? (
      <Button variant="secondary" onClick={() => setManage(connector.id)}>
        {t("connections.action.check")}
      </Button>
    ) : connected && connector ? (
      (faces(connector.pluginInstallationId) ?? (
        <Button variant="secondary" onClick={() => setManage(connector.id)}>
          {t("connections.action.give")}
        </Button>
      ))
    ) : (
      <Button variant="secondary" disabled={!peer} onClick={() => setAdding(app)}>
        {t("connections.action.connect")}
      </Button>
    );
    const shownFaces =
      connected && connector && !needsKey(connector)
        ? faces(connector.pluginInstallationId)
        : undefined;
    return (
      <Row
        key={app.id}
        card
        who={!!shownFaces}
        status={
          connected && connector ? (
            <Chip tone={connectorTone(connector)}>
              {t(`connectors.status.${connector.status}`)}
            </Chip>
          ) : undefined
        }
        name={app.name[language]}
        description={app.description[language]}
        open={
          connected && connector
            ? () => setManage(connector.id)
            : app.supported
              ? () => setAdding(app)
              : undefined
        }
        right={right}
      />
    );
  };
  const pluginAppRow = (summary: PluginSummary) => {
    const rows = connectorsOf(summary.installationId);
    const missing = rows.find(needsKey);
    const failed = rows.find((connector) => connector.status === "error");
    const outside = rows.some((connector) => runsOutsideSandbox(connector, hostPlatform()));
    const supported =
      summary.applicationPlatforms.length === 0 ||
      summary.applicationPlatforms.includes(hostPlatform() as "darwin" | "win32" | "linux");
    const right = missing ? (
      <Button variant="secondary" onClick={() => setManage(missing.id)}>
        {t("connections.action.addKey")}
      </Button>
    ) : failed ? (
      <Button variant="secondary" onClick={() => setManage(failed.id)}>
        {t("connections.action.check")}
      </Button>
    ) : !supported ? (
      <span className={styles.note}>{t("connectors.appUnsupported")}</span>
    ) : (
      (faces(summary.installationId) ?? (
        <Button variant="secondary" onClick={() => openInstallation(summary.installationId)}>
          {t("connections.action.give")}
        </Button>
      ))
    );
    const active = rows.find((connector) => connector.enabled || connector.status === "stopping");
    return (
      <Row
        key={`plugin-app:${summary.installationId}`}
        card
        who={!!faces(summary.installationId)}
        status={
          outside ? (
            <Chip tone="warn">{t("connectors.outsideSandbox.badge")}</Chip>
          ) : active ? (
            <Chip tone={connectorTone(active)}>{t(`connectors.status.${active.status}`)}</Chip>
          ) : undefined
        }
        name={localText(summary.name[language], language)}
        description={[
          t("connections.fromPackage"),
          localText(summary.description[language], language),
        ]
          .filter(Boolean)
          .join(" · ")}
        open={() => openInstallation(summary.installationId)}
        right={right}
      />
    );
  };
  const installationRow = (summary: PluginSummary) => {
    const rows = connectorsOf(summary.installationId);
    const missing = rows.find(needsKey);
    const failed = rows.find((connector) => connector.status === "error");
    const open = () => openInstallation(summary.installationId);
    const right = missing ? (
      <Button variant="secondary" onClick={() => setManage(missing.id)}>
        {t("connections.action.addKey")}
      </Button>
    ) : failed ? (
      <Button variant="secondary" onClick={() => setManage(failed.id)}>
        {t("connections.action.check")}
      </Button>
    ) : (
      ((rows.length ? faces(summary.installationId) : skillFaces(summary.skillTargets)) ?? (
        <Button variant="secondary" onClick={open}>
          {t("connections.action.give")}
        </Button>
      ))
    );
    const name = localText(summary.name[language], language);
    const description = localText(summary.description[language], language);
    const outside = rows.some((connector) => runsOutsideSandbox(connector, hostPlatform()));
    return (
      <Row
        key={summary.installationId}
        name={name}
        status={
          outside ? <Chip tone="warn">{t("connectors.outsideSandbox.badge")}</Chip> : undefined
        }
        description={
          summary.sourceKind === "directory"
            ? [t("connections.fromPackage"), description].filter(Boolean).join(" · ")
            : description
        }
        open={open}
        right={right}
      />
    );
  };
  const listTab = (kind: "mcp") => {
    const items = mcpItems;
    // Plugin packages that carry servers are offered here; skill-only ones in the 技能 tab.
    const found = discovery.rows().filter((row) => offeredIn(row, "mcp"));
    if (summariesRead.value && !items.length)
      return (
        <EmptyState
          kind={kind}
          discovery={discovery}
          open={() => setBringing({ tab: "mcp" })}
          addYourself={() => choose("mcp")}
        />
      );
    return (
      <>
        <BringBar kind={kind} rows={found} open={() => setBringing({ tab: "mcp" })} />
        <div className={styles.rows}>{items.map(installationRow)}</div>
      </>
    );
  };
  // Each tab reports only the reads it needs, so one broken list cannot hide the rest.
  const tabReads =
    tab === "apps"
      ? [apps]
      : tab === "skills"
        ? [skillCountRead, summariesRead, installationsRead, connectorsRead]
        : tab === "mcp"
          ? [summariesRead, installationsRead, connectorsRead]
          : [];
  const tabError = tabReads.find((read) => read.error)?.error;
  const tabLoading = tabReads.some((read) => read.loading);
  const reloadTab = () => {
    for (const read of tabReads) read.refresh();
  };
  // A change event re-reads the list and its value is undefined until the new page lands. Dropping
  // the panel then unmounted it, and remounting called showModal again, which put it on top of an
  // open connection's settings: after turning a connection on, its start error sat hidden behind
  // the overview (Linux acceptance 2026-11-15). Keep the open panel's last row while re-reading.
  const lastPanelSummary = useRef<(typeof summaries)[number] | undefined>(undefined);
  const foundPanelSummary = summaries.find((summary) => summary.installationId === panel);
  if (foundPanelSummary || summariesRead.value) lastPanelSummary.current = foundPanelSummary;
  const panelSummary =
    foundPanelSummary ??
    (lastPanelSummary.current?.installationId === panel ? lastPanelSummary.current : undefined);
  // Removing a connection from its drawer removes the package it came from (not built-in apps).
  const manageInstallation = connectors.find((row) => row.id === manage)?.pluginInstallationId;
  const manageSummary = summaries.find(
    (summary) => summary.installationId === manageInstallation && summary.sourceKind !== "builtin",
  );
  const uninstallTarget =
    installations.find((row) => row.id === uninstalling?.installation.id) ??
    uninstalling?.installation;
  return (
    <main className={styles.page} style={pageTone("blue")}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <PageHeading icon="link" tone="blue" ref={heading} tabIndex={-1}>
            {t("connectors.title")}
          </PageHeading>
          <p>{t("connections.subtitle")}</p>
        </div>
        {/* Tokens sit beside 添加 and open as a dialog (maintainers 2026-10-31). */}
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={() => setShowSecrets(true)}>
            <Icon name="key" size={14} />
            {t("connections.tokens.title")}
          </Button>
          <AddMenu
            choose={choose}
            disabled={!peer}
            notionInstalled={
              knowledgeTab &&
              (detected.value?.notion.installed ?? false) &&
              !(knowledge.value?.items ?? []).some((source) => source.kind === "notion")
            }
          />
        </div>
      </header>
      {showSecrets && <TokensDialog secrets={secrets} close={() => setShowSecrets(false)} />}
      <Tabs
        className={styles.tabs}
        label={t("connectors.title")}
        value={tab}
        onValueChange={setTab}
        tabs={TABS.map((value) => ({
          value,
          label: t(`connections.tab.${value}`),
          count: counts[value],
        }))}
      />
      <div className={styles.scroll}>
        <div className={styles.body} role="tabpanel">
          {results && <BringOverSummary results={results} rows={discovery.rows()} />}
          {removedName && (
            <p role="status" className={styles.note}>
              {t("connectors.removedNamed", { name: removedName })}
            </p>
          )}
          <ConnectorFeedback loading={tabLoading} error={tabError} retry={reloadTab} />
          {tab === "apps" && (
            <div className={styles.cards}>
              {appItems.map(appRow)}
              {pluginAppItems.map(pluginAppRow)}
            </div>
          )}
          {tab === "mcp" && listTab("mcp")}
          {tab === "skills" && (
            <SkillsTab
              snapshot={snapshot}
              editor={skillEditor}
              extras={skillExtras}
              bar={
                <BringBar
                  kind="skills"
                  rows={discovery.rows().filter((row) => offeredIn(row, "skills"))}
                  open={() => setBringing({ tab: "skills" })}
                />
              }
              empty={
                <EmptyState
                  kind="skills"
                  discovery={discovery}
                  open={() => setBringing({ tab: "skills" })}
                  addYourself={() => choose("skill")}
                />
              }
            />
          )}
          {tab === "skills" && skillPackages.length > 0 && (
            <div className={styles.rows}>
              <p className={styles.note}>{t("connections.skillPackages")}</p>
              {skillPackages.map(installationRow)}
            </div>
          )}
          {tab === "knowledge" && (
            <KnowledgeTab
              sources={knowledge.value?.items ?? []}
              loading={knowledge.loading}
              error={knowledge.error}
              retry={knowledge.refresh}
              snapshot={snapshot}
              changed={changed}
              more={knowledge.next}
              request={knowledgeAdd}
              // Maintainers 2026-11-13: a kept request was replayed on every visit to this tab, so a
              // connected Notion re-ran its add and opened its panel; it is used once.
              requestHandled={() => setKnowledgeAdd(undefined)}
              bots={bots}
              groups={groups}
              detection={detected.value}
              detecting={detected.loading}
            />
          )}
          <div className={styles.foot}>
            {tab === "apps" && <p className={styles.note}>{t("connections.appsFoot")}</p>}
          </div>
        </div>
      </div>
      {skillLink && (
        <ConnectorPanel
          key={JSON.stringify([skillLink.groupId, skillLink.botId, skillLink.skillId])}
          title={skillLink.name}
          close={closeSkillLink}
        >
          {skillExtras(skillLink)}
        </ConnectorPanel>
      )}
      {adding && (
        <AppSetup
          app={adding}
          close={() => setAdding(undefined)}
          changed={changed}
          connected={(connector: Connector) => {
            setAdding(undefined);
            setManage(connector.id);
            changed();
          }}
        />
      )}
      {customMcp && (
        <CustomMcp
          close={() => setCustomMcp(false)}
          preview={(text) => {
            setCustomMcp(false);
            setImporting({ text });
          }}
        />
      )}
      {importing && (
        <ImportPlugin
          initialText={importing.text}
          close={() => setImporting(undefined)}
          changed={changed}
          connected={(connectorId) => {
            setImporting(undefined);
            setManage(connectorId);
          }}
        />
      )}
      {writingSkill && (
        <WriteSkillPanel writer={skillWriter} bots={bots} close={() => setWritingSkill(false)} />
      )}
      {linking && (
        <SkillImportDialog bots={bots} close={() => setLinking(false)} imported={changed} />
      )}
      {bringing && (
        <BringOverDialog
          tab={bringing.tab}
          discovery={discovery}
          bots={bots}
          close={() => setBringing(undefined)}
          done={(value) => {
            setResults(value);
            setBringing(undefined);
          }}
        />
      )}
      {panelSummary && (
        <ConnectionPanel
          key={panelSummary.installationId}
          summary={panelSummary}
          connectors={connectorsOf(panelSummary.installationId)}
          snapshot={snapshot}
          operations={operations}
          changed={changed}
          manage={(id) => setManage(id)}
          remove={() => startUninstall(panelSummary)}
          close={() => setPanel(undefined)}
        />
      )}
      {manage && (
        <ConnectorDetails
          key={manage}
          id={manage}
          initialSection={link?.section}
          requestedTarget={link?.target}
          apps={appItems}
          snapshot={snapshot}
          operations={operations}
          remove={manageSummary && (() => startUninstall(manageSummary))}
          changed={changed}
          close={() => setManage(undefined)}
        />
      )}
      {uninstalling && uninstallTarget && (
        <UninstallPlugin
          key={uninstallTarget.id}
          installation={uninstallTarget}
          name={uninstalling.name}
          skillCount={uninstalling.skillCount}
          apps={appItems}
          snapshot={snapshot}
          operations={operations}
          changed={changed}
          done={() => {
            setRemovedName(uninstalling.name ?? t("connectors.pluginFallback"));
            setUninstalling(undefined);
            changed();
          }}
          close={() => setUninstalling(undefined)}
        />
      )}
    </main>
  );
}
