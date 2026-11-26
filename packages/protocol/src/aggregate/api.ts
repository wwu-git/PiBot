// Product peers add capability contracts to the shared brain kernel API.
import {
  BrowserDebugMethods,
  BrowserEvents,
  BrowserExtensionEvents,
  BrowserExtensionMethods,
  BrowserMethods,
} from "@pibot/browser-contract";
import { ComputerEvents, ComputerMethods } from "@pibot/computer-use-contract";
import {
  CredentialEvents,
  CredentialMethods,
  GoogleCompatEvents,
  GoogleCompatMethods,
  UserSecretEvents,
  UserSecretMethods,
} from "@pibot/credentials-contract";
import { ExternalAgentEvents, ExternalAgentMethods } from "@pibot/external-agents-contract";
import { ImageArtifactMethods } from "@pibot/images-contract";
import { ImportEvents, ImportMethods } from "@pibot/import-contract";
import { ModelProviderEvents, ModelProviderMethods } from "@pibot/models-contract";
import { OfficeMethods } from "@pibot/office-contract";
import {
  ConnectorActivityMethods,
  ConnectorAppMethods,
  ConnectorEvents,
  ConnectorImportMethods,
  ConnectorMethods,
  DiscoveryMethods,
  KnowledgeEvents,
  KnowledgeMethods,
} from "@pibot/plugins-contract";
import {
  AbsolutePathSchema,
  AgentErrorCodeSchema,
  AgentReviewEvents,
  AppProfileMethods,
  ApprovalEvents,
  ApprovalMethods,
  AttachmentInputSchema,
  AttachmentSchema,
  AuditMethods,
  AutoCheckEvents,
  AutoCheckMethods,
  BackgroundCommandEvents,
  BackgroundCommandMethods,
  BotEvents,
  BotHooksEvents,
  BotHooksMethods,
  BotMethods,
  BotPanelTabSchema,
  BotPatchSchema,
  BotSchema,
  BrowserHostMethods,
  BrowserViewHostMethods,
  base64Schema,
  CapabilityEvents,
  CapabilityMethods,
  ChatAdditionEvents,
  ChatAdditionMethods,
  ChatEvents,
  ChatMethods,
  ChatNoticeEvents,
  ChatNoticeMethods,
  ChatRecoveryMethods,
  ChatRouteFields,
  ChatTargetSchema,
  ConnectorImportHostMethods,
  ContinuationEvents,
  ContinuationMethods,
  ConversationRetryMethods,
  CredentialHostMethods,
  DeliveryEvidenceMethods,
  DraftEvents,
  DraftMethods,
  ExecutionCollectionEvents,
  ExecutionCollectionMethods,
  ExecutionEvents,
  ExecutionMethods,
  ExecutionModeSchema,
  ExternalImageMethods,
  FILE_LIMIT,
  FileMethods,
  FolderSelectionSchema,
  GrantMethods,
  GroupEvents,
  GroupExecutionEvents,
  GroupExecutionMethods,
  GroupFileMethods,
  GroupMethods,
  GroupPlanEvents,
  GroupPlanMethods,
  GroupResourceEvents,
  GroupResourceMethods,
  GroupTopicMethods,
  HostComputerGuardMethods,
  HostComputerMethods,
  IdSchema,
  ImageContentSchema,
  InboxCountMethods,
  InboxEvents,
  KernelEvents,
  KernelHostMethods,
  KernelMethods,
  KnowledgeDetectHostMethods,
  MAX_ATTACHMENTS,
  MemoryEvents,
  MemoryMethods,
  MessageActionMethods,
  MessageQuoteSchema,
  MessageSchema,
  NetworkProxyConfigSchema,
  NetworkProxySetSchema,
  NetworkProxyTestSchema,
  OfficeHostMethods,
  PermissionEvents,
  PermissionMethods,
  PersonalTodoMethods,
  PreviewMethods,
  ReviewExecutionMethods,
  RunLogMethods,
  RunReceiptMethods,
  RunRetentionMethods,
  RunsResumeMethods,
  RunsRetryMethods,
  RuntimeEvents,
  RuntimeMethods,
  SafeSecretSchema,
  SearchMethods,
  SequenceSchema,
  SettingsSchema,
  SidebarEvents,
  SidebarMethods,
  TaskExecutionEvents,
  TaskExecutionMethods,
  TEAM_ARCHIVE_MAX_BYTES,
  TeamTemplateSchema,
  ThumbnailContentSchema,
  ToolCallEvents,
  TopicMethods,
  TopicWorkplaceMethods,
  UiNavigationSchema,
  WebUrlSchema,
  WorkplaceMethods,
  YoloEvents,
  YoloMethods,
} from "@pibot/protocol-base";
import {
  EndpointEvents,
  EndpointMethods,
  RemoteEvents,
  RemoteHostMethods,
  RemoteMethods,
} from "@pibot/remote-contract";
import {
  RoutineControlSchema,
  RoutineEvents,
  RoutineHostMethods,
  RoutineMethods,
} from "@pibot/routines-contract";
import {
  SkillEvents,
  SkillLinkEvents,
  SkillLinkMethods,
  SkillMethods,
  TeachEvents,
  TeachMethods,
  WorkflowMethods,
} from "@pibot/skills-contract";
import {
  BuiltinMethods,
  PiDispatchEvents,
  PiDispatchMethods,
  RoleCatalogMethods,
  TeamMethods,
} from "@pibot/teams-contract";
import {
  ChangesEvents,
  ChangesMethods,
  FileCheckpointMethods,
  ManagedWorktreeMethods,
} from "@pibot/workspaces-contract";
import { z } from "zod";
import { InboxMethods } from "./inbox.ts";

