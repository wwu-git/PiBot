import { en, zh } from "@pibot/i18n";
import { useNavigation, useRpc, useSettings, useT, useWorkspace } from "@pibot/renderer-kit";
import { RoutineOverlay, routineTarget } from "@pibot/routines/ui";
import { TeamOverlays } from "@pibot/teams/ui";
import { Card, Logo, ThemeProvider } from "@pibot/ui";
import { RestoreRequestProvider } from "@pibot/workspaces/ui";
import { lazy, Suspense, useEffect, useState } from "react";
import { pickStartupLabels } from "../../shared/startup-labels.ts";
import type { StartupSnapshot } from "../../shared/startup-snapshot.ts";
import { AboutYouDialog } from "../features/app-menu/AboutYouDialog.tsx";
import { AppDialog } from "../features/app-menu/AppDialog.tsx";
import { AboutPanel } from "../features/app-menu/AppPanels.tsx";
import { ProviderImportDialog } from "../features/app-menu/ProviderImportDialog.tsx";
import { UpdateNotice, UpdatesPanel } from "../features/app-menu/UpdatesPanel.tsx";
import { UpdatesProvider } from "../features/app-menu/updates.tsx";
import { ComposerDraftProvider } from "../features/chat/composer/composer-drafts.tsx";
import { ChatScreen } from "../features/chat/index.tsx";
import { TaskInputProvider } from "../features/execution/task-inputs.tsx";
import { WelcomeFlow } from "../features/welcome/index.tsx";
import { WorkspaceProvider } from "../features/workspace/data.tsx";
import { ProjectMemoryDialog } from "../features/workspace/memory/project/ProjectMemory.tsx";
import { NewChatDialogs } from "../features/workspace/new-chat/NewChatDialogs.tsx";
import { newChatDialog } from "../features/workspace/new-chat/new-chat-dialog.ts";
import styles from "../page.module.css";
import { BrowserPorts } from "./browser-ports.tsx";
import { ConnectorsPorts } from "./connectors-ports.tsx";
import { NavigationProvider } from "./navigation.tsx";
import { RoutinesPorts } from "./routines-ports.tsx";
import { RpcProvider } from "./rpc.tsx";
import { SettingsProvider } from "./settings.tsx";
import { SkillsPorts } from "./skills-ports.tsx";
import { StartupCapture } from "./startup-capture.tsx";
import { useStartupCover } from "./startup-cover.ts";
import { StartupDisplayProvider, useStartupDisplay } from "./startup-display.tsx";
import { CachedStartupScreen } from "./startup-screen.tsx";
import { TeamsPorts } from "./teams-ports.tsx";
import { WorkspacesPorts } from "./workspaces-ports.tsx";

// The live tree already loaded the full tables; the cached cover reads the same strings.
const startupLabels = { zh: pickStartupLabels(zh), en: pickStartupLabels(en) };

// These surfaces are opened after the first screen. Keeping them out of the initial module graph
// lets the cached/live chat paint while their chunks remain available on first use.
const SettingsScreen = lazy(() =>
  import("../features/settings/index.tsx").then((m) => ({ default: m.SettingsScreen })),
);

/** Shown until the brain is ready and settings are loaded, and when the brain fails. */
function BrainStatusScreen() {
  const { state } = useRpc();
  const t = useT();
  return (
    <main className={styles.page}>
      <Card className={styles.card}>
        <Logo size={72} />
        <h1>{t("app.name")}</h1>
        <p role="status">{t(`brain.${state}`)}</p>
      </Card>
    </main>
  );
}

