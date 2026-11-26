import { createHash } from "node:crypto";
import {
  ConnectorOperationSchema,
  ConnectorSchema,
  ConnectorToolSchema,
  PluginInstallationSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";

export function connectorToolDefinitionFingerprint(tool: {
  description: string;
  schema: unknown;
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        tool.description,
        tool.schema,
        tool.readOnlyHint ?? null,
        tool.idempotentHint ?? null,
        tool.destructiveHint ?? null,
      ]),
    )
    .digest("hex");
}

export function connectorConflict(): never {
  throw new RpcError(RpcErrorCodes.connectorStale, "Connector revision changed");
}
export function connectorMissing(): never {
  throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector unavailable");
}
export function parseInstallation(row: Record<string, unknown>) {
  return PluginInstallationSchema.parse({
    id: row.id,
    pluginId: row.plugin_id,
    version: row.version,
    digest: row.digest,
    revision: row.revision,
    sourceKind: row.source_kind,
    status: row.status,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
export function parseConnector(row: Record<string, unknown>) {
  return ConnectorSchema.parse({
    id: row.id,
    pluginInstallationId: row.plugin_installation_id,
    serverId: row.server_id,
    revision: row.revision,
    catalogVersion: row.catalog_version,
    kind: row.kind,
    identity: row.identity,
    confirmationMode: row.confirmation_mode,
    outsideSandbox: row.outside_sandbox === 1,
    name: row.name,
    enabled: row.enabled === 1,
    status: row.status,
    statusDetailCode: row.status_detail_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
export function parseConnectorOperation(row: Record<string, unknown>) {
  return ConnectorOperationSchema.parse({
    id: row.id,
    installationId: row.installation_id,
    connectorId: row.connector_id,
    kind: row.kind,
    revision: row.revision,
    state: row.state,
    phase: row.phase,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
export function parseConnectorTool(row: Record<string, unknown>) {
  return ConnectorToolSchema.parse({
    connectorId: row.connector_id,
    catalogVersion: row.catalog_version,
    tool: row.tool_name,
    ...(typeof row.title === "string" && row.title ? { title: row.title } : {}),
    description: row.description,
    schema: JSON.parse(String(row.schema_json)),
    enabled: row.enabled === 1,
    readOnly: row.read_only === 1,
    suggestedReadOnly: row.suggested_read_only === 1,
    ...(row.read_only_hint === null || row.read_only_hint === undefined
      ? {}
      : { readOnlyHint: row.read_only_hint === 1 }),
    ...(row.idempotent_hint === null || row.idempotent_hint === undefined
      ? {}
      : { idempotentHint: row.idempotent_hint === 1 }),
    ...(row.destructive_hint === null || row.destructive_hint === undefined
      ? {}
      : { destructiveHint: row.destructive_hint === 1 }),
    ...(row.draft_binding && row.draft_binding !== "null"
      ? { draftBinding: JSON.parse(String(row.draft_binding)) }
      : {}),
    ...(row.capability_id === null || row.capability_id === undefined
      ? {}
      : {
          capabilityId: row.capability_id,
          capabilityTool: row.capability_tool,
          capabilityReadOnly: row.capability_read_only === 1,
        }),
  });
}