export * from "@pibot/protocol-base";
export * from "@pibot/protocol-base";

const name = z.string().min(1);
const count = z.number().int().nonnegative().safe();

export const Events = {
  ...KernelEvents,
  ...ImportEvents,
  ...ExternalAgentEvents,
  ...CapabilityEvents,
  ...RemoteEvents,
  ...EndpointEvents,
  ...ContinuationEvents,
  ...GroupExecutionEvents,
  ...ConnectorEvents,
  ...KnowledgeEvents,
  ...DraftEvents,
  ...ExecutionCollectionEvents,
  ...TaskExecutionEvents,
  ...AgentReviewEvents,
  ...ExecutionEvents,
  ...ChatAdditionEvents,
  ...ApprovalEvents,
  ...ToolCallEvents,
  ...PermissionEvents,
  ...RoutineEvents,
  ...RuntimeEvents,
  ...ChatEvents,
  ...BotEvents,
  ...GroupEvents,
  ...GroupPlanEvents,
  ...MemoryEvents,
  ...InboxEvents,
  ...SidebarEvents,
  ...ModelProviderEvents,
  ...ComputerEvents,
  ...BrowserEvents,
  ...BrowserExtensionEvents,
  ...SkillEvents,
  ...SkillLinkEvents,
  ...GroupResourceEvents,
  ...TeachEvents,
  ...ChangesEvents,
  ...ChatNoticeEvents,
  ...CredentialEvents,
  ...UserSecretEvents,
  ...BackgroundCommandEvents,
  ...YoloEvents,
  ...GoogleCompatEvents,
  ...AutoCheckEvents,
  ...BotHooksEvents,
  ...PiDispatchEvents,
  "ui.navigate": UiNavigationSchema,
  "chat.delta": z.strictObject({
    ...ChatRouteFields,
    runId: IdSchema,
    messageId: IdSchema,
    text: z.string(),
    newReply: z.boolean().optional(),
  }),
  "chat.done": z.strictObject({
    ...ChatRouteFields,
    runId: IdSchema,
    messageId: IdSchema,
    usage: z.json().optional(),
    stopReason: name,
  }),
  "chat.error": z.strictObject({
    ...ChatRouteFields,
    runId: IdSchema,
    messageId: IdSchema,
    code: AgentErrorCodeSchema,
    message: z.string(),
  }),
  "settings.changed": SettingsSchema,
  "network.changed": NetworkProxyConfigSchema,
  "brain.status": z.strictObject({ state: z.enum(["starting", "ready", "restarting", "failed"]) }),
} as const;

