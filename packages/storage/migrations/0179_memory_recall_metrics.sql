CREATE TABLE memory_recall_metrics (
  memory_id TEXT PRIMARY KEY REFERENCES scoped_memories(id) ON DELETE CASCADE,
  injected_count INTEGER NOT NULL DEFAULT 0 CHECK(injected_count>=0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count>=0 AND used_count<=injected_count),
  measured_since TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE memory_recall_observations (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES scoped_memories(id) ON DELETE CASCADE,
  memory_updated_at TEXT NOT NULL,
  injected_at TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY(run_id,memory_id)
);
CREATE INDEX memory_recall_observations_memory ON memory_recall_observations(memory_id);
