import type { BuiltinApp, CapabilityId, ConnectorServer, DraftBinding } from "@pibot/protocol-base";
import { BuiltinAppSchema, CapabilityIdSchema, DraftBindingSchema } from "@pibot/protocol-base";
import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const skillId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const plain = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const secretTarget = z.strictObject({
  target: z.enum(["header", "env"]),
  name: z.string().min(1).max(128),
  prefix: z.string().max(64).default(""),
});
const auth = z.strictObject({
  kind: z.enum(["none", "bearer", "oauth", "system"]),
  credential: secretTarget.optional(),
});
const commonPreset = {
  id,
  auth,
  networkDomains: z.array(z.string().min(1).max(253)).max(64).default([]),
};

export const PiBotServerPresetSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...commonPreset,
    transport: z.literal("http"),
    url: z.url({ protocol: /^https?$/ }),
    sseFallback: z.boolean().optional(),
    headers: z.record(z.string().min(1).max(128), z.string().max(4096)).default({}),
  }),
  z.strictObject({
    ...commonPreset,
    transport: z.literal("stdio"),
    /** Resolved only through the host's compiled-in service table. */
    fixedService: z.enum(["calendar", "contacts", "gmail"]),
    env: z.record(z.string().min(1).max(64), z.string().max(4096)).default({}),
  }),
]);

const draftRule = z.strictObject({
  tool: plain,
  binding: DraftBindingSchema,
  when: z
    .strictObject({
      string: z.array(plain).max(16).default([]),
      absent: z.array(plain).max(16).default([]),
      schemaTypes: z
        .record(
          plain,
          z.array(z.enum(["string", "number", "integer", "boolean", "array", "object"])).max(4),
        )
        .default({}),
    })
    .optional(),
});

export const PiBotPluginManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  order: z.number().int().min(0).max(10_000),
  card: BuiltinAppSchema.omit({ id: true, supported: true, unsupportedReason: true }).extend({
    platforms: z
      .array(z.enum(["darwin", "win32", "linux"]))
      .max(3)
      .optional(),
    unsupportedReason: plain.optional(),
  }),
  mcp: z
    .strictObject({
      presets: z
        .record(id, PiBotServerPresetSchema)
        .refine((value) => Object.keys(value).length <= 16),
      requiresToken: z.array(id).max(16).default([]),
      authorizeOnEnable: z.boolean().default(false),
      readOnlyTools: z.array(plain).max(10_000).default([]),
      toolDescriptions: z
        .record(plain, z.strictObject({ zh: plain, en: plain }))
        .refine((value) => Object.keys(value).length <= 10_000)
        .optional(),
      disabledTools: z.array(plain).max(10_000).default([]),
      disabledToolPatterns: z.array(z.string().min(1).max(512)).max(32).default([]),
      capability: z
        .strictObject({
          id: CapabilityIdSchema,
          tools: z.record(plain, plain),
          readOnlyTools: z.array(plain).max(10_000),
        })
        .optional(),
      draftBindings: z.array(draftRule).max(100).default([]),
      oauthStartTool: plain.optional(),
      trusted: z
        .strictObject({
          stdio: z
            .strictObject({
              machLookup: z.array(plain).max(64).default([]),
              legacyBuiltinId: id.optional(),
              legacyMode: id.optional(),
              openTimeoutMs: z.number().int().min(1).max(300_000).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * User-facing text in plugin.json `userConfig` (title, description, option labels): a plain string,
 * "中文 / English", or `{ "zh": …, "en": … }`. Pi Bot shows the reader's language either way.
 */
export const PluginTextSchema = z.union([
  z.string().max(4096),
  z.strictObject({ zh: z.string().max(2000), en: z.string().max(2000) }),
]);
export type PluginText = z.output<typeof PluginTextSchema>;
export const ClaudePluginUserConfigFieldSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "directory", "file"]).optional(),
    title: PluginTextSchema.optional(),
    description: PluginTextSchema.optional(),
    sensitive: z.boolean().optional(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z
      .array(
        z.object({
          value: z.union([z.string(), z.number(), z.boolean()]),
          label: PluginTextSchema,
        }),
      )
      .optional(),
  })
  .loose();

/**
 * One stored string for either form. A localized object becomes "中文 / English", the form older
 * Pi Bot versions and existing packages already use, so stored settings keep one shape.
 */
export function pluginText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const parsed = PluginTextSchema.safeParse(value);
  if (!parsed.success || typeof parsed.data === "string") return undefined;
  const zh = parsed.data.zh.trim();
  const en = parsed.data.en.trim();
  if (!zh || !en || zh === en) return zh || en;
  return `${zh} / ${en}`;
}

/** Claude-compatible public manifest. Unknown official fields stay available to the importer. */
export const ClaudePluginManifestSchema = z
  .object({
    name: plain.optional(),
    version: plain.optional(),
    description: z.string().max(4096).optional(),
    mcpServers: z.unknown().optional(),
    userConfig: z.unknown().optional(),
  })
  .loose();

export interface PluginSkillResource {
  path: string;
  content: string | Uint8Array;
}
export interface PluginSkillLocale {
  skillMd: string;
  files?: readonly PluginSkillResource[];
}
export interface PluginSkill {
  id: string;
  locales: Readonly<Record<"zh" | "en", PluginSkillLocale>>;
}

export interface McpCapability {
  id: CapabilityId;
  tools: Readonly<Record<string, string>>;
  readOnlyTools: ReadonlySet<string>;
}
export interface TrustedStdioBoundary {
  machLookup?: readonly string[];
  hostScriptPath?: string;
}
/** Validated runtime result of the declarative loader; plugins do not construct this in TS. */
export interface Plugin {
  id: string;
  version: string;
  card(platform: NodeJS.Platform): BuiltinApp;
  mcp?: {
    server(input: { mode: string; credentialName?: string }): ConnectorServer;
    requiresToken?(mode: string): boolean;
    authorizeOnEnable?: boolean;
    trustedReads: ReadonlySet<string>;
    toolDescriptions?: Readonly<Record<string, { zh: string; en: string }>>;
    defaultEnabled(tool: string): boolean;
    draftBinding(
      tool: string,
      schema: unknown,
      args?: Record<string, unknown>,
    ): DraftBinding | undefined;
    oauthStartTool?: string;
    capability?: McpCapability;
    trustedStdio?: TrustedStdioBoundary;
    openTimeoutMs?: number;
    legacyBuiltinMode?(server: ConnectorServer): string | undefined;
  };
  skills?: readonly PluginSkill[];
}

export type PiBotPluginManifest = z.output<typeof PiBotPluginManifestSchema>;
export type PiBotServerPreset = z.output<typeof PiBotServerPresetSchema>;
export type ClaudePluginManifest = z.output<typeof ClaudePluginManifestSchema>;
export const PluginSkillIdSchema = skillId;

/** Shared standard-format boundary used before either builtin enrichment or untrusted import. */
export function parseClaudePluginManifest(value: unknown): ClaudePluginManifest {
  return ClaudePluginManifestSchema.parse(value);
}
