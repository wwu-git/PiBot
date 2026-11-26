// The brain kernel uses these wire contracts before product capabilities are composed.
import { z } from "zod";
import { ProxyAddressSchema } from "../app/network-proxy.ts";
import { AcpEvents, AcpMethods } from "../execution/independent-background.ts";
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
  DiagnosticsMethods,
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
  KernelInboxMethods,
  KnowledgeConfirmHostMethods,
  KnowledgeDetectHostMethods,
  KnowledgeOpenHostMethods,
  MAX_ATTACHMENTS,
  MAX_REPLY_ATTACHMENTS,
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
  RunEventMethods,
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
} from "./kernel-parts.ts";
import type { Params, Payload, Result } from "./peer.ts";

const name = z.string().min(1);
const count = z.number().int().nonnegative().safe();
const noParams = z.union([z.undefined(), z.strictObject({})]);
const ok = z.strictObject({ ok: z.literal(true) });

/** RPC events owned by the kernel. Capability events are composed by `@pibot/brain-app`. */
export const KernelEvents = {
  ...AcpEvents,
  ...CapabilityEvents,
  ...ContinuationEvents,
  ...GroupExecutionEvents,
  ...DraftEvents,
  ...ExecutionCollectionEvents,
  ...TaskExecutionEvents,
  ...AgentReviewEvents,
  ...ExecutionEvents,
  ...ChatAdditionEvents,
  ...ApprovalEvents,
  ...ToolCallEvents,
  ...PermissionEvents,
  ...RuntimeEvents,
  ...ChatEvents,
  ...BotEvents,
  ...GroupEvents,
  ...GroupPlanEvents,
  ...MemoryEvents,
  ...InboxEvents,
  ...SidebarEvents,
  ...GroupResourceEvents,
  ...ChatNoticeEvents,
  ...BackgroundCommandEvents,
  ...YoloEvents,
  ...AutoCheckEvents,
  ...BotHooksEvents,
  "ui.navigate": UiNavigationSchema,
  "chat.delta": z.strictObject({
    ...ChatRouteFields,
    runId: IdSchema,
    messageId: IdSchema,
    text: z.string(),
    newReply: z.boolean().optional(),
  }),
  "chat.attachments": z.strictObject({
    ...ChatRouteFields,
    runId: IdSchema,
    messageId: IdSchema,
    attachments: z.array(AttachmentSchema).max(MAX_REPLY_ATTACHMENTS),
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

function eventSchema<K extends keyof typeof KernelEvents>(method: K) {
  return z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal(method),
    params: z.strictObject({ seq: SequenceSchema.positive(), payload: KernelEvents[method] }),
  });
}

export const KernelEventEnvelopeSchema = z.discriminatedUnion("method", [
  eventSchema("acp.changed"),
  eventSchema("capabilities.changed"),
  eventSchema("botHooks.changed"),
  eventSchema("groups.execution.changed"),
  eventSchema("drafts.changed"),
  eventSchema("execution.collection.changed"),
  eventSchema("execution.changed"),
  eventSchema("execution.todo.changed"),
  eventSchema("execution.question.answered"),
  eventSchema("execution.task.changed"),
  eventSchema("review.execution.changed"),
  eventSchema("delivery.evidence.changed"),
  eventSchema("execution.budget.changed"),
  eventSchema("chat.message"),
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
  eventSchema("sidebar.changed"),
  eventSchema("runtime.health"),
  eventSchema("runtime.commands"),
  eventSchema("runtime.activeRuns"),
  eventSchema("runtime.liveActivity"),
  eventSchema("continuations.pending"),
  eventSchema("chat.notice"),
  eventSchema("backgroundCommands.changed"),
  eventSchema("conversations.yolo.changed"),
  eventSchema("autoCheck.changed"),
]);

/** RPC methods owned by the kernel. Capability methods are injected at the composition root. */
export const KernelMethods = {
  ...AcpMethods,
  ...CapabilityMethods,
  ...KernelInboxMethods,
  ...ContinuationMethods,
  ...PersonalTodoMethods,
  ...PreviewMethods,
  ...ChatRecoveryMethods,
  ...MessageActionMethods,
  ...GroupExecutionMethods,
  ...DraftMethods,
  ...ExecutionCollectionMethods,
  ...TaskExecutionMethods,
  ...ReviewExecutionMethods,
  ...DeliveryEvidenceMethods,
  ...ExecutionMethods,
  ...ChatAdditionMethods,
  ...WorkplaceMethods,
  ...ApprovalMethods,
  ...PermissionMethods,
  ...GrantMethods,
  ...AuditMethods,
  ...RunLogMethods,
  ...DiagnosticsMethods,
  ...RunEventMethods,
  ...FileMethods,
  ...TopicWorkplaceMethods,
  ...GroupFileMethods,
  ...GroupTopicMethods,
  ...RunsRetryMethods,
  ...RunsResumeMethods,
  ...RunReceiptMethods,
  ...RunRetentionMethods,
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
  ...GroupResourceMethods,
  ...ChatNoticeMethods,
  ...BackgroundCommandMethods,
  ...YoloMethods,
  ...AutoCheckMethods,
  ...BotHooksMethods,
  ...AppProfileMethods,
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
        workplace: FolderSelectionSchema.optional(),
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
      attachments: z.array(AttachmentSchema).max(10).optional(),
      conversationId: IdSchema.optional(),
      groupId: IdSchema.optional(),
      threadId: IdSchema.optional(),
    }),
  },
  ...ExternalImageMethods,
  "chat.attachment": { params: z.strictObject({ id: IdSchema }), result: ImageContentSchema },
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
    result: z.array(KernelEventEnvelopeSchema),
  },
} as const;

