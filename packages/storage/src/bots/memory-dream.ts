import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema, MemoryDreamSummarySchema } from "@pibot/protocol-base";
import { z } from "zod";
import { transaction } from "../database/database.ts";

const select = `id,day,started_at AS startedAt,finished_at AS finishedAt,status,cursor,
  merged,retired,proposed,tokens,MAX(COALESCE(cost_usd,0),0) AS costUsd,undo_json AS undoJson,undone`;
const scalar = MemoryDreamSummarySchema.omit({ undoable: true }).extend({
  day: z.string(),
  cursor: z.string().nullable(),
  undoJson: z.string(),
  undone: z.number().int().min(0).max(1),
});
const receipts = z.array(z.strictObject({ botId: IdSchema, proposalId: IdSchema })).max(100);

export type DreamReceipt = z.infer<typeof receipts>[number];
export type DreamRun = NonNullable<ReturnType<MemoryDreamRepo["last"]>>;

type DreamSourceOwner = { scope: "bot" | "user"; ownerId: string };
type DreamSourceProgress = DreamSourceOwner & { through: number };
const factLimit = 24;

/**
 * Runs stored before unknown prices were handled could hold a negative cost (custom models price
 * at -1). Reads clamp it so one old row cannot make every later summary fail validation.
 */
export function nonNegativeCost(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}
const factAgeMs = 7 * 86_400_000;

export class MemoryDreamRepo {
  constructor(private readonly db: DatabaseSync) {}

  recover(now: string) {
    this.db
      .prepare(`UPDATE memory_dream_runs SET status='interrupted',finished_at=?
      WHERE status='running'`)
      .run(now);
  }

  last() {
    const row = this.db
      .prepare(`SELECT ${select} FROM memory_dream_runs ORDER BY day DESC LIMIT 1`)
      .get();
    if (!row) return undefined;
    const { undoJson, ...state } = scalar.parse(row);
    return { ...state, receipts: receipts.parse(JSON.parse(undoJson)) };
  }

