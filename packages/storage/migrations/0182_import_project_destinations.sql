-- Every source project of a batch can create its own folder and write its own AGENTS.md, and
-- memories and the role can go to different Bots, so undo needs one receipt per destination.
-- Written to be safe to re-run on a database that already has part of it.
CREATE TABLE IF NOT EXISTS import_project_notes (
  import_id TEXT NOT NULL REFERENCES import_jobs(id),
  position INTEGER NOT NULL,
  -- The Bot that wrote the file (and restores it); NULL is the batch Bot.
  bot_id TEXT,
  root TEXT NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  -- The file did not exist; undo removes it instead of writing before_text back.
  created INTEGER NOT NULL DEFAULT 0 CHECK(created IN (0,1)),
  before_text TEXT NOT NULL,
  written_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','restored','kept')),
  PRIMARY KEY(import_id, position)
);
INSERT OR IGNORE INTO import_project_notes
  (import_id, position, root, device, inode, created, before_text, written_hash, state)
  SELECT import_id, 0, root, device, inode, 0, before_text, written_hash, state
  FROM import_project_files;
CREATE INDEX IF NOT EXISTS import_project_notes_root ON import_project_notes(root, state);

-- Folders the batch created (removed by undo only while still empty) and work-folder records it
-- registered for a Bot (hidden by undo once no topic or routine uses them).
CREATE TABLE IF NOT EXISTS import_folders (
  import_id TEXT NOT NULL REFERENCES import_jobs(id),
  path TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  inode TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('pending','removed','kept')),
  PRIMARY KEY(import_id, path)
);
CREATE TABLE IF NOT EXISTS import_folder_records (
  import_id TEXT NOT NULL REFERENCES import_jobs(id),
  bot_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  PRIMARY KEY(import_id, bot_id, folder_id)
);

-- A project's topics belong to the Bot chosen for that project, not only the batch Bot; they
-- still come only from a running batch of the same source, for a Bot that is not archived.
DROP TRIGGER IF EXISTS import_topic_owner;
CREATE TRIGGER import_topic_owner BEFORE INSERT ON conversations
WHEN (NEW.import_id IS NULL AND NEW.import_source IS NOT NULL)
  OR (NEW.import_id IS NOT NULL AND (
    NEW.kind<>'dm' OR NEW.pi_session_file IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM import_jobs WHERE id=NEW.import_id AND state='running'
        AND source=NEW.import_source
    )
    OR NOT EXISTS (SELECT 1 FROM bots WHERE id=NEW.bot_id AND archived_at IS NULL)
  ))
BEGIN
  SELECT RAISE(ABORT, 'import_topic_read_only');
END;

-- SQLite has no ADD COLUMN IF NOT EXISTS; the migration ledger runs this file once.
-- NULL keeps the batch Bot for rows written before per-item destinations.
ALTER TABLE import_memories ADD COLUMN owner_id TEXT;
ALTER TABLE import_personas ADD COLUMN bot_id TEXT;
-- The import history lists batches by when they started; earlier batches show no date.
ALTER TABLE import_jobs ADD COLUMN created_at TEXT;
CREATE INDEX IF NOT EXISTS import_jobs_history ON import_jobs(created_at);