/** Host calls owned or consumed by the kernel. Capability-only host calls are injected outside. */
export const KernelHostMethods = {
  "host.updates.proxy": {
    params: z.strictObject({ url: ProxyAddressSchema.nullable().optional() }),
    result: z.null(),
  },
  ...OfficeHostMethods,
  ...ConnectorImportHostMethods,
  ...KnowledgeDetectHostMethods,
  ...KnowledgeOpenHostMethods,
  ...KnowledgeConfirmHostMethods,
  ...BrowserHostMethods,
  ...BrowserViewHostMethods,
  ...CredentialHostMethods,
  ...HostComputerMethods,
  ...HostComputerGuardMethods,
  "host.teams.pickFile": { params: noParams, result: z.string().min(1).max(32768).nullable() },
  "host.teams.read": {
    params: z.strictObject({ file: z.string().min(1).max(32768) }),
    result: z.string().max(Math.ceil(TEAM_ARCHIVE_MAX_BYTES / 3) * 4),
  },
  "host.teams.cancel": { params: noParams, result: z.null() },
  "host.teams.save": {
    params: z.union([
      z.strictObject({ template: TeamTemplateSchema }),
      z.strictObject({
        defaultName: z.string().min(1).max(200).optional(),
        archive: z
          .string()
          .min(1)
          .max(Math.ceil(TEAM_ARCHIVE_MAX_BYTES / 3) * 4),
      }),
    ]),
    result: z.strictObject({ saved: z.boolean() }),
  },
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
  "host.pickFile": {
    params: z.union([noParams, z.strictObject({ defaultPath: AbsolutePathSchema.optional() })]),
    result: AbsolutePathSchema.nullable(),
  },
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
  "host.attachments.stepThumbnail": {
    params: z.strictObject({
      botId: IdSchema,
      file: z.string().regex(/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/),
    }),
    result: ThumbnailContentSchema,
  },
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

export type KernelMethodParams = {
  [K in keyof typeof KernelMethods]: Params<typeof KernelMethods, K>;
};
export type KernelMethodResults = {
  [K in keyof typeof KernelMethods]: Result<typeof KernelMethods, K>;
};
export type KernelEventPayloads = {
  [K in keyof typeof KernelEvents]: Payload<typeof KernelEvents, K>;
};
export type KernelHostParams = {
  [K in keyof typeof KernelHostMethods]: Params<typeof KernelHostMethods, K>;
};
export type KernelHostResults = {
  [K in keyof typeof KernelHostMethods]: Result<typeof KernelHostMethods, K>;
};
