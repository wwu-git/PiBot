/**
 * Narrow L4 implementation surface. Only `@pibot/orchestration` may import this entry; ordinary
 * capability packages use `@pibot/brain/kit` and cannot reach queue, retry, budget or workflow
 * orchestration internals.
 */

// One canonical file identity encoding for every recorder and checker (execution core/file-identity).
export {
  type FileIdentity,
  fileIdentity,
  matchesFileIdentity,
  sameFile,
} from "@pibot/execution/file-identity";
export { invalidAttachment } from "./conversations/attachments/attachment-files.ts";
export type { PreparedAttachments } from "./conversations/attachments/attachments.ts";
export { readManagedImage } from "./conversations/attachments/managed-image.ts";
export type { ChatService } from "./conversations/chat/chat.ts";
export type { ChatConfirmation } from "./conversations/chat/chat-confirmation.ts";
export { inspectChatRecovery } from "./conversations/chat/chat-recovery.ts";
export {
  quotedAttachmentIds,
  quotedPrompt,
  resolveMessageQuote,
} from "./conversations/chat/message-quote.ts";
export {
  type UserMessageDisplay,
  userMessageUsage,
} from "./conversations/chat/user-message-display.ts";
export { abortable } from "./core/abort.ts";
export { auditText, collaborationAuditFields } from "./core/audit-fields.ts";
export type { KernelRegisterRpc } from "./core/business-rpc.ts";
export { GroupToolError } from "./core/collaboration-tool-error.ts";
export { activeGroup, visibleGroupMessage } from "./core/group-access.ts";
export type { CollaborationPort, ToolRunContext } from "./core/local-types.ts";
export type { GroupOrchestrationPort, OrchestrationFactory } from "./core/orchestration.ts";
export { resolvePersonaLanguage } from "./core/personas/language.ts";
export type { BrainRedactor } from "./core/privacy.ts";
export { redactValue } from "./core/privacy.ts";
export { runPermissions } from "./core/run-permissions.ts";
export {
  continuedMode,
  intersectTaskPermissions,
  taskPermissionsNarrowed,
} from "./core/task-permissions.ts";
export type { LocalService } from "./local-service.ts";
export { GroupFilesService } from "./resources/groups/group-files.ts";
export { GroupFoldersService } from "./resources/groups/group-folders.ts";
export { GroupTopicFolderChoices } from "./resources/groups/group-topic-folder-choices.ts";
export { groupWorkplace } from "./resources/groups/group-workplace.ts";
export { skillContract } from "./resources/packages/skill-format.ts";
export {
  resolveRunWorkplace,
  topicWorkplaceSnapshot,
} from "./resources/workplaces/run-workplace.ts";
export { workspaceBoundary } from "./resources/workplaces/workspace-boundary.ts";
export {
  localWorkspaceFiles,
  type WorkspaceFileAccess,
  workspaceFiles,
} from "./resources/workplaces/workspace-files.ts";
export { DEFAULT_CODE_EXTENSIONS } from "./runtime/checks/auto-check-files.ts";
export type {
  ContinuationStop,
  Ledger,
  TakeResult,
} from "./runtime/continuation/continuation-budget.ts";
export {
  continuationKey,
  TASK_CONTINUATION_KIND,
  TASK_CONTINUATION_PREFIX,
} from "./runtime/continuation/continuation-keys.ts";
export {
  ACTIVE_TASK_STATUSES,
  CONTINUATION_ROOT_CAPACITY,
  CONTINUATION_TRIGGER_ATTEMPTS,
  TASK_TREE_MAX,
  TASK_TREE_PAGE,
} from "./runtime/continuation/continuation-limits.ts";
export {
  noteAttachmentDeliveryMissing,
  noteContinuationStopped,
} from "./runtime/continuation/continuation-notice.ts";
export { resultPrompt } from "./runtime/continuation/continuation-prompts.ts";
export { attachmentModelForBot, validateImageInputs } from "./runtime/media/image-preflight.ts";
export type { OfficePort } from "./runtime/media/office-port.ts";
export { canAskUser } from "./runtime/questions/user-question-tools.ts";
export { BudgetExceededError, BudgetService } from "./runtime/queue/budget-service.ts";
export { resumeRun } from "./runtime/queue/resume-service.ts";
export { retryRun } from "./runtime/queue/retry-service.ts";
export { RunCleanup } from "./runtime/queue/run-cleanup.ts";
export type { QueueInput, RunQueue } from "./runtime/queue/run-queue.ts";
export { groupPlanStartFailure } from "./runtime/tools/group-plan-failure.ts";
export { groupAuthorization } from "./runtime/tools/local-prepare.ts";
export { flattenInputIssues, inputIssueFacts } from "./runtime/tools/tool-input-issues.ts";
export { parseTool, type ToolInput } from "./runtime/tools/tools.ts";
export { checkDelivery } from "./runtime/workflows/delivery-check.ts";
export type { DeliverySources } from "./runtime/workflows/delivery-citations.ts";
export {
  boundedFeedback,
  citationFailureHint,
  citationIssueText,
  deliveryCorrectionText,
} from "./runtime/workflows/delivery-correction.ts";
export { deliveryFile } from "./runtime/workflows/delivery-path.ts";
export { DeliveryRun } from "./runtime/workflows/delivery-run.ts";
export {
  type DeliveryProvenance,
  deliverySources,
} from "./runtime/workflows/delivery-sources.ts";
export { replyCitationFacts } from "./runtime/workflows/reply-citations.ts";
export {
  outputBasename,
  requestedOutputNames,
} from "./runtime/workflows/requested-output-names.ts";
export { workflowLimits, workflowPriced } from "./runtime/workflows/workflow-budget.ts";
export {
  folderName,
  planFolderName,
  resolveWorkflowFolder,
  workflowOutputRoots,
} from "./runtime/workflows/workflow-folder.ts";
export { pipelineWorkflow } from "./runtime/workflows/workflow-pipeline.ts";
export {
  checkWorkflowInputs,
  prepareWorkflow,
  type WorkflowRun,
  type WorkflowSkill,
} from "./runtime/workflows/workflow-prepare.ts";
export { restoreWorkflow } from "./runtime/workflows/workflow-recovery.ts";
export type {
  GroupWorktreesPort,
  PlanStepWorkspace,
  StepKeep,
  StepMerge,
} from "./runtime/workspaces/port.ts";
