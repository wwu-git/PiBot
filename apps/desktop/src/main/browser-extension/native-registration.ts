import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// The name the extension connects to (apps/browser-extension, connectNative).
export const NATIVE_HOST_NAME = "com.pibot.browser";
export const BROWSERS = ["chrome", "edge", "brave", "chromium", "firefox"] as const;
/** From the manifest key in apps/browser-extension (sha256 of the key, a–p). */
/**
 * The Chrome Web Store item (manifest `key` = the store's public key, so a locally loaded build
 * has the same id), then the development id builds carried before the listing (2026-11-19).
 */
export const CHROME_EXTENSION_IDS = [
  "jfaelafpdicbnlnbngicngehehafpmbk",
  "epolfpffabplnhnkpjlckibfckdfeeib",
] as const;
export const FIREFOX_EXTENSION_ID = "extension@pibot.space";
export type NativeBrowser = (typeof BROWSERS)[number];

export function nativeManifestPath(
  platform: NodeJS.Platform,
  home: string,
  browser: NativeBrowser,
): string {
  if (platform === "win32")
    return join(
      home,
      "AppData",
      "Local",
      "PiBot",
      "NativeMessagingHosts",
      `${NATIVE_HOST_NAME}-${browser}.json`,
    );
  if (platform === "darwin") {
    const roots: Record<NativeBrowser, string> = {
      chrome: join(home, "Library", "Application Support", "Google", "Chrome"),
      edge: join(home, "Library", "Application Support", "Microsoft Edge"),
      brave: join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
      chromium: join(home, "Library", "Application Support", "Chromium"),
      firefox: join(home, "Library", "Application Support", "Mozilla"),
    };
    const root = roots[browser];
    return join(root, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
  }
  if (platform === "linux") {
    const roots: Record<NativeBrowser, string> = {
      chrome: join(home, ".config", "google-chrome"),
      edge: join(home, ".config", "microsoft-edge"),
      brave: join(home, ".config", "BraveSoftware", "Brave-Browser"),
      chromium: join(home, ".config", "chromium"),
      firefox: join(home, ".mozilla"),
    };
    const root = roots[browser];
    return join(
      root,
      browser === "firefox" ? "native-messaging-hosts" : "NativeMessagingHosts",
      `${NATIVE_HOST_NAME}.json`,
    );
  }
  throw new Error("native_manifest_registry_required");
}

/** Chromium browsers name the allowed extension by origin, Firefox by add-on id. */
export function nativeManifest(browser: NativeBrowser, launcher: string) {
  return {
    name: NATIVE_HOST_NAME,
    description: "Pi Bot browser bridge",
    path: launcher,
    type: "stdio",
    ...(browser === "firefox"
      ? { allowed_extensions: [FIREFOX_EXTENSION_ID] }
      : { allowed_origins: CHROME_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`) }),
  };
}

/** The browser's own folder exists, so it is installed for this user (the manifest goes in it). */
export function browserProfileRoot(
  platform: NodeJS.Platform,
  home: string,
  browser: NativeBrowser,
) {
  return platform === "win32"
    ? undefined
    : dirname(dirname(nativeManifestPath(platform, home, browser)));
}

/** Writes the manifest (and on Windows its registry value); unchanged content is left alone. */
export async function registerNativeManifest(options: {
  platform: NodeJS.Platform;
  home: string;
  browser: NativeBrowser;
  launcher: string;
}): Promise<boolean> {
  const path = nativeManifestPath(options.platform, options.home, options.browser);
  const content = `${JSON.stringify(nativeManifest(options.browser, options.launcher), null, 2)}\n`;
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
  if (options.platform === "win32")
    await registry("add", registryPath(options.browser), ["/ve", "/t", "REG_SZ", "/d", path, "/f"]);
  return true;
}

/** The launcher an existing manifest starts, if it is ours and readable. */
export async function nativeManifestLauncher(options: {
  platform: NodeJS.Platform;
  home: string;
  browser: NativeBrowser;
}): Promise<string | undefined> {
  const path = nativeManifestPath(options.platform, options.home, options.browser);
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const manifest = value as { name?: unknown; path?: unknown };
    return manifest.name === NATIVE_HOST_NAME && typeof manifest.path === "string"
      ? manifest.path
      : undefined;
  } catch {
    // Missing or unreadable: no other Pi Bot's launcher to protect.
    return undefined;
  }
}

export async function revokeNativeManifest(options: {
  platform: NodeJS.Platform;
  home: string;
  browser: NativeBrowser;
}): Promise<boolean> {
  const path = nativeManifestPath(options.platform, options.home, options.browser);
  const existed = await readFile(path, "utf8").then(
    () => true,
    () => false,
  );
  if (options.platform === "win32")
    await registry("delete", registryPath(options.browser), ["/f"]).catch(() => undefined);
  await rm(path, { force: true });
  return existed;
}

function registryPath(browser: NativeBrowser) {
  const keys: Record<NativeBrowser, string> = {
    chrome: "Google\\Chrome",
    edge: "Microsoft\\Edge",
    brave: "BraveSoftware\\Brave-Browser",
    chromium: "Chromium",
    firefox: "Mozilla",
  };
  return `HKCU\\Software\\${keys[browser]}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
}

function registry(action: "add" | "delete", key: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile("reg.exe", [action, key, ...args], { windowsHide: true, timeout: 5000 }, (error) =>
      error ? reject(new Error("native_manifest_registry_failed")) : resolve(),
    ),
  );
}
