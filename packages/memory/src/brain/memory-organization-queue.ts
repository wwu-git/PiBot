// Coordinates scheduled and owner-initiated organization without concurrent model calls.
import type { DatabaseSync } from "node:sqlite";
import type { MemoryDraftRequest } from "@pibot/agent";
import type { BrainRedactor } from "@pibot/brain/kit";
import { RpcError } from "@pibot/protocol-base";
import { BotsRepo, MemoryOrganizationsRepo, memoryMaintenanceUsage } from "@pibot/storage";
import { dayStart } from "./memory-extraction-attempt.ts";
import { logMemoryAttempt } from "./memory-maintenance-log.ts";
import { MemoryOrganizationAttempt } from "./memory-organization-attempt.ts";
import { organizationErrorDetails } from "./memory-organization-errors.ts";
import { sortUserMemories } from "./memory-scope-sort.ts";
import type { MemoryService } from "./memory-service.ts";

export interface OrganizationDeps {
  db: DatabaseSync;
  redactor: BrainRedactor;
  logger: { warn(message: string): void; info?(message: string): void };
  memory: MemoryService;
  healthChanged?(): void;
  statusChanged?(botId: string): void;
  isIdle(): boolean;
  automatic?(): boolean;
  draftMemories?: (request: MemoryDraftRequest) => Promise<{
    draft: unknown;
    tokens: number;
    costUsd?: number;
  }>;
}

/** A Bot's notes are organized at most this often per day, failures included. */
const RUNS_PER_BOT_DAY = 4;
const ORGANIZE_COUNT = 40;
const ORGANIZE_MIN = 8;
const WINDOW_MS = 7 * 86400_000;
const RETRY_MS = 24 * 3600_000;
const SCAN_MS = 5 * 60_000;

/**
 * The organization worker. It shares the extraction worker's constraints — idle-only, one
 * run at a time, durable across restarts, and the same daily budget — because both spend the same
 * auxiliary-model allowance. It never edits a note: every result is a pending proposal for the user.
 */
export class MemoryOrganizationQueue {
  private readonly repo: MemoryOrganizationsRepo;
  private readonly bots: BotsRepo;
  private readonly attempt: MemoryOrganizationAttempt;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private running: Promise<void> | undefined;
  private busy = false;

  constructor(private readonly deps: OrganizationDeps) {
    this.repo = new MemoryOrganizationsRepo(deps.db);
    this.bots = new BotsRepo(deps.db);
    this.attempt = new MemoryOrganizationAttempt(deps, this.repo);
  }

  start() {
    this.repo.recover();
    this.stopped = false;
    this.schedule(90_000);
  }

  private ownerTask: Promise<unknown> | undefined;
  private ownerRunId: string | undefined;

  async sortIntoPlace(
    runId: string,
    signal: AbortSignal,
    progress: Parameters<typeof sortUserMemories>[3],
  ) {
    if (this.busy || this.stopped || !this.deps.isIdle())
      throw new RpcError(-32011, "memory_sort_busy");
    this.busy = true;
    this.controller = new AbortController();
    const combined = AbortSignal.any([
      signal,
      this.controller.signal,
      AbortSignal.timeout(300_000),
    ]);
    this.ownerRunId = runId;
    const task = sortUserMemories(this.deps, runId, combined, progress);
    this.ownerTask = task;
    try {
      return await task;
    } finally {
      this.ownerTask = undefined;
      this.ownerRunId = undefined;
      this.controller = undefined;
      this.busy = false;
    }
  }

  async cancelSortIntoPlace(runId: string) {
    if (this.ownerRunId !== runId) return;
    this.controller?.abort();
    await this.ownerTask;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.running;
    await this.ownerTask;
  }

  /** The extraction worker yields to a running organization run, so only one model call is in flight. */
  idle() {
    return !this.busy;
  }

  usage(since: string) {
    return this.repo.usageSince(since);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delay);
    this.timer.unref?.();
  }

  private async tick() {
    if (this.stopped) return;
    try {
      await this.drain();
    } catch (error) {
      this.warn("memory_organization_tick_failed", error);
    }
    this.schedule(SCAN_MS);
  }

  /**
   * Both spec branches (over 40 notes, or a week passed with new notes) share the seven-day
   * cooldown: without it a Bot that stays above 40 would call the model on every scan while the
   * user ignores the proposals. A failed attempt retries after a day instead.
   */
  private due(
    reason: {
      activeCount: number;
      lastDoneAt: string | null;
      lastAttemptAt: string | null;
      lastChangedAt: string | null;
    },
    now: number,
  ) {
    if (reason.lastAttemptAt && now - Date.parse(reason.lastAttemptAt) < RETRY_MS) return undefined;
    if (reason.lastDoneAt && now - Date.parse(reason.lastDoneAt) < WINDOW_MS) return undefined;
    if (reason.activeCount > ORGANIZE_COUNT) return "count" as const;
    const changed =
      reason.lastChangedAt !== null &&
      (reason.lastDoneAt === null || reason.lastChangedAt > reason.lastDoneAt);
    return reason.activeCount >= ORGANIZE_MIN && changed ? ("stale" as const) : undefined;
  }

  private enqueueDue() {
    const now = Date.now();
    let count = 0;
    let cursor = "";
    for (;;) {
      const botIds = this.bots.activeIds(cursor);
      for (const botId of botIds) {
        for (const target of this.repo.targets(botId)) {
          const reason = this.due(target, now);
          if (!reason) continue;
          if (this.repo.enqueue({ botId, scope: target.scope, ownerId: target.ownerId, reason }))
            count++;
        }
      }
      if (botIds.length < 100) break;
      cursor = botIds.at(-1) ?? "";
    }
    return count;
  }

  private async drain() {
    if (this.busy || this.stopped || this.deps.automatic?.() === false || !this.deps.isIdle())
      return;
    this.busy = true;
    this.controller = new AbortController();
    try {
      this.enqueueDue();
      while (!this.stopped && this.deps.isIdle()) {
        const limit = this.attempt.limit();
        // Extraction and organization draw on the same day budget: whichever cap is reached first
        // stops both, so the configured ceiling is the real spend.
        const used = memoryMaintenanceUsage(this.deps.db, dayStart());
        if (used.costUsd >= limit.costUsd || used.tokens >= limit.tokens) break;
        const counts = this.repo.todayByBot(dayStart());
        const full = [...counts].filter(([, n]) => n >= RUNS_PER_BOT_DAY).map(([id]) => id);
        const next = this.repo.claim(full);
        if (!next) break;
        const start = performance.now();
        try {
          await this.attempt.process(next, this.controller.signal);
        } finally {
          logMemoryAttempt(this.deps, "organization", next, start);
        }
      }
    } finally {
      this.busy = false;
      this.controller = undefined;
    }
  }

  private warn(reason: string, error: unknown) {
    this.deps.logger.warn(
      JSON.stringify({
        module: "memory",
        reasonCode: reason,
        ...organizationErrorDetails(error),
      }),
    );
  }
}
