import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  BrainRedactor,
  MemoryPromptRequest,
  MemoryRecallObservation,
  MemoryRecallRequest,
  RegisterRpc,
} from "@pibot/brain/kit";
import { requireGroupMember } from "@pibot/brain/kit";
import { type MemoryWriteFacts, memoryWritePolicy, mustAskNow } from "@pibot/policy";
import {
  type KernelEvents,
  type KernelMethods,
  type Memory,
  type MemoryOwner,
  type MemoryProposal,
  type Page,
  type Peer,
  RpcError,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  BotsRepo,
  GroupsRepo,
  isScopeMove,
  MEMORY_SEARCH_LIMIT,
  MemoriesRepo,
  MemoryProjectsRepo,
  MemoryUndoRepo,
  memoryRecallSnapshot,
  memoryStatus,
  SidebarRepo,
  SimilarMemoryError,
  sameMemoryRevision,
  transaction,
} from "@pibot/storage";
import { createGroupMemoryOperations } from "./group-memory-operations.ts";
import {
  curatedMemoryText,
  curatedUserMemoryText,
  type MemoryChangeReason,
  memoryChanged,
  memoryPrompt,
} from "./memory-context.ts";
import {
  candidateInput,
  type ExtractionCandidate,
  extractionCatalog,
} from "./memory-extraction.ts";
import { type MemoryToolInput, noteValue, parseMemoryInput } from "./memory-input.ts";
import { type OrganizationProposal, organizationCatalog } from "./memory-organization.ts";
import { organizationInputs } from "./memory-organization-inputs.ts";
import { applyProjectFile, projectFileProposal } from "./memory-project-file.ts";
import { createMemoryReads } from "./memory-reads.ts";
import { MemoryRecallMetrics } from "./memory-recall-metrics.ts";
import { undoableMemory } from "./memory-reversal.ts";
import {
  assertScopeMoveDestination,
  assertScopeMoveRemoval,
  assertScopeMoveUndo,
} from "./memory-scope-move-guard.ts";
import { MemoryUsage } from "./memory-usage.ts";

