// Inject trusted desktop host facts into computer-use drivers.
import {
  type ComputerDriver,
  type ComputerService,
  createComputerService,
  createCuaLoader,
  createPlatformDriver,
  isSupportedPlatform,
  type ScreenAccess,
  type SessionState,
  scrubDriverText,
} from "@pibot/computer";
import { windowsProgramFiles } from "@pibot/execution";
import type { Logger } from "@pibot/observability";
import {
  type ComputerStatus,
  type HostComputerParams,
  type HostComputerResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { desktopCapturer, powerMonitor, shell, systemPreferences } from "electron";
import { createOfficeHost } from "../host/office-host.ts";
import { electronDisplays, nativeImageCodec } from "./computer-host-media.ts";
import { createMacAutomation } from "./mac-automation.ts";
import { createMacCuaRuntime } from "./mac-cua-runtime.ts";
import { createMacPermissionProbe } from "./mac-permission-probe.ts";

type Method = keyof HostComputerParams;
export type ComputerHost = ReturnType<typeof createComputerHost>;

const SETTINGS_PANES = {
  accessibility: "Privacy_Accessibility",
  screenRecording: "Privacy_ScreenCapture",
  automation: "Privacy_Automation",
} as const;

/** Why the mac owner sealed itself; EmbeddedDriverError keeps its text in inner.reason. */
function ownerFailure(code: string, error: unknown): string {
  const reason = (error as { inner?: { reason?: unknown } } | undefined)?.inner?.reason;
  const text = typeof reason === "string" ? reason : error instanceof Error ? error.message : "";
  return JSON.stringify({
    module: "computer",
    event: "cua_owner_failed",
    code,
    error: error instanceof Error ? error.name : typeof error,
    detail: scrubDriverText(text, 200),
  });
}

/**
 * The operating-the-computer service of the background process: mac owner, Windows /
 * Linux desktop main process. macOS checks permissions after app readiness; the daemon
 * starts lazily only when both required grants exist. Computer grants are dropped when the brain that registered them exits (`revokeAll`) and the
 * driver's resident helpers are released with the last grant. Owner: whoever created it calls
 * dispose() when the process stops.
 */
export function createComputerHost(options: {
  logger: Logger;
  platform?: NodeJS.Platform;
  /** User-editable blocklist. */
  blocked?(app: { id: string; name: string }): boolean;
  /** The same list without the closed-until-synced default, for the user's own Office choice. */
  officeBlocked?(app: { id: string; name: string }): boolean;
}) {
  const platform = options.platform ?? process.platform;
  let locked = false;
  const onLock = () => {
    locked = true;
  };
  const onUnlock = () => {
    locked = false;
  };
  // Lock events exist on macOS and Windows; Linux reports "unlocked".
  powerMonitor.on("lock-screen", onLock);
  powerMonitor.on("unlock-screen", onUnlock);
  const session = async (): Promise<SessionState> => ({
    hidIdleSeconds: powerMonitor.getSystemIdleTime(),
    locked,
  });

  // The TCC preflight behind Settings · Computer's Screen Recording row (CGPreflight…).
  const screenAccess = (): ScreenAccess => {
    if (platform !== "darwin") return "granted";
    const granted = macOwner?.permissions?.screenRecording;
    return granted === undefined ? "unknown" : granted ? "granted" : "denied";
  };

  // Set before either permission primitives or the driver load native code.
  process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
  process.env.CUA_TELEMETRY_ENABLED = "false";
  process.env.CUA_DRIVER_RS_UPDATE_CHECK = "false";
  // Same-process SDK defense only: the macOS daemon's safe environment drops this variable.
  process.env.CUA_DRIVER_DISABLE_RUN_SCRIPT = "1";
  let service: ComputerService | undefined;
  let platformDriver: ComputerDriver | undefined;
  const automation =
    platform === "darwin"
      ? createMacAutomation({
          onError: (error) =>
            options.logger.warn(
              JSON.stringify({
                module: "computer",
                event: "automation_probe_failed",
                error: error instanceof Error ? error.name : "unknown",
              }),
            ),
        })
      : undefined;
  const liveProbe =
    platform === "darwin"
      ? createMacPermissionProbe({
          onError: (error) =>
            options.logger.warn(
              JSON.stringify({
                module: "computer",
                event: "permission_probe_failed",
                error: error instanceof Error ? error.name : "unknown",
              }),
            ),
        })
      : undefined;
  const macOwner =
    platform === "darwin"
      ? createMacCuaRuntime({
          invalidate: () => {
            service?.grants.revokeAll();
          },
          async release() {
            await service?.dispose();
            service = undefined;
            platformDriver = undefined;
          },
          failed: (code, error) => options.logger.warn(ownerFailure(code, error)),
        })
      : undefined;
  let reported = false;
  let polling: Promise<void> | undefined;
  const permissionTimer = macOwner
    ? setInterval(() => {
        if (polling) return;
        polling = macOwner
          .refresh()
          .catch(() => {
            if (!reported)
              options.logger.warn(
                JSON.stringify({ module: "computer", event: "cua_owner_unavailable" }),
              );
            reported = true;
          })
          .finally(() => {
            polling = undefined;
          });
      }, 2_000)
    : undefined;
  permissionTimer?.unref();
  const get = (): ComputerService => {
    if (service) return service;
    if (!isSupportedPlatform(platform))
      throw new RpcError(RpcErrorCodes.unsupported, "computer_unsupported");
    // Cua's CLI crate has PostHog telemetry and an update check; the SDK build has neither
    //, and these switches keep it that way if a later build links them.
    process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
    process.env.CUA_TELEMETRY_ENABLED = "false";
    process.env.CUA_DRIVER_RS_UPDATE_CHECK = "false";
    process.env.CUA_DRIVER_DISABLE_RUN_SCRIPT = "1";
    const driver = createPlatformDriver({
      platform,
      load: createCuaLoader().load,
      session,
      connect: macOwner?.connect,
      ...(platform === "win32" ? { windowsProgramFiles: windowsProgramFiles(process.env) } : {}),
    });
    platformDriver = driver;
    service = createComputerService({
      driver,
      codec: nativeImageCodec,
      displays: electronDisplays,
      screenAccess,
      blocked: options.blocked ?? (() => true),
      onCleanupError: () =>
        options.logger.warn(JSON.stringify({ module: "computer", event: "driver_release_failed" })),
      // detail / diagnostic say which driver error a failure was (the owner's opaque
      // screenshot driver_error, app_not_running); both are scrubbed of window text.
      audit: (e) =>
        options.logger.info(
          `audit ${e.method} botId=${e.botId} runId=${e.runId}${e.app ? ` app=${JSON.stringify(e.app)}` : ""}${e.target ? ` target=${JSON.stringify(e.target)}` : ""} ok=${e.ok}${e.code ? ` code=${e.code}` : ""}${e.detail ? ` detail=${JSON.stringify(e.detail)}` : ""}${e.diagnostic ? ` driver=${JSON.stringify(e.diagnostic)}` : ""} ms=${e.ms}${e.treeTiming ? ` treeMs=${JSON.stringify(e.treeTiming)}` : ""}${e.displayRead ? ` displayRead=${JSON.stringify(e.displayRead)}` : ""}${e.completed !== undefined ? ` completed=${e.completed}` : ""}`,
        ),
      onInternalError: (method, error) =>
        options.logger.error(
          `${method} driver failure ${error instanceof Error ? `${error.name}: ${scrubDriverText(error.message, 160)}` : typeof error}`,
        ),
    });
    return service;
  };

  const office = createOfficeHost({
    platform,
    driver: () => {
      get();
      if (!platformDriver) throw new RpcError(RpcErrorCodes.unsupported, "computer_unsupported");
      return platformDriver;
    },
    logger: options.logger,
    blocked: options.officeBlocked ?? options.blocked,
  });

  async function status(unavailable = false): Promise<ComputerStatus> {
    if (!isSupportedPlatform(platform))
      throw new RpcError(RpcErrorCodes.unsupported, "computer_unsupported");
    // Electron's answers can stay "granted" after the user turns a permission off (owner
    // 2026-11-13); the live probe can only lower them, never grant what the API denies.
    const live = liveProbe ? await liveProbe() : undefined;
    const accessibilityOn = !!macOwner?.permissions?.accessibility && live?.accessibility !== false;
    const screenOn = !!macOwner?.permissions?.screenRecording && live?.screenRecording !== false;
    const reason = unavailable
      ? "driver_missing"
      : macOwner && (!macOwner.permissions?.required || !accessibilityOn || !screenOn)
        ? "permission_missing"
        : await get().driverUnavailable();
    const mac = platform === "darwin";
    const driver = get().features;
    // List the protocol's feature fields one by one instead of spreading the driver: the driver
    // also carries internal flags (secureTree), and the wire schema is strict, so a spread
    // would fail result validation on every platform.
    const features: ComputerStatus["features"] = {
      backgroundClick: driver.backgroundClick,
      backgroundDrag: driver.backgroundDrag,
      backgroundKeys: driver.backgroundKeys,
      displayScreenshot: true,
    };
    return {
      platform,
      available: reason === undefined,
      ...(reason === undefined ? {} : { unavailableReason: reason }),
      permissions: {
        accessibility: mac
          ? accessibilityOn
            ? "granted"
            : "denied"
          : platform === "linux"
            ? "unknown"
            : "not_needed",
        screenRecording: mac
          ? macOwner?.permissions === undefined
            ? "unknown"
            : screenOn
              ? "granted"
              : "denied"
          : "not_needed",
        // Maintainers 2026-11-13: welcome and settings check System Events / Finder consent too.
        automation: automation ? await automation.status() : "not_needed",
      },
      features,
    };
  }

  async function dispatch<K extends Method>(
    method: K,
    params: HostComputerParams[K],
    signal?: AbortSignal,
  ): Promise<HostComputerResults[K]> {
    const s = get();
    const p = params as never;
    const table: { [M in Method]: () => Promise<HostComputerResults[M]> } = {
      "host.computer.status": status,
      "host.computer.openSystemSettings": async () => {
        if (platform !== "darwin")
          throw new RpcError(RpcErrorCodes.unsupported, "no_system_permissions");
        const kind = (params as HostComputerParams["host.computer.openSystemSettings"]).pane;
        // macOS lists an app under Accessibility / Screen Recording only after it has asked once,
        // so the user would otherwise have to find and add Pi Bot.app by hand. Asking happens only
        // on this explicit click; the background poll never prompts.
        // Automation is granted in the consent dialog; the pane only helps after a denial.
        if (kind === "automation" && automation && (await automation.request()) === "granted")
          return null;
        try {
          if (kind === "accessibility" && !systemPreferences.isTrustedAccessibilityClient(false))
            systemPreferences.isTrustedAccessibilityClient(true);
          if (
            kind === "screenRecording" &&
            systemPreferences.getMediaAccessStatus("screen") !== "granted"
          )
            await desktopCapturer.getSources({
              types: ["screen"],
              thumbnailSize: { width: 0, height: 0 },
            });
        } catch (error) {
          // Registration is a convenience; the settings pane still opens.
          options.logger.warn(
            JSON.stringify({
              module: "computer",
              event: "permission_register_failed",
              kind,
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
        }
        await shell.openExternal(
          `x-apple.systempreferences:com.apple.preference.security?${SETTINGS_PANES[kind]}`,
        );
        return null;
      },
      "host.computer.installedApps": () => s.installedApps(p),
      "host.computer.resolveAppName": () => s.resolveAppName(p, signal),
      "host.computer.grants.set": async () => {
        s.grants.set(p);
        return null;
      },
      "host.computer.grants.revoke": async () => {
        const revoked = s.grants.revoke(p);
        await s.grants.drain(p);
        return { revoked };
      },
      "host.computer.listApps": () => s.listApps(p),
      "host.computer.frontmostApp": () => s.frontmostApp(p),
      "host.computer.screenshot": () => s.screenshot(p),
      "host.computer.uiTree": () => s.uiTree(p),
      "host.computer.uiAction": () => s.uiAction(p),
      "host.computer.pointer": () => s.pointer(p),
      "host.computer.keys": () => s.keys(p),
      "host.computer.open": () => s.open(p),
      "host.computer.userActivity": () => s.userActivity(p),
    };
    return table[method]() as Promise<HostComputerResults[K]>;
  }

  async function handle<K extends Method>(
    method: K,
    params: HostComputerParams[K],
    signal?: AbortSignal,
  ): Promise<HostComputerResults[K]> {
    signal?.throwIfAborted();
    if (!macOwner) return dispatch(method, params, signal);
    const metadata =
      method === "host.computer.status" ||
      method === "host.computer.openSystemSettings" ||
      method === "host.computer.grants.set" ||
      method === "host.computer.grants.revoke";
    try {
      return await macOwner.run(
        () => {
          signal?.throwIfAborted();
          return dispatch(method, params, signal);
        },
        () =>
          (method === "host.computer.resolveAppName"
            ? { id: null }
            : method === "host.computer.installedApps"
              ? { supported: false, reason: "permission_missing" }
              : {
                  ok: false,
                  code: "permission_missing",
                  detail: "macos_permissions_required",
                }) as HostComputerResults[K],
        !metadata,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("cua_owner_")) throw error;
      if (method === "host.computer.status") return (await status(true)) as HostComputerResults[K];
      if (method === "host.computer.openSystemSettings") return dispatch(method, params, signal);
      throw new RpcError(RpcErrorCodes.internal, "cua_owner_unavailable");
    }
  }
  return {
    handle,
    officeApps: office.apps,
    officeOpen: office.open,
    /** The brain that registered grants is gone: nothing may act on them any more. */
    revokeAll() {
      const revoked = service?.grants.revokeAll() ?? 0;
      if (revoked) options.logger.info(`computer grants revoked count=${revoked}`);
    },
    async dispose() {
      office.dispose();
      powerMonitor.off("lock-screen", onLock);
      powerMonitor.off("unlock-screen", onUnlock);
      if (permissionTimer) clearInterval(permissionTimer);
      if (macOwner) await macOwner.stop();
      else await service?.dispose();
      service = undefined;
    },
  };
}
