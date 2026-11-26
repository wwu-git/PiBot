-- Keep batch ownership and the committed revision needed for safe whole-import undo.
ALTER TABLE import_jobs ADD COLUMN added_memories INTEGER NOT NULL DEFAULT 0;
CREATE TABLE import_memories (
  import_id TEXT NOT NULL REFERENCES import_jobs(id),
  memory_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('user','bot')),
  revision TEXT NOT NULL,
  PRIMARY KEY(import_id, memory_id)
);
CREATE TABLE import_personas (
  import_id TEXT PRIMARY KEY REFERENCES import_jobs(id),
  previous_prompt TEXT NOT NULL,
  applied_hash TEXT NOT NULL
);
CREATE TABLE import_memory_usage (
  import_id TEXT PRIMARY KEY REFERENCES import_jobs(id),
  at TEXT NOT NULL,
  tokens INTEGER NOT NULL CHECK(tokens >= 0)
);
CREATE INDEX import_memory_usage_at ON import_memory_usage(at);
CREATE TABLE import_project_files (
  import_id TEXT PRIMARY KEY REFERENCES import_jobs(id),
  root TEXT NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  before_text TEXT NOT NULL,
  written_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','restored','kept'))
);
