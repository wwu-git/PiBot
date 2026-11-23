import type { DatabaseSync } from "node:sqlite";
import {
  type CapabilityId,
  CapabilityIdSchema,
  type Connector,
  ConnectorPageSchema,
  ConnectorServerSchema,
  ConnectorUpdateSchema,
  connectorAuditEvents,
  IdSchema,
  RpcError,
  RpcErrorCodes,
  supportsDirectConnectionWrites,
} from "@pibot/plugins-contract/full";
import type { AuditRepo } from "@pibot/storage";
import { readPage, transaction } from "@pibot/storage";
import {
  connectorConflict,
  connectorMissing,
  connectorToolDefinitionFingerprint,
  parseConnector,
  parseConnectorTool,
} from "./connector-records.ts";
import type { PluginAccessRepo } from "./plugin-access.ts";

export class ConnectorsRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditRepo,
    private readonly pluginAccess: PluginAccessRepo,
  ) {}

  get(id: string): Connector | undefined {
    const row = this.db
      .prepare(`SELECT c.* FROM connectors c JOIN plugin_installations p
      ON p.id=c.plugin_installation_id WHERE c.id=? AND c.removed_at IS NULL AND p.status='installed'`)
      .get(IdSchema.parse(id));
    return row ? parseConnector(row) : undefined;
  }

  forApp(appId: string): Connector[] {
    const row = this.db
      .prepare(
        "SELECT c.* FROM connectors c JOIN plugin_installations p ON p.id=c.plugin_installation_id WHERE p.plugin_id=? AND p.source_kind='builtin' AND p.status='installed' AND c.removed_at IS NULL ORDER BY c.created_at,c.id LIMIT 1",
      )
      .get(`pibot.${appId}`);
    return row ? [parseConnector(row)] : [];
  }

  /** Exact tool row for dispatch validation (any page position). */
  tool(connectorId: string, catalogVersion: number, toolName: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM connector_tools WHERE connector_id=? AND catalog_version=? AND tool_name=?",
      )
      .get(IdSchema.parse(connectorId), catalogVersion, toolName);
    return row ? parseConnectorTool(row) : undefined;
  }

  /** Status aliases use only a unique current mapping; they never rewrite dispatch names. */
  toolByCapability(connectorId: string, catalogVersion: number, capabilityTool: string) {
    const rows = this.db
      .prepare(
        "SELECT * FROM connector_tools WHERE connector_id=? AND catalog_version=? AND capability_tool=? LIMIT 2",
      )
      .all(IdSchema.parse(connectorId), catalogVersion, capabilityTool);
    return rows.length === 1 && rows[0] ? parseConnectorTool(rows[0]) : undefined;
  }

  list(
    input: { cursor?: string; limit?: number; installationId?: string; builtin?: boolean } = {},
  ) {
    const page = ConnectorPageSchema.parse({ cursor: input.cursor, limit: input.limit });
    const scope: [string, string | number][] = [];
    if (input.installationId)
      scope.push(["plugin_installation_id", IdSchema.parse(input.installationId)]);
    if (input.builtin !== undefined)
      scope.push([
        "EXISTS(SELECT 1 FROM plugin_installations WHERE id=connectors.plugin_installation_id AND source_kind='builtin')",
        input.builtin ? 1 : 0,
      ]);
    const rows = readPage(
      this.db,
      "connectors",
      "*",
      "created_at",
      {
        before: page.cursor,
        limit: page.limit + 1,
      },
      [["removed_at", null], ...scope],
      scope,
    );
    const items = rows.slice(0, page.limit).map(parseConnector);
    return { items, nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null };
  }

  /** Discovery shares the same connection kinds and Bot visibility boundary as dispatch. */
  discover(
    botId: string,
    groupId: string | undefined,
    input: {
      connectorId?: string;
      query?: string;
      after?: number;
      limit: number;
      readOnly?: boolean;
    },
  ) {
    const visible = `FROM connectors c JOIN plugin_installations p ON p.id=c.plugin_installation_id
      JOIN plugin_access a ON a.installation_id=p.id
      WHERE c.removed_at IS NULL AND p.status='installed' AND p.enabled=1 AND c.enabled=1
      AND c.status IN ('ready','idle') AND c.kind IN ('mcp_remote','mcp_stdio','builtin','rest')
      AND (a.mode IN ('all','ask_first') OR (a.mode='selected' AND (
        (? IS NULL AND EXISTS (SELECT 1 FROM json_each(a.bots_json) WHERE value=?)) OR
        (? IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(a.groups_json) WHERE value=?)))))
      AND (? IS NULL OR c.id=?)`;
    // Same rule as accessAllows: a group run uses only the group's grant, a direct chat the Bot's.
    const group = groupId ? IdSchema.parse(groupId) : null;
    const values = [
      group,
      IdSchema.parse(botId),
      group,
      group,
      input.connectorId ?? null,
      input.connectorId ?? null,
    ];
    const versions = this.db
      .prepare(`SELECT c.id,c.revision,c.catalog_version ${visible} ORDER BY c.id LIMIT 1001`)
      .all(...values);
    if (versions.length > 1000)
      throw new RpcError(RpcErrorCodes.busy, "Discovery connection limit reached");
    const rows = this.db
      .prepare(`SELECT t.rowid AS cursor_id,t.* FROM connector_tools t
      JOIN (SELECT c.id,c.catalog_version ${visible}) v
      ON v.id=t.connector_id AND v.catalog_version=t.catalog_version
      WHERE t.enabled=1 AND t.rowid>? AND (?=0 OR t.read_only=1)
      AND (?='' OR instr(lower(t.tool_name),lower(?))>0 OR instr(lower(t.description),lower(?))>0)
      ORDER BY t.rowid LIMIT ?`)
      .all(
        ...values,
        input.after ?? 0,
        input.readOnly ? 1 : 0,
        input.query ?? "",
        input.query ?? "",
        input.query ?? "",
        input.limit + 1,
      );
    const selected: { cursor: number; tool: ReturnType<typeof parseConnectorTool> }[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, input.limit)) {
      const tool = parseConnectorTool(row);
      bytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
      if (bytes > 256 * 1024) break;
      selected.push({ cursor: Number(row.cursor_id), tool });
    }
    return {
      versions,
      items: selected.map((item) => item.tool),
      after: rows.length > selected.length ? selected.at(-1)?.cursor : undefined,
    };
  }

  /** Internal only: must not be included in a renderer snapshot. */
  configuration(id: string) {
    if (!this.get(id)) connectorMissing();
    const row = this.db.prepare("SELECT config_json FROM connectors WHERE id=?").get(id);
    return ConnectorServerSchema.parse(JSON.parse(String(row?.config_json)));
  }

  /** Uninstall already revoked execution visibility; cleanup still owns its configuration. */
  configurationForCleanup(id: string, installationId: string) {
    const row = this.db
      .prepare(`SELECT c.config_json FROM connectors c JOIN plugin_installations p
      ON p.id=c.plugin_installation_id WHERE c.id=? AND c.plugin_installation_id=?
      AND c.removed_at IS NULL AND p.status IN ('installed','removing')`)
      .get(IdSchema.parse(id), IdSchema.parse(installationId));
    if (!row) connectorMissing();
    return ConnectorServerSchema.parse(JSON.parse(String(row.config_json)));
  }

  access(id: string) {
    if (!this.get(id)) connectorMissing();
    return this.pluginAccess.forConnector(id);
  }

  update(
    input: Parameters<typeof ConnectorUpdateSchema.parse>[0],
    actorBotId: string,
    options: { recordToolOverrides?: boolean } = {},
  ) {
    const patch = ConnectorUpdateSchema.parse(input);
    return transaction(this.db, () => {
      const current = this.get(patch.id);
      if (!current) connectorMissing();
      if (current.revision !== patch.expectedRevision) connectorConflict();
      this.assertNoOperation(current.id);
      if (
        patch.confirmationMode === "direct_read_write" &&
        !supportsDirectConnectionWrites(current.kind)
      )
        throw new RpcError(
          RpcErrorCodes.invalidParams,
          "Direct read and write requires an MCP connection",
        );
      if (patch.networkDomains !== undefined) {
        const installation = this.db
          .prepare("SELECT source_kind FROM plugin_installations WHERE id=?")
          .get(current.pluginInstallationId);
        if (!installation || installation.source_kind === "builtin")
          throw new RpcError(
            RpcErrorCodes.invalidParams,
            "Builtin network settings cannot be edited",
          );
        const server = this.configuration(current.id);
        this.db
          .prepare("UPDATE connectors SET config_json=? WHERE id=?")
          .run(JSON.stringify({ ...server, networkDomains: patch.networkDomains }), current.id);
      }
      const nextCatalog = current.catalogVersion + (patch.tools ? 1 : 0);
      if (patch.tools) {
        this.db
          .prepare(`INSERT INTO connector_tools(
            connector_id,catalog_version,tool_name,description,schema_json,enabled,read_only,
            suggested_read_only,draft_binding,read_only_hint,idempotent_hint,destructive_hint,
            capability_id,capability_tool,capability_read_only)
          SELECT connector_id,?,tool_name,description,schema_json,enabled,read_only,
            suggested_read_only,draft_binding,read_only_hint,idempotent_hint,destructive_hint,
            capability_id,capability_tool,capability_read_only
          FROM connector_tools
          WHERE connector_id=? AND catalog_version=?`)
          .run(nextCatalog, current.id, current.catalogVersion);
        const update =
          this.db.prepare(`UPDATE connector_tools SET enabled=?,read_only=?,draft_binding=COALESCE(?,draft_binding)
          WHERE connector_id=? AND catalog_version=? AND tool_name=?`);
        for (const tool of patch.tools) {
          if (
            !update.run(
              tool.enabled ? 1 : 0,
              tool.readOnly ? 1 : 0,
              tool.draftBinding === undefined ? null : JSON.stringify(tool.draftBinding),
              current.id,
              nextCatalog,
              tool.tool,
            ).changes
          )
            throw new RpcError(RpcErrorCodes.invalidParams, "Unknown connector tool");
        }
        if (options.recordToolOverrides !== false) {
          const override = this.db.prepare(`INSERT INTO connector_tool_overrides
            (connector_id,tool_name,enabled,read_only,read_only_fingerprint) VALUES(?,?,?,?,?)
            ON CONFLICT(connector_id,tool_name) DO UPDATE SET
              enabled=excluded.enabled,read_only=excluded.read_only,
              read_only_fingerprint=excluded.read_only_fingerprint`);
          const deny = this.db.prepare(
            "INSERT INTO connector_tool_denials(connector_id,tool_name) VALUES(?,?) ON CONFLICT DO NOTHING",
          );
          const allow = this.db.prepare(
            "DELETE FROM connector_tool_denials WHERE connector_id=? AND tool_name=?",
          );
          for (const tool of patch.tools) {
            const stored = this.tool(current.id, nextCatalog, tool.tool);
            if (!stored) throw new RpcError(RpcErrorCodes.invalidParams, "Unknown connector tool");
            override.run(
              current.id,
              tool.tool,
              tool.enabled ? 1 : 0,
              tool.readOnly ? 1 : 0,
              connectorToolDefinitionFingerprint(stored),
            );
            if (tool.enabled) allow.run(current.id, tool.tool);
            else deny.run(current.id, tool.tool);
          }
          const overrideCount = this.db
            .prepare("SELECT count(*) AS n FROM connector_tool_overrides WHERE connector_id=?")
            .get(current.id);
          if (Number(overrideCount?.n) > 10_000)
            throw new RpcError(RpcErrorCodes.busy, "Connector tool setting limit reached");
        }
        this.db
          .prepare("DELETE FROM connector_tools WHERE connector_id=? AND catalog_version<>?")
          .run(current.id, nextCatalog);
      }
      if (patch.access) {
        const plugin = this.db
          .prepare("SELECT revision FROM plugin_installations WHERE id=?")
          .get(current.pluginInstallationId);
        this.pluginAccess.update(
          current.pluginInstallationId,
          Number(plugin?.revision),
          patch.access,
          actorBotId,
        );
        // Access is installation-wide, so its update already advances every connector receipt.
        if (!patch.tools && !patch.confirmationMode && patch.networkDomains === undefined)
          return this.get(current.id) as Connector;
      }
      this.db
        .prepare(
          "UPDATE connectors SET revision=revision+1,catalog_version=?,confirmation_mode=COALESCE(?,confirmation_mode),updated_at=? WHERE id=?",
        )
        .run(nextCatalog, patch.confirmationMode ?? null, new Date().toISOString(), current.id);
      this.audit.append({
        botId: IdSchema.parse(actorBotId),
        kind: "connector.changed",
        summary:
          patch.networkDomains !== undefined
            ? connectorAuditEvents.network
            : connectorAuditEvents.access,
        detail: {
          connectorId: current.id,
          revision: this.get(current.id)?.revision ?? current.revision + 1,
          catalogVersion: nextCatalog,
          ...(patch.networkDomains !== undefined
            ? { reasonCode: "network_domains_changed", entryCount: patch.networkDomains.length }
            : {}),
          // Builtin-default reconciliation is the only caller that skips overrides; it is not a
          // user edit (the confirmation restore and the records page both rely on this).
          ...(options.recordToolOverrides === false ? { internal: true } : {}),
          ...(patch.confirmationMode
            ? { reasonCode: `confirmation_${patch.confirmationMode}` }
            : {}),
        },
      });
      return this.get(current.id) as Connector;
    });
  }

  /**
   * Records the person's run-as-me choice with its audit row in one transaction. The
   * caller has the native confirmation and the receipt; this only stores the visible state.
   */
  setOutsideSandbox(
    input: { id: string; expectedRevision: number; enabled: boolean },
    actorBotId: string,
    /** The receipt write or removal, so flag, receipt and audit commit together. */
    receipt: () => void,
  ): Connector {
    return transaction(this.db, () => {
      const current = this.get(input.id);
      if (!current) connectorMissing();
      if (current.revision !== input.expectedRevision) connectorConflict();
      this.assertNoOperation(current.id);
      receipt();
      this.db
        .prepare(
          "UPDATE connectors SET revision=revision+1,outside_sandbox=?,updated_at=? WHERE id=?",
        )
        .run(input.enabled ? 1 : 0, new Date().toISOString(), current.id);
      const updated = this.get(current.id) as Connector;
      this.audit.append({
        botId: IdSchema.parse(actorBotId),
        kind: "connector.changed",
        summary: input.enabled
          ? connectorAuditEvents.outsideSandboxOn
          : connectorAuditEvents.outsideSandboxOff,
        detail: {
          connectorId: current.id,
          revision: updated.revision,
          reasonCode: input.enabled ? "outside_sandbox_on" : "outside_sandbox_off",
        },
      });
      return updated;
    });
  }

  /** One bounded snapshot avoids per-tool SQLite queries during catalog default reconciliation. */
  toolPolicyStates(connectorId: string) {
    const current = this.get(connectorId);
    if (!current) connectorMissing();
    const rows = this.db
      .prepare(`SELECT t.tool_name,t.enabled,t.read_only,
        EXISTS(SELECT 1 FROM connector_tool_overrides o
          WHERE o.connector_id=t.connector_id AND o.tool_name=t.tool_name) AS overridden
      FROM connector_tools t WHERE t.connector_id=? AND t.catalog_version=?
      ORDER BY t.tool_name LIMIT 10001`)
      .all(IdSchema.parse(connectorId), current.catalogVersion);
    if (rows.length > 10_000) throw new TypeError("Connector catalog too large");
    return new Map(
      rows.map((row) => [
        String(row.tool_name),
        {
          enabled: row.enabled === 1,
          readOnly: row.read_only === 1,
          overridden: row.overridden === 1,
        },
      ]),
    );
  }

  tools(id: string, input: { cursor?: string; limit?: number } = {}) {
    const page = ConnectorPageSchema.extend({
      limit: ConnectorPageSchema.shape.limit.unwrap().max(50).default(50),
    }).parse(input);
    const current = this.get(id);
    if (!current) connectorMissing();
    let after = "";
    if (page.cursor) {
      if (!/^\d+:\d+$/.test(page.cursor))
        throw new RpcError(RpcErrorCodes.invalidParams, "Invalid tool cursor");
      const [version, rowId] = page.cursor.split(":").map(Number);
      if (version !== current.catalogVersion || !Number.isSafeInteger(rowId)) connectorConflict();
      const anchor = this.db
        .prepare(`SELECT tool_name FROM connector_tools WHERE rowid=?
        AND connector_id=? AND catalog_version=?`)
        .get(rowId ?? 0, id, current.catalogVersion);
      if (!anchor) connectorConflict();
      after = String(anchor.tool_name);
    }
    const rows = this.db
      .prepare(`SELECT rowid AS cursor_id,* FROM connector_tools
      WHERE connector_id=? AND catalog_version=? AND tool_name>? ORDER BY tool_name LIMIT ?`)
      .all(id, current.catalogVersion, after, page.limit + 1);
    const selected: typeof rows = [];
    const items: ReturnType<typeof parseConnectorTool>[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, page.limit)) {
      const item = parseConnectorTool(row);
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (bytes + size > 256 * 1024) break;
      bytes += size;
      selected.push(row);
      items.push(item);
    }
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        rows.length > selected.length && last
          ? `${current.catalogVersion}:${last.cursor_id}`
          : null,
    };
  }

  /** Current atomic catalog suggestions only; stale generations never participate. */
  capabilitySuggestions(id: string): CapabilityId[] {
    const current = this.get(id);
    if (!current) connectorMissing();
    return this.db
      .prepare(`SELECT DISTINCT capability_id FROM connector_tools
        WHERE connector_id=? AND catalog_version=? AND capability_id IS NOT NULL
        ORDER BY capability_id`)
      .all(current.id, current.catalogVersion)
      .map((row) => CapabilityIdSchema.parse(row.capability_id));
  }

  /**
   * Enabled connections whose current catalog maps this capability: trusted native apps first,
   * then oldest first.
   */
  capabilityConnectors(capabilityId: CapabilityId): string[] {
    return this.db
      .prepare(`SELECT c.id FROM connectors c JOIN plugin_installations p
        ON p.id=c.plugin_installation_id
        WHERE c.enabled=1 AND c.removed_at IS NULL AND p.status='installed'
          AND EXISTS (SELECT 1 FROM connector_tools t WHERE t.connector_id=c.id
            AND t.catalog_version=c.catalog_version AND t.capability_id=?)
        ORDER BY c.kind='builtin' DESC, c.created_at, c.id LIMIT 20`)
      .all(CapabilityIdSchema.parse(capabilityId))
      .map((row) => IdSchema.parse(row.id));
  }

  private assertNoOperation(id: string) {
    if (
      this.db
        .prepare(`SELECT 1 FROM connector_operations WHERE connector_id=?
      AND state IN ('pending','running','stopping') LIMIT 1`)
        .get(id)
    )
      throw new RpcError(RpcErrorCodes.busy, "Connector operation in progress");
  }
}
