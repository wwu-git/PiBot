// A plan that cannot go on by itself waits for the user's choice on its card instead of ending.
import { type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import { type GroupWorkflowRunRecord, MessagesRepo, transaction } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { unresolvedVerdicts } from "./group-workflow-verdicts.ts";

type Choice = KernelMethodParams["groups.plan.choose"]["choice"];

const choices: Record<"replan_limit" | "fix_skipped", readonly Choice[]> = {
  replan_limit: ["continue", "new_plan", "stop"],
  fix_skipped: ["accept", "stop"],
};

/**
 * No replans are left but nothing hit a hard limit (budget, rounds, time): ending the plan here
 * threw away the steps that had not run yet and left the card without a way on. The plan waits
 * instead; the verdicts still failing are listed, since continuing keeps them as they are.
 */
export function holdForReplanLimit(service: GroupService, record: GroupWorkflowRunRecord) {
  const held = transaction(service.deps.db, () => {
    const latest = service.workflows.repo.get(record.id);
    if (!latest || !["running", "waiting"].includes(latest.status)) return false;
    const ledger = progressOf(latest);
    if (ledger.hold) return false;
    const stepIds = unresolvedVerdicts(ledger)
      .map(([id]) => id)
      .slice(0, 20);
    service.workflows.progress.save(latest, {
      ...ledger,
      requested: false,
      replanRunId: undefined,
      hold: { kind: "replan_limit", stepIds },
    });
    service.workflows.repo.updateRun(record.id, "waiting");
    const zh = service.deps.chat.currentLanguage() === "zh";
    new MessagesRepo(service.deps.db).create({
      conversationId: service.groups.get(record.groupId)?.conversationId ?? "",
      botId: record.coordinatorBotId,
      role: "assistant",
      status: "done",
      markUnread: false,
      content: zh
        ? "重新规划次数已用完（2/2），计划先停在这里，已完成的步骤和产物都保留。请在计划卡片上选择：按剩下的步骤继续，或新开计划。"
        : "No replans left (2/2), so the plan waits here; completed steps and outputs are kept. On the plan card, continue with the remaining steps or start a new plan.",
    });
    service.workflows.audit(
      latest,
      "group.workflow.disposition",
      "Replan limit reached; waiting for the user / 重新规划次数用尽，等你选择",
      { actor: "system", reasonCode: "replan_limit_hold", stepCount: stepIds.length },
    );
    return true;
  });
  if (held) service.changed(record.groupId, "updated");
}

/** The user's answer. A stale card (the plan moved on or ended) gets an explicit error. */
export function resolvePlanHold(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  choice: Choice,
) {
  const kind = progressOf(record).hold?.kind;
  if (!kind || !["running", "waiting"].includes(record.status) || !choices[kind].includes(choice))
    throw new RpcError(-32602, "group_plan_choice_unavailable");
  if (choice === "stop" || choice === "new_plan") {
    service.workflows.audit(
      record,
      "group.workflow.disposition",
      "Plan ended by the user's choice / 用户选择结束计划",
      { actor: "user", reasonCode: `plan_choice_${choice}` },
    );
    service.workflows.progress.stop(record, "user_stopped", "user");
    return;
  }
  transaction(service.deps.db, () => {
    const latest = service.workflows.repo.get(record.id);
    const ledger = latest ? progressOf(latest) : undefined;
    if (!latest || !ledger?.hold || ledger.hold.kind !== kind || latest.status !== record.status)
      throw new RpcError(-32602, "group_plan_choice_unavailable");
    // Continuing without a replan keeps every verdict still failing as it is; accepting keeps
    // the ones whose repair was skipped. Either way the user owns that decision, not the program.
    const accepted =
      choice === "continue" ? unresolvedVerdicts(ledger).map(([id]) => id) : ledger.hold.stepIds;
    service.workflows.progress.save(latest, {
      ...ledger,
      hold: undefined,
      requested: false,
      verdictAccepts: {
        ...ledger.verdictAccepts,
        ...Object.fromEntries(accepted.map((id) => [id, true as const])),
      },
    });
    service.workflows.repo.updateRun(record.id, "running");
    service.workflows.audit(
      latest,
      "group.workflow.disposition",
      choice === "continue"
        ? "Continuing with the remaining steps, no replan / 按剩下的步骤继续，不再重新规划"
        : "FAIL verdict accepted as is / 不通过的结论按现状接受",
      {
        actor: "user",
        reasonCode: choice === "continue" ? "plan_continue_remaining" : "verdict_accepted_as_is",
        stepCount: accepted.length,
      },
    );
  });
  service.changed(record.groupId, "updated");
  service.workflows.schedule(record.id);
}
