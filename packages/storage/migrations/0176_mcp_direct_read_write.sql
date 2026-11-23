ALTER TABLE connectors RENAME COLUMN confirmation_mode TO previous_confirmation_mode;
ALTER TABLE connectors ADD COLUMN confirmation_mode TEXT NOT NULL DEFAULT 'read_write'
  CHECK(confirmation_mode IN ('read_write','always_ask','read_only')
    OR (confirmation_mode = 'direct_read_write' AND kind IN ('mcp_remote','mcp_stdio')));
UPDATE connectors SET confirmation_mode = previous_confirmation_mode
WHERE previous_confirmation_mode <> 'read_write';
ALTER TABLE connectors DROP COLUMN previous_confirmation_mode;
