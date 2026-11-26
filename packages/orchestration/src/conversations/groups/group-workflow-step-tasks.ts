import type { GroupTask } from "@pibot/protocol-base";
import { type GroupWorkflowRunRecord, transaction } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/**
 * A step the user skipped or accepted, or a plan that ended, must not leave its attempts' tasks
 * open: the task list would show work nobody will ever do (a skipped step's second attempt stayed
 * 进行中 after its plan completed). Only tasks with nothing running are closed; a task whose run is
 * still being drained is closed by the caller once that drain settles.
 */
export function closeStepTasks(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  stepIds: readonly string[],
  reasonCode: "step_skipped" | "step_accepted" | "plan_stopped" | "plan_completed",
  actor: "user" | "system",
) {
  const closed: GroupTask[] = [];
  transaction(service.deps.db, () => {
    for (const stepId of stepIds)
      for (const id of service.workflows.repo.openStepTasks(record.id, stepId)) {
        const task = service.tasks.get(id);
        if (task?.status !== "open" || service.runs.hasActiveForTask(id, "")) continue;
        closed.push(service.tasks.finish(id, task.assigneeBotId, "cancelled"));
        service.cycles.claimWake(id);
        service.deps.local.approvals.audit.append({
          botId: record.coordinatorBotId,
          kind: "group.workflow.disposition",
          summary: "Plan step task closed / 计划步骤的任务已关闭",
          detail: {
            groupId: record.groupId,
            workflowRunId: record.id,
            actor,
            stepId,
            taskId: id,
            reasonCode,
          },
        });
      }
  });
  for (const task of closed) service.taskChanged(task);
  return closed.length;
}
