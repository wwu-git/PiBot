/**
 * The brain kernel's public surface for capability packages (`@pibot/brain/kit`). A capability
 * imports kernel services, types and helpers only from here, so this file is the complete list of
 * what capabilities depend on. Add to it deliberately; everything else in the kernel stays private.
 */

// One canonical file identity encoding for every recorder and checker (execution core/file-identity).
export {
  type FileIdentity,
  fileIdentity,
  matchesFileIdentity,
  sameFile,
} from "@pibot/execution/file-identity";
export {
  attachmentDirectory,
  checkedImage,
  invalidAttachment,
  storedAttachmentFile,
} from "./conversations/attachments/attachment-files.ts";
export { attachmentSource } from "./conversations/attachments/attachment-source.ts";
export type { PreparedAttachments } from "./conversations/attachments/attachments.ts";
export { AttachmentService } from "./conversations/attachments/attachments.ts";
export { imageDimensions } from "./conversations/attachments/image-dimensions.ts";
export { readManagedImage } from "./conversations/attachments/managed-image.ts";
export { isOutputDeliverable } from "./conversations/attachments/output-path.ts";
export {
  type PreviewSourceDeps,
  type PreviewSourceFile,
  previewSource,
  previewSourceError,
} from "./conversations/attachments/preview-source.ts";
export { type SendFilesInput, sendFiles } from "./conversations/attachments/send-files.ts";
export {
  avatarColors,
  avatarEyes,
  avatarShapes,
  unusedAvatar,
} from "./conversations/bots/avatars.ts";
export type { ChatService } from "./conversations/chat/chat.ts";
export { siteOf } from "./conversations/chat/chat-notices.ts";
export { ChatReplies } from "./conversations/chat/chat-replies.ts";
export { abortable } from "./core/abort.ts";
export { ApprovalChangedError } from "./core/approvals.ts";
export { auditProviderName, auditText } from "./core/audit-fields.ts";
export { auditAutoAllow } from "./core/auto-allow.ts";
export type { RegisterRpc, RpcRequestContext } from "./core/business-rpc.ts";
export type {
  BrainCapability,
  CapabilityContext,
  ToolCardDescriber,
  ToolExecutor,
  UnattendedAuthorization,
  UnattendedSendIntent,
  UnattendedSendLedger,
} from "./core/capability.ts";
export {
  type CapabilityResolver,
  defaultCapabilityResolver,
} from "./core/capability-resolver.ts";
export {
  cloudScope,
  EncryptedAuth,
  registerSecretLeaves,
  registerSecretText,
} from "./core/encrypted-auth.ts";
export { endpoint } from "./core/endpoint.ts";
export { activeGroup, requireGroupMember, visibleGroupMessage } from "./core/group-access.ts";
export type { HostCall } from "./core/host-call.ts";
export type { CollaborationPort, PreparedTool, ToolRunContext } from "./core/local-types.ts";
export { mainDirectRun } from "./core/main-direct.ts";
export type {
  ExecutionCleanupPort,
  ExecutionPort,
  GroupOrchestrationDependencies,
  GroupOrchestrationPort,
  OrchestrationFactory,
  TaskAuthorityPort,
  TaskRuntimePort,
} from "./core/orchestration.ts";
export { fallbackPersona } from "./core/personas/bot.ts";
export { resolvePersonaLanguage } from "./core/personas/language.ts";
export { phoneOfflineRule, phoneSystemPrompt } from "./core/personas/phone.ts";
export type { BrainRedactor } from "./core/privacy.ts";
export { redactValue } from "./core/privacy.ts";
export {
  explainRunScope,
  runPermissionScope,
  runPermissionSources,
  runPermissions,
} from "./core/run-permissions.ts";
export {
  continuedMode,
  intersectTaskPermissions,
  taskPermissionsNarrowed,
} from "./core/task-permissions.ts";
export { ToolTimer } from "./core/tool-timing.ts";
export { allowedByYolo, auditYolo, runYolo } from "./core/yolo.ts";
export { writeZip } from "./core/zip-write.ts";
export type { BrainHost } from "./index.ts";
export type { LocalService } from "./local-service.ts";
export * from "./resources/packages/skill-format.ts";
export * from "./resources/packages/skill-package.ts";
export * from "./resources/packages/skill-runtime.ts";
export * from "./resources/packages/skill-scan.ts";
export {
  folderEntries,
  type SkillSourceFile,
  zipEntries,
} from "./resources/packages/skill-source.ts";
export * from "./resources/packages/skill-zip.ts";
export { FolderLockError } from "./resources/workplaces/folder-write-lock.ts";
export {
  isWorkplaceUnavailable,
  resolveRunWorkplace,
  topicWorkplaceSnapshot,
  unavailableErrnos,
  unavailableExecCodes,
  withWorkplaceErrors,
  workplaceUnavailableReason,
} from "./resources/workplaces/run-workplace.ts";
export { workspaceBoundary } from "./resources/workplaces/workspace-boundary.ts";
export {
  localWorkspaceFiles,
  type WorkspaceFileAccess,
  workspaceFiles,
} from "./resources/workplaces/workspace-files.ts";
export { normalizeAddress } from "./runtime/browser/address.ts";
export type * from "./runtime/browser/port.ts";
export { defaultAutoCheckForNewBot } from "./runtime/checks/auto-check.ts";
export { computerTarget, isComputerTool } from "./runtime/computer/computer-grants-policy.ts";
export type { ComputerInput } from "./runtime/computer/input.ts";
export type {
  ComputerPrepared,
  ComputerRunContext,
  ComputerRuntime,
  ComputerStepInput,
  ComputerToolRun,
  ComputerUsePort,
} from "./runtime/computer/port.ts";
export type {
  CredentialServices,
  CredentialsPort,
  GoogleCompatPort,
  SecretUse,
  UserSecretsPort,
} from "./runtime/credentials/port.ts";
export {
  askForUnmappedAction,
  authorizeDelegatedAction,
  type DelegatedDecision,
} from "./runtime/external-agents/delegated-authorization.ts";
export type { ExternalAgentRunHost, ExternalAgentsPort } from "./runtime/external-agents/port.ts";
export { requireImageModel } from "./runtime/media/image-preflight.ts";
export type { ImageRunHost, ImagesPort } from "./runtime/media/images-port.ts";
export type { BinaryToolRun, ExtractedOffice, OfficePort } from "./runtime/media/office-port.ts";
export type {
  GroupMemoryPort,
  MemoryPort,
  MemoryPromptRequest,
  MemoryRecallObservation,
  MemoryRecallRequest,
  PersonalMemoryPort,
} from "./runtime/memory/port.ts";
export { memoryProjectPath } from "./runtime/memory/project.ts";
export type { ModelProvidersPort, ModelSettingsPort } from "./runtime/models/port.ts";
export { writeReviewedProjectNotes } from "./runtime/notes/reviewed-project-notes.ts";
export type { WakeSource } from "./runtime/queue/brain-sleep.ts";
export type { ChatRun } from "./runtime/queue/chat-run.ts";
export type { QueueInput, RunQueue } from "./runtime/queue/run-queue.ts";
export { reviewerChoices } from "./runtime/review/review-reviewer.ts";
export { businessConfirmation } from "./runtime/tools/business-confirmation.ts";
export { validateConnectorArgs } from "./runtime/tools/connectors/connector-schema.ts";
export {
  type ConnectorCallInput,
  type ConnectorDiscoverInput,
  type ConnectorReadHost,
  ConnectorToolError,
  connectorDigest,
  dispatchReadConnector,
  type PreparedConnector,
} from "./runtime/tools/connectors/connector-tools.ts";
export type { ConnectorsPort } from "./runtime/tools/connectors/port.ts";
export {
  authorizationSnapshot,
  authorizationUnchanged,
  groupAuthorization,
  prepareTool,
  toolFingerprint,
} from "./runtime/tools/local-prepare.ts";
export type {
  BuiltinMethodsPort,
  PluginSkillInput,
  PluginSkillsHost,
  SkillConfirmation,
  SkillInventoryItem,
  SkillProposalContext,
  SkillsPort,
} from "./runtime/tools/skills/port.ts";
export { blockedReason } from "./runtime/tools/tools.ts";
export { RoutineClock } from "./runtime/unattended/clock.ts";
export { connectorPreauthIssue } from "./runtime/unattended/connector-preauth.ts";
export { preauthOperation, routineOperationHash } from "./runtime/unattended/operation.ts";
export {
  explicitWorkplace,
  routineSelectionFor,
  routineWorkplace,
} from "./runtime/unattended/workplace.ts";
export { migratedOutputPath, migrateLegacyOutputs } from "./runtime/workflows/output-migration.ts";
export {
  LEGACY_OUTPUT_ROOTS,
  OUTPUT_ROOT_SEGMENTS,
} from "./runtime/workflows/workflow-folder.ts";
export {
  type PreparedWorkflow,
  prepareWorkflow,
  type WorkflowRun,
  type WorkflowSkill,
} from "./runtime/workflows/workflow-prepare.ts";
export {
  selectedSkillName,
  skillReferenceNotice,
  skillReferenceText,
  workflowUserText,
} from "./runtime/workflows/workflow-text.ts";
export type {
  WorkspaceChat,
  WorkspaceGroups,
  WorkspaceLocal,
  WorkspaceTopics,
} from "./runtime/workspaces/host.ts";
export type {
  ManagedBranchConfigurationHandle,
  ManagedBranchConfigurationPort,
  ManagedConfigOwnerProof,
} from "./runtime/workspaces/managed-config-port.ts";
export type {
  BeforeWrite,
  ChangesPort,
  ChangesRoot,
  ChangesScope,
  PlanStepWorkspace,
  RunChangesPort,
  StepKeep,
  StepMerge,
  StepWorkspaceFallback,
  TurnFileSource,
  WorkspaceServices,
  WorktreeReceipt,
} from "./runtime/workspaces/port.ts";
