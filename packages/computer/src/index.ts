// Expose the platform-neutral computer driver factory.
import type { ComputerDriver, Platform, SessionState } from "./core/types.ts";
import type { Cua } from "./cua/loader.ts";
import { createLinuxDriver } from "./drivers/linux.ts";
import { createMacDriver } from "./drivers/mac.ts";
import { createWindowsDriver } from "./drivers/win.ts";

export { compressToBudget, type ImageCodec, type RawImage } from "./actions/image.ts";
export { launchCommand, runLaunch } from "./actions/launch.ts";
export type { DisplayCapture, ScreenAccess } from "./core/context.ts";
export { ComputerError, DEFAULT_CALL_TIMEOUT_MS, scrubDriverText } from "./core/errors.ts";
export type * from "./core/types.ts";
export { CUA_TOOL_WHITELIST } from "./cua/client.ts";
export { createCuaLoader, resolveCuaEntry, unpackedEntry } from "./cua/loader.ts";
export { isAlwaysBlocked, isBlockedWindow } from "./guard/blocklist.ts";
export {
  createGrantRegistry,
  type GrantScope,
  type GrantVerifier,
  grantCovers,
} from "./guard/grants.ts";
export {
  type AuditEntry,
  type ComputerService,
  type ComputerServiceOptions,
  createComputerService,
  type GrantedMethod,
} from "./service/service.ts";

export function isSupportedPlatform(platform: string): platform is Platform {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

/** The platform's driver (drivers/{mac,win,linux}.ts); one interface for all three. */
export function createPlatformDriver(options: {
  platform: Platform;
  load(): Promise<Cua>;
  connect?(module: Cua): Promise<import("@trycua/cua-driver").CuaDriverLike>;
  /** Idle seconds and lock state on Windows / Linux (macOS reads them itself). */
  session(signal?: AbortSignal): Promise<SessionState>;
  timeoutMs?: number;
  windowsProgramFiles?: string;
}): ComputerDriver {
  switch (options.platform) {
    case "darwin":
      return createMacDriver(options);
    case "win32":
      return createWindowsDriver(options);
    case "linux":
      return createLinuxDriver(options);
  }
}
