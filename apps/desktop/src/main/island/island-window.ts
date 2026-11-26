import { join } from "node:path";
import tokens from "@pibot/ui/tokens.css?raw";
import { BrowserWindow, ipcMain, nativeTheme, screen, session } from "electron";
import {
  IslandActionSchema,
  type IslandState,
  LIVE_ISLAND_ACTION,
  LIVE_ISLAND_READY,
  LIVE_ISLAND_STATE,
} from "../../shared/live-island.ts";

const PARTITION = "pibot-island";
// The first frame before the preload reports the pill's laid-out size.
const INITIAL = { width: 584, height: 72 };
const TOP_GAP = 6;
// Window opacity exists on macOS and Windows only; Linux hides and shows the window instead.
const FADE = process.platform === "darwin" || process.platform === "win32";

// Same look as the computer-use bar: the page colours inverted (--prim pill, --bg text), pill
// radius, theme shadow, 13 px. Colours come only from the shared theme tokens. Images are the
// Bots' own re-encoded avatars, so `img-src data:` is the only source the page may load.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>${tokens}
html,body{margin:0;background:transparent;overflow:hidden;font-family:var(--font-sans);user-select:none;cursor:default}
#host{display:inline-flex;flex-direction:column;align-items:center;padding:4px 12px 12px}
.pill{display:flex;align-items:center;gap:10px;height:44px;box-sizing:border-box;padding:0 8px 0 9px;
  border-radius:var(--radius-pill);background:var(--prim);color:var(--bg);box-shadow:var(--shadow);
  font-size:13px;position:relative;z-index:1;cursor:pointer;white-space:nowrap}
.pill.full{width:520px}
.pill.avatars{gap:6px;padding:0 12px 0 9px}
.face{width:26px;height:26px;flex:none;display:inline-flex;border-radius:50%;background:var(--bg);overflow:hidden}
.face svg,.face img{width:26px;height:26px;display:block}
.text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.text b{font-weight:600}
.sep{opacity:.6}
.time{opacity:.65;font-variant-numeric:tabular-nums}
.dot{width:8px;height:8px;border-radius:50%;background:var(--avatar-pink);margin-left:6px;flex:none;
  animation:pulse 1.2s ease-in-out infinite}
.count{opacity:.85;margin-left:2px}
.nav{display:flex;align-items:center;gap:2px;margin-left:4px;padding:0 4px;height:30px;border-radius:15px;
  background:color-mix(in srgb,var(--bg) 18%,transparent)}
.arrows{display:inline-flex;flex-direction:column}
.arrow{border:0;padding:0;margin:0;background:transparent;color:inherit;cursor:pointer;line-height:0;height:14px}
.arrow svg{width:14px;height:14px}
.index{font-variant-numeric:tabular-nums;font-size:12px;padding-right:4px}
.peek{width:480px;height:10px;margin-top:-4px;border-radius:0 0 14px 14px;
  background:color-mix(in srgb,var(--prim) 55%,var(--bg));box-shadow:var(--shadow)}
.text.flip{animation:flip 180ms ease-out}
@keyframes pulse{50%{opacity:.35}}
@keyframes flip{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dot,.text.flip{animation:none!important}}
</style></head><body><div id="host" role="status" aria-live="polite"></div></body></html>`;

/**
 * The live island window: always on top, never takes focus, on every desktop space, owned by the
 * process that runs the brain so it also shows with no Pi Bot window open. Modelled on the
 * computer-use indicator; `destroy()` closes the window and removes every listener it added.
 */
export function createIslandWindow(options: {
  outputDir: string;
  title: string;
  onAction(raw: unknown): void;
}) {
  let window: BrowserWindow | undefined;
  let ready = false;
  let latest: Omit<IslandState, "theme"> | undefined;
  let size = INITIAL;
  session
    .fromPartition(PARTITION)
    .setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const bounds = () => {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(size.width, area.width);
    return {
      width,
      height: size.height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + TOP_GAP,
    };
  };
  const send = () => {
    if (!window || window.isDestroyed() || !ready || !latest) return;
    window.webContents.send(LIVE_ISLAND_STATE, {
      ...latest,
      theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    });
  };
  const fromWindow = (event: Electron.IpcMainEvent) =>
    !!window && !window.isDestroyed() && event.sender === window.webContents;
  const onReady = (event: Electron.IpcMainEvent) => {
    if (!fromWindow(event)) return;
    ready = true;
    send();
  };
  const onAction = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (!fromWindow(event)) return;
    const parsed = IslandActionSchema.safeParse(raw);
    if (!parsed.success) return;
    if (parsed.data.kind === "size") {
      size = { width: parsed.data.width, height: parsed.data.height };
      if (window && !window.isDestroyed()) window.setBounds(bounds());
      return;
    }
    options.onAction(parsed.data);
  };
  // The work area moves with the menu bar, Dock, taskbar and display changes.
  const onDisplay = () => {
    if (window && !window.isDestroyed()) window.setBounds(bounds());
  };
  ipcMain.on(LIVE_ISLAND_READY, onReady);
  ipcMain.on(LIVE_ISLAND_ACTION, onAction);
  nativeTheme.on("updated", send);
  screen.on("display-metrics-changed", onDisplay);
  screen.on("display-added", onDisplay);
  screen.on("display-removed", onDisplay);

  const create = () => {
    const created = new BrowserWindow({
      ...bounds(),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      title: options.title,
      // A non-activating panel on macOS: clicks work without pulling focus from the user's app.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: {
        preload: join(options.outputDir, "..", "preload", "live-island.cjs"),
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    // One level below the computer-use bar ("screen-saver"), which wins whenever both show.
    created.setAlwaysOnTop(true, "pop-up-menu");
    // skipTransformProcessType keeps the dock-less background owner from becoming a regular app.
    created.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.on("closed", () => {
      if (window === created) {
        window = undefined;
        ready = false;
      }
    });
    void created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    created.once("ready-to-show", () => {
      if (latest && !created.isDestroyed()) created.showInactive();
    });
    return created;
  };

  return {
    show(state: Omit<IslandState, "theme">) {
      latest = state;
      if (!window || window.isDestroyed()) window = create();
      else {
        if (!window.isVisible()) window.showInactive();
        if (FADE) {
          window.setIgnoreMouseEvents(false);
          window.setOpacity(1);
        }
      }
      send();
    },
    hide() {
      latest = undefined;
      if (!window || window.isDestroyed()) return;
      if (!FADE) {
        window.hide();
        return;
      }
      // Ordering the panel out and in again ran macOS's open animation on every focus change; under
      // load it stayed stuck at a quarter size for seconds. A transparent, click-through window
      // has nothing to animate.
      window.setOpacity(0);
      window.setIgnoreMouseEvents(true);
    },
    setTitle(title: string) {
      if (window && !window.isDestroyed()) window.setTitle(title);
    },
    destroy() {
      ipcMain.off(LIVE_ISLAND_READY, onReady);
      ipcMain.off(LIVE_ISLAND_ACTION, onAction);
      nativeTheme.off("updated", send);
      screen.off("display-metrics-changed", onDisplay);
      screen.off("display-added", onDisplay);
      screen.off("display-removed", onDisplay);
      if (window && !window.isDestroyed()) window.destroy();
      window = undefined;
    },
  };
}
