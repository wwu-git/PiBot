import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@pibot/protocol-base";
import { z } from "zod";

export const RunFileChangeKindSchema = z.enum(["add", "modify", "delete", "command"]);
const ref = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
const RowSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  botId: IdSchema,
  root: z.string().min(1),
  path: z.string().min(1),
  kind: RunFileChangeKindSchema,
  beforeRef: ref,
  afterRef: ref,
  beforeMode: z.number().int().min(0).max(0o777).nullable(),
  afterMode: z.number().int().min(0).max(0o777).nullable(),
  rootDevice: z.string().nullable(),
  rootInode: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type RunFileChange = z.infer<typeof RowSchema>;
/** One path in a turn: the first recorded "before" and the last recorded "after". */
export interface RunFileSummary {
  path: string;
  root: string;
  kind: z.infer<typeof RunFileChangeKindSchema>;
  beforeRef: string | null;
  afterRef: string | null;
  beforeMode: number | null;
  afterMode: number | null;
  rootDevice: string | null;
  rootInode: string | null;
}

/** Hard cap per run: a runaway command cannot grow the table without bound. */
export const RUN_FILE_CHANGE_LIMIT = 2000;
const columns =
  "id,run_id AS runId,bot_id AS botId,root,path,kind,before_ref AS beforeRef,after_ref AS afterRef,before_mode AS beforeMode,after_mode AS afterMode,root_device AS rootDevice,root_inode AS rootInode,created_at AS createdAt";

export class RunFileChangesRepo {
  constructor(private readonly db: DatabaseSync) {}
  /** Returns false when the run already reached its cap; the caller records nothing more. */
  record(
    input: Omit<
      RunFileChange,
      "id" | "createdAt" | "beforeMode" | "afterMode" | "rootDevice" | "rootInode"
    > &
      Partial<Pick<RunFileChange, "beforeMode" | "afterMode" | "rootDevice" | "rootInode">>,
  ): boolean {
    const row = RowSchema.parse({
      ...input,
      beforeMode: input.beforeMode ?? null,
      afterMode: input.afterMode ?? null,
      rootDevice: input.rootDevice ?? null,
      rootInode: input.rootInode ?? null,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const used = Number(
      this.db.prepare("SELECT count(*) AS n FROM run_file_changes WHERE run_id=?").get(row.runId)
        ?.n ?? 0,
    );
    if (used >= RUN_FILE_CHANGE_LIMIT) return false;
    this.db
      .prepare(
        "INSERT INTO run_file_changes(id,run_id,bot_id,root,path,kind,before_ref,after_ref,before_mode,after_mode,root_device,root_inode,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.runId,
        row.botId,
        row.root,
        row.path,
        row.kind,
        row.beforeRef,
        row.afterRef,
        row.beforeMode,
        row.afterMode,
        row.rootDevice,
        row.rootInode,
        row.createdAt,
      );
    return true;
  }
  /** Paths already recorded by write tools, so command-observed paths do not duplicate them. */
  paths(runId: string): Set<string> {
    return new Set(
      this.db
        .prepare("SELECT DISTINCT path FROM run_file_changes WHERE run_id=? LIMIT ?")
        .all(IdSchema.parse(runId), RUN_FILE_CHANGE_LIMIT)
        .map((row) => String(row.path)),
    );
  }
  /**
   * When each path the runs wrote was last written, bounded. A command observation counts (a
   * script that renders a chart writes only through a command); tool deletes do not.
   */
  lastWrites(runIds: readonly string[]): { root: string; path: string; at: string }[] {
    const ids = runIds.slice(0, 50).map((id) => IdSchema.parse(id));
    if (!ids.length) return [];
    return this.db
      .prepare(
        `SELECT root,path,max(created_at) AS at FROM run_file_changes
        WHERE run_id IN (${ids.map(() => "?").join(",")})
        AND (kind='command' OR (kind IN ('add','modify') AND after_ref IS NOT NULL))
        GROUP BY root,path ORDER BY at DESC LIMIT ?`,
      )
      .all(...ids, RUN_FILE_CHANGE_LIMIT)
      .map((row) => ({ root: String(row.root), path: String(row.path), at: String(row.at) }));
  }
  botOf(runId: string): string | undefined {
    const row = this.db
      .prepare("SELECT bot_id AS botId FROM run_file_changes WHERE run_id=? LIMIT 1")
      .get(IdSchema.parse(runId));
    return row ? String(row.botId) : undefined;
  }
  /** Rows are bounded per run, so the aggregation is a single bounded scan ordered by time. */
  summarize(runId: string): RunFileSummary[] {
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM run_file_changes WHERE run_id=? ORDER BY created_at,rowid LIMIT ?`,
      )
      .all(IdSchema.parse(runId), RUN_FILE_CHANGE_LIMIT)
      .map((row) => RowSchema.parse(row));
    const byPath = new Map<string, RunFileSummary>();
    for (const row of rows) {
      const current = byPath.get(row.path);
      if (!current) {
        byPath.set(row.path, {
          path: row.path,
          root: row.root,
          kind: row.kind,
          beforeRef: row.beforeRef,
          afterRef: row.afterRef,
          beforeMode: row.beforeMode,
          afterMode: row.afterMode,
          rootDevice: row.rootDevice,
          rootInode: row.rootInode,
        });
        continue;
      }
      // A tool write wins over a command observation of the same path; "add" survives later edits.
      if (current.kind === "command" && row.kind !== "command") {
        current.kind = row.kind;
        current.beforeRef = row.beforeRef;
        current.beforeMode = row.beforeMode;
      }
      if (row.kind !== "command") {
        current.afterRef = row.afterRef;
        current.afterMode = row.afterMode;
      }
      if (current.rootDevice !== row.rootDevice || current.rootInode !== row.rootInode) {
        current.rootDevice = null;
        current.rootInode = null;
      }
    }
    return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  /** The newest run in a conversation that changed files ("this turn"). */
  latestRun(target: { botId: string; conversationId?: string; groupId?: string }) {
    const row = target.groupId
      ? this.db
          .prepare(
            "SELECT c.run_id AS runId FROM run_file_changes c JOIN runs r ON r.id=c.run_id WHERE r.group_id=? ORDER BY c.created_at DESC LIMIT 1",
          )
          .get(IdSchema.parse(target.groupId))
      : target.conversationId
        ? this.db
            .prepare(
              "SELECT c.run_id AS runId FROM run_file_changes c JOIN runs r ON r.id=c.run_id WHERE r.conversation_id=? AND r.group_id IS NULL ORDER BY c.created_at DESC LIMIT 1",
            )
            .get(IdSchema.parse(target.conversationId))
        : this.db
            .prepare(
              "SELECT c.run_id AS runId FROM run_file_changes c JOIN runs r ON r.id=c.run_id WHERE c.bot_id=? AND r.group_id IS NULL ORDER BY c.created_at DESC LIMIT 1",
            )
            .get(IdSchema.parse(target.botId));
    return row ? String(row.runId) : undefined;
  }
  /** Removes rows older than the retention cutoff and returns their runs so snapshots can go too. */
  expire(before: string, limit = 500): { runId: string; botId: string }[] {
    const runs = this.db
      .prepare(
        "SELECT run_id AS runId, bot_id AS botId FROM run_file_changes GROUP BY run_id,bot_id HAVING max(created_at) < ? LIMIT ?",
      )
      .all(before, limit)
      .map((row) => ({ runId: String(row.runId), botId: String(row.botId) }));
    const remove = this.db.prepare("DELETE FROM run_file_changes WHERE run_id=?");
    for (const run of runs) remove.run(run.runId);
    return runs;
  }
}
