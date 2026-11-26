export * from "./bots/bot-cleanup.ts";
export * from "./bots/bot-hooks.ts";
export * from "./bots/memory.ts";
export * from "./bots/memory-dream.ts";
export * from "./bots/memory-extraction.ts";
export * from "./bots/memory-maintenance.ts";
export * from "./bots/memory-maintenance-status.ts";
export * from "./bots/memory-management.ts";
export * from "./bots/memory-organization.ts";
export { MemoryProjectsRepo } from "./bots/memory-projects.ts";
export * from "./bots/memory-recall.ts";
export * from "./bots/memory-recall-metrics.ts";
export * from "./bots/memory-scope-moves.ts";
export { normalizeMemory, SimilarMemoryError, sameMemoryRevision } from "./bots/memory-search.ts";
export * from "./bots/memory-undo.ts";
export * from "./codemap/code-map.ts";
export * from "./computer/app-blocklist.ts";
export * from "./computer/computer-grants.ts";
export * from "./computer/computer-steps.ts";
export * from "./conversations/attachment-paths.ts";
export * from "./conversations/attachments.ts";
export * from "./conversations/chat-additions.ts";
export * from "./conversations/chat-notices.ts";
export * from "./conversations/chat-search.ts";
export * from "./conversations/chat-search-index.ts";
export * from "./conversations/continuation-state.ts";
export * from "./conversations/conversation-retries.ts";
export * from "./conversations/conversation-yolo.ts";
export * from "./conversations/conversations.ts";
export * from "./conversations/drafts.ts";
export * from "./conversations/inbox.ts";
export { MessageTransfersRepo } from "./conversations/message-transfers.ts";
export * from "./conversations/personal-todos.ts";
export { hasRoutineQuestionUserOrigin } from "./conversations/question-origin.ts";
export * from "./conversations/read-messages.ts";
export * from "./conversations/sidebar.ts";
export * from "./conversations/tool-groups.ts";
export * from "./conversations/topic-folders.ts";
export * from "./conversations/topics.ts";
export { type CleanupManifest, groupSessionFiles } from "./database/cleanup.ts";
export * from "./database/data-dir.ts";
export * from "./database/database.ts";
/** Keyset paging shared with capability stores (`readPage(db, table, columns, time, page)`). */
export { readPage } from "./database/paging.ts";
export * from "./execution/execution.ts";
export * from "./execution/execution-budget.ts";
export * from "./execution/execution-checkpoint.ts";
export * from "./execution/execution-collection.ts";
export * from "./execution/task-authority.ts";
export * from "./execution/task-execution.ts";
export * from "./groups/group-computer-always.ts";
export * from "./groups/group-cycles.ts";
export * from "./groups/group-execution-limits.ts";
export * from "./groups/group-folders.ts";
export * from "./groups/group-handoffs.ts";
export * from "./groups/group-member-workspaces.ts";
export * from "./groups/group-memory.ts";
export * from "./groups/group-plans.ts";
export * from "./groups/group-task-execution.ts";
export * from "./groups/group-task-history.ts";
export * from "./groups/group-tasks.ts";
export { GroupTopicsRepo } from "./groups/group-topics.ts";
export * from "./groups/group-workflows.ts";
export * from "./groups/groups.ts";
export * from "./media/image-artifact-types.ts";
export * from "./media/image-artifacts.ts";
export * from "./media/image-context.ts";
export * from "./permissions/approval-pauses.ts";
export * from "./permissions/approvals.ts";
export * from "./permissions/audit.ts";
export * from "./permissions/grants.ts";
export * from "./permissions/permissions.ts";
export * from "./runs/agent-review.ts";
export * from "./runs/auto-check.ts";
export * from "./runs/background-commands.ts";
export * from "./runs/background-continuations.ts";
export { BackgroundTaskHealthRepo } from "./runs/background-health.ts";
export { BrainWakeRepo } from "./runs/brain-wake.ts";
export { LiveActivityRepo } from "./runs/live-activity.ts";
export * from "./runs/review-findings.ts";
export * from "./runs/run-events.ts";
export * from "./runs/run-receipt.ts";
export * from "./runs/run-recovery.ts";
export * from "./runs/run-retention.ts";
export * from "./runs/runs.ts";
export * from "./runs/tool-calls.ts";
export * from "./runs/tool-journal.ts";
export * from "./secrets/secret-store.ts";
export * from "./settings/background-preferences.ts";
export { NetworkProxyRepo } from "./settings/network-proxy.ts";
export * from "./settings/power-events.ts";
export * from "./settings/search.ts";
export * from "./settings/search-settings.ts";
export * from "./tools/capability-selection.ts";
export * from "./workspace/file-checkpoints.ts";
export * from "./workspace/managed-root-references.ts";
export * from "./workspace/managed-worktrees.ts";
export { ProjectNotesRepo } from "./workspace/project-notes.ts";
export * from "./workspace/repositories.ts";
export * from "./workspace/run-file-changes.ts";
export * from "./workspace/workplaces.ts";

import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { configureChatSearchRedactor } from "./conversations/chat-search-index.ts";
import { applyMigrations, applyMigrationsYielding } from "./database/database.ts";

/**
 * Migrations live next to the package: this entry sits one level below them in the source tree
 * (packages/storage/src → ../migrations) and in the bundle (out/main/brain.js → out/migrations).
 * Resolve the default here, not in a deeper module folder, so both layouts stay correct.
 */
export function runMigrations(
  db: DatabaseSync,
  dir = fileURLToPath(new URL("../migrations/", import.meta.url)),
): void {
  configureChatSearchRedactor(db);
  applyMigrations(db, dir);
}

/** Startup's variant: `between` runs between migrations so the process can report progress. */
export async function runMigrationsYielding(
  db: DatabaseSync,
  between: () => Promise<void>,
  dir = fileURLToPath(new URL("../migrations/", import.meta.url)),
): Promise<void> {
  configureChatSearchRedactor(db);
  await applyMigrationsYielding(db, dir, between);
}

export { GroupAcpRepo, type GroupAcpRoot } from "./groups/group-acp.ts";
export * from "./groups/group-verification-rules.ts";
export { DiagnosticsRepo } from "./runs/diagnostics.ts";
export { EndpointCapabilitiesRepo } from "./tools/endpoint-capabilities.ts";
