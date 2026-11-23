import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { DomainSchema } from "../permissions/settings.ts";
import { CapabilityIdSchema } from "../tools/capabilities.ts";
import { DraftBindingSchema } from "./drafts.ts";

export const CONNECTOR_IMPORT_MAX_BYTES = 1024 * 1024;
export const CONNECTOR_IMPORT_MAX_SERVERS = 100;
const time = z.iso.datetime();
const count = z.number().int().nonnegative().safe();
const revision = count.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const plain = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const serverId = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const localizedText = z.strictObject({ zh: plain, en: plain });
const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const configValue = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
const serverAuth = z.strictObject({
  kind: z.enum(["none", "bearer", "oauth", "system"]),
  secretNames: z.array(secretName).max(64).default([]),
});
const commonServer = {
  id: serverId,
  auth: serverAuth,
  networkDomains: z.array(DomainSchema).max(64).default([]),
  startupTimeoutSec: z.number().int().min(1).max(300).optional(),
};

// Normalization must migrate plaintext credentials before persisting or returning this shape.
export const ConnectorServerSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...commonServer,
    transport: z.literal("http"),
    url: z.url({ protocol: /^https?$/ }).refine((value) => {
      const url = new URL(value);
      return !url.username && !url.password;
    }, "Credentials must use secret references"),
    /** Explicit compatibility declaration; the client never guesses from a failed HTTP request. */
    sseFallback: z.boolean().optional(),
    headers: z
      .record(
        z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        configValue.refine((value) => !/[\r\n]/.test(value)),
      )
      .refine((value) => Object.keys(value).length <= 32)
      .default({}),
  }),
  z.strictObject({
    ...commonServer,
    transport: z.literal("stdio"),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !/[\0\r\n]/.test(value) && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value),
      )
      .optional(),
    command: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => !/[\0\r\n]/.test(value)),
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes("\0")),
      )
      .max(64)
      .default([]),
    env: z
      .record(
        secretName,
        configValue.refine((value) => !/[\r\n]/.test(value)),
      )
      .refine((value) => Object.keys(value).length <= 64)
      .default({}),
  }),
  z.strictObject({
    ...commonServer,
    transport: z.literal("builtin"),
    builtinId: serverId,
  }),
]);
export const ConnectorManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/),
  version: z.string().trim().min(1).max(64),
  name: localizedText,
  description: localizedText,
  servers: z
    .array(ConnectorServerSchema)
    .max(CONNECTOR_IMPORT_MAX_SERVERS)
    .refine(
      (servers) => new Set(servers.map((server) => server.id)).size === servers.length,
      "Duplicate server id",
    ),
});
export const ConnectorStatusSchema = z.enum([
  "disabled",
  "starting",
  "ready",
  "idle",
  "needs_setup",
  "needs_auth",
  "error",
  "stopping",
]);
export const ConnectorIdentitySchema = z.enum(["user", "bot"]);
export const ConnectorConfirmationModeSchema = z.enum([
  "read_write",
  "always_ask",
  "read_only",
  "direct_read_write",
]);
export type ConnectorConfirmationMode = z.infer<typeof ConnectorConfirmationModeSchema>;

/**
 * The only reading of a connection's confirmation mode. Policy (`@pibot/policy`
 * re-exports this with the request builder), YOLO, routine pre-authorization, routine triggers,
 * "always do this" grants and the draft card all ask it, so no path can forget a mode.
 *
 * - `blocked`: read-only connection and this is a write; denied, whatever is remembered.
 * - `ask_now`: the person must answer this call now; no grant, YOLO, pre-authorization or
 *   unattended run may stand in for that answer.
 * - `normal`: the ordinary rules decide (access, tool switches, drafts, grants).
 */
export function connectionConfirmation(
  mode: ConnectorConfirmationMode,
  write: boolean,
): "blocked" | "ask_now" | "normal" {
  if (mode === "read_only") return write ? "blocked" : "normal";
  return mode === "always_ask" ? "ask_now" : "normal";
}

export function supportsDirectConnectionWrites(kind: Connector["kind"]): boolean {
  return kind === "mcp_remote" || kind === "mcp_stdio";
}

