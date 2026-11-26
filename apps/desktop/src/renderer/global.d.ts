import type {
  BackgroundPreferences,
  DesktopBackgroundResults,
  DesktopUpdateAction,
  DesktopUpdateState,
  IndependentBackgroundState,
  ProviderImportDecision,
} from "@pibot/protocol";

declare global {
  interface Window {
    readonly pibotStartup?: {
      readonly titleOverlay?: boolean;
      locale(): Promise<string>;
      labels(): Promise<import("../shared/startup-labels.ts").StartupLabelTables | null>;
      ready(): Promise<void>;
      read(): Promise<import("../shared/startup-snapshot.ts").StartupSnapshot | null>;
      save(value: import("../shared/startup-snapshot.ts").StartupSnapshot): Promise<void>;
      clear(): Promise<void>;
      timing(value: { method: string; durationMs: number; ok: boolean }): void;
      /** Lifecycle/phase while the first window attaches (identifiers only). */
      onProgress(
        listener: (value: import("../shared/startup-progress.ts").StartupProgressEvent) => void,
      ): () => void;
    };
    readonly pibot: {
      readonly platform: NodeJS.Platform;
      /** Whether this desktop session can show the live island (Wayland cannot place it). */
      readonly liveIsland?: import("../shared/live-island.ts").IslandSupport;
      restartApp(): Promise<{ status: "requested" }>;
      resolveProviderImport(decision: ProviderImportDecision): Promise<{ ok: true }>;
      readonly background: {
        state(): Promise<DesktopBackgroundResults["background.state"]>;
        restart(): Promise<DesktopBackgroundResults["background.restart"]>;
        serviceState(): Promise<IndependentBackgroundState>;
        preferences(patch: Partial<BackgroundPreferences>): Promise<IndependentBackgroundState>;
        stopService(): Promise<{ status: "requested" }>;
      };
      onPort(callback: (port: MessagePort, options?: { scheduled: boolean }) => void): () => void;
      /** Bot browser overlay frame ports, one per Bot; the business port is separate. */
      onBrowserFrames(
        callback: (botId: string, port: MessagePort, groupId?: string) => void,
      ): () => void;
      /** In-app updates run by the desktop main process; the preload validates both directions. */
      readonly updates: {
        run(action: DesktopUpdateAction): Promise<DesktopUpdateState>;
        onState(callback: (state: DesktopUpdateState) => void): () => void;
      };
      /** Shows a save dialog and writes logs/ as a zip. Logs are already redacted. */
      /** The HTTP(S) proxy this computer uses, as a draft for the proxy form; null if none. */
      systemProxy?(): Promise<string | null>;
      exportLogs(): Promise<"saved" | "canceled" | "failed">;
    };
  }
}
