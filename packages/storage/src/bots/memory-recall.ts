import type { DatabaseSync } from "node:sqlite";
import type { MemoryOwner } from "@pibot/protocol-base";
import { normalizeMemory } from "./memory-search.ts";

export const MEMORY_RECALL_LIMIT = 32;
export const MEMORY_SHORT_SCAN_LIMIT = 512;
// Maintainers 2026-11-11: active user notes are no longer all resident (only a fixed token budget is),
// so they are recall candidates like other scopes; the caller passes what it already injected.
const eligible =
  "(archived_at IS NOT NULL OR (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) AND (scope='user' OR category='work' OR category IS NULL))";
const notIn = (ids: readonly string[]) =>
  ids.length ? ` AND id NOT IN (${ids.map(() => "?").join(",")})` : "";
const sample = (tokens: string[], limit: number) =>
  tokens.filter((_, i) => i % Math.max(1, Math.ceil(tokens.length / limit)) === 0).slice(0, limit);

function recallMatch(query: string) {
  // Literal terms only: neither prompt text nor FTS operators become executable query syntax.
  const words = normalizeMemory(query.slice(0, 8192)).match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set<string>();
  const short = new Set<string>();
  for (const word of words) {
    const cjk =
      word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ??
      [];
    for (const segment of cjk) {
      const chars = Array.from(segment);
      for (let i = 0; i + 1 < chars.length; i++) short.add(chars.slice(i, i + 2).join(""));
    }
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      for (let i = 0; i + 2 < chars.length; i++) terms.add(chars.slice(i, i + 3).join(""));
    } else if (word.length >= 3) terms.add(word.slice(0, 64));
  }
  return {
    fts: sample([...terms], 32)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" OR "),
    short: sample([...short], 16),
  };
}

type RecallId = MemoryOwner & { id: string };
export const MEMORY_SEARCH_LIMIT = 20;
export type MemoryCatalogRow = {
  id: string;
  scope: MemoryOwner["scope"];
  ownerId: string;
  category: string | null;
  preview: string;
};
function visibleScope(owners: readonly MemoryOwner[]) {
  return {
    where: owners.map(() => "(m.scope=? AND m.owner_id=?)").join(" OR "),
    params: owners.flatMap((owner) => [owner.scope, owner.ownerId]),
  };
}

/**
 * Memory_search. Same literal terms as recall, but over every active and archived note in
 * the caller's scopes: ids shown in the catalog must stay findable after a keyword query misses.
 */
export function searchMemoryIds(
  db: DatabaseSync,
  owners: readonly MemoryOwner[],
  query: string,
  limit = MEMORY_SEARCH_LIMIT,
  signal?: AbortSignal,
): RecallId[] {
  signal?.throwIfAborted();
  if (!owners.length) return [];
  const match = recallMatch(query);
  const { where, params } = visibleScope(owners);
  const rows = match.fts
    ? db
        .prepare(
          `SELECT m.id,m.scope,m.owner_id AS ownerId
       FROM memory_fts JOIN scoped_memories m ON m.rowid=memory_fts.rowid
       WHERE memory_fts MATCH ? AND (${where})
       ORDER BY memory_fts.rank,m.id LIMIT ?`,
        )
        .all(match.fts, ...params, limit)
    : [];
  signal?.throwIfAborted();
  const result: RecallId[] = rows.map((row) => ({
    id: String(row.id),
    scope: row.scope as MemoryOwner["scope"],
    ownerId: String(row.ownerId),
  }));
  if (result.length >= limit || !match.short.length) return result;
  // Two-character CJK terms are shorter than the trigram tokenizer, so the index cannot answer
  // them; scan a bounded recent window per owner like recall does.
  const known = new Set(result.map((row) => row.id));
  const fallback = db.prepare(`WITH recent AS MATERIALIZED (
    SELECT id,scope,owner_id,normalized_text FROM scoped_memories
    WHERE scope=? AND owner_id=? ORDER BY COALESCE(last_used_at,updated_at) DESC,id DESC LIMIT ?
  ) SELECT id,scope,owner_id AS ownerId FROM recent
    WHERE (${match.short.map(() => "instr(normalized_text,?)>0").join(" OR ")})
    ORDER BY id LIMIT ?`);
  for (const owner of owners) {
    signal?.throwIfAborted();
    const found = fallback.all(
      owner.scope,
      owner.ownerId,
      MEMORY_SHORT_SCAN_LIMIT,
      ...match.short,
      limit,
    );
    for (const row of found) {
      const id = String(row.id);
      if (known.has(id)) continue;
      known.add(id);
      result.push({ id, ...owner });
      if (result.length >= limit) return result;
    }
  }
  return result;
}

// A note's own text must not be able to forge another catalog line: collapse every whitespace run
// (newlines included) to one space before cutting to the preview length.
function catalogPreview(text: string) {
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 60).join("");
}

