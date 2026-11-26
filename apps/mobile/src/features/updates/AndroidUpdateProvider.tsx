/** Owns one update check, download and system-settings handoff for the app. */

import { addNetworkStateListener, getNetworkStateAsync } from "expo-network";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import { pibotAndroid } from "../../../modules/pibot-android/index.ts";
import { useOffline, useOfflineEngine } from "../../offline/OfflineProvider.tsx";
import { useRuntime } from "../../runtime/context.tsx";
import {
  type AndroidUpdate,
  downloadAndroidUpdate,
  fetchAndroidUpdate,
  installAndroidUpdate,
  isNewerUpdate,
  removeCachedUpdate,
} from "./android-update.ts";

type Phase =
  | "available"
  | "downloading"
  | "verify_failed"
  | "network_error"
  | "unknown_sources"
  | "installing"
  | "installed";

interface State {
  update?: AndroidUpdate;
  phase?: Phase;
  progress: number;
  downloadedBytes: number;
}

interface InstallAttempt {
  controller: AbortController;
  handingOff: boolean;
}

const emptyState: State = { progress: 0, downloadedBytes: 0 };
const lastCheckKey = "android-update:last-check";
const checkIntervalMs = 24 * 60 * 60 * 1000;

const Context = createContext<ReturnType<typeof useUpdateOwner> | null>(null);

export function AndroidUpdateProvider({ children }: { children: ReactNode }) {
  const owner = useUpdateOwner();
  return <Context.Provider value={owner}>{children}</Context.Provider>;
}

export function useAndroidUpdate() {
  const owner = useContext(Context);
  if (!owner) throw new Error("android_update_owner_unavailable");
  return owner;
}

function useUpdateChecks(onResult: (update: AndroidUpdate) => void, busy: () => boolean) {
  const runtime = useRuntime();
  const data = runtime.storage.data;
  const offline = useOfflineEngine();
  const { unreachable } = useOffline();
  const current = useRef<AbortController | undefined>(undefined);
  const [checking, setChecking] = useState(false);

  const check = useCallback(
    async (automatic: boolean) => {
      const offlineMode = () => {
        const { selectedId, status } = runtime.getSnapshot();
        return !!selectedId && (status === "offline" || offline.getSnapshot().unreachable);
      };
      if (Platform.OS !== "android" || current.current || busy() || offlineMode()) return;
      const controller = new AbortController();
      const { signal } = controller;
      current.current = controller;
      setChecking(true);
      const abortOffline = () => {
        if (offlineMode()) controller.abort();
      };
      const unsubscribe = offline.subscribe(abortOffline);
      const unsubscribeRuntime = runtime.subscribe(abortOffline);
      const networkListener = addNetworkStateListener((network) => {
        if (network.isConnected === false || network.isInternetReachable === false)
          controller.abort();
      });
      try {
        const network = await getNetworkStateAsync();
        if (
          signal.aborted ||
          network.isConnected === false ||
          network.isInternetReachable === false
        )
          return;
        if (automatic) {
          const last = await data.get(lastCheckKey);
          if (
            typeof last === "number" &&
            Number.isFinite(last) &&
            Date.now() - last < checkIntervalMs
          )
            return;
        }
        signal.throwIfAborted();
        // Persist the attempt before networking, including failed requests and manual checks.
        await data.put(lastCheckKey, Date.now());
        signal.throwIfAborted();
        const update = await fetchAndroidUpdate(signal);
        if (!signal.aborted && !busy()) onResult(update);
      } catch {
        // A failed background check leaves the current offer alone and reports no raw network error.
      } finally {
        networkListener.remove();
        unsubscribeRuntime();
        unsubscribe();
        if (current.current === controller) {
          current.current = undefined;
          setChecking(false);
        }
      }
    },
    [busy, data, offline, onResult, runtime],
  );

  useEffect(() => {
    let disposed = false;
    // Defer until mount is settled so an effect replay cannot consume the startup check.
    void Promise.resolve().then(() => {
      if (!disposed) void check(true);
    });
    return () => {
      disposed = true;
      current.current?.abort();
    };
  }, [check]);

  return { check: () => check(false), checkDisabled: checking || unreachable || busy() };
}

function clearCachedUpdate() {
  try {
    removeCachedUpdate();
  } catch {
    // A later download must still remove the old file before opening a new one.
  }
}

