CREATE TABLE external_agent_bots_next (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL CHECK (agent_id IN ('codex', 'claude', 'cursor', 'opencode', 'antigravity', 'custom')),
  custom_json TEXT CHECK (custom_json IS NULL OR json_valid(custom_json)),
  adapter_version TEXT,
  created_at TEXT NOT NULL,
  options_json TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
  preferences_json TEXT CHECK (preferences_json IS NULL OR json_valid(preferences_json))
);
INSERT INTO external_agent_bots_next
  (bot_id, agent_id, custom_json, adapter_version, created_at, options_json, preferences_json)
SELECT bot_id, agent_id, custom_json, adapter_version, created_at, options_json, preferences_json
FROM external_agent_bots;
DROP TABLE external_agent_bots;
ALTER TABLE external_agent_bots_next RENAME TO external_agent_bots;

CREATE TABLE external_agent_confirmations_next (
  subject TEXT PRIMARY KEY CHECK (
    subject IN ('codex', 'claude', 'cursor', 'opencode', 'antigravity') OR subject LIKE 'custom:%'
  ),
  confirmed_at TEXT NOT NULL
);
INSERT INTO external_agent_confirmations_next (subject, confirmed_at)
SELECT subject, confirmed_at FROM external_agent_confirmations;
DROP TABLE external_agent_confirmations;
ALTER TABLE external_agent_confirmations_next RENAME TO external_agent_confirmations;
