import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

const text = z.string().min(1);
export const CategorySchema = z.enum([
  "run_command",
  "connector",
  "computer",
  "read_file",
  "list_dir",
  "write_file",
  "read_ai_config",
  "read_messages",
  "send_out",
  "web",
  // Handing work to an external agent Bot (delegate_to_agent).
  "agent_delegation",
  // The default Pi only: create, edit, archive and restore Bots and groups.
  "bot_management",
  // The default Pi only: send a message or task to another Bot or a group.
  "work_dispatch",
]);
/**
 * Owner decision 2026-11-24: these two levels exist only on the default Pi. The global value stays
 * at its "ask" default and is never shown or set; Pi's own override is the one switch.
 */
export const PI_MANAGER_CATEGORIES = ["bot_management", "work_dispatch"] as const;
export type PiManagerCategory = (typeof PI_MANAGER_CATEGORIES)[number];
export function isPiManagerCategory(value: string): value is PiManagerCategory {
  return (PI_MANAGER_CATEGORIES as readonly string[]).includes(value);
}
export const LevelSchema = z.enum(["never", "ask", "always"]);
// A strict shape keeps unsupported categories out of persisted settings and RPC patches.
export const PermissionLevelsSchema = z.strictObject({
  run_command: LevelSchema,
  // Existing persisted settings predate connectors; absence keeps the conservative ask default.
  connector: LevelSchema.default("ask"),
  computer: LevelSchema,
  read_file: LevelSchema,
  list_dir: LevelSchema,
  write_file: LevelSchema,
  read_ai_config: LevelSchema,
  read_messages: LevelSchema,
  send_out: LevelSchema,
  web: LevelSchema,
  // Settings saved before it have no entry; absence asks, like `connector` above.
  agent_delegation: LevelSchema.default("ask"),
  bot_management: LevelSchema.default("ask"),
  work_dispatch: LevelSchema.default("ask"),
});
export const PermissionOverridesSchema = PermissionLevelsSchema.omit({
  connector: true,
  agent_delegation: true,
  bot_management: true,
  work_dispatch: true,
})
  .partial()
  .extend({
    connector: LevelSchema.optional(),
    agent_delegation: LevelSchema.optional(),
    bot_management: LevelSchema.optional(),
    work_dispatch: LevelSchema.optional(),
  });
export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/);
export const NetworkSettingsSchema = z.strictObject({
  allowAll: z.boolean(),
  domains: z.array(DomainSchema).max(200),
});
export const BotPermissionOverridesSchema = PermissionOverridesSchema.extend({
  network: NetworkSettingsSchema.optional(),
  /**
   * Owner decision 2026-11-24: every outward send of this Bot asks the person, whatever grants,
   * connection consent, routine pre-approval or YOLO say, and its card never offers "remember".
   * Read from the Bot's own row even in a group (group overrides cannot remove it). Optional so
   * rows saved before it still parse; only `true` is stored.
   */
  confirmEverySend: z.literal(true).optional(),
});
export const IsolationSchema = z.strictObject({ available: z.boolean(), reason: text.optional() });
export const DockerRuntimeSchema = z.enum(["disabled", "orbstack", "desktop", "engine"]);
/**
 * Mirrors the alias rule of the SSH intent parser in `execution/src/ssh/ssh-intent.ts`; the two
 * cannot share code because protocol-base is the leaf every implementation depends on.
 */
export const SshHostAliasSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
/**
 * Only a bare file name in ~/.ssh: Pi Bot never rewrites the user's config, so a stored identity
 * must stay a single path segment (no separators, no "." / "..", no control characters).
 */
export const SshIdentityFileSchema = z.string().regex(/^(?!\.{1,2}$)[^/\\\p{Cc}]{1,255}$/u);
export const SshHostSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  identity: SshIdentityFileSchema.optional(),
});
export const SshHostsSettingsSchema = z
  .record(SshHostAliasSchema, SshHostSettingsSchema)
  .refine((value) => Object.keys(value).length <= 64, "At most 64 SSH hosts");
