/** Structural host ports: desktop supplies Electron objects; the capability never loads Electron. */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface HostEvent {
  preventDefault(): void;
}
interface NavigationEvent extends HostEvent {
  url: string;
  isMainFrame: boolean;
  isSameDocument: boolean;
}
interface ContentsEvents {
  "will-navigate": [NavigationEvent];
  "will-redirect": [NavigationEvent];
  "did-create-window": [BrowserWindow, { url: string }];
  "dom-ready": [];
  "did-fail-load": [unknown, number, string, string, boolean];
  "did-start-navigation": [NavigationEvent];
  login: [
    HostEvent,
    unknown,
    { isProxy: boolean; host: string; port: number },
    (username?: string, password?: string) => void,
  ];
  "render-process-gone": [];
}
export interface WebContents {
  id: number;
  debugger: {
    attach(version: string): void;
    detach(): void;
    isAttached(): boolean;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
    on(
      event: "message",
      listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
    ): unknown;
    on(event: "detach", listener: () => void): unknown;
    off(
      event: "message",
      listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
    ): unknown;
    off(event: "detach", listener: () => void): unknown;
  };
  on<K extends keyof ContentsEvents>(
    event: K,
    listener: (...args: ContentsEvents[K]) => void,
  ): unknown;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  getUserAgent(): string;
  setUserAgent(value: string): void;
  reload(): void;
  invalidate(): void;
  navigationHistory: {
    canGoBack(): boolean;
    goBack(): void;
    /** Phone forward button; optional so older fakes stay valid. */
    canGoForward?(): boolean;
    goForward?(): void;
  };
  insertCSS(css: string): Promise<string>;
  setWindowOpenHandler(
    handler: (details: { url: string; features: string }) =>
      | { action: "deny" }
      | {
          action: "allow";
          outlivesOpener: boolean;
          overrideBrowserWindowOptions: BrowserWindowConstructorOptions;
        },
  ): void;
}
export interface BrowserWindow {
  webContents: WebContents;
  on(event: "close", listener: (event: HostEvent) => void): unknown;
  on(event: "closed" | "move" | "resize", listener: () => void): unknown;
  isDestroyed(): boolean;
  isVisible(): boolean;
  destroy(): void;
  hide(): void;
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle): void;
  getContentSize(): number[];
  setContentSize(width: number, height: number): void;
}
export interface BrowserWindowConstructorOptions {
  width: number;
  height: number;
  show: boolean;
  webPreferences: {
    session: Session;
    sandbox: boolean;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    backgroundThrottling: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
interface RequestDetails {
  url: string;
  resourceType: string;
  method: string;
  webContentsId?: number;
  requestHeaders: Record<string, string>;
  ip?: string;
}
export interface DownloadItem {
  getState(): "progressing" | "completed" | "cancelled" | "interrupted";
  off(event: "done", listener: () => void): unknown;
  getURL(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  getFilename(): string;
  setSavePath(path: string): void;
  cancel(): void;
  on(event: "updated", listener: () => void): unknown;
  once(
    event: "done",
    listener: (event: unknown, state: "completed" | "cancelled" | "interrupted") => void,
  ): unknown;
}
export interface Session {
  setUserAgent(userAgent: string, languages: string): void;
  webRequest: {
    onBeforeRequest(
      listener:
        | ((details: RequestDetails, callback: (response: { cancel?: boolean }) => void) => void)
        | null,
    ): void;
    onResponseStarted(listener: ((details: RequestDetails) => void) | null): void;
    onBeforeSendHeaders(
      listener:
        | ((
            details: RequestDetails,
            callback: (response: { requestHeaders: Record<string, string> }) => void,
          ) => void)
        | null,
    ): void;
  };
  setPermissionRequestHandler(
    listener:
      | ((contents: unknown, permission: string, callback: (allow: boolean) => void) => void)
      | null,
  ): void;
  setPermissionCheckHandler(listener: (() => boolean) | null): void;
  setProxy(config: {
    mode: string;
    proxyRules?: string;
    proxyBypassRules?: string;
    pacScript?: string;
  }): Promise<void>;
  resolveProxy(url: string): Promise<string>;
  closeAllConnections(): Promise<void>;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
  flushStorageData(): void;
  on(
    event: "will-download",
    listener: (event: HostEvent, item: DownloadItem, source?: WebContents) => void,
  ): unknown;
  off(
    event: "will-download",
    listener: (event: HostEvent, item: DownloadItem, source?: WebContents) => void,
  ): unknown;
}
export interface AddressPolicy {
  checkedUrl(value: string): URL;
  checkProxyTarget(url: URL, signal: AbortSignal): Promise<unknown>;
  publicAddresses(url: URL, signal: AbortSignal): Promise<unknown>;
  isPublicAddress(value: string): boolean;
}
export interface BrowserPlatform {
  app: {
    userAgentFallback: string;
    getPreferredSystemLanguages(): string[];
    getLocale(): string;
    on(event: "before-quit", listener: () => void): unknown;
    off(event: "before-quit", listener: () => void): unknown;
  };
  sessionFromPath(path: string): Session;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  prepareTabWindow(window: BrowserWindow): void;
  takeoverBounds(): Rectangle;
  bringToFront(window: BrowserWindow): void;
  sendToBack(window: BrowserWindow): void;
  readonly drawsOnlyWhenShown: boolean;
  redrawHidden(
    window: BrowserWindow,
    options: {
      size?: { width: number; height: number };
      drawn(): Promise<unknown>;
      keep(): boolean;
      hide(): void;
    },
  ): Promise<void>;
  htmlText(html: string, options?: { maxElements?: number }): Promise<{ text: string }>;
  /** JPEG at most `width` wide re-encoded at `quality`; undefined when it does not decode. */
  thumbnail(data: Buffer, width: number, quality: number): Buffer | undefined;
  address: AddressPolicy;
}
