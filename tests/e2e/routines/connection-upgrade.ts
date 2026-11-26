import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { until } from "../chat/harness.ts";
import { draft, type Exercise } from "./shared.ts";

/**
 * An old "ask on first use" GitHub connection the user has not edited since the
 * upgrade goes back to the default, so a routine trigger that polls it keeps running; one whose
 * user chose "ask every time" after the upgrade keeps it. The upgrade is replayed on this
 * fixture's own temporary database while its brain is stopped: the access row from before the upgrade and
 * migration bookkeeping are put back, then the real start-up migrations run.
 */
export async function connectionUpgradeAcceptance(exercise: Exercise) {
  await exercise("旧ask_first的GitHub触发例行升级后继续运行", async (f) => {
    // GitHub is no longer built in; like a user, the scenario imports a GitHub MCP
    // (a local synthetic one) and marks its search tools read-only, which the
    // 「连接有新内容」 preset needs.
    const data = join(f.root, "github.json");
    await writeFile(data, JSON.stringify({ issues: [], pulls: [] }));
    const manifest = {
      schemaVersion: 1,
      id: "a26.github",
      version: "1",
      name: { zh: "GitHub（合成）", en: "GitHub (synthetic)" },
      description: { zh: "本机合成夹具", en: "Local synthetic fixture" },
      servers: [
        {
          id: "github",
          transport: "stdio",
          command: process.execPath,
          args: [f.githubServer, data],
          auth: { kind: "none", secretNames: [] },
          networkDomains: [],
        },
      ],
    };
    const preview = await f.rpc.call("plugins.previewImport", {
      source: { kind: "json", text: JSON.stringify(manifest) },
    });
    const imported = await f.rpc.call("plugins.import", {
      previewId: preview.previewId,
      enable: true,
      expectedDigest: preview.digest,
    });
    const connector = imported.connectors[0];
    assert(connector);
    const installationId = imported.installation.id;
    const ready = await until(
      "连接就绪",
      async () => (await f.rpc.call("connectors.get", { id: connector.id })).connector,
      (value) => value.status === "ready",
    );
    await f.rpc.call("connectors.update", {
      id: connector.id,
      expectedRevision: ready.revision,
      tools: [
        { tool: "search_issues", enabled: true, readOnly: true },
        { tool: "search_pull_requests", enabled: true, readOnly: true },
      ],
    });
    // From here the connection only looks connected: it is switched on only after start-up
    // (start-up would reconnect an enabled one), and a trigger's first check is five minutes
    // after it is created, so the scenario never calls the server.
    const online = () => {
      f.db
        .prepare("UPDATE connectors SET enabled=1,status='idle' WHERE id=?")
        .run(connector.id);
      f.db.prepare("UPDATE plugin_installations SET enabled=1 WHERE id=?").run(installationId);
    };
    // Edits this fixture's stopped database, then starts the brain on it again.
    const restart = async (edit: (db: DatabaseSync) => void) => {
      await f.stop();
      const db = new DatabaseSync(join(f.root, "data", "pibot.db"));
      try {
        db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN");
        edit(db);
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      await f.boot();
      online();
    };
    const replayUpgrade = () =>
      restart((db) => {
        db.prepare(
          "UPDATE connectors SET enabled=0,status='disabled',confirmation_mode='read_write' WHERE id=?",
        ).run(connector.id);
        db.prepare(
          "UPDATE plugin_access SET mode='ask_first',bots_json='[]',groups_json='[]' WHERE installation_id=?",
        ).run(installationId);
        db.prepare(`INSERT INTO connection_access_migrations(installation_id,mode,bots_json,groups_json,state)
          VALUES(?,'ask_first','[]','[]','pending') ON CONFLICT(installation_id) DO UPDATE SET
          mode='ask_first',bots_json='[]',groups_json='[]',state='pending'`).run(installationId);
        db.prepare("DELETE FROM connection_confirmation_restores WHERE connector_id=?").run(
          connector.id,
        );
      });
    const restore = () =>
      f.db
        .prepare("SELECT state FROM connection_confirmation_restores WHERE connector_id=?")
        .get(connector.id)?.state;
    const mode = async () =>
      (await f.rpc.call("connectors.get", { id: connector.id })).connector.confirmationMode;
    // The "new in a connection" trigger replaced the GitHub trigger; same unattended gate.
    const trigger = {
      kind: "connection" as const,
      connectorId: connector.id,
      check: "github.assigned_issues" as const,
      intervalMin: 15 as const,
    };

    // Untouched since the upgrade: back to the default even though nothing relied on it.
    await replayUpgrade();
    assert.equal(await mode(), "read_write");
    assert.equal(restore(), "restored");
    // The user then chose "ask every time": a re-check keeps that choice, and the unattended
    // trigger gate refuses the connection.
    const restored = (await f.rpc.call("connectors.get", { id: connector.id })).connector;
    await f.rpc.call("connectors.update", {
      id: connector.id,
      expectedRevision: restored.revision,
      confirmationMode: "always_ask",
    });
    await restart((db) => {
      db.prepare("UPDATE connectors SET enabled=0,status='disabled' WHERE id=?").run(connector.id);
      db.prepare(
        "UPDATE connection_confirmation_restores SET state='pending' WHERE connector_id=?",
      ).run(connector.id);
    });
    assert.equal(await mode(), "always_ask");
    assert.equal(restore(), "kept");
    await assert.rejects(
      f.rpc.call("routines.create", draft(f, { triggers: [trigger] })),
      /connection_trigger_unavailable/,
    );

    // While the connection allowed it, a routine triggered by it was created.
    const current = (await f.rpc.call("connectors.get", { id: connector.id })).connector;
    await f.rpc.call("connectors.update", {
      id: connector.id,
      expectedRevision: current.revision,
      confirmationMode: "read_write",
    });
    const routine = await f.rpc.call("routines.create", draft(f, { triggers: [trigger] }));
    // Held off only while the replayed start-up has the connection switched off.
    await f.rpc.call("routines.setEnabled", { id: routine.id, enabled: false });

    // Upgrading from the old mode now restores what it did before: the trigger keeps polling.
    await replayUpgrade();
    assert.equal(await mode(), "read_write");
    assert.equal(restore(), "restored");
    const audit = await f.rpc.call("audit.list", { limit: 200 });
    for (const reasonCode of ["confirmation_restored", "confirmation_restore_changed"])
      assert(
        audit.some(
          (entry) =>
            entry.detail.connectorId === connector.id && entry.detail.reasonCode === reasonCode,
        ),
        reasonCode,
      );
    const enabled = await f.rpc.call("routines.setEnabled", { id: routine.id, enabled: true });
    // Editing re-runs the trigger validation that reported connection_trigger_unavailable.
    await f.rpc.call("routines.update", {
      id: routine.id,
      expectedVersion: enabled.version,
      patch: { name: "升级后改名" },
    });
    await f.service.tick();
    const after = await f.rpc.call("routines.get", { id: routine.id });
    assert.equal(after.enabled, true);
    assert.equal(after.pausedReason, null);

    // A device that ran the connection upgrade before the restore existed (queued by 0094), whose connection
    // then restarted and refreshed its tools before this start: those advance `revision` but are
    // not a user change, so it is still restored.
    await f.rpc.call("routines.setEnabled", { id: routine.id, enabled: false });
    await restart((db) => {
      db.prepare(
        "UPDATE connectors SET enabled=0,status='disabled',confirmation_mode='always_ask' WHERE id=?",
      ).run(connector.id);
      db.prepare(`UPDATE connection_confirmation_restores SET state='pending',
        migrated_revision=(SELECT revision FROM connectors WHERE id=?) WHERE connector_id=?`).run(
        connector.id,
        connector.id,
      );
      db.prepare("UPDATE connectors SET revision=revision+2 WHERE id=?").run(connector.id);
    });
    assert.equal(await mode(), "read_write");
    assert.equal(restore(), "restored");
    await f.rpc.call("routines.setEnabled", { id: routine.id, enabled: true });
    await f.service.tick();
    const resumed = await f.rpc.call("routines.get", { id: routine.id });
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.pausedReason, null);
  });
}