/**
 * One line per active note for the injected catalog. Ordering is stable (category, then
 * creation order) because the prompt is cached by prefix: ordering by recent use would rewrite the
 * catalog whenever any memory is touched and turn every later request into a cache miss. Notes
 * already injected in full are excluded so the catalog never repeats what the model can read
 * anyway; the caller adds the truncated count.
 */
export function memoryCatalogRows(
  db: DatabaseSync,
  owners: readonly MemoryOwner[],
  limit = 300,
  exclude: readonly string[] = [],
): { rows: MemoryCatalogRow[]; total: number } {
  if (!owners.length) return { rows: [], total: 0 };
  const { where, params } = visibleScope(owners);
  const excluded = exclude.length ? ` AND m.id NOT IN (${exclude.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(
      `SELECT m.id,m.scope,m.owner_id AS ownerId,m.category,substr(m.text,1,240) AS preview
       FROM scoped_memories m
       WHERE (${where}) AND m.archived_at IS NULL${excluded}
       ORDER BY CASE m.category WHEN 'about_you' THEN 0 WHEN 'how_to' THEN 1 WHEN 'work' THEN 2 ELSE 3 END,
         m.created_at,m.id LIMIT ?`,
    )
    .all(...params, ...exclude, limit)
    .map((row) => ({
      id: String(row.id),
      scope: row.scope as MemoryOwner["scope"],
      ownerId: String(row.ownerId),
      category: row.category == null ? null : String(row.category),
      preview: catalogPreview(String(row.preview)),
    }));
  const total = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM scoped_memories m WHERE (${where}) AND m.archived_at IS NULL${excluded}`,
      )
      .get(...params, ...exclude)?.n ?? 0,
  );
  return { rows, total };
}

function shortMemoryIds(
  db: DatabaseSync,
  owners: readonly MemoryOwner[],
  terms: string[],
  signal?: AbortSignal,
  exclude: readonly string[] = [],
): RecallId[] {
  if (!terms.length) return [];
  const result: RecallId[] = [];
  const query = db.prepare(`WITH recent AS MATERIALIZED (
    SELECT id,scope,owner_id,archived_at,category,expires_at,normalized_text
    FROM scoped_memories WHERE scope=? AND owner_id=?
    ORDER BY created_at DESC,id DESC LIMIT ?
  ) SELECT id,scope,owner_id AS ownerId FROM recent
    WHERE ${eligible}${notIn(exclude)} AND (${terms.map(() => "instr(normalized_text,?)>0").join(" OR ")})
    ORDER BY id LIMIT ?`);
  for (const owner of owners) {
    signal?.throwIfAborted();
    // MATERIALIZED prevents predicate pushdown from turning the scan cap into a match cap.
    const rows = query.all(
      owner.scope,
      owner.ownerId,
      MEMORY_SHORT_SCAN_LIMIT,
      ...exclude,
      ...terms,
      MEMORY_RECALL_LIMIT * 2,
    );
    result.push(...rows.map((row) => ({ id: String(row.id), ...owner })));
  }
  signal?.throwIfAborted();
  return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The caller supplies trusted owners; SQL filters them before any text is returned. `exclude`
 * holds the notes already injected in full, so they cannot use up the candidate limit.
 */
export function recallMemoryIds(
  db: DatabaseSync,
  owners: readonly MemoryOwner[],
  query: string,
  signal?: AbortSignal,
  exclude: readonly string[] = [],
): RecallId[] {
  signal?.throwIfAborted();
  const match = recallMatch(query);
  if (!owners.length) return [];
  const visible = owners.map(() => "(m.scope=? AND m.owner_id=?)").join(" OR ");
  const rows = match.fts
    ? db
        .prepare(
          `SELECT m.id,m.scope,m.owner_id AS ownerId
       FROM memory_fts JOIN scoped_memories m ON m.rowid=memory_fts.rowid
       WHERE memory_fts MATCH ? AND (${visible})
         AND (m.archived_at IS NOT NULL OR m.scope='user' OR m.category='work' OR m.category IS NULL)${notIn(exclude).replace("id NOT IN", "m.id NOT IN")}
       ORDER BY memory_fts.rank,m.id LIMIT ?`,
        )
        .all(
          match.fts,
          ...owners.flatMap((owner) => [owner.scope, owner.ownerId]),
          ...exclude,
          MEMORY_RECALL_LIMIT,
        )
    : [];
  signal?.throwIfAborted();
  const result = rows.map((row) => ({
    id: String(row.id),
    scope: row.scope as MemoryOwner["scope"],
    ownerId: String(row.ownerId),
  }));
  if (result.length === MEMORY_RECALL_LIMIT) return result;
  const known = new Set(result.map((row) => row.id));
  for (const candidate of shortMemoryIds(db, owners, match.short, signal, exclude)) {
    if (known.has(candidate.id)) continue;
    known.add(candidate.id);
    result.push(candidate);
    if (result.length === MEMORY_RECALL_LIMIT) break;
  }
  return result;
}