  start(day: string, startedAt: string, cursor: string | null) {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO memory_dream_runs(id,day,started_at,status,cursor)
      VALUES(?,?,?,'running',?)`)
      .run(id, day, startedAt, cursor);
    return id;
  }

  resume(id: string) {
    const updated = this.db
      .prepare(`UPDATE memory_dream_runs SET status='running', finished_at=NULL
        WHERE id=? AND status IN ('failed','interrupted') AND undone=0`)
      .run(id);
    if (updated.changes !== 1) throw new Error("dream_resume_unowned");
  }

  checkpoint(
    id: string,
    cursor: string,
    result: Pick<DreamRun, "merged" | "retired" | "proposed" | "receipts">,
    facts?: DreamSourceProgress,
  ) {
    transaction(this.db, () => {
      const run = this.last();
      if (!run || run.id !== id || run.status !== "running")
        throw new Error("dream_checkpoint_unowned");
      const updated = this.db
        .prepare(`UPDATE memory_dream_runs SET cursor=?,merged=merged+?,retired=retired+?,
        proposed=proposed+?,undo_json=? WHERE id=? AND status='running'`)
        .run(
          cursor,
          result.merged,
          result.retired,
          result.proposed,
          JSON.stringify(receipts.parse([...run.receipts, ...result.receipts])),
          id,
        );
      if (updated.changes !== 1) throw new Error("dream_checkpoint_unowned");
      if (!facts) return;
      this.db
        .prepare(`INSERT INTO memory_dream_source_watermarks(scope,owner_id,through_seq,updated_at)
          VALUES(?,?,?,?) ON CONFLICT(scope,owner_id) DO UPDATE SET
          through_seq=excluded.through_seq, updated_at=excluded.updated_at
          WHERE excluded.through_seq>memory_dream_source_watermarks.through_seq`)
        .run(facts.scope, facts.ownerId, facts.through, new Date().toISOString());
    });
  }

  /** Called in the ordinary extraction settlement transaction after coverage is recorded. */
  recordFacts(extractionId: string, acceptedProposals: readonly string[]) {
    if (!acceptedProposals.length) return;
    this.pruneFacts();
    this.db
      .prepare(`INSERT OR IGNORE INTO memory_dream_source_facts
        (extraction_id,proposal_id,scope,owner_id,extracted_at)
        SELECT e.id,p.id,p.scope,p.owner_id,e.finished_at
        FROM memory_extractions e JOIN bots b ON b.id=e.bot_id
        JOIN conversations c ON c.id=e.conversation_id AND c.bot_id=e.bot_id
        JOIN messages coverage ON coverage.id=e.coverage_message_id AND coverage.conversation_id=c.id
        JOIN scoped_memory_proposals p ON p.bot_id=e.bot_id
          AND p.id IN (SELECT value FROM json_each(?))
        JOIN messages src ON src.id=p.message_id AND src.conversation_id=c.id
        JOIN scoped_memories m ON m.id=p.resolved_memory_id AND m.scope=p.scope AND m.owner_id=p.owner_id
        WHERE e.id=? AND e.status='done' AND e.reason<>'correction' AND e.group_id IS NULL
          AND b.kind IS NULL AND b.archived_at IS NULL AND b.memory_extraction=1
          AND c.kind='dm' AND c.import_id IS NULL AND c.internal_task_id IS NULL
          AND coverage.import_id IS NULL AND src.import_id IS NULL
          AND src.role='user' AND src.status='done' AND src.bot_id IS NULL
          AND p.status='accepted' AND p.action IN ('add','update')
          AND ((p.scope='bot' AND p.owner_id=e.bot_id) OR (p.scope='user' AND p.owner_id='user'))
        ORDER BY p.id`)
      .run(JSON.stringify(acceptedProposals), extractionId);
  }

  /** Return references to still-current facts only. Topic and message IDs stay out of the draft. */
  unreadFacts(owner: DreamSourceOwner, catalog: readonly string[], now: number) {
    if (!catalog.length) return [];
    const stamp = new Date(now).toISOString();
    return this.db
      .prepare(`SELECT f.seq, f.extraction_id AS extractionId, m.id AS memoryId
        FROM memory_dream_source_facts f
        JOIN memory_extractions e ON e.id=f.extraction_id
        JOIN bots b ON b.id=e.bot_id AND b.kind IS NULL AND b.archived_at IS NULL AND b.memory_extraction=1
        JOIN conversations c ON c.id=e.conversation_id AND c.bot_id=b.id
        JOIN messages coverage ON coverage.id=e.coverage_message_id AND coverage.conversation_id=c.id
        JOIN scoped_memory_proposals p ON p.id=f.proposal_id AND p.scope=f.scope
          AND p.owner_id=f.owner_id AND p.bot_id=e.bot_id
        JOIN messages src ON src.id=p.message_id AND src.conversation_id=c.id
        JOIN scoped_memories m ON m.id=p.resolved_memory_id AND m.scope=f.scope AND m.owner_id=f.owner_id
        WHERE f.scope=? AND f.owner_id=? AND f.extracted_at>=?
          AND f.seq>COALESCE((SELECT w.through_seq FROM memory_dream_source_watermarks w
            WHERE w.scope=f.scope AND w.owner_id=f.owner_id),0)
          AND e.status='done' AND e.reason<>'correction' AND e.group_id IS NULL
          AND c.kind='dm' AND c.import_id IS NULL AND c.internal_task_id IS NULL
          AND coverage.import_id IS NULL AND src.import_id IS NULL
          AND src.role='user' AND src.status='done' AND src.bot_id IS NULL
          AND p.status='accepted' AND p.text=m.text AND p.category IS m.category
          AND m.archived_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)
          AND m.id IN (SELECT value FROM json_each(?))
        ORDER BY f.seq LIMIT ?`)
      .all(
        owner.scope,
        owner.ownerId,
        new Date(now - factAgeMs).toISOString(),
        stamp,
        JSON.stringify(catalog),
        factLimit,
      )
      .map((row) => ({
        seq: Number(row.seq),
        extractionId: String(row.extractionId),
        memoryId: String(row.memoryId),
      }));
  }

  pruneFacts(now = Date.now()) {
    const before = new Date(now - factAgeMs).toISOString();
    this.db.prepare("DELETE FROM memory_dream_source_facts WHERE extracted_at<?").run(before);
    this.db.prepare("DELETE FROM memory_dream_source_watermarks WHERE updated_at<?").run(before);
  }

  usage(id: string, tokens: number, costUsd: number) {
    this.db
      .prepare(`UPDATE memory_dream_runs SET tokens=?,cost_usd=?
      WHERE id=? AND status='running'`)
      .run(tokens, nonNegativeCost(costUsd), id);
  }

  finish(id: string, status: Exclude<DreamRun["status"], "running">, finishedAt: string) {
    this.db
      .prepare(`UPDATE memory_dream_runs SET status=?,finished_at=?
      WHERE id=? AND status='running'`)
      .run(status, finishedAt, id);
  }

  markUndone(id: string) {
    this.db.prepare("UPDATE memory_dream_runs SET undone=1 WHERE id=?").run(id);
  }

  prune(before: string) {
    this.db
      .prepare("DELETE FROM memory_dream_runs WHERE started_at<? AND status<>'running'")
      .run(before);
  }
}