/** Why a host from ~/.ssh/config still cannot run the fixed recipe. */
export const SshHostReasonSchema = z.enum([
  "proxy",
  "match",
  "include_outside_home",
  "include_in_workspace",
  "strict_host_key",
  "option",
  "user",
  "identity_outside_ssh",
  "other",
]);
export const SshHostStatusSchema = z.enum(["ready", "needs_key", "unsupported"]);
export const SshHostEntrySchema = z.strictObject({
  alias: SshHostAliasSchema,
  status: SshHostStatusSchema,
  reason: SshHostReasonSchema.optional(),
  /** Directive name for an `option` reason; it is a keyword, never a value or a path. */
  option: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)
    .optional(),
  enabled: z.boolean(),
  // Whether the configuration itself names an IdentityFile; the row shows the picker otherwise.
  hasKey: z.boolean(),
  identity: SshIdentityFileSchema.optional(),
});
export const SshHostListSchema = z.strictObject({
  hosts: z.array(SshHostEntrySchema).max(64),
  // File names only: private key paths, HostName and ports never reach the renderer.
  identities: z.array(SshIdentityFileSchema).max(200),
  unavailable: z
    .enum(["unsupported_platform", "configuration_unavailable", "configuration_unsupported"])
    .optional(),
  // Whether a config file existed, so an empty alias list may prune stored settings.
  configured: z.boolean().optional(),
});
export const PermissionsSettingsSchema = z.strictObject({
  levels: PermissionLevelsSchema,
  network: NetworkSettingsSchema,
  pathEntries: z.array(text).max(200).optional(),
  dockerRuntime: DockerRuntimeSchema.optional(),
  sshHosts: SshHostsSettingsSchema.optional(),
});
export const PermissionsPatchSchema = z.strictObject({
  levels: PermissionOverridesSchema.optional(),
  network: NetworkSettingsSchema.partial().optional(),
  pathEntries: z.array(text).max(200).optional(),
  dockerRuntime: DockerRuntimeSchema.optional(),
  sshHosts: SshHostsSettingsSchema.optional(),
});
export const PermissionsSchema = PermissionsSettingsSchema.extend({
  isolation: IsolationSchema,
  botId: IdSchema.optional(),
  groupId: IdSchema.optional(),
  overrides: BotPermissionOverridesSchema.optional(),
  effective: PermissionsSettingsSchema.optional(),
});
// Defaults migrate full settings, never partial updates to unrelated categories.
const levelPatch = {
  ...PermissionLevelsSchema.shape,
  connector: LevelSchema,
  agent_delegation: LevelSchema,
  bot_management: LevelSchema,
  work_dispatch: LevelSchema,
};
export const PermissionsSetSchema = z
  .strictObject({
    botId: IdSchema.optional(),
    groupId: IdSchema.optional(),
    levels: z
      .strictObject(
        Object.fromEntries(
          Object.entries(levelPatch).map(([key, value]) => [key, value.nullable().optional()]),
        ) as {
          [K in keyof typeof levelPatch]: z.ZodOptional<z.ZodNullable<(typeof levelPatch)[K]>>;
        },
      )
      .optional(),
    network: NetworkSettingsSchema.partial().nullable().optional(),
    pathEntries: z.array(text).max(200).optional(),
    dockerRuntime: DockerRuntimeSchema.optional(),
    sshHosts: SshHostsSettingsSchema.optional(),
  })
  .refine((value) => !(value.botId && value.groupId), "Choose one permission scope");
export const PermissionEvents = {
  "permissions.changed": PermissionsSchema,
} as const;
const _botId = z.strictObject({ botId: IdSchema });
export const PermissionMethods = {
  "permissions.get": {
    params: z.union([
      z.undefined(),
      z
        .strictObject({ botId: IdSchema.optional(), groupId: IdSchema.optional() })
        .refine((value) => !(value.botId && value.groupId)),
    ]),
    result: PermissionsSchema,
  },
  "permissions.set": { params: PermissionsSetSchema, result: PermissionsSchema },
  "permissions.allowBlockedWebsite": {
    params: z.strictObject({ noticeId: IdSchema, scope: z.enum(["bot", "group", "global"]) }),
    result: PermissionsSchema,
  },
  "permissions.sshHosts.list": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: SshHostListSchema,
  },
  "permissions.paths.discover": {
    params: z.strictObject({ source: z.enum(["process", "terminal"]) }),
    result: z.strictObject({
      paths: z.array(text).max(200),
      source: z.enum(["process", "terminal"]),
      shell: text.optional(),
    }),
  },
} as const;
export type Category = z.infer<typeof CategorySchema>;
export type Level = z.infer<typeof LevelSchema>;
export type PermissionLevels = z.infer<typeof PermissionLevelsSchema>;
export type PermissionOverrides = z.infer<typeof PermissionOverridesSchema>;
export type BotPermissionOverrides = z.infer<typeof BotPermissionOverridesSchema>;
export type PermissionsSettings = z.infer<typeof PermissionsSettingsSchema>;
export type PermissionsPatch = z.infer<typeof PermissionsPatchSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