function useUpdateOwner() {
  const [state, setState] = useState<State>(emptyState);
  const attempt = useRef<InstallAttempt | undefined>(undefined);
  const verified = useRef<string | undefined>(undefined);
  const installerTrip = useRef<
    { leftApp: boolean; returned: boolean; started: boolean } | undefined
  >(undefined);
  const settingsTrip = useRef<{ leftApp: boolean } | undefined>(undefined);

  const busy = useCallback(
    () => !!(attempt.current || verified.current || installerTrip.current),
    [],
  );
  const onResult = useCallback((update: AndroidUpdate) => {
    setState(isNewerUpdate(update) ? { ...emptyState, update, phase: "available" } : emptyState);
  }, []);
  const checks = useUpdateChecks(onResult, busy);

  const start = useCallback(
    async (reuseVerified = false) => {
      const update = state.update;
      if (!update || attempt.current || settingsTrip.current || installerTrip.current) return;
      if (reuseVerified !== !!verified.current) return;

      const controller = new AbortController();
      const job = { controller, handingOff: false };
      const { signal } = controller;
      attempt.current = job;
      setState((current) => ({ ...current, ...emptyState, phase: "downloading" }));
      try {
        const uri =
          verified.current ??
          (await downloadAndroidUpdate(
            update,
            (progress) => {
              if (signal.aborted) return;
              setState((current) => ({
                ...current,
                progress,
                downloadedBytes: Math.round(update.size * progress),
              }));
            },
            signal,
          ));
        signal.throwIfAborted();
        job.handingOff = true;
        setState((current) => ({
          ...current,
          phase: "installing",
          progress: 1,
          downloadedBytes: update.size,
        }));
        const trip = { leftApp: false, returned: false, started: false };
        installerTrip.current = trip;
        const result = await installAndroidUpdate(uri);
        if (result === "unknown_sources") installerTrip.current = undefined;
        else {
          trip.started = true;
          if (trip.returned) {
            installerTrip.current = undefined;
            clearCachedUpdate();
          }
        }
        verified.current = result === "unknown_sources" ? uri : undefined;
        if (!signal.aborted) {
          setState((current) => ({
            ...current,
            phase: result === "unknown_sources" ? "unknown_sources" : "installed",
          }));
        }
      } catch (error) {
        installerTrip.current = undefined;
        verified.current = undefined;
        clearCachedUpdate();
        const phase = signal.aborted
          ? "available"
          : error instanceof Error && error.message === "update_integrity_failed"
            ? "verify_failed"
            : "network_error";
        setState((current) => ({ ...current, ...emptyState, phase }));
      } finally {
        attempt.current = undefined;
      }
    },
    [state.update],
  );

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const listener = AppState.addEventListener("change", (next) => {
      const installer = installerTrip.current;
      if (installer && next === "background") installer.leftApp = true;
      if (installer?.leftApp && next === "active") {
        installer.returned = true;
        if (installer.started) {
          installerTrip.current = undefined;
          clearCachedUpdate();
          setState((current) => ({ ...current }));
        }
      }
      const trip = settingsTrip.current;
      if (!trip) return;
      if (next === "background") trip.leftApp = true;
      if (next === "active" && trip.leftApp) {
        settingsTrip.current = undefined;
        void start(true);
      }
    });
    return () => listener.remove();
  }, [start]);

  useEffect(() => {
    // Android can replace the process on install, before the original owner sees it return.
    if (Platform.OS === "android" && !busy()) clearCachedUpdate();
    return () => {
      settingsTrip.current = undefined;
      if (!attempt.current?.handingOff) attempt.current?.controller.abort();
      if (verified.current && !attempt.current) clearCachedUpdate();
      verified.current = undefined;
    };
  }, [busy]);

  const settings = async () => {
    if (!pibotAndroid || !verified.current || settingsTrip.current) return;
    const trip = { leftApp: false };
    settingsTrip.current = trip;
    try {
      await pibotAndroid.openInstallSettings();
    } catch {
      // Keep the verified offer so the user can retry opening Android settings.
      if (settingsTrip.current === trip) settingsTrip.current = undefined;
    }
  };

  return {
    state,
    start: () => start(),
    cancel: () => {
      const job = attempt.current;
      if (job && !job.handingOff) job.controller.abort();
    },
    settings,
    ...checks,
  };
}
