// Preserve each pre-write copy until a refused or cancelled project change is settled.
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "@pibot/storage";
import { z } from "zod";
import { ImportFailure } from "./failure.ts";

const project = z.object({
  root: z.string(),
  device: z.string(),
  inode: z.string(),
  before: z.string(),
  hash: z.string(),
  created: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
});
const stored = project.extend({ position: z.number().int(), botId: z.string().nullable() });

/** `created`: the file did not exist, so undo removes it instead of writing `before` back. */
export type ProjectReceipt = z.output<typeof project>;
export type StoredReceipt = z.output<typeof stored>;
const folder = z.object({ path: z.string(), device: z.string(), inode: z.string() });
export type CreatedFolder = z.output<typeof folder>;

export class ImportProjects {
  constructor(private readonly db: DatabaseSync) {}

  remember(importId: string, botId: string, position: number, value: ProjectReceipt) {
    transaction(this.db, () => {
      if (!this.applying(importId) || this.compensating(value.root, importId))
        throw new ImportFailure("project");
      const existing = this.at(importId, position);
      if (existing) {
        if (!this.same(existing, value)) throw new ImportFailure("project");
        return;
      }
      this.db
        .prepare(`INSERT INTO import_project_notes
        (import_id,position,bot_id,root,device,inode,created,before_text,written_hash,state)
        VALUES(?,?,?,?,?,?,?,?,?,'pending')`)
        .run(
          importId,
          position,
          botId,
          value.root,
          value.device,
          value.inode,
          value.created ? 1 : 0,
          value.before,
          value.hash,
        );
    });
  }

  compensating(root: string, exceptId = "") {
    return !!this.db
      .prepare(`SELECT 1 FROM import_project_notes p
      JOIN import_jobs j ON j.id=p.import_id
      WHERE p.root=? AND p.import_id<>? AND p.state='pending'
        AND j.cleanup_phase IS NOT NULL LIMIT 1`)
      .get(root, exceptId);
  }

  assertCurrent(
    importId: string,
    position: number,
    value: ProjectReceipt,
    mode: "apply" | "restore",
  ) {
    transaction(this.db, () => {
      const current = this.at(importId, position);
      const cleaning = !!this.db
        .prepare(`SELECT 1 FROM import_jobs WHERE id=? AND cleanup_phase IS NOT NULL`)
        .get(importId);
      if (
        !current ||
        !this.same(current, value) ||
        (mode === "apply"
          ? !this.applying(importId) || this.compensating(value.root, importId)
          : !cleaning || this.hasDependents(importId))
      )
        throw new ImportFailure("project");
    });
  }

  private applying(importId: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM import_jobs
      WHERE id=? AND state='running' AND cleanup_phase IS NULL`)
      .get(importId);
  }

  private same(left: ProjectReceipt, right: ProjectReceipt) {
    return (
      left.root === right.root &&
      left.device === right.device &&
      left.inode === right.inode &&
      left.before === right.before &&
      left.hash === right.hash &&
      left.created === right.created
    );
  }

  private at(importId: string, position: number) {
    const row = this.db
      .prepare(`SELECT root,device,inode,before_text AS before,written_hash AS hash,created
      FROM import_project_notes WHERE import_id=? AND position=? AND state='pending'`)
      .get(importId, position);
    return row ? project.parse(row) : undefined;
  }

  pending(importId: string): StoredReceipt[] {
    return this.db
      .prepare(`SELECT position,bot_id AS botId,root,device,inode,before_text AS before,
        written_hash AS hash,created
      FROM import_project_notes WHERE import_id=? AND state='pending' ORDER BY position`)
      .all(importId)
      .map((row) => stored.parse(row));
  }

  /** A later batch wrote the same file over this batch's change; undoing this one first would lose it. */
  hasDependents(importId: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM import_project_notes original
      JOIN import_project_notes later ON later.root=original.root
        AND later.device=original.device AND later.inode=original.inode
        AND later.rowid>original.rowid AND later.state='pending'
        AND later.import_id<>original.import_id
      WHERE original.import_id=? AND original.state='pending' LIMIT 1`)
      .get(importId);
  }

  settle(importId: string, position: number, state: "restored" | "kept") {
    this.db
      .prepare(`UPDATE import_project_notes
      SET before_text='',root='',device='',inode='',written_hash='',state=?
      WHERE import_id=? AND position=? AND state='pending'`)
      .run(state, importId, position);
  }

  /** Recorded before mkdir, so a crash in between still leaves a receipt to clean up. */
  rememberFolder(importId: string, path: string) {
    transaction(this.db, () => {
      if (!this.applying(importId)) throw new ImportFailure("project");
      this.db
        .prepare(`INSERT OR IGNORE INTO import_folders(import_id,path,state)
          VALUES(?,?,'pending')`)
        .run(importId, path);
    });
  }

  folderCreated(importId: string, value: CreatedFolder) {
    this.db
      .prepare(`UPDATE import_folders SET device=?,inode=?
        WHERE import_id=? AND path=? AND state='pending'`)
      .run(value.device, value.inode, importId, value.path);
  }

  /** Deepest first, so a created parent is only considered after its created children. */
  folders(importId: string): CreatedFolder[] {
    return this.db
      .prepare(`SELECT path,device,inode FROM import_folders
        WHERE import_id=? AND state='pending' ORDER BY length(path) DESC, path DESC`)
      .all(importId)
      .map((row) => folder.parse(row));
  }

  settleFolder(importId: string, path: string, state: "removed" | "kept") {
    this.db
      .prepare(`UPDATE import_folders SET state=? WHERE import_id=? AND path=? AND state='pending'`)
      .run(state, importId, path);
  }
}
