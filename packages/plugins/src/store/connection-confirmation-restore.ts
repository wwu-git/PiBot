import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { connectorAuditEvents, newConnectionDefaults } from "@pibot/plugins-contract/full";
import { type AuditRepo, transaction } from "@pibot/storage";

/**
 * The connection-permissions migration mapped "ask on first use, then remember" to
 * "ask every time", which no longer remembers anything and so asks on every read. A connection
 * the user has not edited since that migration goes back to the new-connection default (read
 * directly, ask before writes), the same mode a fresh install of it gets. One the user edited
 * since keeps what it has, and a failing row stays "ask every time" (the stricter mode).
 *
 * Restoring used to also require evidence that the old first-use question had been
 * answered (a remembered grant, a routine pre-authorization or trigger). A connection still on
 * "ask first" at migration time had by definition never been granted through that question, so
 * an untouched local calendar was kept on "ask every time" (`confirmation_restore_kept_always_ask`)
 * although the user never chose it. Migration 0104 re-queues those `kept` rows.
 *
 * "Edited" is read from the audited user changes, never from `revision`: connector start, stop,
 * status and catalog refreshes advance `revision` too. `revision` only guards the write itself.
 */
export async function restoreFirstUseConfirmation(
  db: DatabaseSync,
  audit: AuditRepo,
  actorBotId: string,
  signal: AbortSignal,
) {
  let after = "";
  while (true) {
    signal.throwIfAborted();
    const rows = db
      .prepare(`SELECT connector_id,installation_id
      FROM connection_confirmation_restores
      WHERE state='pending' AND connector_id>? ORDER BY connector_id LIMIT 100`)
      .all(after);
    if (!rows.length) break;
    for (const row of rows) {
      const connectorId = String(row.connector_id);
      const installationId = String(row.installation_id);
      after = connectorId;
      const settle = (state: "restored" | "kept" | "failed", reasonCode: string) => {
        audit.append({
          botId: actorBotId,
          kind: "connector.changed",
          summary:
            state === "failed"
              ? connectorAuditEvents.failed
              : state === "restored"
                ? connectorAuditEvents.confirmationRestored
                : connectorAuditEvents.access,
          detail: { connectorId, installationId, reasonCode },
        });
        db.prepare("UPDATE connection_confirmation_restores SET state=? WHERE connector_id=?").run(
          state,
          connectorId,
        );
      };
      try {
        transaction(db, () => {
          const current = db
            .prepare(
              "SELECT confirmation_mode,revision,removed_at FROM connectors WHERE id=? AND plugin_installation_id=?",
            )
            .get(connectorId, installationId);
          if (
            !current ||
            current.removed_at !== null ||
            current.confirmation_mode !== "always_ask" ||
            userEditedSinceMigration(db, connectorId, installationId)
          )
            return settle("kept", "confirmation_restore_changed");
          // Compare-and-set on the revision just read, like a user update's expectedRevision:
          // the restore never lands over a newer change, even if this stops being one
          // immediate transaction.
          const written = db
            .prepare(
              "UPDATE connectors SET confirmation_mode=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND confirmation_mode='always_ask'",
            )
            .run(
              newConnectionDefaults.confirmationMode,
              new Date().toISOString(),
              connectorId,
              Number(current.revision),
            );
          if (written.changes !== 1) return settle("kept", "confirmation_restore_changed");
          settle("restored", "confirmation_restored");
        });
      } catch {
        // The row keeps "ask every time" (the stricter mode); the failure stays visible in audit.
        transaction(db, () => settle("failed", "confirmation_restore_failed"));
      }
    }
    await setImmediate(undefined, { signal });
  }
}

/**
 * An explicit user edit of this connection after the installation's connection-permissions migration (its latest
 * `connection_permissions_migrated` audit; none counts every edit, which only keeps the stricter
 * mode). Only rows the user-facing write paths produce count:
 * - `ConnectorsRepo.update` with a confirmation mode (`confirmation_*`; this module's own
 *   `confirmation_restore*` codes are not in the list);
 * - `ConnectorsRepo.update` with tool toggles only (no reason code). Builtin-default
 *   reconciliation writes the same row without `internal` on older data but never
 *   records a tool override, so such a row counts only when the connection has an override;
 * - `PluginAccessRepo.update` (who can use it: installation id, no connector id, no reason code).
 * Lifecycle, catalog, drain and failure rows are `internal` or carry other summaries or reason
 * codes. A re-entered credential leaves no audit tied to the connection (only a lifecycle intent
 * and a secret write) and says nothing about confirmations, so it does not count.
 */
function userEditedSinceMigration(db: DatabaseSync, connectorId: string, installationId: string) {
  return !!db
    .prepare(`SELECT 1 FROM audit_log a
      WHERE a.kind='connector.changed' AND a.summary=?
        AND json_extract(a.detail,'$.internal') IS NOT 1
        AND a.at>=COALESCE((SELECT max(m.at) FROM audit_log m
          WHERE m.kind='connector.changed'
            AND json_extract(m.detail,'$.installationId')=?
            AND json_extract(m.detail,'$.reasonCode')='connection_permissions_migrated'),'')
        AND (
          (json_extract(a.detail,'$.connectorId')=?
            AND json_extract(a.detail,'$.reasonCode') IN
              ('confirmation_read_write','confirmation_always_ask','confirmation_read_only','confirmation_direct_read_write'))
          OR (json_extract(a.detail,'$.connectorId')=?
            AND json_extract(a.detail,'$.reasonCode') IS NULL
            AND EXISTS(SELECT 1 FROM connector_tool_overrides o WHERE o.connector_id=?))
          OR (json_extract(a.detail,'$.installationId')=?
            AND json_extract(a.detail,'$.connectorId') IS NULL
            AND json_extract(a.detail,'$.reasonCode') IS NULL))
      LIMIT 1`)
    .get(
      connectorAuditEvents.access,
      installationId,
      connectorId,
      connectorId,
      connectorId,
      installationId,
    );
}