function eventSchema<K extends keyof typeof Events>(method: K) {
  return z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal(method),
    params: z.strictObject({ seq: SequenceSchema.positive(), payload: Events[method] }),
  });
}
export const EventEnvelopeSchema = z.discriminatedUnion("method", [
  eventSchema("acp.changed"),
  eventSchema("import.progress"),
  eventSchema("capabilities.changed"),
  eventSchema("botHooks.changed"),
  eventSchema("teams.dispatch.changed"),
  eventSchema("devices.changed"),
  eventSchema("endpoints.changed"),
  eventSchema("remote.state"),
  eventSchema("remote.offline.changed"),
  eventSchema("remote.interactive"),
  eventSchema("groups.execution.changed"),
  eventSchema("plugins.changed"),
  eventSchema("connectors.changed"),
  eventSchema("drafts.changed"),
  eventSchema("externalAgents.detected"),
  eventSchema("externalAgents.optionsChanged"),
  eventSchema("externalAgents.statusChanged"),
  eventSchema("connectors.toolsChanged"),
  eventSchema("connectors.operationChanged"),
  eventSchema("knowledge.changed"),
  eventSchema("execution.collection.changed"),
  eventSchema("execution.changed"),
  eventSchema("execution.todo.changed"),
  eventSchema("execution.question.answered"),
  eventSchema("execution.task.changed"),
  eventSchema("review.execution.changed"),
  eventSchema("delivery.evidence.changed"),
  eventSchema("execution.budget.changed"),
  eventSchema("chat.message"),
  eventSchema("routines.changed"),
  eventSchema("routine.run"),
  eventSchema("power.state"),
  eventSchema("ui.navigate"),
  eventSchema("approval.requested"),
  eventSchema("approval.resolved"),
  eventSchema("chat.tool"),
  eventSchema("chat.activity"),
  eventSchema("permissions.changed"),
  eventSchema("chat.delta"),
  eventSchema("chat.status"),
  eventSchema("chat.done"),
  eventSchema("chat.attachments"),
  eventSchema("chat.error"),
  eventSchema("settings.changed"),
  eventSchema("network.changed"),
  eventSchema("providers.changed"),
  eventSchema("brain.status"),
  eventSchema("bots.changed"),
  eventSchema("groups.changed"),
  eventSchema("groups.plan.changed"),
  eventSchema("group.task"),
  eventSchema("group.paused"),
  eventSchema("memory.sortProgress"),
  eventSchema("memory.dream.finished"),
  eventSchema("memory.changed"),
  eventSchema("memory.status.changed"),
  eventSchema("groups.resources.changed"),
  eventSchema("inbox.changed"),
  eventSchema("providers.loginState"),
  eventSchema("providers.loginStep"),
  eventSchema("sidebar.changed"),
  eventSchema("runtime.health"),
  eventSchema("runtime.commands"),
  eventSchema("runtime.activeRuns"),
  eventSchema("runtime.liveActivity"),
  eventSchema("continuations.pending"),
  eventSchema("computer.step"),
  eventSchema("computer.state"),
  eventSchema("browser.state"),
  eventSchema("skills.changed"),
  eventSchema("skills.importProgress"),
  eventSchema("skills.linkProgress"),
  eventSchema("skills.runtimeProgress"),
  eventSchema("teach.progress"),
  eventSchema("changes.changed"),
  eventSchema("chat.notice"),
  eventSchema("credentials.changed"),
  eventSchema("secrets.changed"),
  eventSchema("credentials.capture"),
  eventSchema("backgroundCommands.changed"),
  eventSchema("foregroundCommands.changed"),
  eventSchema("conversations.yolo.changed"),
  eventSchema("browser.googleCompat.changed"),
  eventSchema("browserExtension.changed"),
  eventSchema("autoCheck.changed"),
]);
// No-argument calls omit params on the wire; an explicit empty object is also valid.
const noParams = z.union([z.undefined(), z.strictObject({})]);
const ok = z.strictObject({ ok: z.literal(true) });
// Desktop / app-level methods defined here; capability and kernel method tables are spread in.
const AppMethods = {
  "app.getInfo": {
    params: noParams,
    result: z.strictObject({
      version: name,
      platform: z.enum(["darwin", "win32", "linux"]),
      dataDir: name,
      piVersion: name,
    }),
  },
  "network.getConfig": { params: noParams, result: NetworkProxyConfigSchema },
  "network.setConfig": { params: NetworkProxySetSchema, result: NetworkProxyConfigSchema },
  "network.test": { params: noParams, result: NetworkProxyTestSchema },
  "settings.get": { params: noParams, result: SettingsSchema },
  "settings.set": {
    params: SettingsSchema.partial()
      .extend({ initializeMainBot: z.literal(true).optional() })
      .refine((params) => !params.initializeMainBot || !!params.defaultModel),
    result: SettingsSchema,
  },
  "bots.list": {
    params: z.union([
      noParams,
      z.strictObject({
        before: IdSchema.optional(),
        limit: count.positive().max(200).optional(),
        includeArchived: z.boolean().optional(),
      }),
    ]),
    result: z.array(BotSchema),
  },
  "bots.update": {
    params: BotPatchSchema.extend({
      botId: IdSchema,
      /** Optional compare-and-set for a user-reviewed norms replacement. */
      expectedNorms: z.string().max(20000).optional(),
    }),
    result: BotSchema,
  },
  "chat.history": {
    params: z
      .strictObject({
        botId: IdSchema.optional(),
        topicId: IdSchema.optional(),
        groupId: IdSchema.optional(),
        threadId: IdSchema.optional(),
        before: IdSchema.optional(),
        limit: count.positive().max(200).optional(),
      })
      .refine((p) => ChatTargetSchema.safeParse(p).success, "Invalid chat target"),
    result: z.array(MessageSchema),
  },
  "chat.send": {
    params: z
      .object({
        botId: IdSchema.optional(),
        topicId: IdSchema.optional(),
        clientMessageId: IdSchema.optional(),
        newTopic: z.literal(true).optional(),
        initialMode: ExecutionModeSchema.optional(),
        replyToMessageId: IdSchema.optional(),
        groupId: IdSchema.optional(),
        threadId: IdSchema.optional(),
        text: z.string().max(100_000),
        attachments: z.array(AttachmentInputSchema).max(MAX_ATTACHMENTS).optional(),
        attachmentIds: z.array(IdSchema).max(MAX_ATTACHMENTS).optional(),
        /** The folders a new topic starts with (chosen on the draft); only with `newTopic`. */
        workplace: FolderSelectionSchema.optional(),
        /**
         * Group only: Bots the user picked from the @ list, in text order. The brain resolves each
         * `@name` in the text to these IDs first, so a mention never depends on the name alone.
         */
        mentions: z.array(IdSchema).max(6).optional(),
      })
      .strict()
      .refine(
        (p) =>
          ChatTargetSchema.safeParse(p).success &&
          (!p.newTopic || (!!p.botId && !p.topicId && !p.groupId && !p.threadId)) &&
          (!p.workplace || !!p.newTopic) &&
          (!p.initialMode || !!p.newTopic) &&
          (!p.mentions || (!!p.groupId && !p.threadId)),
        "Invalid chat target",
      )
      .refine(
        (p) =>
          (p.attachments?.length ?? 0) + (p.attachmentIds?.length ?? 0) <= MAX_ATTACHMENTS &&
          (!!p.text.trim() || !!p.attachments?.length || !!p.attachmentIds?.length),
        "Empty message or too many attachments",
      ),
    result: z.strictObject({
      runs: z
        .array(z.strictObject({ botId: IdSchema, runId: IdSchema, assistantMessageId: IdSchema }))
        .max(6)
        .optional(),
      quote: MessageQuoteSchema.optional(),
      userMessageId: IdSchema,
      assistantMessageId: IdSchema,
      runId: IdSchema,
      attachments: z.array(AttachmentSchema).max(MAX_ATTACHMENTS).optional(),
      conversationId: IdSchema.optional(),
      groupId: IdSchema.optional(),
      threadId: IdSchema.optional(),
    }),
  },
  "chat.attachment": { params: z.strictObject({ id: IdSchema }), result: ImageContentSchema },
  // A small cached thumbnail, so the renderer never decodes or validates the full image to show it.
  "chat.attachmentPreview": {
    params: z.strictObject({ id: IdSchema }),
    result: z.union([ThumbnailContentSchema, ImageContentSchema]),
  },
  "chat.openAttachment": { params: z.strictObject({ id: IdSchema }), result: ok },
  "chat.revealAttachment": {
    params: z.strictObject({ id: IdSchema, messageId: IdSchema }),
    result: ok,
  },
  /** The folder of the files a reply left out at the per-reply limit (from the brain's record). */
  "chat.revealOverflow": { params: z.strictObject({ messageId: IdSchema }), result: ok },
  "chat.abort": { params: z.strictObject({ runId: IdSchema }), result: ok },
  "events.resume": {
    params: z.strictObject({ afterSeq: SequenceSchema }),
    result: z.array(EventEnvelopeSchema),
  },
} as const;
// TS7056: the merged literal type is too large to serialize into declarations, so the
// annotation names each table instead of expanding every method signature.
// Kernel-owned tables below already inherit their method types from KernelMethods;
// intersecting a second copy makes TypeScript recursively expand identical Zod schemas.
export const Methods: // Spread order lets InboxMethods replace the kernel's narrower inbox.list; the
// intersection must drop it the same way or the two result types conflict.
Omit<typeof KernelMethods, keyof typeof InboxMethods | keyof typeof AppMethods> &
  typeof EndpointMethods &
  typeof RemoteMethods &
  typeof InboxMethods &
  typeof OfficeMethods &
  typeof ImportMethods &
  typeof ConnectorMethods &
  typeof ConnectorAppMethods &
  typeof ConnectorImportMethods &
  typeof ConnectorActivityMethods &
  typeof DiscoveryMethods &
  typeof KnowledgeMethods &
  typeof BrowserDebugMethods &
  typeof ManagedWorktreeMethods &
  typeof FileCheckpointMethods &
  typeof ImageArtifactMethods &
  typeof ExternalAgentMethods &
  typeof RoutineMethods &
  typeof ModelProviderMethods &
  typeof TeamMethods &
  typeof PiDispatchMethods &
  typeof ComputerMethods &
  typeof BrowserMethods &
  typeof BrowserExtensionMethods &
  typeof SkillMethods &
  typeof SkillLinkMethods &
  typeof WorkflowMethods &
  typeof TeachMethods &
  typeof ChangesMethods &
  typeof CredentialMethods &
  typeof UserSecretMethods &
  typeof GoogleCompatMethods &
  typeof BuiltinMethods &
  typeof RoleCatalogMethods &
  typeof AppMethods = {
  ...KernelMethods,
  ...CapabilityMethods,
  ...RemoteMethods,
  ...EndpointMethods,
  ...InboxMethods,
  ...ContinuationMethods,
  ...PersonalTodoMethods,
  ...OfficeMethods,
  ...ImportMethods,
  ...PreviewMethods,
  ...ChatRecoveryMethods,
  ...MessageActionMethods,
  ...GroupExecutionMethods,
  ...ConnectorMethods,
  ...ConnectorAppMethods,
  ...ConnectorImportMethods,
  ...ConnectorActivityMethods,
  ...DiscoveryMethods,
  ...KnowledgeMethods,
  ...DraftMethods,
  ...ExecutionCollectionMethods,
  ...BrowserDebugMethods,
  ...TaskExecutionMethods,
  ...ReviewExecutionMethods,
  ...DeliveryEvidenceMethods,
  ...ManagedWorktreeMethods,
  ...FileCheckpointMethods,
  ...ExecutionMethods,
  ...ImageArtifactMethods,
  ...ExternalAgentMethods,
  ...ChatAdditionMethods,
  ...WorkplaceMethods,
  ...ApprovalMethods,
  ...PermissionMethods,
  ...GrantMethods,
  ...AuditMethods,
  ...RunLogMethods,
  ...RunRetentionMethods,
  ...FileMethods,
  ...RoutineMethods,
  ...TopicWorkplaceMethods,
  ...GroupFileMethods,
  ...GroupTopicMethods,
  ...RunsRetryMethods,
  ...RunsResumeMethods,
  ...RunReceiptMethods,
  ...RuntimeMethods,
  ...BotMethods,
  ...TopicMethods,
  ...GroupMethods,
  ...GroupPlanMethods,
  ...ChatMethods,
  ...ConversationRetryMethods,
  ...MemoryMethods,
  ...InboxCountMethods,
  ...SidebarMethods,
  ...SearchMethods,
  ...ModelProviderMethods,
  ...TeamMethods,
  ...PiDispatchMethods,
  ...ComputerMethods,
  ...BrowserMethods,
  ...BrowserExtensionMethods,
  ...SkillMethods,
  ...SkillLinkMethods,
  ...WorkflowMethods,
  ...GroupResourceMethods,
  ...TeachMethods,
  ...ChangesMethods,
  ...ChatNoticeMethods,
  ...CredentialMethods,
  ...UserSecretMethods,
  ...BackgroundCommandMethods,
  ...YoloMethods,
  ...GoogleCompatMethods,
  ...BuiltinMethods,
  ...RoleCatalogMethods,
  ...AutoCheckMethods,
  ...BotHooksMethods,
  ...AppProfileMethods,
  ...ExternalImageMethods,
  ...AppMethods,
};

