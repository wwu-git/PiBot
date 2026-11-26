import { lstat } from "node:fs/promises";
import { AgentError, type AgentErrorCode } from "@pibot/agent";
import { directoryIdentity, ExecError } from "@pibot/execution";
import {
  type ResolvedWorkplace,
  RpcError,
  type TopicWorkplaceSnapshot,
} from "@pibot/protocol-base";
import { ConversationsRepo, GroupsRepo } from "@pibot/storage";
import { auditText } from "../../core/audit-fields.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { migrateLegacyOutputs } from "../../runtime/workflows/output-migration.ts";
import { groupWorkplace } from "../groups/group-workplace.ts";
import { workspaceBoundary } from "./workspace-boundary.ts";

export function topicWorkplaceSnapshot(local: LocalService, context: ToolRunContext) {
  if (context.executionTaskId) return undefined;
  if (context.groupId || !context.conversationId) return undefined;
  const topic = new ConversationsRepo(local.deps.db).get(context.conversationId);
  if (topic?.kind !== "dm" || topic.botId !== context.botId || topic.archivedAt)
    throw new RpcError(-32602, "Unknown topic");
  return {
    conversationId: topic.id,
    folderId: topic.workplaceFolderId ?? null,
    revision: topic.workplaceRevision ?? 0,
  } satisfies TopicWorkplaceSnapshot;
}

/** Shared by tools, image destinations and future read-only directory consumers. */
export async function resolveRunWorkplace(
  local: LocalService,
  context: ToolRunContext,
  parent: AbortSignal,
): Promise<ResolvedWorkplace> {
  if (context.projectNotesChange) {
    parent.throwIfAborted();
    await context.projectNotesChange.assertSource?.(parent);
    const workplace = context.projectNotesChange.workplace;
    const root = workplace.boundary.roots[0];
    if (!root) throw new RpcError(-32602, "workspace_boundary_changed");
    const current = await directoryIdentity(root.canonicalPath);
    parent.throwIfAborted();
    if (
      current.canonicalPath !== root.canonicalPath ||
      current.device !== root.device ||
      current.inode !== root.inode
    )
      throw new RpcError(-32602, "workspace_boundary_changed");
    return workplace;
  }
  if (local.tasks.hasAuthority(context)) return local.tasks.workplace(context, parent);
  const signal = AbortSignal.any([parent, local.shutdown.signal, AbortSignal.timeout(20_000)]);
  const topic = topicWorkplaceSnapshot(local, context);
  if (context.topicWorkplace && JSON.stringify(topic) !== JSON.stringify(context.topicWorkplace))
    throw new RpcError(-32602, "topic_workplace_changed");
  const group = context.groupId ? new GroupsRepo(local.deps.db).get(context.groupId) : undefined;
  if (context.groupId && !group) throw new RpcError(-32602, "Group removed");
  // A routine runs in its own folders; its topic's folders never apply to it.
  const routine = !!context.routineRunId || context.routineWorkplace !== undefined;
  const selection = routine
    ? routineSelection(local, context)
    : topic
      ? local.workplaces.topic(topic.conversationId)
      : undefined;
  let workplace: ResolvedWorkplace;
  if (group) {
    workplace = await (local.collaboration?.workplace?.(context, signal) ??
      groupWorkplace(local, context.botId, group, signal));
  } else {
    try {
      workplace = await local.workplaces.context(context.botId, signal, selection);
    } catch (error) {
      const botDefaultStale =
        routine &&
        (context.routineWorkplace?.kind ?? "bot") === "bot" &&
        error instanceof RpcError &&
        [
          "workplace_folder_missing",
          "Unknown working folder",
          "Working folder changed; associate it again",
        ].includes(error.message);
      if (!botDefaultStale) throw error;
      workplace = await local.workplaces.context(context.botId, signal, {
        selection: { primary: "home", readonly: [] },
        revision: 0,
      });
    }
  }
  await migrateOutputsOnce(local, context, workplace, signal);
  // Read-only for this run only: a routine's trial triggers / previous period and the
  // folders picked as workflow inputs.
  const extraRoots = [
    ...(context.routineWorkplace?.temporaryRoots ?? []),
    ...(context.workflowReadRoots ?? []),
  ];
  if (extraRoots.length) {
    if (workplace.boundary.location?.target.startsWith("runner:"))
      throw new RpcError(-32601, "runner_workflow_unsupported");
    // These are read-only references (trial triggers, the previous period). One that is
    // gone is left out so the run still starts in its own folder instead of failing entirely.
    const extra = await Promise.all(
      extraRoots
        .filter((r) => !workplace.boundary.readRoots.includes(r.path))
        .map(async (root) =>
          (await lstat(root.path).then(
            (info) => info.isDirectory(),
            () => false,
          ))
            ? [{ ...root, role: "readonly" as const }]
            : [],
        ),
    ).then((groups) => groups.flat());
    if (extra.length) {
      workplace.boundary = await workspaceBoundary(
        [...workplace.boundary.roots, ...extra],
        workplace.boundary.revision,
        local.deps.platform,
        signal,
      );
      workplace.roots = workplace.boundary.readRoots;
    }
  }
  // Migration 0027 kept a routine's old read-only working directory: same cwd, still read-only.
  const cwd = routine ? context.routineWorkplace?.cwd : undefined;
  if (cwd) {
    const root = workplace.boundary.roots.find((r) => r.id === cwd);
    if (!root && cwd !== "home") throw new RpcError(-32602, "Routine workplace removed");
    workplace.cwd = root?.canonicalPath ?? workplace.home;
  }
  signal.throwIfAborted();
  if (
    context.runWorkplace &&
    JSON.stringify({ cwd: workplace.cwd, boundary: workplace.boundary }) !==
      JSON.stringify(context.runWorkplace)
  )
    throw new RpcError(-32602, "workspace_boundary_changed");
  if (JSON.stringify(topicWorkplaceSnapshot(local, context)) !== JSON.stringify(topic))
    throw new RpcError(-32602, "topic_workplace_changed");
  return workplace;
}

