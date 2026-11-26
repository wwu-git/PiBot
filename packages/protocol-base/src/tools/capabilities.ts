import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { CategorySchema } from "../permissions/settings.ts";

export const CapabilityIdSchema = z.enum([
  "files.read",
  "files.write",
  "web.fetch",
  "web.search",
  "browser",
  "calendar",
  "contacts",
]);

const ConnectorCapabilityImplSchema = z
  .string()
  .regex(/^connector:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .transform((value) => value as `connector:${string}`);

export const CapabilityImplSchema = z.union([
  z.enum(["builtin", "off"]),
  ConnectorCapabilityImplSchema,
]);
export const CapabilityImplTypeSchema = z.enum(["builtin", "connector", "off"]);
export const CapabilityChangedAuditDetailSchema = z.strictObject({
  capabilityId: CapabilityIdSchema,
  capabilityImpl: CapabilityImplTypeSchema,
});

export const CapabilityDefinitionSchema = z.strictObject({
  id: CapabilityIdSchema,
  name: z.strictObject({ zh: z.string().min(1), en: z.string().min(1) }),
  builtinTools: z.array(z.string().min(1)),
  hasBuiltin: z.boolean(),
  permissionCategory: CategorySchema,
});

export type CapabilityId = z.infer<typeof CapabilityIdSchema>;
export type CapabilityImpl = z.infer<typeof CapabilityImplSchema>;
export type CapabilityImplType = z.infer<typeof CapabilityImplTypeSchema>;
export type CapabilityChangedAuditDetail = z.infer<typeof CapabilityChangedAuditDetailSchema>;
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;

export const CAPABILITIES = [
  {
    id: "files.read",
    name: { zh: "读取文件", en: "Read files" },
    builtinTools: ["read_file", "list_dir", "find_files", "search_text"],
    hasBuiltin: true,
    permissionCategory: "read_file",
  },
  {
    id: "files.write",
    name: { zh: "写入文件", en: "Write files" },
    builtinTools: ["write_file", "edit_file", "apply_patch"],
    hasBuiltin: true,
    permissionCategory: "write_file",
  },
  {
    id: "web.fetch",
    name: { zh: "读取网页", en: "Fetch web pages" },
    builtinTools: ["web_fetch"],
    hasBuiltin: true,
    permissionCategory: "web",
  },
  {
    id: "web.search",
    name: { zh: "搜索网页", en: "Search the web" },
    builtinTools: ["web_search"],
    hasBuiltin: true,
    permissionCategory: "web",
  },
  {
    id: "browser",
    name: { zh: "浏览器", en: "Browser" },
    builtinTools: [
      "browser_network",
      "browser_request",
      "browser_secret",
      "browser_diagnostics",
      "browser_inspect",
      "browser_open",
      "browser_snapshot",
      "browser_click", // Both ref and screenshot-point forms stay in this capability.
      "browser_type",
      "browser_select",
      "browser_scroll",
      "browser_back",
      "browser_tabs",
      "browser_close",
      "browser_screenshot",
      "browser_wait",
      "browser_download_list",
      "browser_login",
    ],
    hasBuiltin: true,
    permissionCategory: "web",
  },
  {
    id: "calendar",
    name: { zh: "日历", en: "Calendar" },
    builtinTools: ["calendar_list_events", "calendar_create_event"],
    // Pi Bot's own Local calendar is an ordinary connection, like any calendar MCP (maintainers 2026-10-24).
    hasBuiltin: false,
    permissionCategory: "connector",
  },
  {
    id: "contacts",
    name: { zh: "通讯录", en: "Contacts" },
    builtinTools: ["contacts_count", "contacts_search", "contacts_create"],
    hasBuiltin: false,
    permissionCategory: "connector",
  },
] as const satisfies readonly CapabilityDefinition[];

/** Static model tools that remain outside the first unified-capability registry. */
export const GENERAL_TOOLS = [
  "office_inspect",
  "office_read",
  "office_create",
  "office_edit",
  "office_preview",
  "office_validate",
  "office_render",
  "office_capabilities",
  "office_convert",
  "office_template_fields",
  "office_template_fill",
  "knowledge_search",
  "knowledge_read",
  "tool_discover",
  "connection_needed",
  "connector_discover",
  "connector_call",
  "code_navigate",
  "code_outline",
  "code_symbols",
  "code_map",
  "review_start",
  "review_read",
  "delivery_evidence",
  "review_finding",
  "task_spawn",
  "task_status",
  "task_message",
  "task_cancel",
  "image_result",
  "read_messages",
  "skill_propose",
  "skill_read",
  "plugin_install",
  "check_command_propose",
  "send_file",
  "reveal_in_folder",
  "local_network",
  "assign_task",
  "ask_bot",
  "group_plan",
  "finish_task",
  "group_pause",
  "memory_add",
  "memory_update",
  "memory_remove",
  "memory_search",
  "memory_read",
  "personal_todo",
  "todo_list",
  "todo_update",
  "todo_pause",
  "ask_user",
  "run_command",
  "background_command",
  "write_stdin",
  "screenshot",
  "ui_tree",
  "ui_action",
  "pointer",
  "keys",
  "open_app",
  "open_file",
  "routine_propose",
  "routine_query",
  "routine_flag_attention",
  "phone_media",
  "phone_media_get",
  "phone_sms_code",
  "phone_calls",
  "phone_notifications",
  "execution_targets",
  "workplace_use_runner",
  "delegate_to_agent",
  // The default Pi's management and hand-off tools (offered only in its own direct chat).
  "team_list",
  "bot_manage",
  "group_manage",
  "send_to_bot",
  "send_to_group",
] as const;

export const CapabilitySourceSchema = z.enum(["default", "global", "group", "bot"]);
export const CapabilityScopeSchema = z.enum(["global", "group", "bot"]);
export const CapabilityAvailableSchema = z.strictObject({
  impl: CapabilityImplSchema,
  ready: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});
export const CapabilityItemSchema = z.strictObject({
  id: CapabilityIdSchema,
  impl: CapabilityImplSchema,
  source: CapabilitySourceSchema,
  available: z.array(CapabilityAvailableSchema).max(100),
});
export const CapabilityListParamsSchema = z.strictObject({
  botId: IdSchema.optional(),
  groupId: IdSchema.optional(),
});
export const CapabilitySetParamsSchema = z
  .strictObject({
    scope: CapabilityScopeSchema,
    scopeId: IdSchema.optional(),
    capabilityId: CapabilityIdSchema,
    impl: CapabilityImplSchema.nullable(),
  })
  .refine(
    (value) =>
      value.scope === "global" ? value.scopeId === undefined : value.scopeId !== undefined,
    "scopeId is required for bot/group and forbidden for global",
  );
export const CapabilityChangedSchema = z
  .strictObject({
    scope: CapabilityScopeSchema,
    scopeId: IdSchema.optional(),
    capabilityId: CapabilityIdSchema,
  })
  .refine(
    (value) =>
      value.scope === "global" ? value.scopeId === undefined : value.scopeId !== undefined,
    "scopeId is required for bot/group and forbidden for global",
  );

export const CapabilityMethods = {
  "capabilities.list": {
    params: CapabilityListParamsSchema,
    result: z.strictObject({ items: z.array(CapabilityItemSchema).max(CAPABILITIES.length) }),
  },
  "capabilities.set": {
    params: CapabilitySetParamsSchema,
    result: z.null(),
  },
} as const;
export const CapabilityEvents = {
  "capabilities.changed": CapabilityChangedSchema,
} as const;

export type CapabilitySource = z.infer<typeof CapabilitySourceSchema>;
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>;
export type CapabilityAvailable = z.infer<typeof CapabilityAvailableSchema>;
export type CapabilityItem = z.infer<typeof CapabilityItemSchema>;
export type CapabilityListParams = z.infer<typeof CapabilityListParamsSchema>;
export type CapabilitySetParams = z.infer<typeof CapabilitySetParamsSchema>;
export type CapabilityChanged = z.infer<typeof CapabilityChangedSchema>;
