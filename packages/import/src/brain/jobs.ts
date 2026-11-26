// A single job owner keeps preview authorizations, progress, and cancellation consistent.
import { randomUUID } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { type CapabilityContext, storedAttachmentFile } from "@pibot/brain/kit";
import type { ImportPreview, ImportSource, ImportStatus } from "@pibot/import-contract";
import type { ImportParams } from "@pibot/import-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { ImportStore } from "../store/index.ts";
import type { ImportMemoryScope } from "../store/memories.ts";
import { adapters } from "./adapter.ts";
import { ImportCleanup } from "./cleanup.ts";
import { exportAdapter } from "./exports/index.ts";
import { fixtureAdapter } from "./fixture.ts";
import {
  configRootFor,
  isLocalSource,
  noteSummary,
  supportsLocalSources,
} from "./local/locations.ts";
import { readProjectNote } from "./local/text.ts";
import { ProjectImport } from "./project.ts";
import { summarize } from "./records.ts";
import { ImportReviews } from "./reviews.ts";
import { failureReason, runImport } from "./run.ts";
import { selectedInput } from "./source.ts";
import { startPlan } from "./start.ts";

const PREVIEW_MS = 90_000;

type Running = { importId: string; controller: AbortController; done: Promise<ImportStatus> };

export class ImportJobs {
  private readonly adapters = adapters(
    fixtureAdapter,
    exportAdapter("chatgpt"),
    exportAdapter("claude"),
  );
  private readonly closing = new AbortController();
  private readonly cleanup: ImportCleanup;
  private readonly project: ProjectImport;
  private previewing?: Promise<ImportPreview | null>;
  readonly reviews: ImportReviews;
  private active?: Running;
  private undoReservation?: Promise<void>;

  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportStore,
  ) {
    this.project = new ProjectImport(ctx, store.projects);
    this.reviews = new ImportReviews(
      ctx,
      store,
      this.project,
      this.closing.signal,
      () => !!this.previewing,
    );
    this.cleanup = new ImportCleanup(
      store,
      this.closing.signal,
      (status) => this.publish(status),
      () => this.ctx.logger.error("import_cleanup_failed"),
      async (id, signal) => {
        const botId = this.store.target(id);
        if (typeof botId !== "string") throw new Error("import_job_missing");
        await this.project.restore(id, botId, signal);
        await this.removeAttachmentFiles(id);
      },
    );
  }

  /** Long-message files go with their messages; a startup sweep would also catch leftovers. */
  private async removeAttachmentFiles(importId: string) {
    const files = this.store.attachmentFiles(importId);
    if (!files.length) return;
    const dataDir = await realpath(this.ctx.local.deps.dataDir);
    await Promise.all(
      files.map(({ path }) => rm(storedAttachmentFile(dataDir, path), { force: true })),
    );
  }

  /** The import history, each batch with the same status (and cleanup state) as `status`. */
  history({ before, limit = 20 }: ImportParams<"import.history">) {
    const page = this.store.history(before, limit);
    return {
      items: page.rows.flatMap(({ id, createdAt }) => {
        const status = this.cleanup.status(id);
        return status ? [{ ...status, createdAt }] : [];
      }),
      next: page.next,
    };
  }

  idle() {
    return (
      !this.active &&
      !this.undoReservation &&
      !this.previewing &&
      !this.reviews.busy() &&
      this.cleanup.idle()
    );
  }

  recover() {
    this.store.recover();
    void this.cleanup.wake();
  }

  async detect(source: ImportSource, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.closing.signal, AbortSignal.timeout(PREVIEW_MS)]);
    if (isLocalSource(source) && !supportsLocalSources(this.ctx.local.deps.platform))
      return { available: false };
    for await (const available of this.adapters[source].detect(signal)) {
      signal.throwIfAborted();
      return { available: available && !!this.ctx.host.pickFile };
    }
    return { available: false };
  }

  async preview(source: ImportSource, caller: AbortSignal) {
    this.closing.signal.throwIfAborted();
    if (this.previewing || this.reviews.busy())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_busy");
    const work = this.openPreview(source, caller);
    this.previewing = work;
    try {
      return await work;
    } finally {
      this.previewing = undefined;
    }
  }

  private async openPreview(source: ImportSource, caller: AbortSignal) {
    this.reviews.clear();
    const deadline = AbortSignal.timeout(PREVIEW_MS);
    const signal = AbortSignal.any([caller, this.closing.signal, deadline]);
    try {
      if (!(await this.detect(source, signal)).available)
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      const path = await this.ctx.host.pickFile?.(signal, this.pickerOptions(source));
      signal.throwIfAborted();
      if (!path) return null;
      const input = await selectedInput(this.ctx.local.deps, path, signal, source);
      const { summary, paths } = input.projectNote
        ? await readProjectNote(input, signal).then(() =>
            noteSummary(this.ctx.local.deps.platform, path),
          )
        : await summarize(this.adapters[source], input, signal);
      const preview = { importId: randomUUID(), source, ...summary };
      signal.throwIfAborted();
      this.reviews.set(preview, input, paths);
      return preview;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (deadline.aborted)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_timeout");
      signal.throwIfAborted();
      const reason = failureReason(error);
      if (reason === "internal") throw error;
      if (reason === "unsupported")
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      if (reason === "format" && source !== "fixture")
        throw new RpcError(
          RpcErrorCodes.invalidParams,
          `import_format_${source.replace("-", "_")}`,
        );
      throw new RpcError(RpcErrorCodes.invalidParams, `import_${reason}`);
    }
  }

  private pickerOptions(source: ImportSource) {
    const { platform, userHome } = this.ctx.local.deps;
    if (!isLocalSource(source) || !supportsLocalSources(platform)) return undefined;
    const subdirectory = source === "codex" ? "sessions" : "projects";
    return { defaultPath: join(configRootFor(source, platform, userHome), subdirectory) };
  }

  start(
    importId: string,
    botId: string,
    options: Omit<ImportParams<"import.start">, "importId" | "botId"> = {},
  ) {
    this.closing.signal.throwIfAborted();
    const existing = this.store.get(importId);
    if (existing) {
      if (this.store.target(importId) !== botId)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_target");
      return this.status(importId);
    }
    if (this.active || this.undoReservation || this.reviews.busy() || this.store.unfinished())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    const selection = this.reviews.requireSelection(importId);
    const plan = startPlan(selection, botId, options, {
      store: this.store,
      port: this.ctx.local.memoryImportDistillation,
    });
    this.store.create(importId, selection.preview.source, botId);
    this.reviews.clear();
    const controller = new AbortController();
    const done = runImport({
      ctx: this.ctx,
      preview: selection.preview,
      input: selection.input,
      botId,
      ...plan,
      projectService: this.project,
      cancel: controller.signal,
      closing: this.closing.signal,
      adapter: this.adapters[selection.preview.source],
      redactor: this.ctx.redactor,
      logger: this.ctx.logger,
      cleanup: this.cleanup,
      store: this.store,
      progress: (status) => this.publish(status),
    })
      .then(({ status, change }) => {
        if (status.state === "completed") {
          this.changedTopics(importId);
          for (const owner of change?.memories ?? []) this.changedMemories(owner, "added");
          if (change?.persona) this.changedPersona(change.persona);
          this.publish(status);
        }
        return status;
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = { importId, controller, done };
    // A later status/cancel call still receives the persisted result or the original failure.
    void done.catch(() => this.ctx.logger.error("import_cleanup_failed"));
    return this.status(importId);
  }

  status(importId: string) {
    const status = this.cleanup.status(importId);
    if (!status) throw new RpcError(RpcErrorCodes.invalidParams, "import_unknown");
    return status;
  }

  async cancel(importId: string) {
    const status = this.status(importId);
    if (status.state !== "running" || status.cleanup || this.active?.importId !== importId)
      return status;
    this.active.controller.abort();
    return this.active.done;
  }

  async undo(importId: string) {
    this.closing.signal.throwIfAborted();
    if (this.undoReservation) throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    let release = () => {};
    this.undoReservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const status = this.status(importId);
      if (status.state === "undone") return status;
      if (status.cleanup) {
        void this.cleanup.wake(importId);
        return this.status(importId);
      }
      if (this.active) throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
      if (status.state !== "completed")
        throw new RpcError(RpcErrorCodes.invalidParams, "import_not_completed");
      // Hand-edited project files no longer block undo: cleanup keeps and counts them.
      this.project.assertUndoable(importId);
      this.closing.signal.throwIfAborted();
      // No yield between these checks and the transaction; start and other undos hold the same reservation.
      if (this.active || this.store.unfinished() || this.status(importId).state !== "completed")
        throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
      const { status: pending, change, persona } = this.store.beginUndo(importId);
      this.changedTopics(importId);
      for (const owner of change) this.changedMemories(owner, "removed");
      if (persona) this.changedPersona(persona);
      this.publish(pending);
      void this.cleanup.wake(importId);
      return pending;
    } finally {
      this.undoReservation = undefined;
      release();
    }
  }

  async stop() {
    this.closing.abort();
    this.reviews.clear();
    // A picker rejection after shutdown is expected; the RPC caller owns that error.
    await this.previewing?.catch(() => undefined);
    await this.reviews.wait();
    await Promise.all([this.active?.done, this.undoReservation, this.cleanup.wait()]);
  }

  private changedMemories(
    { scope, botId }: { scope: ImportMemoryScope; botId: string },
    reason: "added" | "removed",
  ) {
    try {
      this.ctx.peer.emit("memory.changed", {
        botId,
        scope,
        ownerId: scope === "user" ? "user" : botId,
        reason,
      });
    } catch {
      // Memory was already committed; readers can refresh from storage after reconnecting.
      this.ctx.logger.warn("import_memory_event_not_delivered");
    }
  }
  private changedPersona(botId: string) {
    try {
      this.ctx.peer.emit("bots.changed", { botId, reason: "updated" });
    } catch {
      // The stored persona is authoritative after a disconnect.
      this.ctx.logger.warn("import_persona_event_not_delivered");
    }
  }
  private changedTopics(importId: string) {
    const target = this.store.target(importId);
    const bots = new Set(this.store.topicBots(importId));
    if (typeof target === "string") bots.add(target);
    try {
      for (const botId of bots)
        this.ctx.peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
    } catch {
      // The committed state is authoritative even if the peer disconnected.
      this.ctx.logger.warn("import_topics_not_delivered");
    }
  }

  private publish(status: ImportStatus) {
    try {
      this.ctx.peer.emit("import.progress", status);
    } catch {
      // The caller can recover authoritative status after a disconnect or delivery failure.
      this.ctx.logger.warn("import_progress_not_delivered");
    }
    return status;
  }
}