/**
 * A routine's own folders. `kind: "bot"` (and older private contexts without a folder) is the
 * deprecated "follow the Bot", read as what a new topic would get. Revision 0: a routine has no
 * revision of its own, and the registry's would change whenever any topic registers a folder.
 */
export function routineSelection(local: LocalService, context: ToolRunContext) {
  const place = context.routineWorkplace;
  if (place?.kind === "bot" || !place?.folderId)
    return { selection: { ...local.workplaces.initial(context.botId), writable: [] }, revision: 0 };
  const primary = place.folderId;
  return {
    selection: {
      primary,
      readonly: [...new Set(place.readonly ?? [])].filter((id) => id !== primary).slice(0, 32),
    },
    revision: 0,
  };
}

// Folder problems the user fixes by associating the folder again (moved, deleted, unreadable or
// swapped for a link). Races such as a topic re-binding mid-run are not in this list.
const unavailableMessages = new Set([
  "workplace_folder_missing",
  "Unknown working folder",
  "Working folder changed; associate it again",
  "Group folder changed; associate it again",
  "Group workplace unavailable",
  "workspace_boundary_changed",
  // The routine's kept working directory and a boundary left without a primary are the
  // same "pick the folder again" state; unmapped they reached the run as `internal`.
  "Routine workplace removed",
  "workspace_primary_missing",
]);

// An unreachable execution target fails the same call, but the person cannot fix it by picking the
// folder again: the display must say the target is offline instead.
const runnerUnavailableMessages = new Set([
  "runner_target_offline",
  "remote_device_revoked",
  "transport_closed",
]);
// Shared with the routine list's log filter (`safeErrorDetails`), so a folder problem is classified
// the same way wherever it is reported.
export const unavailableErrnos: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "ENAMETOOLONG",
]);

