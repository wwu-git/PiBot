import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { DomainSchema } from "../permissions/settings.ts";
import { ConnectorConfirmationModeSchema } from "./connectors.ts";
import { DraftBindingSchema } from "./drafts.ts";

const version = z.number().int().nonnegative().safe();
export const ConnectorFailureCodeSchema = z.enum([
  "invalid_source",
  "source_changed",
  "preview_expired",
  "unsupported_format",
  "unsafe_path",
  "secret_required",
  "secure_storage_unavailable",
  "secret_reconfiguration_required",
  "auth_required",
  "unsupported_platform",
  "isolation_unavailable",
  "dependency_missing",
  "outlook_missing",
  "outlook_access_denied",
  "native_app_failed",
  "connection_failed",
  "cleanup_incomplete",
  "timeout",
  "cancelled",
  "revision_changed",
  "catalog_changed",
  "disabled",
  "not_found",
  "tool_denied",
  "invalid_arguments",
  "internal",
]);
export const ConnectorOperationSchema = z.strictObject({
  id: IdSchema,
  installationId: IdSchema,
  connectorId: IdSchema.nullable(),
  kind: z.enum(["enable", "disable", "restart", "disconnect", "uninstall"]),
  revision: version.positive(),
  state: z.enum(["pending", "running", "stopping", "done", "error", "cancelled"]),
  phase: z.enum(["queued", "setup", "connecting", "discovering", "draining", "finished"]),
  failureCode: ConnectorFailureCodeSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const ConnectorAccessSchema = z
  .strictObject({
    mode: z.enum(["ask_first", "all", "selected"]),
    bots: z
      .array(IdSchema)
      .max(500)
      .refine((bots) => new Set(bots).size === bots.length, "Duplicate bot"),
    groups: z
      .array(IdSchema)
      .max(500)
      .refine((groups) => new Set(groups).size === groups.length, "Duplicate group")
      .default([]),
  })
  .refine(
    (value) => value.mode === "selected" || (value.bots.length === 0 && value.groups.length === 0),
  );
export const ConnectorUpdateSchema = z
  .strictObject({
    id: IdSchema,
    expectedRevision: version.positive(),
    tools: z
      .array(
        z.strictObject({
          tool: z.string().min(1).max(4096),
          enabled: z.boolean(),
          readOnly: z.boolean(),
          draftBinding: DraftBindingSchema.nullable().optional(),
        }),
      )
      .max(100)
      .optional(),
    access: ConnectorAccessSchema.optional(),
    confirmationMode: ConnectorConfirmationModeSchema.optional(),
    networkDomains: z
      .array(DomainSchema)
      .max(64)
      .refine((domains) => new Set(domains).size === domains.length)
      .optional(),
  })
  .refine(
    (value) =>
      value.tools !== undefined ||
      value.networkDomains !== undefined ||
      value.access !== undefined ||
      value.confirmationMode !== undefined,
  )
  .refine(
    (value) =>
      !value.tools || new Set(value.tools.map((tool) => tool.tool)).size === value.tools.length,
  );
export type ConnectorOperation = z.output<typeof ConnectorOperationSchema>;
export type ConnectorAccess = z.output<typeof ConnectorAccessSchema>;

/**
 * Who may use a plugin (maintainers 2026-10-24): a group run is decided only by the group's grant and a
 * direct chat only by the Bot's, so a plugin granted privately never follows a Bot into a group.
 * "all" and "ask_first" are visible everywhere (ask_first asks on first use).
 */
export function accessAllows(
  access: { mode: ConnectorAccess["mode"]; bots: readonly string[]; groups?: readonly string[] },
  botId: string,
  groupId?: string,
): boolean {
  if (access.mode !== "selected") return true;
  return groupId ? (access.groups ?? []).includes(groupId) : access.bots.includes(botId);
}
export type ConnectorFailureCode = z.output<typeof ConnectorFailureCodeSchema>;
