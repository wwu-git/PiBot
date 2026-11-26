// Inject the runner host’s trusted facts into computer-use drivers.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AuditEntry,
  ComputerError,
  type ComputerService,
  createComputerService,
  createCuaLoader,
  createPlatformDriver,
  isSupportedPlatform,
} from "@pibot/computer";
import { windowsProgramFiles } from "@pibot/execution";
import type { ComputerStatus, HostComputerParams, HostComputerResults } from "@pibot/protocol-base";
import { probe } from "./process.ts";
import { createRunnerSession } from "./session.ts";

type Method = keyof HostComputerParams;
type Permissions = ComputerStatus["permissions"];
const PANES = {
  accessibility: "Accessibility",
  screenRecording: "ScreenCapture",
  automation: "Automation",
} as const;

export function createRunnerComputerHost(options: {
  resourcesDir: string;
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  onAudit(entry: AuditEntry): void;
  onDiagnostic(code: string): void;
  blocked?(app: { id: string; name: string }): boolean;
}) {
  if (!isSupportedPlatform(options.platform)) throw new Error("runner_computer_unsupported");
  const platform = options.platform;
  const source = import.meta.url.endsWith(".ts");
  const moduleRoot = join(options.resourcesDir, "computer", "node_modules");
  const loader = source
    ? createCuaLoader()
    : createCuaLoader(
        () => pathToFileURL(join(moduleRoot, "@trycua", "cua-driver", "dist", "index.js")).href,
      );
  const session = createRunnerSession(platform, options.env);
  let displaySupported = false;
  let service: ComputerService | undefined;
  let creating: Promise<ComputerService> | undefined;
  let closed = false;
  let revoking = false;
  let blocklist = new Set<string>(["*"]);
  let current: Permissions = {
    accessibility:
      platform === "darwin" ? "unknown" : platform === "win32" ? "not_needed" : "unknown",
    screenRecording: platform === "darwin" ? "unknown" : "not_needed",
    automation: platform === "darwin" ? "ask_per_app" : "not_needed",
  };
  const pending = new Set<Promise<unknown>>();
  const permissions = async (): Promise<Permissions> => {
    if (platform !== "darwin") return current;
    try {
      const value = (await loader.load()).currentMacOsPermissionStatus();
      const next: Permissions = {
        accessibility: value.accessibility ? "granted" : "denied",
        screenRecording: value.screenRecording ? "granted" : "denied",
        automation: "ask_per_app",
      };
      if (
        (current.accessibility === "granted" && next.accessibility !== "granted") ||
        (current.screenRecording === "granted" && next.screenRecording !== "granted")
      )
        service?.grants.revokeAll();
      current = next;
    } catch {
      current = { accessibility: "unknown", screenRecording: "unknown", automation: "ask_per_app" };
    }
    return current;
  };
  const get = async () => {
    if (closed || revoking) throw new ComputerError("cancelled", "computer_closed");
    creating ??= (async () => {
      const { createRunnerImageCodec } = await import("./codec.ts");
      const imageEntry = source
        ? createRequire(import.meta.url).resolve("@napi-rs/image")
        : join(moduleRoot, "@napi-rs", "image", "index.js");
      const native = (await import(
        pathToFileURL(imageEntry).href
      )) as typeof import("@napi-rs/image");
      const runnerImageCodec = createRunnerImageCodec(native);
      const driver = createPlatformDriver({
        platform,
        load: loader.load,
        session,
        ...(platform === "win32" ? { windowsProgramFiles: windowsProgramFiles(options.env) } : {}),
      });
      const captureDisplay = driver.captureDisplay?.bind(driver);
      displaySupported = !!captureDisplay;
      service = createComputerService({
        displays: captureDisplay
          ? {
              capture: async (index, signal) => {
                const capture = await captureDisplay(index, signal);
                const image = runnerImageCodec.decode(capture.bytes);
                if (image.width !== capture.pixels.width || image.height !== capture.pixels.height)
                  throw new ComputerError("driver_error", "display_dimensions_changed");
                return { image, bounds: capture.bounds };
              },
              displayFor: (rect) => (rect.x >= 0 && rect.y >= 0 ? 0 : undefined),
            }
          : undefined,
        driver,
        codec: runnerImageCodec,
        screenAccess: () =>
          current.screenRecording === "granted"
            ? "granted"
            : current.screenRecording === "denied"
              ? "denied"
              : "unknown",
        blocked: (app) =>
          blocklist.has("*") || blocklist.has(app.id.toLowerCase()) || !!options.blocked?.(app),
        audit: options.onAudit,
        onCleanupError: () => options.onDiagnostic("computer_cleanup_failed"),
        onInternalError: () => options.onDiagnostic("computer_driver_failed"),
      });
      return service;
    })();
    return creating;
  };
  const status = async (signal: AbortSignal): Promise<ComputerStatus> => {
    const permission = await permissions();
    let reason: string | undefined;
    if (platform === "darwin" && permission.accessibility !== "granted")
      reason = "accessibility_permission_missing";
    else if (platform === "darwin" && permission.screenRecording !== "granted")
      reason = "screen_recording_permission_missing";
    else if (platform !== "darwin") {
      try {
        if ((await session(signal)).locked) reason = "screen_locked";
      } catch {
        reason = "interactive_session_unavailable";
      }
    }
    const service = await get();
    reason ??= await service.driverUnavailable();
    return {
      platform,
      available: !reason,
      ...(reason ? { unavailableReason: reason } : {}),
      permissions: permission,
      features: {
        backgroundClick: service.features.backgroundClick,
        backgroundDrag: service.features.backgroundDrag,
        backgroundKeys: service.features.backgroundKeys,
        displayScreenshot: displaySupported,
      },
    };
  };
  async function dispatch<K extends Method>(
    method: K,
    params: HostComputerParams[K],
    signal: AbortSignal,
  ): Promise<HostComputerResults[K]> {
    signal.throwIfAborted();
    if (closed || revoking) throw new ComputerError("cancelled", "computer_closed");
    if (method === "host.computer.status") return (await status(signal)) as HostComputerResults[K];
    if (method === "host.computer.openSystemSettings") {
      if (platform !== "darwin") throw new ComputerError("unsupported", "no_system_permissions");
      const pane = (params as HostComputerParams["host.computer.openSystemSettings"]).pane;
      await probe(
        "/usr/bin/open",
        [`x-apple.systempreferences:com.apple.preference.security?Privacy_${PANES[pane]}`],
        signal,
      );
      return null as HostComputerResults[K];
    }
    const s = await get();
    signal.throwIfAborted();
    if (closed || revoking) throw new ComputerError("cancelled", "computer_closed");
    if (method === "host.computer.grants.set") {
      s.grants.set(params as HostComputerParams["host.computer.grants.set"]);
      return null as HostComputerResults[K];
    }
    if (method === "host.computer.grants.revoke") {
      const p = params as HostComputerParams["host.computer.grants.revoke"];
      const revoked = s.grants.revoke(p);
      await s.grants.drain(p);
      return { revoked } as HostComputerResults[K];
    }
    if (method === "host.computer.installedApps")
      return (await s.installedApps(
        params as HostComputerParams["host.computer.installedApps"],
        signal,
      )) as HostComputerResults[K];
    if (method === "host.computer.resolveAppName")
      return (await s.resolveAppName(
        params as HostComputerParams["host.computer.resolveAppName"],
        signal,
      )) as HostComputerResults[K];
    if (platform === "darwin") {
      const p = await permissions();
      if (p.accessibility !== "granted" || p.screenRecording !== "granted")
        return {
          ok: false,
          code: "permission_missing",
          detail: p.accessibility !== "granted" ? "accessibility" : "screen_recording",
        } as HostComputerResults[K];
    } else {
      try {
        if ((await session(signal)).locked)
          return { ok: false, code: "screen_locked" } as HostComputerResults[K];
      } catch {
        return {
          ok: false,
          code: "unsupported",
          detail: "interactive_session_unavailable",
        } as HostComputerResults[K];
      }
    }
    const p = params as never;
    const table: { [M in Method]?: () => Promise<HostComputerResults[M]> } = {
      "host.computer.installedApps": () => s.installedApps(p, signal),
      "host.computer.resolveAppName": () => s.resolveAppName(p, signal),
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
    const operation = table[method];
    if (!operation) throw new ComputerError("unsupported", "computer_method_unsupported");
    const token = params && "token" in params ? params.token : undefined;
    const abort = () => {
      if (token) s.grants.revoke({ token });
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      return (await operation()) as HostComputerResults[K];
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted && token) await s.grants.drain({ token });
    }
  }
  return {
    permissions,
    setBlocklist(ids: readonly string[]) {
      const next = new Set(ids.map((id) => id.toLowerCase()));
      if (next.size !== blocklist.size || [...next].some((id) => !blocklist.has(id)))
        service?.grants.revokeAll();
      blocklist = next;
    },
    call<K extends Method>(method: K, params: HostComputerParams[K], signal: AbortSignal) {
      const operation = dispatch(method, params, signal);
      pending.add(operation);
      void operation.finally(() => pending.delete(operation)).catch(() => {});
      return operation;
    },
    async revokeAll() {
      revoking = true;
      try {
        service?.grants.revokeAll();
        await Promise.allSettled([...pending]);
        service?.grants.revokeAll();
        if (service) {
          await service.dispose();
          service = undefined;
          creating = undefined;
        }
      } finally {
        revoking = false;
      }
    },
    async dispose() {
      closed = true;
      service?.grants.revokeAll();
      await Promise.allSettled([...pending]);
      await creating?.then((value) => value.dispose());
    },
  };
}
