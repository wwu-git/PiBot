import { createTranslator, type Language } from "@pibot/i18n";
import type { Logger } from "@pibot/observability";
import {
  LIVE_ISLAND_KINDS,
  type LiveActivity,
  type LiveActivityItem,
  type Settings,
  type UiNavigation,
} from "@pibot/protocol";
import {
  type IslandAction,
  type IslandState,
  liveIslandSupport,
} from "../../shared/live-island.ts";
import { createIslandWindow } from "./island-window.ts";

type Translate = ReturnType<typeof createTranslator>;

function statusText(item: LiveActivityItem, language: Language, t: Translate) {
  const title = item.localizedTitle?.[language] ?? item.title;
  if (item.kind === "waiting")
    return title ? t("liveIsland.status.waitingNamed", { title }) : t("liveIsland.status.waiting");
  if (item.kind === "routine")
    return title ? t("liveIsland.status.routineNamed", { title }) : t("liveIsland.status.routine");
  return title ?? t(item.kind === "group" ? "liveIsland.status.group" : "liveIsland.status.chat");
}

/**
 * Decides when the live island shows and what it says. Inputs arrive from the brain (busy Bots,
 * settings), the GUI (whether the Pi Bot window is in front) and the computer-use guard (its bar
 * takes the top of the screen while it shows). Owner: the process running the brain; `dispose()`
 * destroys the window. Where the session cannot place an always-on-top window (Wayland) nothing
 * is created at all.
 */
export function createLiveIsland(options: {
  outputDir: string;
  logger: Logger;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** Bring the main window forward and open this place. */
  open(target: UiNavigation): void;
}) {
  const support = liveIslandSupport(options.platform, options.env);
  if (support !== "supported")
    options.logger.info(JSON.stringify({ module: "live-island", event: "unsupported", support }));
  let window: ReturnType<typeof createIslandWindow> | undefined;
  let items: LiveActivityItem[] = [];
  let settings: Settings | undefined;
  let language: Language = "zh";
  let foreground = false;
  let guardVisible = false;
  let disposed = false;
  let shown: LiveActivityItem[] = [];

  const onAction = (action: IslandAction) => {
    if (action.kind !== "open") return;
    // Only what is on screen now; a stale click from a row that just went away is dropped.
    const item = shown.find((entry) => entry.key === action.key);
    if (item) options.open(item.target);
  };

  const render = () => {
    if (disposed || support !== "supported") return;
    const kinds = new Set(settings?.liveIslandKinds ?? LIVE_ISLAND_KINDS);
    shown = items.filter((item) => kinds.has(item.kind));
    const hidden =
      !settings ||
      settings.liveIsland === false ||
      !shown.length ||
      guardVisible ||
      // Only for when Pi Bot is in the background: the open window already shows the same work.
      foreground;
    if (hidden) {
      window?.hide();
      return;
    }
    const t = createTranslator(language);
    const state: Omit<IslandState, "theme"> = {
      mode: settings?.liveIslandContent ?? "full",
      labels: {
        previous: t("liveIsland.previous"),
        next: t("liveIsland.next"),
        // Templates: the window fills in the count and the running time itself.
        working: t("liveIsland.working"),
        seconds: t("liveIsland.seconds"),
        minutes: t("liveIsland.minutes"),
        hours: t("liveIsland.hours"),
      },
      items: shown.map((item) => ({
        key: item.key,
        name: item.botName,
        text: statusText(item, language, t),
        open: t("liveIsland.open", { bot: item.botName }),
        avatar: item.avatar,
        startedAt: Math.max(0, Date.parse(item.startedAt) || 0),
      })),
    };
    window ??= createIslandWindow({
      outputDir: options.outputDir,
      title: t("liveIsland.windowTitle"),
      onAction,
    });
    window.setTitle(t("liveIsland.windowTitle"));
    window.show(state);
  };

  return {
    support,
    activity(value: LiveActivity) {
      items = value.items;
      render();
    },
    settings(next: Settings, nextLanguage: Language) {
      settings = next;
      language = nextLanguage;
      render();
    },
    foreground(value: boolean) {
      if (foreground === value) return;
      foreground = value;
      render();
    },
    guardVisible(value: boolean) {
      if (guardVisible === value) return;
      guardVisible = value;
      render();
    },
    dispose() {
      disposed = true;
      window?.destroy();
      window = undefined;
    },
  };
}
