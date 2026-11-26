import {
  BuiltinAppConnectSchema,
  BuiltinAppSchema,
  ClaudePluginBundleSchema,
  ClaudePluginComponentSchema,
  ClaudePluginConfigFieldSchema,
  CONNECTOR_IMPORT_MAX_BYTES,
  ConnectionAvailabilitySchema,
  ConnectionTargetSchema,
  ConnectorAccessSchema,
  ConnectorDiagnosticsSchema,
  ConnectorImportFileChangesSchema,
  ConnectorManifestSchema,
  ConnectorOperationSchema,
  ConnectorPageSchema,
  ConnectorSchema,
  ConnectorStatusSchema,
  ConnectorToolSchema,
  ConnectorUpdateSchema,
  DomainSchema,
  IdSchema,
  PluginInstallationSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

// UI <-> brain methods of the connectors capability. Entity schemas stay in protocol-base: the run
// engine (approvals, drafts, unattended runs, the tool runner) reasons about connectors too.
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
const kind = z.enum(["file", "directory"]);
const importConfig = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    z.union([z.string().max(16384), z.number().finite(), z.boolean()]),
  )
  .refine((value) => Object.keys(value).length <= 100)
  .default({});
const source = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("json"),
    text: z
      .string()
      .min(1)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= CONNECTOR_IMPORT_MAX_BYTES,
        "Import too large",
      ),
  }),
  // The host owns this short-lived selection; renderer cannot supply an arbitrary path.
  z.strictObject({ kind: z.literal("selection"), selectionId: IdSchema }),
  // Re-evaluates one backend-owned plugin snapshot with the user's current settings.
  z.strictObject({ kind: z.literal("configured"), previewId: IdSchema, config: importConfig }),
]);
const operation = z.strictObject({ operationId: IdSchema });
const change = z.strictObject({ id: IdSchema, expectedRevision: revision });
export const PluginSkillTargetsSchema = z.strictObject({
  bots: z.array(IdSchema).max(500),
  groups: z.array(IdSchema).max(500),
});
const skillAssignments = z.strictObject({
  installationId: IdSchema,
  revision,
  unassignedCount: count,
  pendingTargetCount: count,
  /** Skills a target already had from an earlier import whose package has since changed. */
  updateCount: count,
});
export const PluginSummarySchema = z.strictObject({
  installationId: IdSchema,
  pluginId: plain,
  revision,
  enabled: z.boolean(),
  /** Json = an MCP configuration, directory = a plugin package (the page's two tabs). */
  sourceKind: z.enum(["builtin", "json", "directory"]).optional(),
  /** Pi Bot application package; shown in Applications while retaining connector permissions. */
  application: z.boolean().default(false),
  applicationPlatforms: z.array(z.enum(["darwin", "win32", "linux"])).default([]),
  /** The other AI tool it was brought over from. */
  originTool: z.enum(["claude-code", "codex", "cursor", "pi", "opencode"]).optional(),
  /** Bots / groups that received a copy of its skills (the row's faces for skill-only plugins). */
  skillTargets: z
    .strictObject({ bots: z.array(IdSchema).max(500), groups: z.array(IdSchema).max(500) })
    .optional(),
  name: z.strictObject({ zh: plain, en: plain }),
  description: z.strictObject({ zh: z.string().max(4096), en: z.string().max(4096) }),
  toolCount: count,
  connectorCount: count,
  skillCount: count,
  skillUpdateCount: count,
  access: ConnectorAccessSchema,
});
export type PluginSummary = z.output<typeof PluginSummarySchema>;
export const ConnectorSourceDetailsSchema = z.strictObject({
  servers: z
    .array(
      z.strictObject({
        id: z.string().max(4096),
        command: z
          .strictObject({ before: z.string().max(4096), after: z.string().max(4096) })
          .optional(),
        arguments: z
          .strictObject({
            before: z.array(z.string().max(4096)).max(64),
            after: z.array(z.string().max(4096)).max(64),
          })
          .optional(),
        envNames: z.strictObject({
          added: z.array(z.string().max(64)).max(64),
          removed: z.array(z.string().max(64)).max(64),
        }),
        websites: z.strictObject({
          before: z.array(z.string().max(4096)).max(129),
          after: z.array(z.string().max(4096)).max(129),
        }),
      }),
    )
    .max(100),
  files: ConnectorImportFileChangesSchema.optional(),
});
export type ConnectorSourceDetails = z.output<typeof ConnectorSourceDetailsSchema>;