function Routes() {
  const { state, peer, navigation, consumeNavigation } = useRpc();
  const { settings, update, t } = useSettings();
  const {
    settingsOverlay,
    dialog,
    view,
    closeSettings,
    openSettings,
    openBotPanel,
    openWorkspace,
    navigate,
    showDialog,
  } = useNavigation();
  const [appPanel, setAppPanel] = useState<"about" | "updates">();
  const [navigationFailed, setNavigationFailed] = useState(false);
  const workspace = useWorkspace();
  const display = useStartupDisplay();
  // Only a successful first screen counts toward the startup timing; a failed read still ends
  // the cached cover (useStartupCover) but must not be logged as a fast success.
  const screenReady =
    state === "ready" &&
    !!settings &&
    !workspace.error &&
    (!settings.onboardingCompleted || !workspace.loading) &&
    (view.name !== "chat" || !display?.snapshot?.conversation || display.historySettled);
  const covering = useStartupCover({
    connected: state === "ready" || !!peer,
    settled:
      !!settings || !workspace.loading || !!display?.historySettled || !!display?.readSettled,
    failed: workspace.error || workspace.detailsError || state === "failed",
    leftChat: view.name !== "chat" || !!settingsOverlay || !!dialog || !!appPanel || !!navigation,
  });
  useEffect(() => {
    if (!screenReady) return;
    // Effects follow the committed tree; timers also run while the window is hidden.
    const timer = setTimeout(() => window.postMessage("pibot:first-screen-ready", "*"), 0);
    return () => clearTimeout(timer);
  }, [screenReady]);
  useEffect(() => {
    if (state !== "ready" || settings?.onboardingCompleted === undefined || !navigation) return;
    if (
      !settings.onboardingCompleted &&
      !("view" in navigation && navigation.view === "provider-import")
    )
      return;
    const owner = new AbortController();
    setNavigationFailed(false);
    if ("view" in navigation) {
      // Tray / menu-bar entries. "New chat" starts a fresh topic with the main Bot, the same as
      // the chat header's new-topic button; without a main Bot it opens "New Bot".
      closeSettings();
      if (navigation.view === "inbox") openWorkspace({ name: "inbox" });
      else if (navigation.view === "settings") openSettings("general");
      else if (navigation.view === "about" || navigation.view === "updates")
        setAppPanel(navigation.view);
      else if (navigation.view === "provider-import") {
        setAppPanel(undefined);
        showDialog(() => ({
          owner: "provider-import",
          key: crypto.randomUUID(),
          state: navigation.preview,
        }));
      } else if (navigation.view === "role-import")
        showDialog(() =>
          newChatDialog(navigation.kind === "group" ? "group" : "bot", {
            kind: navigation.kind,
            id: navigation.id,
            version: navigation.version,
          }),
        );
      else if (navigation.view === "group")
        // The live island: a busy group, opened on the task thread the step runs in.
        navigate({
          name: "chat",
          groupId: navigation.groupId,
          ...(navigation.threadId ? { threadId: navigation.threadId } : {}),
        });
      else if ("botId" in navigation && navigation.botId)
        navigate({ name: "chat", botId: navigation.botId, draftId: crypto.randomUUID() });
      else showDialog(() => newChatDialog("bot"));
      consumeNavigation(navigation);
    } else if (!navigation.conversationId) {
      closeSettings();
      openBotPanel(navigation.botId, navigation.tab);
      consumeNavigation(navigation);
    } else if (peer) {
      void routineTarget(
        peer,
        navigation.botId,
        navigation.conversationId,
        navigation.messageId,
        AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]),
      )
        .then((view) => {
          if (!owner.signal.aborted) {
            closeSettings();
            navigate(view);
            openBotPanel(navigation.botId, navigation.tab, true);
            consumeNavigation(navigation);
          }
        })
        .catch(() => {
          if (!owner.signal.aborted) {
            setNavigationFailed(true);
            consumeNavigation(navigation);
          }
        });
    }
    return () => owner.abort();
  }, [
    state,
    peer,
    navigate,
    settings?.onboardingCompleted,
    navigation,
    consumeNavigation,
    closeSettings,
    openBotPanel,
    openSettings,
    openWorkspace,
    showDialog,
  ]);
  const showCache = !!display?.snapshot && covering;
  if (!settings)
    return showCache && display?.snapshot ? (
      <CachedStartupScreen
        snapshot={display.snapshot}
        labels={startupLabels}
        connected={!!peer}
        systemLocale={display.systemLocale}
      />
    ) : (
      <BrainStatusScreen />
    );
  if (state !== "ready" && !settings.onboardingCompleted) return <BrainStatusScreen />;
  return (
    <>
      <StartupCapture />
      {showCache && display?.snapshot && (
        <CachedStartupScreen
          snapshot={display.snapshot}
          labels={startupLabels}
          connected={!!peer}
          systemLocale={display.systemLocale}
        />
      )}
      <div inert={state !== "ready" || !peer || showCache}>
        {settings.onboardingCompleted ? (
          <ChatScreen />
        ) : (
          <WelcomeFlow onDone={() => void update({ onboardingCompleted: true })} />
        )}
        {settings.onboardingCompleted && <TeamOverlays />}
        {appPanel && (
          <AppDialog title={t(`appMenu.${appPanel}`)} close={() => setAppPanel(undefined)}>
            {appPanel === "about" ? <AboutPanel /> : <UpdatesPanel />}
          </AppDialog>
        )}
        {navigationFailed && <p role="alert">{t("routines.navigationFailed")}</p>}
        {settingsOverlay && !dialog && (
          <Suspense fallback={null}>
            <SettingsScreen
              section={settingsOverlay.section}
              target={settingsOverlay.target}
              onClose={closeSettings}
            />
          </Suspense>
        )}
        {settings.onboardingCompleted && <RoutineOverlay />}
        {settings.onboardingCompleted && <AboutYouDialog />}
        {settings.onboardingCompleted && <ProjectMemoryDialog />}
        {settings.onboardingCompleted && <NewChatDialogs />}
        <ProviderImportDialog />
        {settings.onboardingCompleted && <UpdateNotice />}
      </div>
    </>
  );
}

function Themed() {
  const { theme } = useSettings();
  return (
    <ThemeProvider theme={theme}>
      <NavigationProvider>
        <WorkspaceProvider>
          <RoutinesPorts>
            <BrowserPorts>
              <SkillsPorts>
                <ConnectorsPorts>
                  <TeamsPorts>
                    <UpdatesProvider>
                      <Routes />
                    </UpdatesProvider>
                  </TeamsPorts>
                </ConnectorsPorts>
              </SkillsPorts>
            </BrowserPorts>
          </RoutinesPorts>
        </WorkspaceProvider>
      </NavigationProvider>
    </ThemeProvider>
  );
}

export function App({
  snapshot = null,
  systemLocale = navigator.language,
}: {
  snapshot?: StartupSnapshot | null;
  systemLocale?: string;
}) {
  return (
    <StartupDisplayProvider initial={snapshot} systemLocale={systemLocale}>
      <RpcProvider>
        <SettingsProvider>
          <WorkspacesPorts>
            <RestoreRequestProvider>
              <TaskInputProvider>
                <ComposerDraftProvider>
                  <Themed />
                </ComposerDraftProvider>
              </TaskInputProvider>
            </RestoreRequestProvider>
          </WorkspacesPorts>
        </SettingsProvider>
      </RpcProvider>
    </StartupDisplayProvider>
  );
}
