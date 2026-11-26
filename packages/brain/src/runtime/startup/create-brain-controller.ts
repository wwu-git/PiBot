// Coordinates brain admission and producer shutdown before releasing durable state.
import type { Logger } from "@pibot/observability";
import {
  BrainWakeControlSchema,
  type createPeer,
  type KernelEvents,
  type KernelMethods,
  RpcError,
  RpcErrorCodes,
  type UiNavigation,
} from "@pibot/protocol-base";
import type { AuditRepo, BackgroundPreferencesRepo, BotsRepo } from "@pibot/storage";
import type { BotService } from "../../conversations/bots/bot-service.ts";
import type { ChatService } from "../../conversations/chat/chat.ts";
import { abortable } from "../../core/abort.ts";
import { type CapabilityHandle, stopCapabilities } from "../../core/capability.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import type { startBrain } from "../../index.ts";
import type { SearchService } from "../../integrations/search/search-service.ts";
import type { NetworkProxyService } from "../../integrations/system/network-proxy.ts";
import type { LocalService } from "../../local-service.ts";
import { SHUTDOWN_DRAIN_TIMEOUT_MS } from "../continuation/continuation-limits.ts";
import type { RunRetention } from "../history/run-retention.ts";
import type { ModelProvidersPort } from "../models/port.ts";
import type { BrainSleep } from "../queue/brain-sleep.ts";
import type { ManagedResourcesPort } from "../workspaces/port.ts";

interface StartupContext {
  updateTerminalPath(path: readonly string[]): void;
  /** Set by registerCapabilities; absent only if registration never ran. */
  ports?: { get<T>(name: string): T | undefined };
  stopping: boolean;
  sleepService: BrainSleep;
  backgroundPreferences: BackgroundPreferencesRepo;
  providerTests: AbortController;
  interactiveAttached: boolean;
  stopSessionRecovery(): Promise<void>;
  stopStartupMaintenance(): Promise<void>;
  loopWatch?: { stop(): void };
  quietForMs(): number;
  markPhase(phase: string): void;
  chat: ChatService;
  groups: GroupOrchestrationPort;
  clientChange: Promise<void>;
  modelPort: ModelProvidersPort | undefined;
  capabilities: LocalService;
  interactiveRequests: Set<Promise<unknown>>;
  interactiveDrainHealthy: boolean;
  logger: import("@pibot/observability").Logger;
  peer: ReturnType<typeof createPeer<typeof KernelMethods, typeof KernelEvents>>;
  bots: BotsRepo;
  audit: AuditRepo;
  network: NetworkProxyService;
  capabilityHandles: CapabilityHandle[];
  search: SearchService;
  botBusiness: BotService;
  unsubscribeCheckpoints: (() => void) | undefined;
  requests: Set<Promise<unknown>>;
  resources: ManagedResourcesPort;
  networkCleanup: (() => Promise<void>) | undefined;
  runRetention: RunRetention;
  db: import("node:sqlite").DatabaseSync;
}
/**
 * Awaits in-flight RPC work with a hard bound. Shutdown used to await these sets without a limit,
 * which kept the brain from ever exiting once a call stopped settling. Continuing after the bound
 * is
 * safe because every owner of these calls was already stopped, cancelled or closed above: a late
 * settlement can only re-observe a closed port, while blocking here would keep the database and the
 * whole app open forever. The log line carries only how many are still outstanding, never payloads.
 */
async function settleWithin(
  logger: Logger,
  requests: Iterable<Promise<unknown>>,
  event: string,
): Promise<void> {
  const pending = [...requests];
  let remaining = pending.length;
  try {
    await abortable(
      Promise.allSettled(
        pending.map((request) =>
          request.then(
            () => void remaining--,
            () => void remaining--,
          ),
        ),
      ),
      AbortSignal.timeout(SHUTDOWN_DRAIN_TIMEOUT_MS),
    );
  } catch {
    logger.warn(JSON.stringify({ module: "brain", event, undrained: remaining }));
  }
}

