-- An append-only phase preserves the original terminal-state CHECK and resumes interrupted cleanup.
ALTER TABLE import_jobs ADD COLUMN cleanup_phase TEXT
  CHECK(cleanup_phase IN ('undoing','discarding'));
ALTER TABLE import_jobs ADD COLUMN removed_topics INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN removed_messages INTEGER NOT NULL DEFAULT 0;
CREATE INDEX import_jobs_cleanup ON import_jobs(cleanup_phase) WHERE cleanup_phase IS NOT NULL;