/** Whether anything other than the person's answer to this call may authorize a write here. */
export function connectionWriteRememberable(mode: ConnectorConfirmationMode): boolean {
  return connectionConfirmation(mode, true) === "normal";
}
export const newConnectionDefaults = {
  accessMode: "all",
  confirmationMode: "read_write",
} as const;
export const ConnectorSchema = z.strictObject({
  id: IdSchema,
  pluginInstallationId: IdSchema,
  serverId,
  revision,
  catalogVersion: count,
  kind: z.enum(["mcp_remote", "mcp_stdio", "builtin", "rest"]),
  identity: ConnectorIdentitySchema,
  confirmationMode: ConnectorConfirmationModeSchema.default(newConnectionDefaults.confirmationMode),
  /**
   * The person moved this stdio MCP outside the sandbox (macOS / Linux). Display and
   * intent only; starting it that way also needs the confirmation receipt for this configuration.
   */
  outsideSandbox: z.boolean().default(false),
  appId: serverId.optional(),
  name: plain,
  enabled: z.boolean(),
  status: ConnectorStatusSchema,
  statusDetailCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .nullable(),
  createdAt: time,
  updatedAt: time,
});
/** Fixed reasons a stdio MCP did not come up; the person sees one sentence for each. */
export const ConnectorStartReasonSchema = z.enum([
  "sandbox_start_failed",
  "sandbox_denied",
  "command_not_found",
  "password_prompt",
  "login_required",
  "dependency_missing",
  "timeout",
  "exited",
  "protocol_error",
  "outside_sandbox_reconfirm",
  "unknown",
]);
export type ConnectorStartReason = z.infer<typeof ConnectorStartReasonSchema>;
/** Desktop-only start diagnosis; never sent to the phone (not in its allowlist). */
export const ConnectorStartFailureSchema = z.strictObject({
  phase: z.enum(["start", "initialize", "discover"]),
  reason: ConnectorStartReasonSchema,
  exitCode: z.number().int().safe().nullable(),
  signal: z
    .string()
    .regex(/^SIG[A-Z0-9]{1,16}$/)
    .nullable(),
  timedOut: z.boolean(),
  outsideSandbox: z.boolean(),
  /** The sandbox's own refusals: fixed kind and rule ids, a `~/…` name, path or host. */
  denials: z
    .array(
      z.strictObject({
        kind: z.string().regex(/^[a-z_]{1,32}$/),
        rule: z.string().regex(/^[^\s\0]{1,64}$/),
        target: z.string().max(1024),
      }),
    )
    .max(16),
  /** Redacted end of the server's stderr. */
  stderrTail: z.string().max(4096),
  at: time,
});
export type ConnectorStartFailure = z.output<typeof ConnectorStartFailureSchema>;
export const ConnectorDiagnosticsSchema = z.strictObject({
  /** `available`: macOS / Linux user-imported stdio MCP; Windows always runs them unisolated. */
  outsideSandbox: z.enum(["available", "windows", "unavailable"]),
  /** The switch is on but the configuration changed since the person confirmed it. */
  needsReconfirm: z.boolean(),
  /** Why the detail panel suggests the switch; never turns it on by itself. */
  suggestion: z.enum(["ai_config_path", "sandbox_start_failed"]).nullable(),
  lastFailure: ConnectorStartFailureSchema.nullable(),
});
export type ConnectorDiagnostics = z.output<typeof ConnectorDiagnosticsSchema>;
export const ConnectorToolRefSchema = z.strictObject({
  connectorId: IdSchema,
  catalogVersion: count,
  tool: plain,
});
export const ConnectorToolSchema = ConnectorToolRefSchema.extend({
  description: z.string().max(4096),
  /** Display-only bundled translations; the catalog description still binds authorization. */
  displayDescription: z
    .strictObject({ zh: z.string().max(4096), en: z.string().max(4096) })
    .optional(),
  schema: z
    .record(z.string(), z.json())
    .refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024,
      "Tool schema too large",
    ),
  enabled: z.boolean(),
  readOnly: z.boolean(),
  /** Renderer hint from trusted builtin metadata; never used as runtime authorization. */
  readOnlyLocked: z.boolean().optional(),
  suggestedReadOnly: z.boolean(),
  /** Untrusted MCP declarations persisted with the catalog; never authorization. */
  readOnlyHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  draftBinding: DraftBindingSchema.optional(),
  /** Trusted local app mapping metadata; remote MCP declarations cannot set these fields. */
  capabilityId: CapabilityIdSchema.optional(),
  capabilityTool: plain.optional(),
  capabilityReadOnly: z.boolean().optional(),
});
export const PluginInstallationSchema = z.strictObject({
  id: IdSchema,
  pluginId: plain,
  version: plain,
  digest,
  revision,
  sourceKind: z.enum(["builtin", "json", "directory"]),
  status: z.enum(["installed", "removing", "removed"]),
  enabled: z.boolean(),
  createdAt: time,
  updatedAt: time,
});
export const ConnectorPageSchema = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ConnectorManifest = z.output<typeof ConnectorManifestSchema>;
export type ConnectorServer = z.output<typeof ConnectorServerSchema>;
export type Connector = z.output<typeof ConnectorSchema>;
export type ConnectorToolRef = z.output<typeof ConnectorToolRefSchema>;
export type ConnectorTool = z.output<typeof ConnectorToolSchema>;
export type PluginInstallation = z.output<typeof PluginInstallationSchema>;
