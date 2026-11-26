-- Add classification and validity metadata without rewriting existing memory rows.
ALTER TABLE scoped_memories ADD COLUMN kind TEXT CHECK(kind IN ('preference','method','project','decision'));
ALTER TABLE scoped_memories ADD COLUMN confirmed_at TEXT;
ALTER TABLE scoped_memories ADD COLUMN expires_at TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN expires_at TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN project_path TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN project_diff TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN project_expected_hash TEXT;
UPDATE scoped_memories
SET kind=CASE category WHEN 'about_you' THEN 'preference' WHEN 'how_to' THEN 'method' ELSE 'decision' END,
    confirmed_at=updated_at
WHERE kind IS NULL;