// This table is used exclusively on the brain/main port, never exposed to renderer.
export const HostMethods = {
  ...KernelHostMethods,
  ...RemoteHostMethods,
  ...OfficeHostMethods,
  ...ConnectorImportHostMethods,
  ...KnowledgeDetectHostMethods,
  ...RoutineHostMethods,
  ...BrowserHostMethods,
  ...BrowserViewHostMethods,
  ...CredentialHostMethods,
  ...HostComputerMethods,
  ...HostComputerGuardMethods,
  "host.teams.pickFile": { params: noParams, result: z.string().min(1).max(32768).nullable() },
  // The picked file's raw bytes as base64 (a version-3 zip or a version-1/2 JSON file).
  "host.teams.read": {
    params: z.strictObject({ file: z.string().min(1).max(32768) }),
    result: z.string().max(Math.ceil(TEAM_ARCHIVE_MAX_BYTES / 3) * 4),
  },
  "host.teams.cancel": { params: noParams, result: z.null() },
  "host.teams.save": {
    // `archive`: a version-3 zip built and redacted by brain, base64.
    params: z.union([
      z.strictObject({ template: TeamTemplateSchema }),
      z.strictObject({
        archive: z
          .string()
          .min(1)
          .max(Math.ceil(TEAM_ARCHIVE_MAX_BYTES / 3) * 4),
        defaultName: z.string().min(1).max(200).optional(),
      }),
    ]),
    result: z.strictObject({ saved: z.boolean() }),
  },
  // `create` opens a dialog that lets the user make a new folder and pick it. Must match
  // protocol-base's definition: this one is what the host validates against.
  "host.pickFolder": {
    params: z.union([
      noParams,
      z.strictObject({
        create: z.boolean().optional(),
        defaultPath: AbsolutePathSchema.optional(),
      }),
    ]),
    result: AbsolutePathSchema.nullable(),
  },
  /** Arbitrary workflow file input; the renderer receives only the selected path. */
  "host.pickFile": {
    params: z.union([noParams, z.strictObject({ defaultPath: AbsolutePathSchema.optional() })]),
    result: AbsolutePathSchema.nullable(),
  },
  // One SKILL.md (its folder's skill) or a .zip; brain reads and checks the file itself.
  "host.skills.pickFile": { params: noParams, result: AbsolutePathSchema.nullable() },
  "host.memoryDreamActivity": {
    params: noParams,
    result: z
      .strictObject({
        idleSeconds: z.number().nonnegative(),
        supply: z.enum(["ac", "battery", "unknown"]),
      })
      .nullable(),
  },
  "host.notify": {
    params: z.strictObject({
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(2000),
      botId: IdSchema,
      tab: BotPanelTabSchema.optional(),
      conversationId: IdSchema.optional(),
      messageId: IdSchema.optional(),
      routineRunId: IdSchema.optional(),
    }),
    result: z.strictObject({
      shown: z.boolean(),
      reason: z.enum(["foreground", "unsupported", "failed"]).optional(),
    }),
  },
  "host.openPath": {
    params: z.strictObject({
      path: name.max(32768),
      allowedRoots: z.array(name.max(32768)).min(1).max(202),
    }),
    result: z.null(),
  },
  "host.revealPath": {
    params: z.strictObject({
      path: name.max(32768),
      allowedRoots: z.array(name.max(32768)).min(1).max(202),
    }),
    result: z.null(),
  },
  "host.attachments.image": {
    params: ImageContentSchema,
    result: z.strictObject({
      image: ImageContentSchema,
      width: count.positive(),
      height: count.positive(),
    }),
  },
  "host.attachments.pdf": {
    params: z.strictObject({ data: base64Schema(FILE_LIMIT), pages: count.positive().max(10) }),
    result: z.strictObject({
      images: z.array(ImageContentSchema).min(1).max(10),
      totalPages: count.positive(),
    }),
  },
  "host.attachments.thumbnail": {
    params: z.strictObject({
      botId: IdSchema,
      file: z.string().regex(/^[0-9a-f-]{36}\.[a-z0-9]+$/),
    }),
    result: ThumbnailContentSchema,
  },
  // Thumbnail of an operation step's screenshot under bots/<id>/computer/screenshots.
  "host.attachments.stepThumbnail": {
    params: z.strictObject({
      botId: IdSchema,
      file: z.string().regex(/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/),
    }),
    result: ThumbnailContentSchema,
  },
  // Thumbnail of an image-diff side brain staged under bots/<id>/changes/previews.
  "host.attachments.changeThumbnail": {
    params: z.strictObject({
      botId: IdSchema,
      file: z.string().regex(/^[0-9a-f-]{36}\.(?:png|jpg|gif|webp|bmp|ico|tiff|avif|heic)$/),
    }),
    result: ThumbnailContentSchema,
  },
  "host.attachments.open": {
    params: z.strictObject({
      botId: IdSchema,
      file: z.string().regex(/^[0-9a-f-]{36}\.[a-z0-9]+$/),
    }),
    result: z.null(),
  },
  "host.secrets.isAvailable": { params: noParams, result: z.boolean() },
  "host.secrets.encrypt": {
    params: z.strictObject({ plain: SafeSecretSchema }),
    result: z.instanceof(Uint8Array),
  },
  "host.secrets.decrypt": {
    params: z.strictObject({ cipher: z.instanceof(Uint8Array) }),
    result: z.string(),
  },
  "host.env.detect": { params: noParams, result: z.array(name) },
  "host.env.read": { params: z.strictObject({ name }), result: z.string().nullable() },
  "host.openExternal": { params: z.strictObject({ url: WebUrlSchema }), result: z.null() },
  "host.setLoginItem": { params: z.strictObject({ openAtLogin: z.boolean() }), result: z.null() },
} as const;

import type { Params, Payload, Result } from "@pibot/protocol-base";

export type { EventTable, MethodTable, Params, Payload, Result } from "@pibot/protocol-base";
export type MethodParams = { [K in keyof typeof Methods]: Params<typeof Methods, K> };
export type MethodResults = { [K in keyof typeof Methods]: Result<typeof Methods, K> };
export type EventPayloads = { [K in keyof typeof Events]: Payload<typeof Events, K> };
export type HostParams = { [K in keyof typeof HostMethods]: Params<typeof HostMethods, K> };
export type HostResults = { [K in keyof typeof HostMethods]: Result<typeof HostMethods, K> };
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/**
 * Brain control messages from the desktop host. The kernel's own controls plus the ones capabilities
 * contribute (routines: power events), composed here so kernel schemas never import a capability.
 */
export const BrainControlSchema = z.discriminatedUnion("type", [
  ...RoutineControlSchema.options,
  z.strictObject({ type: z.literal("stop") }),
  z.strictObject({ type: z.literal("close-hint-shown") }),
  z.strictObject({ type: z.literal("login-item-state"), openAtLogin: z.boolean() }),
  z.strictObject({ type: z.literal("navigate"), target: UiNavigationSchema }),
]);
