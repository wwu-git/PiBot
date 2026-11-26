CREATE TABLE memory_dream_runs (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','done','limited','interrupted','failed')),
  cursor TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0,
  proposed INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  undo_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(undo_json)),
  undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0,1))
);

CREATE INDEX memory_dream_runs_time ON memory_dream_runs(started_at);

-- References only. Facts remain in their original scoped memory and disappear with the proposal.
CREATE TABLE memory_dream_source_facts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_id TEXT NOT NULL REFERENCES memory_extractions(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL REFERENCES scoped_memory_proposals(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('bot','user')),
  owner_id TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  UNIQUE(extraction_id, proposal_id)
);

CREATE INDEX memory_dream_source_owner ON memory_dream_source_facts(scope,owner_id,seq);
CREATE INDEX memory_dream_source_expiry ON memory_dream_source_facts(extracted_at);
CREATE INDEX memory_dream_source_proposal ON memory_dream_source_facts(proposal_id);

CREATE TABLE memory_dream_source_watermarks (
  scope TEXT NOT NULL CHECK(scope IN ('bot','user')),
  owner_id TEXT NOT NULL,
  through_seq INTEGER NOT NULL CHECK(through_seq>0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope,owner_id)
);