export const ConnectorMethods = {
  "connectors.updateFromSource": {
    params: change.extend({ confirmed: z.boolean(), expectedDigest: digest.optional() }),
    timeoutMs: 330_000,
    result: z.strictObject({
      state: z.enum(["preview", "updated", "source_not_found"]),
      installationId: IdSchema,
      expectedRevision: revision,
      changes: z.strictObject({
        commands: count,
        arguments: count,
        envNames: count,
        websites: count,
        files: count,
      }),
      connector: ConnectorSchema.optional(),
      details: ConnectorSourceDetailsSchema.optional(),
      sourceDigest: digest.optional(),
    }),
  },
  "connections.availability": {
    params: z.strictObject({
      target: ConnectionTargetSchema,
      connection: z.string().min(1).max(200),
      tool: z.string().min(1).max(4096).optional(),
    }),
    result: ConnectionAvailabilitySchema,
  },
  "plugins.list": {
    params: ConnectorPageSchema.extend({ connectionsOnly: z.boolean().optional() }),
    result: z.strictObject({
      items: z.array(PluginInstallationSchema).max(100),
      nextCursor: plain.nullable(),
    }),
  },
  "plugins.available": {
    params: z.strictObject({
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    result: z.strictObject({
      items: z.array(PluginSummarySchema).max(100),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "plugins.setEnabled": {
    params: z.strictObject({
      installationId: IdSchema,
      expectedRevision: revision,
      enabled: z.boolean(),
    }),
    result: PluginInstallationSchema,
  },
  "plugins.previewImport": {
    params: z.strictObject({ source }),
    result: z.strictObject({
      previewId: IdSchema,
      digest,
      manifest: ConnectorManifestSchema,
      declaredVersion: ConnectorManifestSchema.shape.version.optional(),
      commandWarnings: z
        .array(z.enum(["dangerous", "unverified"]))
        .max(2)
        .optional(),
      plugin: z
        .strictObject({
          components: z.array(ClaudePluginComponentSchema).max(300),
          config: z.array(ClaudePluginConfigFieldSchema).max(100),
          skillCount: count,
          /** A Pi Bot application package's card: its 准备工作 help and documentation link. */
          application: ClaudePluginBundleSchema.shape.applicationCard,
        })
        .optional(),
      expiresAt: time,
    }),
  },
  "plugins.cancelPreview": {
    params: z.strictObject({ previewId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "plugins.pendingSkillAssignments": {
    params: z.strictObject({
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    result: z.strictObject({
      items: z
        .array(skillAssignments.extend({ name: z.strictObject({ zh: plain, en: plain }) }))
        .max(100),
      totalCount: count,
      nextBefore: IdSchema.nullable(),
    }),
  },
  "plugins.skillAssignments": {
    params: z.strictObject({ installationId: IdSchema }),
    result: skillAssignments,
  },
  "plugins.assignSkills": {
    params: z.strictObject({
      installationId: IdSchema,
      expectedRevision: revision,
      targets: PluginSkillTargetsSchema,
    }),
    result: skillAssignments,
  },
  "plugins.import": {
    params: z.strictObject({
      previewId: IdSchema,
      enable: z.boolean(),
      expectedDigest: digest,
      skillTargets: PluginSkillTargetsSchema.default({ bots: [], groups: [] }),
      config: importConfig,
      networkDomains: z
        .record(z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/), z.array(DomainSchema).max(64))
        .refine((value) => Object.keys(value).length <= 100)
        .default({}),
    }),
    result: z.strictObject({
      installation: PluginInstallationSchema,
      connectors: z.array(ConnectorSchema).max(100),
      unassignedSkillCount: count.optional(),
      pendingSkillTargetCount: count.optional(),
    }),
  },
  "plugins.uninstall": {
    params: z.strictObject({ installationId: IdSchema, expectedRevision: revision }),
    result: operation,
  },
  "connectors.list": {
    params: ConnectorPageSchema.extend({
      installationId: IdSchema.optional(),
      builtin: z.boolean().optional(),
    }),
    result: z.strictObject({
      items: z.array(ConnectorSchema).max(100),
      nextCursor: plain.nullable(),
    }),
  },
  "connectors.get": {
    params: z.strictObject({ id: IdSchema }),
    result: z.strictObject({
      connector: ConnectorSchema,
      access: ConnectorAccessSchema,
      auth: z.enum(["none", "bearer", "oauth", "system"]).optional(),
      canReplaceCredential: z.boolean().optional(),
      networkDomains: z.array(DomainSchema).max(64).optional(),
      canEditNetworkDomains: z.boolean().optional(),
      bundledNode: z.boolean().optional(),
    }),
  },
  "connectors.update": { params: ConnectorUpdateSchema, result: ConnectorSchema },
  "connectors.operation": {
    params: z.strictObject({ operationId: IdSchema }),
    result: ConnectorOperationSchema,
  },
  "connectors.tools": {
    params: ConnectorPageSchema.extend({
      id: IdSchema,
      limit: z.number().int().min(1).max(50).default(50),
    }),
    result: z.strictObject({
      items: z.array(ConnectorToolSchema).max(50),
      nextCursor: plain.nullable(),
    }),
  },
  "connectors.setEnabled": {
    params: change.extend({ enabled: z.boolean() }),
    timeoutMs: 330_000,
    result: operation,
  },
  "connectors.disconnect": { params: change, result: operation },
  "connectors.restart": { params: change, timeoutMs: 330_000, result: operation },
  /** Desktop-only; the phone allowlist leaves both out on purpose. */
  "connectors.diagnostics": {
    params: z.strictObject({ id: IdSchema }),
    result: ConnectorDiagnosticsSchema,
  },
  "connectors.setOutsideSandbox": {
    params: change.extend({ enabled: z.boolean() }),
    // Outlives the native confirmation and host forwarding deadlines.
    timeoutMs: 330_000,
    result: z.strictObject({
      connector: ConnectorSchema,
      /** The running connection restarts so the new setting takes effect. */
      operationId: IdSchema.nullable(),
    }),
  },
} as const;
const connectorVersion = { connectorId: IdSchema, revision, catalogVersion: count };
export const ConnectorEvents = {
  "plugins.changed": z.strictObject({
    installationId: IdSchema,
    revision,
    reason: z.enum(["imported", "enabled", "disabled", "removed", "access"]),
  }),
  "connectors.changed": z.strictObject({ ...connectorVersion, status: ConnectorStatusSchema }),
  "connectors.toolsChanged": z.strictObject(connectorVersion),
  "connectors.operationChanged": ConnectorOperationSchema,
} as const;
export const ConnectorImportMethods = {
  "plugins.pickImport": {
    params: z.strictObject({ kind }),
    // The picker is a native dialog a person may keep open for minutes, so it declares
    // its own deadline (the background request guard and the caller's default follow it). It is
    // longer than the 620 s a background picks forwards to the window with, and only guards a hang.
    timeoutMs: 650_000,
    // A cancel is a result, not a failure: the panel returns to its buttons without an error.
    result: z.strictObject({ selectionId: IdSchema.nullable(), canceled: z.boolean() }),
  },
} as const;
export const ConnectorAppMethods = {
  "apps.list": {
    params: z.strictObject({}),
    result: z.strictObject({ items: z.array(BuiltinAppSchema).max(100) }),
  },
  "apps.connect": {
    params: BuiltinAppConnectSchema,
    result: z.strictObject({
      installation: PluginInstallationSchema,
      connectors: z.array(ConnectorSchema).max(1),
    }),
  },
  "connectors.authorize": {
    params: z.strictObject({
      id: IdSchema,
      expectedRevision: z.number().int().positive().safe(),
      token: z
        .string()
        .min(1)
        .max(16384)
        .refine((value) => !/[\0\r\n]/.test(value))
        .optional(),
      /** Which of a brought-over connection's tokens to replace (as 访问令牌 lists it). */
      tokenName: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
        .optional(),
    }),
    result: z.strictObject({ authorizationId: IdSchema, expiresAt: z.iso.datetime() }),
  },
  "connectors.cancelAuthorization": {
    params: z.strictObject({ authorizationId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;
