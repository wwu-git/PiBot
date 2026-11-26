import { requireOptionalNativeModule } from "expo";

/**
 * The Android-only local module. Absent on iOS, in Expo Go and in
 * builds made before `expo prebuild` picked it up; callers treat absence as "unsupported".
 */
export interface PibotAndroidModule {
  installApk(uri: string): Promise<"started" | "unknown_sources">;
  sha256File(uri: string): Promise<string>;
  openInstallSettings(): Promise<void>;
  addListener(event: "linkTick", listener: () => void): { remove(): void };
  /** Remote-control foreground service; false when Android refused the start (background). */
  startLinkService(title: string, body: string, channel: string): Promise<boolean>;
  updateLinkService(title: string, body: string, channel: string): Promise<void>;
  stopLinkService(): Promise<void>;
  googleServicesAvailable(): Promise<boolean>;
  linkServiceRunning(): Promise<boolean>;
  /** Whether any VPN network is up (not only the default one). */
  vpnActive(): Promise<boolean>;
  /** Battery "Restricted" (background restriction) and "optimized" (not exempt from Doze). */
  backgroundLimits(): Promise<{ restricted: boolean; optimized: boolean }>;
  /** The app's system details page, where the battery choice is changed. */
  openBatterySettings(): Promise<void>;
  readPagePermission(
    kind: "notifications" | "calls",
  ): Promise<"granted" | "denied" | "unsupported">;
  beginPhonePage(): Promise<string>;
  cancelPhonePage(id: string): Promise<void>;
  readPhonePage(
    requestId: string,
    kind: "notifications" | "calls",
    beforeTime: number,
    beforeId: string,
    limit: number,
  ): Promise<unknown>;
  requestCallHistory(): Promise<{ granted: boolean }>;
  openNotificationAccess(): Promise<void>;
  smsCapabilities(): Promise<{ consent: boolean; readSms: "granted" | "denied" | "undeclared" }>;
  requestReadSms(): Promise<{ granted: boolean }>;
  /** Rejects with code phone_consent_denied / phone_sms_timeout / phone_busy / unsupported_platform. */
  waitForConsentCode(
    senderHint: string | null,
    waitMs: number,
  ): Promise<{ code: string; senderLast4: string | null }>;
  cancelConsentCode(): Promise<void>;
  readRecentCode(
    senderHint: string | null,
    sinceMs: number,
  ): Promise<{ code: string; senderLast4: string | null } | null>;
}
export const pibotAndroid = requireOptionalNativeModule<PibotAndroidModule>("PibotAndroid");
