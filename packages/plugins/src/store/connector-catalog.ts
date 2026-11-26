import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  type Connector,
  type ConnectorTool,
  ConnectorToolSchema,
  connectorAuditEvents,
  IdSchema,
} from "@pibot/plugins-contract/full";
import type { AuditRepo } from "@pibot/storage";
import { transaction } from "@pibot/storage";
import type { ConnectorOperationsRepo } from "./connector-operations.ts";
import {
  connectorConflict,
  connectorToolDefinitionFingerprint,
  parseConnector,
} from "./connector-records.ts";

/** Brain collects bounded, validated remote pages before publishing one atomic catalog. */
export class ConnectorCatalogRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly operations: ConnectorOperationsRepo,
    private readonly audit: AuditRepo,
  ) {}

  /** Compare a bounded remote snapshot without materializing a second whole catalog. */
  matches(
    connectorId: string,
    catalogVersion: number,
    tools: Pick<
      ConnectorTool,
      | "tool"
      | "description"
      | "schema"
      | "suggestedReadOnly"
      | "readOnlyHint"
      | "idempotentHint"
      | "destructiveHint"
      | "capabilityId"
      | "capabilityTool"
      | "capabilityReadOnly"
    >[],
  ): boolean {
    const expected = new Map(tools.map((tool) => [tool.tool, tool]));
    let count = 0;
    for (const row of this.db
      .prepare(`SELECT tool_name,description,schema_json,suggested_read_only,
        read_only_hint,idempotent_hint,destructive_hint,
        capability_id,capability_tool,capability_read_only
      FROM connector_tools WHERE connector_id=? AND catalog_version=?`)
      .iterate(connectorId, catalogVersion)) {
      const tool = expected.get(String(row.tool_name));
      if (
        !tool ||
        tool.description !== row.description ||
        !isDeepStrictEqual(tool.schema, JSON.parse(String(row.schema_json))) ||
        tool.suggestedReadOnly !== (row.suggested_read_only === 1) ||
        tool.readOnlyHint !== nullableBoolean(row.read_only_hint) ||
        tool.idempotentHint !== nullableBoolean(row.idempotent_hint) ||
        tool.destructiveHint !== nullableBoolean(row.destructive_hint) ||
        tool.capabilityId !== nullableString(row.capability_id) ||
        tool.capabilityTool !== nullableString(row.capability_tool) ||
        tool.capabilityReadOnly !== nullableBoolean(row.capability_read_only)
      )
        return false;
      count++;
    }
    return count === tools.length;
  }

  publish(input: {
    connectorId: string;
    expectedRevision: number;
    operation?: { id: string; expectedRevision: number };
    tools: Pick<
      ConnectorTool,
      | "tool"
      | "title"
      | "description"
      | "schema"
      | "suggestedReadOnly"
      | "readOnlyHint"
      | "idempotentHint"
      | "destructiveHint"
      | "capabilityId"
      | "capabilityTool"
      | "capabilityReadOnly"
    >[];
    actorBotId: string;
  }): Connector {
    if (input.tools.length > 10_000) throw new TypeError("Connector catalog too large");
    return transaction(this.db, () => {
      const row = this.db
        .prepare(`SELECT c.* FROM connectors c JOIN plugin_installations p
        ON p.id=c.plugin_installation_id WHERE c.id=? AND c.enabled=1 AND c.removed_at IS NULL AND p.status='installed'`)
        .get(IdSchema.parse(input.connectorId));
      if (!row || row.revision !== input.expectedRevision) connectorConflict();
      const current = parseConnector(row);
      if (input.operation) {
        const operation = this.operations.current(
          input.operation.id,
          input.operation.expectedRevision,
        );
        if (
          operation.connectorId !== current.id ||
          (operation.kind !== "enable" && operation.kind !== "restart")
        )
          connectorConflict();
      } else if (current.status !== "ready" && current.status !== "idle") connectorConflict();
      // Connection generations invalidate dispatch via revision, not the content receipt.
      const changed = !this.matches(current.id, current.catalogVersion, input.tools);
      const version = current.catalogVersion + (changed ? 1 : 0);
      const denied = this.db.prepare(
        "SELECT 1 FROM connector_tool_denials WHERE connector_id=? AND tool_name=?",
      );
      const override = this.db.prepare(
        `SELECT enabled,read_only,read_only_fingerprint FROM connector_tool_overrides
        WHERE connector_id=? AND tool_name=?`,
      );
      const previous =
        this.db.prepare(`SELECT enabled,read_only,schema_json,description,draft_binding,
        read_only_hint,idempotent_hint,destructive_hint FROM connector_tools
        WHERE connector_id=? AND catalog_version=? AND tool_name=?`);
      let bytes = 0;
      const tools = input.tools.map((tool) => {
        // Identity must not change after deny lookup or dispatch would refer to another tool.
        if (tool.tool !== tool.tool.trim()) throw new TypeError("Invalid connector tool name");
        bytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
        if (bytes > 8 * 1024 * 1024) throw new TypeError("Connector catalog too large");
        const old = previous.get(current.id, current.catalogVersion, tool.tool);
        const userOverride = override.get(current.id, tool.tool);
        const unchanged =
          old?.schema_json !== undefined &&
          isDeepStrictEqual(JSON.parse(String(old.schema_json)), tool.schema) &&
          old?.description === tool.description &&
          nullableBoolean(old?.read_only_hint) === tool.readOnlyHint &&
          nullableBoolean(old?.idempotent_hint) === tool.idempotentHint &&
          nullableBoolean(old?.destructive_hint) === tool.destructiveHint;
        const readOnlyOverride =
          userOverride?.read_only === 1 &&
          userOverride.read_only_fingerprint === connectorToolDefinitionFingerprint(tool);
        return ConnectorToolSchema.parse({
          ...tool,
          connectorId: current.id,
          catalogVersion: version,
          // Keep explicit denies; changed/new definitions never inherit an earlier read-only decision.
          enabled: userOverride
            ? userOverride.enabled === 1
            : !denied.get(current.id, tool.tool) && (old ? old.enabled === 1 : true),
          // A tool the server marks read-only (and not destructive)
          // starts read-only; the person's own choice in 高级 still wins.
          readOnly: userOverride
            ? readOnlyOverride
            : (tool.readOnlyHint === true && tool.destructiveHint !== true) ||
              (unchanged && old?.read_only === 1),
          ...(unchanged && old?.draft_binding && old.draft_binding !== "null"
            ? { draftBinding: JSON.parse(String(old.draft_binding)) }
            : {}),
        });
      });
      if (new Set(tools.map((tool) => tool.tool)).size !== tools.length)
        throw new TypeError("Duplicate connector tool");
      if (changed)
        this.db.prepare("DELETE FROM connector_tools WHERE connector_id=?").run(current.id);
      const insert = this.db.prepare(`INSERT INTO connector_tools
        (connector_id,catalog_version,tool_name,description,schema_json,enabled,read_only,
          suggested_read_only,read_only_hint,idempotent_hint,destructive_hint,draft_binding,
          capability_id,capability_tool,capability_read_only,title)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const tool of changed ? tools : [])
        insert.run(
          current.id,
          version,
          tool.tool,
          tool.description,
          JSON.stringify(tool.schema),
          tool.enabled ? 1 : 0,
          tool.readOnly ? 1 : 0,
          tool.suggestedReadOnly ? 1 : 0,
          sqlBoolean(tool.readOnlyHint),
          sqlBoolean(tool.idempotentHint),
          sqlBoolean(tool.destructiveHint),
          tool.draftBinding ? JSON.stringify(tool.draftBinding) : null,
          tool.capabilityId ?? null,
          tool.capabilityTool ?? null,
          sqlBoolean(tool.capabilityReadOnly),
          tool.title ?? null,
        );
      // A title is display only, so a renamed tool keeps its catalog generation (and the grants and
      // drafts bound to it); only the shown name follows the server.
      if (!changed) {
        const retitle = this.db.prepare(
          "UPDATE connector_tools SET title=? WHERE connector_id=? AND catalog_version=? AND tool_name=?",
        );
        for (const tool of tools) retitle.run(tool.title ?? null, current.id, version, tool.tool);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE connectors SET revision=revision+1,catalog_version=?,status='ready',status_detail_code=NULL,updated_at=? WHERE id=?`,
        )
        .run(version, now, current.id);
      if (input.operation)
        this.db
          .prepare(
            `UPDATE connector_operations SET state='done',phase='finished',revision=revision+1,updated_at=? WHERE id=?`,
          )
          .run(now, input.operation.id);
      this.audit.append({
        botId: IdSchema.parse(input.actorBotId),
        kind: "connector.changed",
        summary: connectorAuditEvents.catalog,
        detail: {
          internal: true,
          connectorId: current.id,
          revision: current.revision + 1,
          catalogVersion: version,
        },
      });
      return {
        ...current,
        revision: current.revision + 1,
        status: "ready",
        statusDetailCode: null,
        catalogVersion: version,
        updatedAt: now,
      };
    });
  }
}

const nullableBoolean = (value: unknown): boolean | undefined =>
  value === null || value === undefined ? undefined : value === 1;
const nullableString = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);
const sqlBoolean = (value: boolean | undefined): number | null =>
  value === undefined ? null : value ? 1 : 0;
