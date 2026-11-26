// Bind confirmed memory additions to the batch without changing pre-existing memories.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ImportMemoryReview } from "@pibot/import-contract";
import { type Memory, type MemoryOwner, RpcError } from "@pibot/protocol-base";
import { MemoriesRepo } from "@pibot/storage";
import { ImportFailure } from "./failure.ts";

export type ImportMemoryScope = "user" | "bot";
export type MemoryCandidate = ImportMemoryReview["items"][number];
export type ReviewedMemory = { item: MemoryCandidate; conflict: string };
export type MemorySelection = { scope: ImportMemoryScope; selected: ReviewedMemory[] };

export const normalized = (text: string) =>
  text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function revision(memory: Memory) {
  const { lastUsedAt: _last, useCount: _count, ...content } = memory;
  return digest(content);
}

function qualifiers(text: string) {
  return text
    .replace(/\d+(?:\.\d+)?/gu, "#")
    .replace(/不|没|无|别|勿|未|非|\b(?:not|no|never)\s*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export class ImportMemories {
  constructor(
    private readonly db: DatabaseSync,
    private readonly redact: (text: string) => string,
  ) {}

  private owner(botId: string, scope: ImportMemoryScope): MemoryOwner {
    return { scope, ownerId: scope === "user" ? "user" : botId };
  }

  private repo(botId: string, scope: ImportMemoryScope) {
    return new MemoriesRepo(this.db, this.redact, this.owner(botId, scope));
  }

  inspection(botId: string, scope: ImportMemoryScope) {
    const repo = this.repo(botId, scope);
    const active = repo.list(botId);
    return (candidate: Omit<MemoryCandidate, "outcome" | "existingText">): ReviewedMemory => {
      const duplicate = repo.similar(botId, candidate.text);
      if (duplicate) return { item: { ...candidate, outcome: "duplicate" }, conflict: "" };
      const key = qualifiers(normalized(candidate.text));
      const matched =
        key.length >= 8
          ? active.filter((memory) => qualifiers(normalized(memory.text)) === key)
          : [];
      const existing = matched[0];
      if (!existing) return { item: { ...candidate, outcome: "add" }, conflict: "" };
      return {
        item: { ...candidate, outcome: "conflict", existingText: this.redact(existing.text) },
        conflict: digest(matched.map(revision)),
      };
    };
  }

  add(importId: string, botId: string, selection: MemorySelection) {
    const { scope, selected } = selection;
    const repo = this.repo(botId, scope);
    const inspect = this.inspection(botId, scope);
    const active = repo.list(botId);
    let chars = active.reduce((sum, memory) => sum + Array.from(memory.text).length, 0);
    let added = 0;
    for (const { item, conflict } of selected) {
      const text = this.redact(item.text);
      const current = inspect({ id: item.id, category: item.category, text });
      if (text !== item.text || current.conflict !== conflict)
        throw new ImportFailure("memory_conflict");
      if (current.item.outcome === "duplicate" || repo.similar(botId, text)) continue;
      chars += Array.from(text).length;
      if (active.length + added >= 100 || chars > 8000) throw new ImportFailure("memory_quota");
      const memory = repo.add(botId, text, null, item.category);
      const saved = repo.get(botId, memory.id);
      if (!saved) throw new Error("import_memory_missing");
      this.db
        .prepare(`INSERT INTO import_memories(import_id,memory_id,scope,revision,owner_id)
          VALUES(?,?,?,?,?)`)
        .run(importId, memory.id, scope, revision(saved), botId);
      added++;
    }
    this.db
      .prepare("UPDATE import_jobs SET added_memories=added_memories+? WHERE id=?")
      .run(added, importId);
    return added ? { scope, botId } : undefined;
  }

  /** `botId` is the batch Bot, the owner of rows recorded before per-item destinations. */
  remove(importId: string, botId: string) {
    const rows = this.db
      .prepare("SELECT memory_id,scope,revision,owner_id FROM import_memories WHERE import_id=?")
      .all(importId);
    const changed = new Map<string, { scope: ImportMemoryScope; botId: string }>();
    for (const row of rows) {
      const scope = row.scope === "user" ? "user" : "bot";
      const owner = typeof row.owner_id === "string" ? row.owner_id : botId;
      const id = String(row.memory_id);
      const stored = this.repo(owner, scope).get(owner, id);
      if (!stored) continue;
      if (stored.id !== id || revision(stored) !== row.revision)
        throw new RpcError(-32011, "import_memory_conflict");
      this.db.prepare("DELETE FROM scoped_memories WHERE id=?").run(id);
      changed.set(scope === "user" ? "user" : owner, { scope, botId: owner });
    }
    this.db.prepare("DELETE FROM import_memories WHERE import_id=?").run(importId);
    return [...changed.values()];
  }
}
