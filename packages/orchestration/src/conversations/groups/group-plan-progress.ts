import {
  type GroupPlanProgress,
  GroupPlanProgressSchema,
  type KernelMethodParams,
  RpcError,
} from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord, GroupWorkflowStepRecord } from "@pibot/storage";
import { stepTaskId, workspaceSteps } from "./group-plan-step-workspaces.ts";
import type { GroupService } from "./group-service.ts";
import { resolvePlanHold } from "./group-workflow-hold.ts";
import { GroupWorkflowPause } from "./group-workflow-pause.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";
import { verdictResolution } from "./group-workflow-verdicts.ts";

const unavailable = () => new RpcError(-32602, "group_plan_progress_unavailable");

/**
 * The plan a card stands for now: a card's DAG id, or the newest replacement of the same budget
 * root when replanning replaced it (each replacement keeps the chain's root).
 */
function current(service: GroupService, groupId: string, workflowRunId: string) {
  const group = service.active(groupId);
  const record = service.workflows.repo.get(workflowRunId);
  if (!record || record.groupId !== group.id || workflowOf(record).source.kind !== "dynamic")
    throw unavailable();
  if (record.status !== "cancelled" || !record.budgetRootRunId) return record;
  return (
    service.workflows.repo.latestPlan(group.id, record.cycleId, record.budgetRootRunId) ?? record
  );
}

/** Where a step's work is: program facts from its task and workspace rows, never file content. */
function workspaceOf(
  service: GroupService,
  state: GroupWorkflowStepRecord,
  own: ReadonlySet<string>,
): GroupPlanProgress["steps"][number]["workspace"] {
  if (!own.has(state.stepId)) return undefined;
  const taskId = stepTaskId(service, state);
  if (!taskId) return undefined;
  const workspace = service.memberWorktrees.workspace(taskId);
  if (!workspace)
    return service.tasks.get(taskId)?.executionMode === "serial" ? "shared" : undefined;
  if (workspace.state === "integrated") return "merged";
  if (workspace.state === "conflict") return "conflict";
  if (workspace.state === "removed") return undefined;
  return state.status === "passed" ? "merging" : "own";
}

/** Each step's workspace state, for the progress card and the program's status lines. */
export function stepWorkspaces(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  states: readonly GroupWorkflowStepRecord[],
) {
  const own = workspaceSteps(record, workflowOf(record), states);
  return new Map(states.map((state) => [state.stepId, workspaceOf(service, state, own)]));
}

function facts(service: GroupService, record: GroupWorkflowRunRecord): GroupPlanProgress {
  const states = service.workflows.repo.steps(record.id);
  const own = workspaceSteps(record, workflowOf(record), states);
  const merges = progressOf(record).merges ?? {};
  const held = GroupWorkflowPause.held(record);
  const steps = states.map((step) => {
    const workspace = workspaceOf(service, step, own);
    const files = workspace === "conflict" ? merges[step.stepId]?.files : undefined;
    const taskId =
      step.status === "running" && own.has(step.stepId) ? stepTaskId(service, step) : undefined;
    // A step waiting for its turn in the shared folder has not started: it reads as waiting, so
    // the bar never counts it among the steps running at once.
    const waiting = !!taskId && service.memberWorktrees.waitingTurn(taskId);
    return {
      stepId: step.stepId,
      executionRunId: step.executionRunId,
      status: waiting ? ("ready" as const) : step.status,
      attempt: step.attempt,
      verdictResolution: verdictResolution(progressOf(record), step.stepId),
      ...(progressOf(record).verdicts[step.stepId]
        ? { verdict: progressOf(record).verdicts[step.stepId] }
        : {}),
      ...(workspace ? { workspace } : {}),
      ...(files?.length ? { conflictFiles: files } : {}),
      ...(step.status === "ready" && held.has(step.stepId) ? { paused: true as const } : {}),
    };
  });
  const ledger = record.budgetRootRunId
    ? service.deps.local.budgets.repo.get(record.budgetRootRunId)
    : undefined;
  const pending = record.budgetRootRunId
    ? service.deps.local.budgets.repo.pendingModelRequests(record.budgetRootRunId)
    : 0;
  const progress = progressOf(record);
  const review = progress.review;
  const uncovered = review?.coverage?.filter((item) => item === null).length ?? 0;
  return GroupPlanProgressSchema.parse({
    workflowRunId: record.id,
    status: record.status,
    stoppedReason: progress.stoppedReason ?? null,
    ...(review
      ? {
          deliveryReview: {
            status: review.unavailable
              ? "unavailable"
              : !review.coverage
                ? "pending"
                : uncovered
                  ? "partial"
                  : "covered",
            covered: (review.coverage?.length ?? 0) - uncovered,
            uncovered,
            ...(review.supplementStepId ? { supplementStepId: review.supplementStepId } : {}),
          },
        }
      : {}),
    steps,
    passed: steps.filter((step) => step.status === "passed").length,
    total: steps.length,
    ...(progress.hold && ["running", "waiting"].includes(record.status)
      ? { choice: { kind: progress.hold.kind, stepIds: progress.hold.stepIds } }
      : {}),
    // Only settled unknown charges hide the total; retain the root ledger while streams run.
    costUsd: ledger && ledger.unknownCostRequests === pending ? ledger.knownCostUsd : null,
    pendingCostRequests: pending,
    budgetUsd: ledger?.limits.costUsd ?? null,
  });
}

/** Program facts only (states, attempts, ledger totals); no step text or file content. */
export function planProgress(
  service: GroupService,
  params: KernelMethodParams["groups.plan.progress"],
): GroupPlanProgress {
  return facts(service, current(service, params.groupId, params.workflowRunId));
}

/**
 * The user's stop: the existing hard stop with a fixed reason and the user as actor. It fails
 * the plan, aborts running step runs, the pending replan and the source run, and keeps passed
 * deliverables and cost. An already ended plan is left as it is, so repeats are harmless.
 */
export function stopPlan(
  service: GroupService,
  params: KernelMethodParams["groups.plan.stop"],
): GroupPlanProgress {
  const record = current(service, params.groupId, params.workflowRunId);
  if (record.status === "running" || record.status === "waiting")
    service.workflows.progress.stop(record, "user_stopped", "user");
  return facts(service, service.workflows.repo.get(record.id) ?? record);
}

/** The user's answer to the plan's waiting choice; the program does the rest, no model call. */
export function choosePlan(
  service: GroupService,
  params: KernelMethodParams["groups.plan.choose"],
): GroupPlanProgress {
  const record = current(service, params.groupId, params.workflowRunId);
  resolvePlanHold(service, record, params.choice);
  return facts(service, service.workflows.repo.get(record.id) ?? record);
}