export class MemoryService {
  private readonly repo: MemoriesRepo;
  private readonly undo: MemoryUndoRepo;
  private readonly bots: BotsRepo;
  private readonly group: ReturnType<typeof createGroupMemoryOperations>;
  private readonly usage: MemoryUsage;
  private readonly recall: MemoryRecallMetrics;
  private readonly reads: ReturnType<typeof createMemoryReads>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly peer: Peer<typeof KernelMethods, typeof KernelEvents>,
    private readonly redactor: BrainRedactor,
    usageError: () => void = () => {
      throw new Error("memory_usage_write_failed");
    },
  ) {
    this.repo = new MemoriesRepo(db, (text) => redactor.redact(text));
    this.undo = new MemoryUndoRepo(db);
    this.bots = new BotsRepo(db);
    this.usage = new MemoryUsage(db, usageError);
    this.recall = new MemoryRecallMetrics(db, usageError, (botId, note) => {
      const bot = this.bots.get(botId);
      if (!bot || bot.archivedAt) return false;
      if (note.scope === "group") {
        const group = new GroupsRepo(db).get(note.ownerId);
        return (
          !!group && !group.archivedAt && group.members.some((member) => member.botId === botId)
        );
      }
      return note.scope === "user"
        ? note.ownerId === "user"
        : note.scope === "bot"
          ? note.ownerId === botId
          : !!new MemoryProjectsRepo(db).byId(note.ownerId);
    });
    this.reads = createMemoryReads({
      repoFor: (owner) => this.repoFor(owner),
      recordUsage: (ids) => this.usage.record(ids),
    });
    this.group = createGroupMemoryOperations({
      db,
      peer,
      redactor,
      write: (action) => this.write(action),
      resolve: (id, accept) => this.resolve(id, accept),
    });
  }

  active(botId: string) {
    const bot = this.bots.get(botId);
    if (!bot || bot.archivedAt) throw new RpcError(-32602, "Unknown active Bot");
    return bot;
  }

  projectForConversation(conversationId: string) {
    const row = this.db
      .prepare(
        "SELECT f.path FROM conversations c JOIN working_folders f ON f.id=c.workplace_folder_id WHERE (c.id=? OR EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND m.conversation_id=c.id)) AND c.workplace_folder_id IS NOT NULL",
      )
      .get(conversationId, conversationId);
    if (!row) return undefined;
    return new MemoryProjectsRepo(this.db).ensure(String(row.path));
  }

  /**
   * Project facts are written to the folder's AGENTS.md, so they are always a reviewable
   * proposal with the exact diff; nothing in the background changes a user's project file.
   */
  projectProposal(conversationId: string, text: string) {
    const project = this.projectForConversation(conversationId);
    return project
      ? projectFileProposal(join(project.path, "AGENTS.md"), this.redactor.redact(text))
      : undefined;
  }

  /** Same card for a run that already knows its canonical project folder. */
  projectProposalForPath(projectPath: string, text: string) {
    // Same redaction as the stored note: the diff goes into a file other tools and people read.
    return projectFileProposal(join(projectPath, "AGENTS.md"), this.redactor.redact(text));
  }

  /** Project ids come from the run's canonical folder; only writes create the project row. */
  projectId(path: string | undefined, create: boolean): string | undefined {
    if (!path) return undefined;
    const projects = new MemoryProjectsRepo(this.db);
    return (create ? projects.ensure(path) : projects.byPath(path))?.id;
  }
  private scopedOwnerId(scope: MemoryOwner["scope"], groupId?: string, projectId?: string) {
    return scope === "group" ? groupId : scope === "project" ? projectId : undefined;
  }
  private repoFor(owner: MemoryOwner) {
    return new MemoriesRepo(this.db, (text) => this.redactor.redact(text), owner);
  }
  private owner(botId: string, scope: MemoryOwner["scope"] = "bot", ownerId?: string): MemoryOwner {
    this.active(botId);
    if (scope === "user") {
      if (ownerId && ownerId !== "user") throw new RpcError(-32602, "Invalid memory owner");
      return { scope, ownerId: "user" };
    }
    if (scope === "group") {
      if (!ownerId) throw new RpcError(-32602, "group_resource_unavailable");
      requireGroupMember({ db: this.db }, ownerId);
      return { scope, ownerId };
    }
    if (scope === "project") {
      if (!ownerId || !new MemoryProjectsRepo(this.db).byId(ownerId))
        throw new RpcError(-32602, "project_memory_unavailable");
      return { scope, ownerId };
    }
    if (ownerId && ownerId !== botId) throw new RpcError(-32602, "Unknown owned memory");
    return { scope, ownerId: botId };
  }
  prompt(botId: string, request?: MemoryPromptRequest) {
    this.active(botId);
    return memoryPrompt(
      this.db,
      this.redactor,
      botId,
      undefined,
      (ids) => this.usage.record(ids),
      request,
      (notes) => {
        if (request?.runId)
          this.recall.inject(request.runId, botId, notes, request.runSignal ?? request.signal);
      },
    );
  }
  observeRecall(runId: string, observation: MemoryRecallObservation) {
    this.recall.observe(runId, observation);
  }
  finishRecall(runId: string) {
    this.recall.finish(runId);
  }
  recallSnapshot(botId: string, request: MemoryRecallRequest) {
    return memoryRecallSnapshot(
      this.db,
      this.visibleOwners(botId, request.groupId, request.project),
      request.ids,
      request.signal,
    );
  }
  sharedUser(botId: string, signal: AbortSignal) {
    this.active(botId);
    return curatedUserMemoryText(this.db, this.redactor, botId, signal, (ids) =>
      this.usage.record(ids),
    );
  }
  curated(botId: string, request: { maxChars: number; signal: AbortSignal }) {
    this.active(botId);
    return curatedMemoryText(this.db, this.redactor, botId, request.maxChars, request.signal);
  }
  /** Always a proposal, whatever the Bot's memory mode (alwaysPropose). */
  proposeOffline(
    botId: string,
    messageId: string,
    input: {
      text: string;
      category: NonNullable<Memory["category"]>;
      why?: string;
      how?: string;
    },
  ) {
    try {
      const result = this.execute(
        botId,
        messageId,
        parseMemoryInput("memory_add", {
          text: input.text,
          category: input.category,
          ...(input.why ? { why: input.why } : {}),
          ...(input.how ? { how: input.how } : {}),
        }),
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      return { proposalId: result.proposal.id };
    } catch (error) {
      // An equal note already exists: the phone's proposal adds nothing, which is not a failure.
      if (error instanceof RpcError && error.message === "memory_similar") return undefined;
      throw error;
    }
  }
  stop() {
    this.recall.stop();
    this.usage.stop();
  }
  flushUsage() {
    this.usage.flush();
  }
  similar(
    botId: string,
    text: string,
    scope: MemoryOwner["scope"],
    groupId?: string,
    projectId?: string,
  ) {
    if (groupId) requireGroupMember({ db: this.db }, groupId, botId);
    if (scope === "project" && !projectId) return undefined;
    return this.repoFor(
      this.owner(botId, scope, this.scopedOwnerId(scope, groupId, projectId)),
    ).similar(botId, text);
  }
  status(botId: string, scope?: MemoryOwner["scope"], ownerId?: string) {
    this.active(botId);
    const owners: MemoryOwner[] = scope
      ? [this.owner(botId, scope, ownerId)]
      : [
          { scope: "user", ownerId: "user" },
          { scope: "bot", ownerId: botId },
        ];
    const statuses = owners.map((o) => memoryStatus(this.db, o));
    return {
      activeCount: statuses.reduce((n, s) => n + s.activeCount, 0),
      archivedCount: statuses.reduce((n, s) => n + s.archivedCount, 0),
      unusedCount: statuses.reduce((n, s) => n + s.unusedCount, 0),
      needsOrganization: statuses.some((s) => s.needsOrganization),
    };
  }

  writeTarget(
    botId: string,
    id: string,
    scope?: Memory["scope"],
    groupId?: string,
    project?: string,
  ) {
    // The prompt, the reads and the writes all decide visibility in visibleOwners, so a run can
    // never touch an owner that the other paths consider out of scope.
    for (const owner of this.visibleOwners(botId, groupId, project)) {
      if (scope && owner.scope !== scope) continue;
      const value = this.repoFor(owner).get(botId, id);
      if (value) return { text: value.text, scope: owner.scope };
    }
    return undefined;
  }

  /**
   * Reads use exactly the owners the prompt injected, so memory_read/memory_search can
   * never reach another Bot's notes or a group the Bot has left.
   */
  private visibleOwners(botId: string, groupId?: string, project?: string): MemoryOwner[] {
    this.active(botId);
    if (groupId) requireGroupMember({ db: this.db }, groupId, botId);
    const projectId = this.projectId(project, false);
    return [
      { scope: "user", ownerId: "user" },
      { scope: "bot", ownerId: botId },
      ...(groupId ? [{ scope: "group" as const, ownerId: groupId }] : []),
      ...(projectId ? [{ scope: "project" as const, ownerId: projectId }] : []),
    ];
  }
  read(
    botId: string,
    id: string,
    scope?: Memory["scope"],
    groupId?: string,
    project?: string,
  ): Memory | undefined {
    return this.reads.read(botId, this.visibleOwners(botId, groupId, project), id, scope);
  }
  search(
    botId: string,
    query: string,
    scope?: Memory["scope"],
    groupId?: string,
    project?: string,
    limit = MEMORY_SEARCH_LIMIT,
    signal?: AbortSignal,
  ): Memory[] {
    return this.reads.search(
      this.db,
      botId,
      this.visibleOwners(botId, groupId, project),
      query,
      scope,
      limit,
      signal,
    );
  }

  private audit(
    owner: MemoryOwner,
    botId: string,
    reason: string,
    memoryId?: string,
    proposalId?: string,
  ) {
    new AuditRepo(this.db, this.redactor).append({
      botId,
      kind: "memory.changed",
      summary: "Memory changed / 记忆变更",
      detail: {
        memoryScope: owner.scope,
        memoryOwnerId: owner.ownerId,
        ...(owner.scope === "group" ? { groupId: owner.ownerId } : {}),
        reasonCode: reason,
        ...(memoryId ? { memoryId } : {}),
        ...(proposalId ? { memoryProposalId: proposalId } : {}),
      },
    });
  }
  private changed(
    botId: string,
    reason: MemoryChangeReason,
    memoryId?: string,
    proposalId?: string,
    owner: MemoryOwner = { scope: "bot", ownerId: botId },
  ) {
    memoryChanged(this.db, this.peer, botId, reason, memoryId, proposalId, owner);
  }

  private write<T>(action: () => T): T {
    try {
      this.usage.flush();
      return action();
    } catch (error) {
      if (error instanceof SimilarMemoryError) throw new RpcError(-32011, "memory_similar");
      if (error instanceof TypeError && error.message === "memory_conflict")
        throw new RpcError(-32011, "memory_conflict");
      if (
        error instanceof TypeError &&
        ["group_memory_unavailable", "group_memory_quota", "group_memory_conflict"].includes(
          error.message,
        )
      )
        throw new RpcError(-32602, error.message);
      const expected =
        error instanceof Error &&
        (error.message === "Memory quota exceeded" ||
          [
            "Unknown owned memory",
            "Unknown active Bot",
            "Source message is outside Bot conversations",
            "Proposal target no longer exists",
          ].includes(error.message));
      if (expected)
        throw new RpcError(
          -32602,
          "Memory unavailable or quota exceeded (100 notes / 8000 characters); consolidate first",
        );
      throw error;
    }
  }

  toolScope(
    botId: string,
    input: MemoryToolInput,
    groupId?: string,
    projectId?: string,
  ): MemoryOwner["scope"] {
    this.active(botId);
    if (groupId) requireGroupMember({ db: this.db }, groupId, botId);
    const explicit = input.args.scope;
    // A project exists only while the run works in a user folder (not the Bot's own one).
    if (explicit === "project" && !projectId)
      throw new RpcError(-32602, "project_memory_unavailable");
    const candidates: MemoryOwner[] = [
      { scope: "user", ownerId: "user" },
      { scope: "bot", ownerId: botId },
      ...(groupId ? [{ scope: "group" as const, ownerId: groupId }] : []),
      ...(projectId ? [{ scope: "project" as const, ownerId: projectId }] : []),
    ];
    const targetId = input.tool === "memory_add" ? undefined : input.args.id;
    const prior = targetId
      ? candidates
          .filter((o) => !explicit || o.scope === explicit)
          .flatMap((o) => this.repoFor(o).get(botId, targetId) ?? [])[0]
      : undefined;
    return (
      explicit ??
      prior?.scope ??
      (input.tool === "memory_add" && input.args.category === "about_you"
        ? "user"
        : groupId
          ? "group"
          : "bot")
    );
  }

  execute(
    botId: string,
    messageId: string | null,
    input: MemoryToolInput,
    automatic = false,
    afterApply?: () => void,
    groupId?: string,
    beforeApply?: () => void,
    projectId?: string,
    /** Organization must never apply directly, whatever the Bot's memory mode is. */
    alwaysPropose = false,
    projectMeta?: { path: string; diff: string; hash: string },
  ) {
    const bot = this.active(botId);
    const scope = this.toolScope(botId, input, groupId, projectId);
    if (scope === "group") throw new RpcError(-32602, "Use trusted group executor");
    const owner = this.owner(botId, scope, scope === "project" ? projectId : undefined);
    const repo = this.repoFor(owner);
    // Project notes are shared working context like the group's own: only the Bot's
    // ask mode holds them; facts about the user from a group still ask.
    const ask =
      alwaysPropose ||
      // A note that also edits AGENTS.md waits for the owner's confirmation in every mode.
      !!projectMeta ||
      (((!!groupId && scope !== "project") || bot.memoryMode === "ask") && !automatic);
    const result = this.write(() =>
      transaction(this.db, () => {
        beforeApply?.();
        const before = input.tool === "memory_add" ? null : repo.get(botId, input.args.id);
        if (input.tool !== "memory_add" && !before)
          throw new RpcError(-32602, "Unknown owned memory");
        const action =
          input.tool === "memory_add"
            ? "add"
            : input.tool === "memory_update"
              ? "update"
              : "remove";
        const proposal = repo.propose(
          botId,
          input.tool === "memory_remove"
            ? (before?.text ?? "")
            : (input.args.text ?? before?.text ?? ""),
          messageId,
          { action, memoryId: before?.id ?? null },
          input.tool === "memory_remove"
            ? (before?.category ?? null)
            : (input.args.category ?? before?.category ?? null),
          input.tool === "memory_remove"
            ? {}
            : {
                // null is an explicit "clear": the proposal column's NULL already means
                // "not mentioned", so the clear travels as an empty string.
                why: noteValue(input.args.why, before?.why),
                how: noteValue(input.args.how, before?.how),
                ...(projectMeta
                  ? {
                      projectPath: projectMeta.path,
                      projectDiff: projectMeta.diff,
                      projectExpectedHash: projectMeta.hash,
                    }
                  : {}),
              },
          "expiresAt" in input.args ? (input.args.expiresAt ?? null) : null,
        );
        this.audit(
          owner,
          botId,
          ask ? "memory_proposed" : "memory_applied",
          before?.id,
          proposal.id,
        );
        if (ask) {
          new SidebarRepo(this.db).activity(`dm:${botId}`, true);
          return { proposal, memory: null };
        }
        const applied = repo.resolve(proposal.id, true);
        this.undo.set(
          botId,
          proposal.id,
          before ? { ...before, text: this.redactor.redact(before.text) } : null,
          applied.memory,
        );
        afterApply?.();
        return applied;
      }),
    );
    this.changed(
      botId,
      ask
        ? "proposed"
        : input.tool === "memory_add"
          ? "added"
          : input.tool === "memory_update"
            ? "updated"
            : "removed",
      result.memory?.id ?? result.proposal.memoryId ?? undefined,
      result.proposal.id,
      owner,
    );
    return result;
  }

  list(
    botId: string,
    scope?: MemoryOwner["scope"],
    ownerId?: string,
    page?: Page,
    state?: "active" | "archived" | "all",
  ) {
    this.active(botId);
    if (scope === undefined) return this.repo.visible(botId, page, state);
    return this.repoFor(this.owner(botId, scope, ownerId)).page(
      botId,
      { limit: 100, ...page },
      state,
    );
  }

  proposals(botId: string) {
    this.active(botId);
    return this.repo.authoredProposals(botId);
  }

  acceptAutomatic(proposalId: string, afterApply: () => void, facts: () => MemoryWriteFacts) {
    const proposal = this.repo.proposal(proposalId);
    if (proposal?.status !== "pending" || isScopeMove(this.db, proposalId)) return;
    this.active(proposal.botId);
    if (proposal.scope === "group") throw new RpcError(-32602, "group_resource_unavailable");
    const owner = { scope: proposal.scope ?? "bot", ownerId: proposal.ownerId ?? proposal.botId };
    const repo = this.repoFor(owner);
    const result = this.write(() =>
      transaction(this.db, () => {
        // A later YOLO switch cannot answer a fresh mandatory memory question.
        if (mustAskNow(memoryWritePolicy({ text: proposal.text, ...facts() }))) return undefined;
        const before = proposal.memoryId ? repo.get(proposal.botId, proposal.memoryId) : null;
        const applied = repo.resolve(proposal.id, true);
        this.undo.set(
          proposal.botId,
          proposal.id,
          before ? { ...before, text: this.redactor.redact(before.text) } : null,
          applied.memory,
        );
        afterApply();
        this.audit(owner, proposal.botId, "memory_automatic", applied.memory?.id, proposal.id);
        return applied;
      }),
    );
    if (result) this.changed(proposal.botId, "resolved", result.memory?.id, proposal.id, owner);
  }

  undoable(botId: string) {
    this.active(botId);
    return undoableMemory(this.db, botId, this.repo, this.undo, this.redactor);
  }

  /**
   * A Bot that saves a correction itself (memory_add during the turn) leaves its card on the
   * text-less step message before the words, where it faded before the reply was read, and the
   * later correction extraction then found nothing new. The turn's own notes move under the
   * reply instead and are returned for its "noted" receipt, so one card shows with its undo.
   */
  anchorRunNotes(botId: string, replyId: string) {
    this.active(botId);
    const rows = this.db
      .prepare(
        `SELECT p.id AS proposalId, p.status, p.resolved_memory_id AS memoryId, p.text
        FROM scoped_memory_proposals p
        JOIN messages source ON source.id=p.message_id
        JOIN messages reply ON reply.id=? AND reply.run_id IS NOT NULL AND reply.run_id=source.run_id
          AND reply.conversation_id=source.conversation_id
        WHERE p.bot_id=? AND p.status IN ('pending','accepted') AND p.action IN ('add','update')
          AND p.scope IN ('bot','user','project')
        ORDER BY p.created_at, p.rowid LIMIT 5`,
      )
      .all(replyId, botId)
      .map((row) => ({
        proposalId: String(row.proposalId),
        status: String(row.status),
        memoryId: row.memoryId == null ? null : String(row.memoryId),
        text: String(row.text),
      }));
    if (!rows.length) return [];
    transaction(this.db, () => {
      const move = this.db.prepare(
        "UPDATE scoped_memory_proposals SET message_id=? WHERE id=? AND bot_id=?",
      );
      for (const row of rows) move.run(replyId, row.proposalId, botId);
    });
    this.changed(botId, "proposed", undefined, rows[0]?.proposalId);
    return rows.flatMap((row) =>
      row.status === "accepted" && row.memoryId ? [{ id: row.memoryId, text: row.text }] : [],
    );
  }

  update(
    botId: string,
    id: string,
    patch: { text?: string; category?: Memory["category"] },
    scope?: MemoryOwner["scope"],
    ownerId?: string,
  ) {
    this.active(botId);
    const selected =
      scope ?? (this.repoFor({ scope: "user", ownerId: "user" }).get(botId, id) ? "user" : "bot");
    const owner = this.owner(botId, selected, ownerId);
    if (scope === "group")
      return this.groupSave(
        owner.ownerId,
        patch.text ?? this.groupRepo(owner.ownerId).get(id)?.text ?? "",
        patch.category === undefined
          ? (this.groupRepo(owner.ownerId).get(id)?.category ?? null)
          : patch.category,
        id,
      );
    const memory = this.write(() =>
      transaction(this.db, () => {
        const value = this.repoFor(owner).update(botId, id, patch);
        if (value) this.audit(owner, botId, "memory_updated", id);
        return value;
      }),
    );
    if (!memory) throw new RpcError(-32602, "Unknown owned memory");
    this.changed(botId, "updated", id, undefined, owner);
    return memory;
  }

  remove(botId: string, id: string, scope?: MemoryOwner["scope"], ownerId?: string) {
    this.active(botId);
    const selected =
      scope ?? (this.repoFor({ scope: "user", ownerId: "user" }).get(botId, id) ? "user" : "bot");
    const owner = this.owner(botId, selected, ownerId);
    if (scope === "group") return this.groupRemove(owner.ownerId, id);
    transaction(this.db, () => {
      if (!this.repoFor(owner).remove(botId, id))
        throw new RpcError(-32602, "Unknown owned memory");
      this.audit(owner, botId, "memory_removed", id);
    });
    this.changed(botId, "removed", id, undefined, owner);
    return { ok: true as const };
  }

  clear(botId: string, scope: MemoryOwner["scope"] = "bot", ownerId?: string) {
    this.active(botId);
    const owner = this.owner(botId, scope, ownerId);
    transaction(this.db, () => {
      this.repoFor(owner).clear(botId);
      this.undo.clearOwner(owner);
      this.audit(owner, botId, "memory_cleared");
    });
    this.changed(botId, "cleared", undefined, undefined, owner);
    return { ok: true as const };
  }

  resolve(proposalId: string, accept: boolean) {
    const proposal = this.repo.proposal(proposalId);
    if (!proposal) throw new RpcError(-32602, "Unknown proposal");
    if (
      accept &&
      proposal.status === "pending" &&
      proposal.projectPath &&
      proposal.projectDiff &&
      proposal.projectExpectedHash
    ) {
      // The user's confirm on this card is the approval for the write. The file is small and
      // resolve() is synchronous for every proposal kind, so the sync API keeps one code path.
      if (basename(proposal.projectPath) !== "AGENTS.md")
        throw new RpcError(-32011, "memory_project_target_invalid");
      applyProjectFile(proposal.projectPath, proposal.projectDiff, proposal.projectExpectedHash);
      this.audit(
        { scope: "project", ownerId: proposal.ownerId ?? proposal.botId },
        proposal.botId,
        "memory.project_written",
        undefined,
        proposalId,
      );
    }
    if (proposal.scope === "group") requireGroupMember({ db: this.db }, proposal.ownerId as string);
    if (proposal.scope !== "user") this.active(proposal.botId);
    const owner: MemoryOwner = {
      scope: proposal.scope ?? "bot",
      ownerId: proposal.ownerId ?? proposal.botId,
    };
    const repo = this.repoFor(owner);
    const result = this.write(() =>
      transaction(this.db, () => {
        this.audit(
          owner,
          proposal.botId,
          accept ? "memory_accepted" : "memory_rejected",
          proposal.memoryId ?? undefined,
          proposalId,
        );
        if (proposal.action !== "move")
          return accept ? this.acceptOne(proposal, repo) : this.undoOne(proposal, repo);
        // One card, up to two linked rows. The destination row stays internal; both go
        // through the same per-row checks and undo snapshots as the earlier two-card flow, in a
        // safe order. A move onto an identical Bot note has no destination row at all.
        const target = this.moveTarget(proposalId);
        const targetRepo =
          target && this.repoFor({ scope: "bot", ownerId: target.ownerId ?? target.botId });
        if (accept) {
          if (proposal.status === "pending" && target && targetRepo) {
            if (target.status !== "pending")
              throw new RpcError(-32011, "memory_move_copy_required");
            // Destination first (checked unchanged before it writes), then the source removal,
            // which requires the live copy the destination just made.
            this.acceptOne(target, targetRepo);
          }
          const accepted = this.acceptOne(proposal, repo);
          this.audit(owner, proposal.botId, "memory.moved", undefined, proposalId);
          return accepted;
        }
        if (proposal.status === "pending") {
          if (target?.status === "pending" && targetRepo) targetRepo.resolve(target.id, false);
          return repo.resolve(proposalId, false);
        }
        // Undo: put the note back in 关于你 first; only then may the Bot's copy be taken back.
        const undone = this.undoOne(proposal, repo);
        if (target?.status === "accepted" && targetRepo) this.undoOne(target, targetRepo);
        return undone;
      }),
    );
    this.changed(proposal.botId, "resolved", result.memory?.id, proposalId, owner);
    return result;
  }
  private moveTarget(proposalId: string): MemoryProposal | undefined {
    const move = this.db
      .prepare("SELECT target_proposal_id FROM memory_scope_moves WHERE removal_id=?")
      .get(proposalId);
    if (!move) throw new RpcError(-32011, "memory_move_copy_required");
    if (move.target_proposal_id == null) return undefined;
    const target = this.repo.proposal(String(move.target_proposal_id));
    if (!target) throw new RpcError(-32011, "memory_move_copy_required");
    return target;
  }
  private acceptOne(proposal: MemoryProposal, repo: MemoriesRepo) {
    if (proposal.status === "pending") {
      assertScopeMoveRemoval(this.db, proposal.id);
      assertScopeMoveDestination(this.db, proposal.id);
    }
    // Suggestions produced by a background run have no snapshot yet. Keeping the
    // pre-accept image makes accepting one as undoable as a write the Bot made itself.
    const before =
      proposal.status === "pending" && proposal.action !== "add" && proposal.memoryId
        ? (repo.get(proposal.botId, proposal.memoryId) ?? null)
        : null;
    const accepted = repo.resolve(proposal.id, true);
    if (proposal.status === "pending")
      this.undo.set(proposal.botId, proposal.id, before, accepted.memory);
    return accepted;
  }
  private undoOne(proposal: MemoryProposal, repo: MemoriesRepo) {
    const snapshot = this.undo.get(proposal.botId, proposal.id);
    if (!snapshot) return repo.resolve(proposal.id, false);
    assertScopeMoveUndo(this.db, proposal.id);
    const targetId = snapshot.after?.id ?? snapshot.before?.id;
    if (!targetId) throw new RpcError(-32602, "Undo unavailable");
    const current = repo.get(proposal.botId, targetId) ?? null;
    if (!sameMemoryRevision(current, snapshot.after))
      throw new RpcError(-32011, "Memory changed since this operation");
    if (snapshot.before) {
      if (current && current.archivedAt !== snapshot.before.archivedAt)
        repo.archive(proposal.botId, targetId, !!snapshot.before.archivedAt, false);
      else if (current)
        repo.update(proposal.botId, targetId, {
          text: snapshot.before.text,
          category: snapshot.before.category,
          why: snapshot.before.why ?? null,
          how: snapshot.before.how ?? null,
        });
      else repo.restore(snapshot.before);
    } else repo.remove(proposal.botId, targetId);
    this.repo.markUndone(proposal.id, snapshot.before?.id ?? null);
    this.undo.remove(proposal.botId, proposal.id);
    return repo.resolve(proposal.id, false);
  }
  private groupChanged(groupId: string) {
    this.group.groupChanged(groupId);
  }
  private groupRepo(groupId: string) {
    return this.group.groupRepo(groupId);
  }
  groupList(groupId: string) {
    return this.group.groupList(groupId);
  }
  groupPrompt(groupId: string, botId?: string, request?: MemoryPromptRequest) {
    const group = requireGroupMember({ db: this.db }, groupId, botId);
    const member = botId ?? group.coordinatorBotId;
    this.active(member);
    return memoryPrompt(
      this.db,
      this.redactor,
      member,
      groupId,
      (ids) => this.usage.record(ids),
      request,
      (notes) => {
        if (request?.runId)
          this.recall.inject(request.runId, member, notes, request.runSignal ?? request.signal);
      },
    );
  }
  groupSave(...args: Parameters<ReturnType<typeof createGroupMemoryOperations>["groupSave"]>) {
    return this.group.groupSave(...args);
  }
  groupRemove(...args: Parameters<ReturnType<typeof createGroupMemoryOperations>["groupRemove"]>) {
    return this.group.groupRemove(...args);
  }
  groupResolve(
    ...args: Parameters<ReturnType<typeof createGroupMemoryOperations>["groupResolve"]>
  ) {
    return this.group.groupResolve(...args);
  }
  groupExecute(
    ...args: Parameters<ReturnType<typeof createGroupMemoryOperations>["groupExecute"]>
  ) {
    return this.group.groupExecute(...args);
  }
  groupAutomaticAudit(groupId: string, botId: string) {
    this.group.groupAutomaticAudit(groupId, botId);
  }

  /** Existing notes the extraction model may update instead of adding duplicates. */
  extractionCatalog(botId: string, groupId: string | null) {
    this.active(botId);
    return extractionCatalog(this.db, botId, groupId);
  }

  /**
   * Applies one already-validated candidate. A Bot in `ask` mode (and a member's note about the
   * user in a group) stays a proposal, so a background run can never silently rewrite those.
   */
  applyExtraction(
    botId: string,
    messageId: string,
    candidate: ExtractionCandidate,
    groupId: string | null,
    projectId?: string,
  ) {
    const bot = this.active(botId);
    if (candidate.scope === "group" && !groupId) throw new TypeError("candidate_scope_denied");
    if (candidate.action === "update") {
      const owner = this.owner(
        botId,
        candidate.scope,
        candidate.scope === "group" ? (groupId ?? undefined) : undefined,
      );
      if (!candidate.id || !this.repoFor(owner).get(botId, candidate.id))
        throw new TypeError("candidate_target_missing");
    }
    const automatic =
      bot.memoryMode === "auto" &&
      (!groupId || candidate.scope !== "user") &&
      // Project facts become the AGENTS.md card; the background never applies them itself.
      candidate.scope !== "project";
    const input = candidateInput(candidate);
    const projectMeta =
      candidate.scope === "project" ? this.projectProposal(messageId, candidate.text) : undefined;
    return groupId && candidate.scope === "group"
      ? this.group.groupExecute(
          { botId, messageId, groupId },
          input,
          automatic
            ? {
                assertCurrent: () => {
                  this.active(botId);
                },
                audit: () => this.group.groupAutomaticAudit(groupId, botId),
              }
            : undefined,
        )
      : this.execute(
          botId,
          messageId,
          input,
          automatic,
          undefined,
          groupId ?? undefined,
          undefined,
          projectId,
          false,
          projectMeta
            ? { path: projectMeta.path, diff: projectMeta.diff, hash: projectMeta.hash }
            : undefined,
        );
  }

  /** Dream may retire existing Bot notes, keeping the exact before/after undo trail. */
  dreamArchive(
    botId: string,
    expected: readonly Memory[],
    reason: "expired" | "merged",
    survivor?: Memory,
  ) {
    this.active(botId);
    const owner = { scope: "bot", ownerId: botId } as const;
    const repo = this.repoFor(owner);
    return transaction(this.db, () => {
      for (const note of survivor ? [survivor, ...expected] : expected) {
        const current = repo.get(botId, note.id);
        if (!current || current.archivedAt || !sameMemoryRevision(current, note))
          throw new RpcError(-32011, "memory_conflict");
      }
      return expected.map((note) => {
        const proposal = repo.propose(
          botId,
          note.text,
          null,
          { action: "update", memoryId: note.id },
          note.category,
        );
        const result = repo.resolve(proposal.id, true, "archive");
        if (!result.memory) throw new Error("dream_archive_missing");
        this.undo.set(botId, proposal.id, note, result.memory);
        new AuditRepo(this.db, this.redactor).append({
          botId,
          kind: "memory.changed",
          summary: "Dream archived a Bot memory / Dream 归档 Bot 记忆",
          detail: {
            actor: "automatic",
            reasonCode: `memory_dream_${reason}`,
            memoryScope: "bot",
            memoryOwnerId: botId,
            memoryId: note.id,
            memoryProposalId: proposal.id,
          },
        });
        return { botId, proposalId: proposal.id };
      });
    });
  }

  dreamCurrent(
    botId: string,
    scope: "user" | "bot",
    ownerId: string,
    expected: (Memory | undefined)[],
  ) {
    const repo = this.repoFor({ scope, ownerId });
    return expected.every(
      (note) => note && sameMemoryRevision(repo.get(botId, note.id) ?? null, note),
    );
  }

  dreamProject(botId: string, note: Memory) {
    if (
      note.scope !== "bot" ||
      note.ownerId !== botId ||
      (note.sources?.length ?? 0) > 20 ||
      !this.dreamCurrent(botId, "bot", botId, [note])
    )
      return false;
    const ids = new Set([
      note.sourceMessageId,
      ...(note.sources ?? [])
        .filter((source) => source.botId === botId)
        .map((source) => source.messageId),
    ]);
    const lookup = this.db.prepare(`SELECT f.path FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      JOIN working_folders f ON f.id=c.workplace_folder_id AND f.bot_id=c.bot_id
      WHERE m.id=? AND m.status='done' AND c.bot_id=? AND c.kind='dm'
      AND m.import_id IS NULL AND c.import_id IS NULL AND c.internal_task_id IS NULL
      AND f.location='local' AND f.hidden_at IS NULL`);
    const folders = new Map<string, string>();
    for (const id of ids) {
      if (!id) continue;
      const row = lookup.get(id, botId);
      if (typeof row?.path === "string") folders.set(row.path, id);
    }
    // The owner confirms a copy into the source project's database-backed memory.
    if (folders.size !== 1) return false;
    const [entry] = folders;
    if (!entry) return false;
    const [path, sourceId] = entry;
    const ownerId = new MemoryProjectsRepo(this.db).ensure(path).id;
    if (
      this.repoFor({ scope: "project", ownerId }).similar(botId, note.text) ||
      this.db
        .prepare(`SELECT 1 FROM scoped_memory_proposals
          WHERE scope='project' AND owner_id=? AND action='add' AND status='pending' AND text=? LIMIT 1`)
        .get(ownerId, this.redactor.redact(note.text))
    )
      return false;
    this.execute(
      botId,
      sourceId,
      {
        tool: "memory_add",
        args: {
          scope: "project",
          text: note.text,
          category: "work",
          why: note.why ?? undefined,
          how: note.how ?? undefined,
        },
      },
      false,
      undefined,
      undefined,
      undefined,
      ownerId,
      true,
    );
    return true;
  }

  dreamChange(botId: string, proposalId: string) {
    return this.undo.get(botId, proposalId)?.before?.text;
  }

  dreamUndo(botId: string, proposalId: string) {
    this.active(botId);
    const owner = { scope: "bot", ownerId: botId } as const;
    const repo = this.repoFor(owner);
    const proposal = repo.proposal(proposalId);
    const snapshot = this.undo.get(botId, proposalId);
    if (
      !proposal ||
      proposal.botId !== botId ||
      proposal.scope !== "bot" ||
      proposal.ownerId !== botId ||
      proposal.status !== "accepted" ||
      !snapshot?.before ||
      snapshot.before.archivedAt ||
      !snapshot.after?.archivedAt
    )
      throw new RpcError(-32011, "memory_conflict");
    this.undoOne(proposal, repo);
    this.audit(owner, botId, "memory_dream_undo", proposal.memoryId ?? undefined, proposalId);
  }

  dreamChanged(botId: string) {
    this.changed(botId, "updated", undefined, undefined, { scope: "bot", ownerId: botId });
  }

  /** The notes one owner would be organized over, plus the ids a reply may refer to. */
  organizationCatalog(botId: string, scope: "user" | "bot", ownerId: string) {
    this.active(botId);
    const owner = this.owner(botId, scope, scope === "bot" ? botId : undefined);
    if (owner.ownerId !== ownerId) throw new RpcError(-32602, "Invalid memory owner");
    return organizationCatalog(this.db, { scope, ownerId });
  }

  /**
   * Organization always proposes, never rewrites. The proposal path is the same one a
   * todo-mode write takes, so a merge/remove here is a pending suggestion with the same accept,
   * undo and audit trail — including in `auto` mode, which would otherwise let a model silently
   * delete notes it merely guessed were stale.
   */
  applyOrganization(
    botId: string,
    scope: "user" | "bot",
    ownerId: string,
    proposal: OrganizationProposal,
    skipPending = false,
  ) {
    this.active(botId);
    const owner = this.owner(botId, scope, scope === "bot" ? botId : undefined);
    if (owner.ownerId !== ownerId) throw new RpcError(-32602, "Invalid memory owner");
    let created = 0;
    for (const input of organizationInputs(scope, proposal)) {
      if (
        skipPending &&
        input.tool !== "memory_add" &&
        this.db
          .prepare(`SELECT 1 FROM scoped_memory_proposals
            WHERE scope=? AND owner_id=? AND memory_id=? AND status='pending' LIMIT 1`)
          .get(scope, ownerId, input.args.id)
      )
        continue;
      try {
        // Nine positional flags would be unreadable at the call site, so the intent is spelled
        // out here: no run, not automatic, and always a proposal.
        this.execute(botId, null, input, false, undefined, undefined, undefined, undefined, true);
        created++;
      } catch {
        // One note can disappear or change between the model call and this write; the remaining
        // parts of the same suggestion are still worth showing.
      }
    }
    return created;
  }
}

export function registerMemoryRpc(handle: RegisterRpc, memory: MemoryService) {
  handle("memory.list", async ({ botId, scope, ownerId, state, ...page }) =>
    memory.list(botId, scope, ownerId, page, state),
  );
  handle("memory.update", async ({ botId, id, scope, ownerId, ...patch }) =>
    memory.update(botId, id, patch, scope, ownerId),
  );
  handle("memory.remove", async ({ botId, id, scope, ownerId }) =>
    memory.remove(botId, id, scope, ownerId),
  );
  handle("memory.clear", async ({ botId, scope, ownerId }) => memory.clear(botId, scope, ownerId));
  handle("memory.resolve", async ({ proposalId, accept }) => memory.resolve(proposalId, accept));
}
