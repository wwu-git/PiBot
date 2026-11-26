import {
  BotPermissionOverridesSchema,
  CHAT_SEARCH_TARGET,
  ComputerAppIdSchema,
  ConnectorConfirmationModeSchema,
  CredentialSiteSchema,
  GitConfigurationFactsSchema,
  GitEntryFactsSchema,
  GitHookFactsSchema,
  GrantSchema,
  HostSshFactsSchema,
  IdSchema,
  LocalPortSchema,
  MAX_COMPUTER_APPS,
  PermissionsSettingsSchema,
  WorkplacesSchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import { pathApi } from "../paths/paths.ts";
import { PolicyInputError } from "./errors.ts";
import { OutsideSandboxFactsSchema } from "./outside-sandbox.ts";
import type { EvaluationInput, Platform } from "./types.ts";

/** This run's allowed local-network targets (origins or hosts), supplied by brain. */
const privateApprovals = z.strictObject({
  approved: z.array(z.string().min(1).max(300)).max(64),
});
const requestSchema = z.discriminatedUnion("category", [
  z.strictObject({ category: z.literal("tool_discovery") }),
  z.strictObject({ category: z.literal("plugin_install") }),
  z.strictObject({
    category: z.literal("send_out"),
    identity: z.enum(["user", "bot"]),
    connectorId: IdSchema,
    tool: z.string().min(1).max(4096),
    target: z.string().min(1).max(4096),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rememberable: z.boolean(),
  }),
  z.strictObject({ category: z.literal("planning") }),
  z.discriminatedUnion("operation", [
    z.strictObject({
      category: z.literal("connector"),
      operation: z.literal("discover"),
      visible: z.boolean(),
    }),
    z.strictObject({
      category: z.literal("connector"),
      operation: z.literal("call"),
      connectorId: IdSchema.optional(),
      tool: z.string().min(1).max(4096).optional(),
      visible: z.boolean(),
      readOnly: z.boolean(),
      confirmationMode: ConnectorConfirmationModeSchema,
    }),
  ]),
  z.strictObject({
    category: z.literal("read_messages"),
    target: z.union([IdSchema, z.enum(["readable_conversations", CHAT_SEARCH_TARGET])]),
    scopeValid: z.boolean(),
  }),
  z.strictObject({
    category: z.literal("image_generation"),
    recipient: z.string().min(1).max(253),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
  }),
  z.strictObject({
    category: z.literal("routine_proposal"),
    operation: z.enum(["propose", "query"]),
  }),
  z.strictObject({ category: z.literal("skill_proposal") }),
  z.strictObject({
    category: z.literal("workplace_proposal"),
    operation: z.enum(["list", "propose"]),
  }),
  z.strictObject({ category: z.literal("check_proposal") }),
  z.strictObject({
    category: z.literal("collaboration"),
    operation: z.enum(["assign_task", "ask_bot", "finish_task", "group_pause"]),
  }),
  z.strictObject({
    category: z.literal("agent_delegation"),
    agent: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({
    category: z.literal("bot_management"),
    operation: z.enum(["list", "change"]),
    mainDirect: z.boolean().optional(),
  }),
  z.strictObject({
    category: z.literal("work_dispatch"),
    mainDirect: z.boolean().optional(),
  }),
  z.strictObject({
    category: z.literal("memory"),
    operation: z.enum(["add", "update", "remove"]),
    text: z.string().max(16000).optional(),
    afterUntrusted: z.boolean().optional(),
    scope: z.enum(["user", "bot", "group", "project"]).optional(),
  }),
  z.strictObject({ category: z.literal("memory_read") }),
  z.strictObject({ category: z.literal("review") }),
  z.strictObject({
    category: z.literal("phone_data"),
    operation: z.enum(["media", "media_get", "sms_code", "calls", "notifications"]),
  }),
  z.strictObject({
    category: z.literal("run_command"),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    background: z.literal(true).optional(),
    stdin: z.literal(true).optional(),
    writePaths: z.array(z.string().min(1).max(32_768)).min(1).max(8).optional(),
    outsideSandbox: z.literal(true).optional(),
    privateNetwork: privateApprovals.optional(),
  }),
  z
    .strictObject({
      category: z.literal("local_network"),
      operation: z.enum(["info", "ping"]),
      host: z.string().min(1).max(253).optional(),
      approved: privateApprovals.shape.approved.optional(),
    })
    .refine(
      (value) =>
        value.operation === "info"
          ? value.host === undefined && value.approved === undefined
          : value.host !== undefined && value.approved !== undefined,
      "ping needs host and approved; info takes neither",
    ),
  z.strictObject({
    category: z.literal("background"),
    operation: z.enum(["list", "output", "wait", "stop"]),
  }),
  z.strictObject({ category: z.literal("browser_tabs") }),
  ...(["read_file", "list_dir", "write_file"] as const).map((category) =>
    z.strictObject({
      category: z.literal(category),
      path: z.string().min(1),
      projectNotes: z.boolean().optional(),
    }),
  ),
  z.strictObject({
    category: z.literal("web"),
    browserSensitive: z
      .strictObject({ kind: z.string().max(64), name: z.string().max(256) })
      .optional(),
    url: z.string().min(1),
    search: z
      .strictObject({
        disclosed: z.boolean(),
        configuredEndpoint: z.string().min(1).optional(),
        confirmBeforeUse: z.boolean().optional(),
      })
      .optional(),
    login: z.strictObject({ site: CredentialSiteSchema }).optional(),
    // A form submission in the Bot browser on this page's site.
    submit: z.literal(true).optional(),
    fetch: z.literal(true).optional(),
    localPorts: z.array(LocalPortSchema).max(48).optional(),
    privateNetwork: privateApprovals.optional(),
  }),
  z.strictObject({
    category: z.literal("computer"),
    tool: z.string().min(1).max(64).optional(),
    apps: z.array(ComputerAppIdSchema).max(MAX_COMPUTER_APPS).optional(),
    coordinates: z.boolean().optional(),
    alwaysApps: z.array(ComputerAppIdSchema).max(MAX_COMPUTER_APPS).optional(),
  }),
  ...(["read_ai_config"] as const).map((category) =>
    z.strictObject({ category: z.literal(category) }),
  ),
]);
/**
 * These roots come from brain, not from anything a person confirmed. A relative or
 * control-character entry would silently widen the exemption, so only absolute paths pass.
 */
function outputRoots(
  roots: readonly string[] | undefined,
  isAbsolute: (path: string) => boolean,
): readonly string[] | undefined {
  for (const root of roots ?? [])
    if (!isAbsolute(root) || hasControlCharacters(root))
      throw new PolicyInputError("Output roots must be absolute paths");
  return roots?.length ? roots : undefined;
}
function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
export function parseInput(input: EvaluationInput, platform: Platform): EvaluationInput {
  if (input.commandIsolation !== undefined && typeof input.commandIsolation !== "function")
    throw new PolicyInputError("Invalid command isolation probe");
  if (input.confirmEverySend !== undefined && typeof input.confirmEverySend !== "boolean")
    throw new PolicyInputError("Invalid send confirmation fact");
  const settings = PermissionsSettingsSchema.parse(input.settings);
  const botOverrides = BotPermissionOverridesSchema.parse(input.botOverrides ?? {});
  const gitConfiguration =
    input.gitConfiguration === undefined
      ? undefined
      : GitConfigurationFactsSchema.strict().parse(input.gitConfiguration);
  const knownFile = gitConfiguration?.operation === "known-file";
  if (
    gitConfiguration &&
    (knownFile ? input.request.category !== "write_file" : input.request.category !== "run_command")
  )
    throw new PolicyInputError("Git configuration facts do not match the request category");
  if (
    input.gitConfigurationFile &&
    (!knownFile || typeof input.gitConfigurationFile.verifyCurrent !== "function")
  )
    throw new PolicyInputError("Invalid known configuration file adapter");
  if (
    input.managedGitConfiguration &&
    (gitConfiguration?.reason !== "managed_branch_candidate" ||
      typeof input.managedGitConfiguration.verifyCurrent !== "function")
  )
    throw new PolicyInputError("Invalid managed configuration adapter");
  if (
    input.gitHooksPath &&
    (gitConfiguration?.operation !== "hooks-path" ||
      typeof input.gitHooksPath.verifyCurrent !== "function")
  )
    throw new PolicyInputError("Invalid hooks path adapter");
  const gitHook = input.gitHook === undefined ? undefined : GitHookFactsSchema.parse(input.gitHook);
  const hostSsh = input.hostSsh === undefined ? undefined : HostSshFactsSchema.parse(input.hostSsh);
  const gitEntries =
    input.gitEntries === undefined ? undefined : GitEntryFactsSchema.parse(input.gitEntries);
  if (
    [gitConfiguration, gitHook, hostSsh, gitEntries].filter(Boolean).length > 1 ||
    ((gitHook || hostSsh || gitEntries) && input.request.category !== "run_command")
  )
    throw new PolicyInputError("Conflicting or non-command execution recipe facts");
  const { isAbsolute } = pathApi(platform);
  const groupOutputRoots = outputRoots(input.groupOutputRoots, isAbsolute);
  const commandReadRoots = outputRoots(input.commandReadRoots, isAbsolute);
  return {
    ...input,
    gitConfiguration,
    gitHook,
    hostSsh,
    gitEntries,
    ...(input.outsideSandbox === undefined
      ? {}
      : { outsideSandbox: OutsideSandboxFactsSchema.parse(input.outsideSandbox) }),
    // The local_network refine pairs ping with host/approved; zod cannot narrow that shape.
    request: requestSchema.parse(input.request) as EvaluationInput["request"],
    settings: { ...settings, network: botOverrides.network ?? settings.network },
    botOverrides,
    grants: (input.grants ?? []).map((grant) => GrantSchema.parse(grant)),
    runGrants: (input.runGrants ?? []).map((grant) => GrantSchema.parse(grant)),
    workplace: WorkplacesSchema.parse(input.workplace),
    ...(groupOutputRoots ? { groupOutputRoots } : {}),
    ...(commandReadRoots ? { commandReadRoots } : {}),
  };
}
