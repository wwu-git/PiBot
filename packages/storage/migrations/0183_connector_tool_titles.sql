-- The MCP tool `title` (or annotations.title) a server declares, kept with each catalog generation
-- for display only. It is never part of a tool's identity, fingerprint or authorization.
ALTER TABLE connector_tools ADD COLUMN title TEXT CHECK(title IS NULL OR length(title) <= 200);