export function createBrainController(ctx: StartupContext): Awaited<ReturnType<typeof startBrain>> {
  let stopped: Promise<void> | undefined;
  return {
    updateTerminalPath(path) {
      ctx.updateTerminalPath(path);
    },
    quietForMs: () => ctx.quietForMs(),
    markPhase: (phase) => ctx.markPhase(phase),
    backgroundSleep(input) {
      if (ctx.stopping) return Promise.reject(new RpcError(RpcErrorCodes.closed, "Brain stopping"));
      return ctx.sleepService.control(BrainWakeControlSchema.parse(input));
    },
    backgroundActivity() {
      return ctx.sleepService.interrupt();
    },
    backgroundPreferences(value) {
      if (value && !ctx.sleepService.interrupt())
        throw new RpcError(RpcErrorCodes.closed, "brain_sleep_committed");
      return value ? ctx.backgroundPreferences.set(value) : ctx.backgroundPreferences.get();
    },
    desktopClient(connected) {
      if (!ctx.sleepService.interrupt())
        return Promise.reject(new RpcError(RpcErrorCodes.closed, "brain_sleep_committed"));
      // Initial attachment sync may report offline without a desktop having quit.
      const leaving = !connected && ctx.interactiveAttached;
      // Close admission synchronously; a preflight accepted before this boundary must drain.
      if (!connected) {
        if (leaving) ctx.capabilities.memoryExtraction?.pause();
        ctx.ports
          ?.get<import("../../core/capability.ts").InteractiveClientPort>("interactive-client")
          ?.setInteractive("quit");
        ctx.providerTests.abort();
        ctx.interactiveAttached = false;
        ctx.chat.admitInteractive(false);
        ctx.groups.admitInteractive(false);
      }
      const change = ctx.clientChange.then(async () => {
        if (!connected) {
          const drained = await Promise.allSettled([
            ctx.chat.drainInteractive(),
            ctx.groups.drainInteractive(),
            ctx.modelPort?.drainInteractive(),
            // Quitting the app (scheduling may continue without it) ends background
            // commands; with no chat open nobody could see or stop them.
            ctx.capabilities.background.stopAll("app_quit"),
          ]);
          // Bounded: an RPC that never settles must not keep admission closed forever.
          await settleWithin(ctx.logger, ctx.interactiveRequests, "interactive_requests_timeout");
          if (leaving && !ctx.stopping) await ctx.capabilities.memoryExtraction?.saveOnExit();
          if (drained.some((result) => result.status === "rejected"))
            throw new Error("interactive_drain_unconfirmed");
        } else {
          await ctx.sleepService.ensureWorking();
          if (!ctx.interactiveDrainHealthy) throw new Error("interactive_drain_unconfirmed");
          ctx.providerTests = new AbortController();
          ctx.interactiveAttached = true;
          ctx.ports
            ?.get<import("../../core/capability.ts").InteractiveClientPort>("interactive-client")
            ?.setInteractive("available");
          ctx.capabilities.memoryExtraction?.resume();
          ctx.chat.admitInteractive(true);
          ctx.groups.admitInteractive(true);
        }
      });
      ctx.clientChange = change.catch(() => {
        ctx.interactiveDrainHealthy = false;
        ctx.logger.error("Interactive client drain failed; admission remains closed");
        try {
          ctx.peer.emit("runtime.health", {
            healthy: false,
            reason: "interactive_drain_failed",
            botIds: [],
          });
        } catch {
          // The drain already failed; failing to report it must not replace the stored error.
          ctx.logger.warn("Interactive drain failure not reported");
        }
        try {
          // No Bot owns a client-wide failure; file it under the main Bot so it stays visible.
          const botId = ctx.bots.getMain()?.id;
          if (botId)
            ctx.audit.append({
              botId,
              kind: "runtime.drain_failed",
              summary: "Interactive client drain failed / 交互排空失败",
              detail: { reasonCode: "interactive_drain_failed" },
            });
          else ctx.logger.warn("Interactive drain audit skipped: no main bot");
        } catch {
          // Audit is secondary here; never let it replace the stored drain failure.
          ctx.logger.warn("Interactive drain audit not written");
        }
      });
      return change;
    },
    navigate(target: UiNavigation) {
      if (ctx.stopping) return;
      if (!ctx.sleepService.interrupt()) return;
      if ("view" in target) {
        const main = target.view === "new-chat" ? ctx.bots.getMain() : undefined;
        ctx.peer.emit(
          "ui.navigate",
          main && !main.archivedAt ? { view: "new-chat", botId: main.id } : target,
        );
        return;
      }
      const bot = ctx.bots.get(target.botId);
      if (bot && !bot.archivedAt) ctx.peer.emit("ui.navigate", target);
    },
    stop() {
      stopped ??= (async () => {
        ctx.stopping = true;
        const extraction = ctx.capabilities.memoryExtraction;
        extraction?.pause();
        const sessionRecoveryStopped = ctx.stopSessionRecovery();
        await ctx.stopStartupMaintenance();
        ctx.sleepService.dispose();
        await ctx.sleepService.settled();
        ctx.providerTests.abort();
        ctx.network.cancel();
        // Capability stop closes admission before kernel drains; workspace evidence has a late
        // dispose below. Any failed drain must prevent database closure.
        await stopCapabilities(ctx.capabilityHandles);
        await ctx.runRetention.stop();
        ctx.search.cancel();
        ctx.modelPort?.cancelAll();
        await ctx.capabilities.cancel();
        // Every wait below is bounded (15 s each). Before, a run whose SDK never drained
        // kept the app from ever quitting after a network drop. A run still undrained at the bound
        // is marked interrupted (queue stopStep) before the database closes; a late write from it
        // then fails against the closed handle instead of corrupting anything (SQLite transactions
        // are atomic), which is the trade accepted here over an app that cannot exit.
        // Queue cleanup still consumes group workplace/authority ports; drain consumers first.
        await ctx.chat.stop();
        await ctx.groups.stop();
        await ctx.botBusiness.stop();
        await extraction?.saveOnExit();
        ctx.unsubscribeCheckpoints?.();
        await settleWithin(ctx.logger, ctx.requests, "shutdown_requests_timeout");
        await ctx.modelPort?.stop();
        // Dedicated SRT operations own SQLite receipts beyond the RPC caller's cancellation.
        await ctx.resources.dispose();
        // Live MCP servers must drain before the database closes.
        // Cancelled RPC callers may settle before catalog/keyring owners do.
        // Keep the network adapter installed until those owners can no longer issue requests.
        await ctx.modelPort?.settled();
        await sessionRecoveryStopped;
        await ctx.search.settled();
        await ctx.networkCleanup?.();
        await ctx.capabilities.dispose();
        const steps = [
          () => ctx.peer.dispose(),
          () => ctx.logger.info("Brain stopped"),
          () => ctx.loopWatch?.stop(),
          () => ctx.db.close(),
        ];
        for (const step of steps) {
          try {
            await step();
          } catch {
            // A failed cleanup must not prevent closing the port or database.
            try {
              ctx.logger.error("Brain cleanup failed");
            } catch {
              /* Logging may also be unavailable during shutdown. */
            }
          }
        }
      })();
      return stopped;
    },
  };
}
