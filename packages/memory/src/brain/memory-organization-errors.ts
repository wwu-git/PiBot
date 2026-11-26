// Classifies organization failures without exposing diagnostic text.
import { AgentErrorCodeSchema } from "@pibot/protocol-base";

/** SQLite diagnostics may contain identifiers or content; only fixed classifications leave here. */
export function organizationErrorDetails(error: unknown) {
  if (error instanceof Error && ["ZodError", "SyntaxError", "TypeError"].includes(error.name))
    return { error: "draft_invalid" };
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  if (value?.code !== "ERR_SQLITE_ERROR") {
    const parsed = AgentErrorCodeSchema.safeParse(value?.code);
    return { error: parsed.success ? parsed.data : "organization_failed" };
  }
  const message = typeof value.message === "string" ? value.message.slice(0, 1024) : "";
  const primary = typeof value.errcode === "number" ? value.errcode & 0xff : undefined;
  let sqliteReason: string;
  if (/^no such column:/i.test(message)) sqliteReason = "sqlite_missing_column";
  else if (/^no such table:/i.test(message)) sqliteReason = "sqlite_missing_table";
  else if (/^ambiguous column name:/i.test(message)) sqliteReason = "sqlite_ambiguous_column";
  else if (/^fts5:|^unterminated string$/i.test(message)) sqliteReason = "sqlite_fts";
  else if (/syntax error|^incomplete input$/i.test(message)) sqliteReason = "sqlite_syntax";
  else {
    switch (primary) {
      case 5:
      case 6:
        sqliteReason = "sqlite_busy";
        break;
      case 17:
        sqliteReason = "sqlite_schema_changed";
        break;
      case 19:
        sqliteReason = "sqlite_constraint";
        break;
      case 25:
        sqliteReason = "sqlite_parameter";
        break;
      default:
        sqliteReason = "sqlite_other";
    }
  }
  return { error: "ERR_SQLITE_ERROR", sqliteReason };
}
