import { type MemoryDreamSummary, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  BotsRepo,
  DEFAULT_SETTINGS,
  type DreamRun,
  MemoryDreamRepo,
  transaction,
} from "@pibot/storage";
import { draftDreamOwner, dreamConflict } from "./memory-dream-plan.ts";
import { organizationErrorDetails } from "./memory-organization-errors.ts";
import type { OrganizationDeps } from "./memory-organization-queue.ts";

const scanMs = 60_000;
const idleSeconds = 3600;
const checkEnabledMs = 500;
const runMs = 300_000;
const userCursor = "!";

function localDay(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

interface DreamDeps extends OrganizationDeps {
  activity?(
    signal: AbortSignal,
  ): Promise<{ idleSeconds: number; supply: "ac" | "battery" | "unknown" } | null>;
  interrupt(): boolean;
  finished(id: string): void;
}

export class MemoryDream {
  private readonly repo: MemoryDreamRepo;
  private readonly bots: BotsRepo;
  private readonly automaticSetting;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operation: Promise<MemoryDreamSummary | null> | undefined;
  private readonly closing = new AbortController();
  private owner: AbortController | undefined;
  private stopped = false;

  constructor(private readonly deps: DreamDeps) {
    this.repo = new MemoryDreamRepo(deps.db);
    this.bots = new BotsRepo(deps.db);
    this.automaticSetting = deps.db.prepare(
      "SELECT value FROM settings WHERE key='memoryDreamEnabled'",
    );
  }

  start() {
    this.repo.recover(new Date().toISOString());
    this.repo.pruneFacts();
    this.schedule();
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, scanMs);
    this.timer.unref?.();
  }

  enabled() {
    if (!this.deps.activity) return false;
    const setting = this.automaticSetting.get();
    return setting ? setting.value === "true" : DEFAULT_SETTINGS.memoryDreamEnabled === true;
  }

  idle() {
    return !this.operation;
  }

  userWork() {
    this.owner?.abort();
  }

  private async tick() {
    try {
      if (!this.enabled() || this.stopped || !this.idle() || !this.deps.isIdle()) return;
      const last = this.repo.last();
      if (last && last.day >= localDay()) return;
      await this.run(false, this.closing.signal);
    } catch (error) {
      if (
        !this.closing.signal.aborted &&
        !(error instanceof RpcError && error.code === RpcErrorCodes.busy)
      )
        this.warn("memory_dream_schedule_failed", error);
    }
  }

  last() {
    const run = this.repo.last();
    return run ? this.summary(run) : null;
  }

  private summary(run: DreamRun): MemoryDreamSummary {
    const { day: _day, cursor: _cursor, receipts, undone, ...summary } = run;
    return { ...summary, undoable: run.status !== "running" && !undone && receipts.length > 0 };
  }

  async run(manual: true, requestSignal: AbortSignal): Promise<MemoryDreamSummary>;
  async run(manual: false, requestSignal: AbortSignal): Promise<MemoryDreamSummary | null>;
  async run(manual: boolean, requestSignal: AbortSignal): Promise<MemoryDreamSummary | null> {
    if (!this.idle() || this.stopped || !this.deps.isIdle())
      throw new RpcError(RpcErrorCodes.busy, "memory_dream_busy");
    const day = localDay();
    const previous = this.repo.last();
    const resume =
      manual &&
      previous?.day === day &&
      !previous.undone &&
      (previous.status === "failed" || previous.status === "interrupted");
    if (previous && previous.day >= day && !resume) return this.summary(previous);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      requestSignal,
      this.closing.signal,
      controller.signal,
      AbortSignal.timeout(runMs),
    ]);
    // The settings RPC has no internal subscription. Track it only while an automatic
    // attempt owns a signal, so a disabled setting can stop an in-flight model request.
    const watch = manual
      ? undefined
      : setInterval(() => {
          if (signal.aborted) return;
          try {
            if (!this.enabled()) controller.abort();
          } catch (error) {
            controller.abort();
            this.warn("memory_dream_setting_read_failed", error);
          }
        }, checkEnabledMs);
    watch?.unref?.();
    const holder = this.startRun(manual, day, previous, resume, signal);
    // Store the in-progress admission check too, so another model worker cannot overtake it.
    this.operation = holder;
    void this.operation.catch(() => {
      /* The original promise reports the failure. */
    });
    this.owner = controller;
    try {
      return await holder;
    } catch (error) {
      if (!manual && signal.aborted) return null;
      throw error;
    } finally {
      clearInterval(watch);
      this.operation = undefined;
      this.owner = undefined;
    }
  }

  private async canContinue(manual: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.deps.isIdle()) return false;
    if (manual) return true;
    if (!this.enabled()) return false;
    const activity = await this.deps.activity?.(signal);
    signal.throwIfAborted();
    return (
      activity?.supply === "ac" &&
      activity.idleSeconds >= idleSeconds &&
      this.enabled() &&
      this.deps.isIdle()
    );
  }

  private async startRun(
    manual: boolean,
    day: string,
    previous: DreamRun | undefined,
    resume: boolean,
    signal: AbortSignal,
  ) {
    if (!(await this.canContinue(manual, signal)) || !this.deps.interrupt()) {
      if (manual) throw new RpcError(RpcErrorCodes.busy, "memory_dream_busy");
      return null;
    }
    const cursor =
      previous && previous.status !== "done" && !previous.undone ? previous.cursor : null;
    const id =
      resume && previous ? previous.id : this.repo.start(day, new Date().toISOString(), cursor);
    if (resume) this.repo.resume(id);
    let status: Exclude<DreamRun["status"], "running"> = "done";
    try {
      const main = this.bots.getMain();
      const first = main && !main.archivedAt ? main.id : this.bots.activeIds()[0];
      if (first && cursor === null) {
        const run = this.read(id);
        if (!(await this.process(run, first, "user", userCursor, manual, signal)))
          status = "interrupted";
      }
      let after = cursor ?? userCursor;
      while (status === "done") {
        const batch = this.bots.activeIds(after);
        if (!batch.length) break;
        for (const botId of batch) {
          const run = this.read(id);
          if (!(await this.process(run, botId, "bot", botId, manual, signal))) {
            status = "interrupted";
            break;
          }
          after = botId;
        }
      }
    } catch (error) {
      const { error: reason } = organizationErrorDetails(error);
      status = signal.aborted
        ? "interrupted"
        : reason === "budget_exhausted"
          ? "limited"
          : "failed";
      if (status === "failed") this.warn("memory_dream_run_failed", error);
    } finally {
      this.repo.finish(id, status, new Date().toISOString());
    }
    const result = this.summary(this.read(id));
    this.repo.prune(new Date(Date.now() - 35 * 86_400_000).toISOString());
    this.repo.pruneFacts();
    this.deps.finished(id);
    return result;
  }

  private read(id: string) {
    const run = this.repo.last();
    if (!run || run.id !== id) throw new Error("dream_run_unowned");
    return run;
  }

  private async process(
    run: DreamRun,
    botId: string,
    scope: "user" | "bot",
    cursor: string,
    manual: boolean,
    signal: AbortSignal,
  ) {
    if (!(await this.canContinue(manual, signal))) return false;
    const memory = this.deps.memory;
    const owner = scope === "user" ? "user" : botId;
    const notes = memory.list(botId, scope, owner, { limit: 100 }, "active");
    const factOwner = { scope, ownerId: owner };
    if (!manual && !this.enabled()) return false;
    const plan = await draftDreamOwner(this.deps, this.repo, run, botId, factOwner, notes, signal);
    if (plan.dropped)
      this.deps.logger.warn(
        JSON.stringify({
          module: "memory",
          reasonCode: "memory_dream_proposals_dropped",
          count: Math.min(plan.dropped, 100),
        }),
      );
    if (!(await this.canContinue(manual, signal))) return false;
    const archives =
      plan.expired.length + plan.merges.reduce((count, group) => count + group.length - 1, 0);
    if (run.receipts.length + archives > 100)
      throw Object.assign(new Error("memory_dream_change_limit"), { code: "budget_exhausted" });
    const noteById = new Map(notes.map((note) => [note.id, note]));
    const result = transaction(this.deps.db, () => {
      signal.throwIfAborted();
      if (!manual && !this.enabled()) return null;
      const receipts: DreamRun["receipts"] = [];
      let merged = 0;
      let retired = 0;
      let proposed = 0;
      for (const note of plan.expired) {
        try {
          receipts.push(...memory.dreamArchive(botId, [note], "expired"));
          retired++;
        } catch (error) {
          if (!dreamConflict(error)) throw error;
        }
      }
      for (const group of plan.merges) {
        try {
          receipts.push(...memory.dreamArchive(botId, group.slice(1), "merged", group[0]));
          merged++;
        } catch (error) {
          if (!dreamConflict(error)) throw error;
        }
      }
      for (const proposal of plan.suggested) {
        const expected = proposal.ids.map((id) => noteById.get(id));
        if (!memory.dreamCurrent(botId, scope, owner, expected)) continue;
        proposed += memory.applyOrganization(botId, scope, owner, proposal, true);
      }
      for (const note of plan.projects) {
        try {
          if (memory.dreamProject(botId, note)) proposed++;
        } catch (error) {
          if (!dreamConflict(error)) this.warn("memory_dream_project_suggestion_failed", error);
        }
      }
      const result = { receipts, merged, retired, proposed };
      this.repo.checkpoint(
        run.id,
        cursor,
        result,
        plan.processedFactSequence === undefined
          ? undefined
          : { ...factOwner, through: plan.processedFactSequence },
      );
      return result;
    });
    if (!result) return false;
    if (result.receipts.length) memory.dreamChanged(botId);
    return true;
  }

  changes(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const run = this.read(id);
    if (run.status === "running" || run.undone) return [];
    return run.receipts.flatMap(({ botId, proposalId }) => {
      const snapshot = this.deps.memory.dreamChange(botId, proposalId);
      const bot = this.bots.get(botId);
      return snapshot && bot
        ? [
            {
              proposalId,
              botName: this.deps.redactor.redact(bot.name).slice(0, 1000),
              text: this.deps.redactor.redact(snapshot).slice(0, 8000),
            },
          ]
        : [];
    });
  }

  undo(id: string, signal: AbortSignal) {
    if (!this.idle()) throw new RpcError(RpcErrorCodes.busy, "memory_dream_busy");
    const run = this.read(id);
    if (run.status === "running" || run.undone || !run.receipts.length)
      throw new RpcError(RpcErrorCodes.invalidParams, "memory_dream_undo_unavailable");
    signal.throwIfAborted();
    transaction(this.deps.db, () => {
      for (const receipt of [...run.receipts].reverse()) {
        this.deps.memory.dreamUndo(receipt.botId, receipt.proposalId);
      }
      this.repo.markUndone(id);
    });
    for (const botId of new Set(run.receipts.map((receipt) => receipt.botId)))
      this.deps.memory.dreamChanged(botId);
    this.deps.finished(id);
    return { ok: true as const };
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.closing.abort();
    await this.operation?.catch(() => {
      /* Startup or the active RPC reports the failure. */
    });
  }

  private warn(reasonCode: string, error: unknown) {
    this.deps.logger.warn(
      JSON.stringify({ module: "memory", reasonCode, ...organizationErrorDetails(error) }),
    );
  }
}
