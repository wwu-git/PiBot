/** Android update feed, download, integrity check, and native installer bridge. */

import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import { z } from "zod";
import { pibotAndroid } from "../../../modules/pibot-android/index.ts";

const FeedSchema = z.object({
  version: z.string().min(1),
  versionCode: z.number().int().nonnegative(),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  size: z.number().int().positive(),
});

export type AndroidUpdate = z.infer<typeof FeedSchema> & { productionFeed: boolean };
const FEED_URL = "https://pibot.space/updates/android.json";
const TIMEOUT_MS = 20_000;
const CACHE_NAME = "pibot-android-update.apk";

function feedUrl() {
  const override = process.env.EXPO_PUBLIC_UPDATE_FEED_URL;
  return __DEV__ && override ? override : FEED_URL;
}

function assertOfficialUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== "pibot.space")
    throw new Error("update_url_rejected");
}

function assertDevelopmentUrl(value: string) {
  const parsed = new URL(value);
  if (!__DEV__ || !["http:", "https:"].includes(parsed.protocol))
    throw new Error("update_url_rejected");
  if (!/(^localhost$|^127\.0\.0\.1$|^192\.168\.)/.test(parsed.hostname))
    throw new Error("update_url_rejected");
}

export async function fetchAndroidUpdate(signal?: AbortSignal): Promise<AndroidUpdate> {
  if (Platform.OS !== "android") throw new Error("unsupported_platform");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = AbortSignal.any(signal ? [signal, timeout] : [timeout]);
  const source = feedUrl();
  const productionFeed = source === FEED_URL;
  if (productionFeed) assertOfficialUrl(source);
  else assertDevelopmentUrl(source);
  const response = await fetch(source, {
    signal: combined,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("update_feed_unavailable");
  const result = FeedSchema.parse(await response.json());
  if (productionFeed) assertOfficialUrl(result.url);
  else assertDevelopmentUrl(result.url);
  return { ...result, productionFeed };
}

export function isNewerUpdate(update: AndroidUpdate) {
  const installed = Constants.expoConfig?.android?.versionCode ?? 0;
  return update.versionCode > installed;
}

export function removeCachedUpdate() {
  const file = new File(Paths.cache, CACHE_NAME);
  if (file.exists) file.delete();
}

export async function downloadAndroidUpdate(
  update: AndroidUpdate,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (update.productionFeed) assertOfficialUrl(update.url);
  else assertDevelopmentUrl(update.url);
  const destination = new File(Paths.cache, CACHE_NAME);
  removeCachedUpdate();
  const task = FileSystem.createDownloadResumable(update.url, destination.uri, {}, (progress) =>
    onProgress(
      Math.min(1, progress.totalBytesWritten / Math.max(progress.totalBytesExpectedToWrite, 1)),
    ),
  );
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= task.cancelAsync().catch(() => {
      // The native task may already have finished. Its download promise owns the drain.
    });
  };
  const timeout = setTimeout(stop, 30 * 60_000);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const result = await task.downloadAsync();
    signal.throwIfAborted();
    if (stopping || !result || result.status !== 200) throw new Error("update_download_failed");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
    // Legacy Expo leaves its progress subscription attached when downloadAsync settles.
    stop();
    await stopping;
  }
  signal.throwIfAborted();
  const size = destination.size;
  const hash = await pibotAndroid?.sha256File(destination.uri);
  signal.throwIfAborted();
  if (size !== update.size || hash !== update.sha256.toLowerCase())
    throw new Error("update_integrity_failed");
  return destination.uri;
}

export async function installAndroidUpdate(uri: string) {
  if (Platform.OS !== "android" || !pibotAndroid) throw new Error("unsupported_platform");
  return pibotAndroid.installApk(uri);
}
