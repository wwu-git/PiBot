/*
 * The options `startBrainHost` accepts. Separated from the host body so the services it builds and
 * the caller that assembles them (desktop main) can name the same shape.
 */
import type { BrowserFrameTransport } from "@pibot/browser/host";
import type { ComputerGuard } from "@pibot/computer-use/host";
import type { Logger } from "@pibot/observability";
import type {
  BotNavigation,
  EventPayloads,
  GuiHostMethods,
  Peer,
  Port,
  Settings,
} from "@pibot/protocol";
import type { createRoutineHost } from "@pibot/routines/host";
import type { Redactor } from "@pibot/secrets";
import type { BrowserWindow } from "electron";
import type { ComputerHost } from "../computer/computer-host.ts";
import type { createHostCapabilities } from "../host/host-capabilities.ts";
import type { createSecureStorage } from "../host/secure-storage.ts";
import type { prelaunchBrainProcess } from "./brain-process.ts";

export interface BrainHostOptions {
  updateProxy?(url: string | null | undefined): Promise<void>;
  systemLocale?: string;
  window?: BrowserWindow;
  business?: Port;
  acp?: Port;
  onAcpRetired?(): void;
  gui?: Pick<Peer<typeof GuiHostMethods, Record<string, never>>, "call">;
  foreground?(): boolean;
  onStatus?(
    state: EventPayloads["brain.status"]["state"],
    reason?: "database_newer_than_app",
  ): void;
  /**
   * The starting child is still advancing. Owners waiting on startup (background launch
   * deadline, GUI attach window) extend their budget on this instead of a fixed wall clock.
   */
  onStartupProgress?(phase: string): void;
  onReady?(): void;
  beforeBootstrap?(pid: number): Promise<void>;
  bootstrapSignal?: AbortSignal;
  onChild?(child: Electron.UtilityProcess): void;
  prelaunchedBrain?: ReturnType<typeof prelaunchBrainProcess>;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
  dataDir: string;
  outputDir: string;
  resourcesDir: string;
  dev: boolean;
  logger: Logger;
  redactor: Redactor;
  onLoginItem(openAtLogin: boolean): void;
  onSettings(settings: Settings): void;
  focusBot(botId: string, tab: BotNavigation["tab"], target?: BotNavigation): void;
  /** The tray's "waiting for you" count follows this instead of polling the brain. */
  onInboxChanged?(): void;
  onActiveRuns?(count: number): void;
  /** Busy Bots for the live island; an empty list when the brain is not ready. */
  onLiveActivity?(value: EventPayloads["runtime.liveActivity"]): void;
  routines?: ReturnType<typeof createRoutineHost>;
  /** Independent owners keep power listeners across expected utility retirement. */
  retainRoutineHost?: boolean;
  storage?: ReturnType<typeof createSecureStorage>;
  capabilities?: ReturnType<typeof createHostCapabilities>;
  attachmentPartition?: string;
  routineTesting?: boolean;
  /** Operating the computer; grants die with the brain process that registered them. */
  computer?: Pick<ComputerHost, "handle" | "revokeAll" | "officeApps" | "officeOpen">;
  /** Where Bot browser overlay frames go; absent means no overlay can be shown. */
  frames?: BrowserFrameTransport;
  /** Run protections; reset with the brain that drove them. */
  computerGuard?: Pick<ComputerGuard, "handle" | "reset">;
}