// A runner (and the local execution layer) reports the same folder failures as ExecError codes
// without an errno. One missing from this list fell through to `internal`: a Windows path over
// the 260-character MAX_PATH limit looks like "not found" or "failed to canonicalize".
const runnerRunErrors: Readonly<Record<string, AgentErrorCode>> = {
  runner_target_offline: "runner_offline",
  remote_device_revoked: "runner_revoked",
  workspace_targets_mixed: "workplace_mixed_locations",
  transport_closed: "runner_disconnected",
  // An older runner has no managed Git for parallel group worktrees.
  runner_update_required: "runner_update_required",
};

export const unavailableExecCodes: ReadonlySet<string> = new Set([
  "file_not_found",
  "file_not_directory",
  "file_access_denied",
  "file_failed",
]);

/**
 * Returns whether resolving a workplace failed for a condition the user can fix by associating
 * the folder again. This is shared by run error mapping and routine list annotations: the latter
 * must not depend on an adapter preserving an errno/path pair after crossing the RPC boundary.
 */
export function workplaceUnavailableReason(error: unknown): "workspace" | "runner" | undefined {
  const message = error instanceof RpcError ? error.message : undefined;
  if (message && runnerUnavailableMessages.has(message)) return "runner";
  if (message && unavailableMessages.has(message)) return "workspace";
  const errno = (error as { code?: unknown } | null)?.code;
  if (typeof errno === "string" && unavailableErrnos.has(errno)) return "workspace";
  return error instanceof ExecError && unavailableExecCodes.has(error.code)
    ? "workspace"
    : undefined;
}

export function isWorkplaceUnavailable(error: unknown): boolean {
  return workplaceUnavailableReason(error) !== undefined;
}

/**
 * Resolving a run's working folder before the model is called: a missing or unreadable folder
 * becomes the explicit `workplace_unavailable` error instead of `internal`.
 */
export async function withWorkplaceErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    // A runner folder fails per call with its own identifiers; at run level they would reach the
    // chat as `internal` because the RPC code is not an AgentErrorCode.
    const runnerCode = error instanceof RpcError ? runnerRunErrors[error.message] : undefined;
    if (runnerCode) throw new AgentError(runnerCode);
    if (error instanceof RpcError && error.message === "group_workspace_platform_unsupported")
      throw new AgentError("group_workspace_unsupported");
    if (
      error instanceof RpcError &&
      (error.message.startsWith("group_workspace_") || error.message === "worktree_quota")
    )
      throw new AgentError("group_workspace_unavailable");
    if (isWorkplaceUnavailable(error)) throw new AgentError("workplace_unavailable");
    throw error;
  }
}

/**
 * The first time a folder on this computer is used after the upgrade, its pre-A55 outputs
 * move to `.pibot/out` (maintainers 2026-11-12). Never fails the run: a folder that cannot be migrated
 * keeps its old outputs where they are.
 */
async function migrateOutputsOnce(
  local: LocalService,
  context: ToolRunContext,
  workplace: ResolvedWorkplace,
  signal: AbortSignal,
) {
  if ((workplace.boundary.location?.target ?? "local") !== "local") return;
  const primary = workplace.boundary.primaryPath;
  if (!primary || local.outputMigrations.has(primary)) return;
  local.outputMigrations.add(primary);
  try {
    const result = await migrateLegacyOutputs(primary, signal);
    if (!result) return;
    // A name already taken in `.pibot/out` stays in the old folder; it would only repeat each start.
    if (!result.moved) {
      local.deps.logger.info(
        JSON.stringify({ module: "outputs", event: "migration_skipped", skipped: result.skipped }),
      );
      return;
    }
    local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "outputs.migrated",
      summary: "Outputs moved to .pibot/out / 产出移到 .pibot/out",
      detail: {
        actor: "automatic",
        path: auditText(primary, local.deps.redactor, 4096),
        movedCount: result.moved,
        skippedCount: result.skipped,
      },
    });
  } catch {
    signal.throwIfAborted();
    local.deps.logger.warn(JSON.stringify({ module: "outputs", event: "migration_failed" }));
  }
}
