import { type ChildProcess, execFile } from "node:child_process";
import {
  type ComputerGuardAction,
  ComputerGuardActionSchema,
  type ComputerGuardEntry,
  type HostComputerGuardParams,
  type HostComputerGuardResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/computer-use-contract/full";
import { createTranslator, type Language } from "@pibot/i18n";
import type { Logger } from "@pibot/observability";

import type { GuardRenderState, GuardWindow } from "./types.ts";

// Avatar colours that have a theme token (`--avatar-<name>` in packages/ui tokens.css).
const AVATAR_COLORS = new Set([
  "amber",
  "blue",
  "brown",
  "gray",
  "green",
  "ink",
  "orange",
  "pink",
  "teal",
  "violet",
]);

type Method = keyof HostComputerGuardParams;
export type ComputerGuard = ReturnType<typeof createComputerGuard>;

const MAX_QUEUED_ACTIONS = 50;
const AUTOMATION_TIMEOUT_MS = 120_000;
// One harmless Apple Event ("get name") to an already running app, so macOS attributes the
// Automation consent to Pi Bot while the user is at the screen. Not running → skipped:
// sending the event would launch the app. The app ID is an argv value, never script text.
const AUTOMATION_SCRIPT =
  "function run(argv){var app=Application(argv[0]);if(!app.running())return 'not_running';app.name();return 'ok';}";

function shortcutFor(platform: NodeJS.Platform) {
  return platform === "darwin"
    ? { accelerator: "Control+Alt+Command+.", label: "⌃⌥⌘." }
    : { accelerator: "Control+Alt+Shift+.", label: "Ctrl+Alt+Shift+." };
}

/**
 * Background-process side of the run protections: the indicator window, the
 * global stop shortcut (registered only while some run holds a grant), the action queue brain
 * long-polls, Automation consent warm-up and the mirrored user blocklist. Brain decides; this
 * only shows and reports. `reset()` runs when the brain that drove it exits; `dispose()` when
 * the process stops.
 */
export function createComputerGuard(options: {
  logger: Logger;
  outputDir: string;
  globalShortcut: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
  };
  createWindow(options: {
    outputDir: string;
    title: string;
    onAction(raw: unknown): void;
  }): GuardWindow;
  platform?: NodeJS.Platform;
  /** The indicator appeared or went away (other top-of-screen UI steps aside while it shows). */
  visibilityChanged?(visible: boolean): void;
}) {
  const platform = options.platform ?? process.platform;
  const shortcut = shortcutFor(platform);
  let entries: ComputerGuardEntry[] = [];
  let language: Language = "zh";
  let shortcutRegistered = false;
  let blocked = new Set<string>(["*"]);
  const actions: ComputerGuardAction[] = [];
  const waiters = new Set<() => void>();
  const children = new Set<ChildProcess>();
  let window: GuardWindow | undefined;
  let visible = false;
  const setVisible = (next: boolean) => {
    if (next === visible) return;
    visible = next;
    options.visibilityChanged?.(next);
  };

  const push = (action: ComputerGuardAction) => {
    if (actions.length >= MAX_QUEUED_ACTIONS) actions.shift();
    actions.push(action);
    for (const wake of [...waiters]) wake();
  };
  const accept = (raw: unknown) => {
    const parsed = ComputerGuardActionSchema.safeParse(raw);
    if (!parsed.success) return;
    const action = parsed.data;
    // Only act on what is on screen now; a stale click from a closed row is dropped.
    const known =
      action.kind === "stopAll" ||
      (action.kind === "foreground"
        ? entries.some((entry) => entry.confirm?.requestId === action.requestId)
        : entries.some((entry) => entry.botId === action.botId));
    if (known) push(action);
  };
  const registerShortcut = (on: boolean) => {
    if (on === shortcutRegistered) return;
    if (on) {
      shortcutRegistered = options.globalShortcut.register(shortcut.accelerator, () =>
        push({ kind: "stopAll" }),
      );
      if (!shortcutRegistered) options.logger.warn("computer stop shortcut unavailable");
    } else {
      options.globalShortcut.unregister(shortcut.accelerator);
      shortcutRegistered = false;
    }
  };

  const render = (): GuardRenderState => {
    const t = createTranslator(language);
    return {
      labels: {
        pause: t("computerGuard.pause"),
        resume: t("computerGuard.resume"),
        stop: t("computerGuard.stop"),
        allow: t("computerGuard.allow"),
        skip: t("computerGuard.skip"),
        hint: t("computerGuard.stopHint", { key: shortcut.label }),
      },
      rows: entries.map((entry) => {
        const vars = {
          bot: entry.botName,
          apps: entry.apps.join(language === "zh" ? "、" : ", "),
          step: entry.step ?? "",
        };
        const text =
          entry.mode === "paused"
            ? t(
                entry.pausedBy === "activity"
                  ? "computerGuard.pausedActivity"
                  : entry.pausedBy === "locked"
                    ? "computerGuard.pausedLocked"
                    : "computerGuard.pausedUser",
                vars,
              )
            : entry.mode === "waiting"
              ? t("computerGuard.waiting", vars)
              : entry.mode === "foreground"
                ? t("computerGuard.foreground", vars)
                : t("computerGuard.background", vars);
        return {
          botId: entry.botId,
          ...(entry.botColor && AVATAR_COLORS.has(entry.botColor) ? { color: entry.botColor } : {}),
          mode: entry.mode,
          text,
          canPause: entry.mode !== "paused",
          canResume: entry.pausedBy === "user",
          confirm: entry.confirm
            ? {
                requestId: entry.confirm.requestId,
                text: t("computerGuard.confirm", {
                  bot: entry.botName,
                  action: entry.confirm.action,
                }),
              }
            : null,
        };
      }),
    };
  };

  function update(params: HostComputerGuardParams["host.computerGuard.update"]) {
    language = params.language;
    entries = params.entries;
    registerShortcut(entries.length > 0);
    if (!entries.length) {
      window?.hide();
      setVisible(false);
      return null;
    }
    window ??= options.createWindow({
      outputDir: options.outputDir,
      title: createTranslator(language)("computerGuard.title"),
      onAction: accept,
    });
    window.show(render());
    setVisible(true);
    return null;
  }

  function nextActions(
    waitMs: number,
  ): Promise<HostComputerGuardResults["host.computerGuard.actions"]> {
    if (actions.length || waitMs === 0) return Promise.resolve({ actions: actions.splice(0) });
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        resolve({ actions: actions.splice(0) });
      };
      const timer = setTimeout(wake, waitMs);
      waiters.add(wake);
    });
  }

  function prepareAutomation(
    params: HostComputerGuardParams["host.computerGuard.prepareAutomation"],
  ) {
    if (platform !== "darwin") return { supported: false, triggered: 0 };
    // Sequential: each consent dialog blocks its event until the user answers.
    void params.apps.reduce(
      (previous, appId) =>
        previous.then(
          () =>
            new Promise<void>((resolve) => {
              const child = execFile(
                "/usr/bin/osascript",
                ["-l", "JavaScript", "-e", AUTOMATION_SCRIPT, appId],
                { timeout: AUTOMATION_TIMEOUT_MS, windowsHide: true },
                (error) => {
                  children.delete(child);
                  // A refusal or timeout only means the consent is still missing; the driver
                  // reports permission_missing when it matters.
                  // Only the kind of failure: osascript's stderr may name the app's windows.
                  if (error)
                    options.logger.warn(
                      `computer automation warm-up incomplete (${error.killed ? "timeout" : `exit ${String(error.code ?? "?")}`})`,
                    );
                  resolve();
                },
              );
              children.add(child);
            }),
        ),
      Promise.resolve(),
    );
    return { supported: true, triggered: params.apps.length };
  }

  async function handle<K extends Method>(
    method: K,
    params: HostComputerGuardParams[K],
  ): Promise<HostComputerGuardResults[K]> {
    const p = params as never;
    const table: { [M in Method]: () => Promise<HostComputerGuardResults[M]> } = {
      "host.computerGuard.update": async () => update(p),
      "host.computerGuard.actions": () =>
        nextActions((params as HostComputerGuardParams["host.computerGuard.actions"]).waitMs),
      "host.computerGuard.prepareAutomation": async () => prepareAutomation(p),
      "host.computerGuard.blocklist": async () => {
        blocked = new Set(
          (params as HostComputerGuardParams["host.computerGuard.blocklist"]).appIds.map((id) =>
            id.toLowerCase(),
          ),
        );
        return null;
      },
    };
    if (!table[method]) throw new RpcError(RpcErrorCodes.unsupported, "computer_guard_method");
    return table[method]() as Promise<HostComputerGuardResults[K]>;
  }

  /** The brain that drove the indicator is gone: hide it and let pending polls return. */
  function reset() {
    blocked = new Set(["*"]);
    entries = [];
    actions.length = 0;
    registerShortcut(false);
    window?.hide();
    setVisible(false);
    for (const wake of [...waiters]) wake();
  }

  return {
    handle,
    reset,
    /** User-editable blocklist mirror for the driver's app check. */
    blocked: (app: { id: string; name: string }) =>
      blocked.has("*") || blocked.has(app.id.toLowerCase()),
    /**
     * Only apps the user put on the list. "*" means the brain has not synced the list yet, which
     * must keep automation closed but must not hide apps from the user's own "open with" choice.
     */
    listed: (app: { id: string; name: string }) => blocked.has(app.id.toLowerCase()),
    dispose() {
      reset();
      for (const child of children) child.kill();
      children.clear();
      window?.destroy();
      window = undefined;
    },
  };
}
