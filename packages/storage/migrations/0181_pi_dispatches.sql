-- Work the default Pi handed to a Bot or a group: one row per send_to_bot / send_to_group call,
-- read by the receipt card under that step. Names, status, a short redacted excerpt and output
-- file names only; never the full task, replies or file contents.
CREATE TABLE pi_dispatches (
  id TEXT PRIMARY KEY,
  pi_bot_id TEXT NOT NULL,
  pi_run_id TEXT NOT NULL,
  pi_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('bot','group')),
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_conversation_id TEXT,
  target_run_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('working','done','failed','stopped','waiting')),
  summary TEXT NOT NULL DEFAULT '',
  outputs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(outputs_json)),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(pi_run_id, tool_call_id)
);

CREATE INDEX pi_dispatches_message ON pi_dispatches(pi_message_id, created_at);
CREATE INDEX pi_dispatches_open ON pi_dispatches(status) WHERE status IN ('working','waiting');
