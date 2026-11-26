import type { GroupWorkflowDecision } from "@pibot/protocol-base";

/** Plain-text fallback for clients without the structured card, in one language only. */
export function decisionText(decision: GroupWorkflowDecision, language: "zh" | "en") {
  const zh = language === "zh";
  const title = zh ? `「${decision.title}」` : `“${decision.title}”`;
  if (decision.reviewSteps) {
    return decision.state === "resolved"
      ? zh
        ? `你已确认计划${title}的全部人工核对项。`
        : `You confirmed all human checks for plan ${title}.`
      : [
          zh
            ? `计划${title}的步骤已执行完，请一次核对并确认以下人工项：`
            : `Plan ${title} has finished executing. Review and confirm these human checks together:`,
          ...decision.reviewSteps.map((step) => `${step.title}: ${step.checks.join("; ")}`),
        ].join("\n");
  }
  if (decision.state === "resolved") {
    const text = {
      accept: zh ? `你确认了${title}` : `You confirmed ${title}`,
      retry: zh ? `你要求重试${title}` : `You requested a retry of ${title}`,
      skip: zh ? `你跳过了${title}` : `You skipped ${title}`,
      reassign: zh
        ? `${title}已改派给 ${decision.reassignedTo ?? "群成员"}`
        : `${title} reassigned to ${decision.reassignedTo ?? "a group member"}`,
    };
    return decision.resolution
      ? text[decision.resolution]
      : zh
        ? `${title}的决定已记录`
        : `Decision recorded for ${title}`;
  }
  if (decision.reasonCode === "permission_denied")
    return zh
      ? `步骤${title}被权限拦截；请核对权限后接续。这不是预算停止。`
      : `Step ${title} was blocked by permissions. Review permissions before continuing; this was not a budget stop.`;
  if (decision.reasonCode === "repeated_operation")
    return zh
      ? `步骤${title}的成员反复调用无效工具或参数，程序只停了这一步，其他步骤照常进行。`
      : `The member on step ${title} kept repeating invalid tool calls, so the program stopped only this step; other steps continue.`;
  if (decision.reasonCode === "context_full")
    return zh
      ? `步骤${title}上下文装不下，已停下${decision.reading ? `：正在读 ${decision.reading}` : ""}。可以缩小范围重试。`
      : `Step ${title} stopped: its context was full${decision.reading ? ` while reading ${decision.reading}` : ""}. You can retry with a narrower scope.`;
  // The note is the program's fixed facts about what the coordinator saw and chose.
  if (
    decision.reasonCode === "coordinator_handed_over" ||
    decision.reasonCode === "dispositions_exhausted"
  )
    return [
      zh
        ? `步骤${title}已用完修复轮次，由你决定下一步：`
        : `Step ${title} used up its fix rounds; you decide what happens next:`,
      ...(decision.note ? [decision.note] : []),
    ].join("\n");
  if (decision.confirmationRequired)
    return zh
      ? `步骤${title}等待你核对产物后确认。`
      : `Step ${title} needs your confirmation after checking the outputs.`;
  if (
    decision.reasonCode === "execution_interrupted" ||
    decision.reasonCode === "restart_interrupted"
  )
    return zh ? `步骤${title}的执行被中断。` : `Execution of step ${title} was interrupted.`;
  return zh
    ? `步骤${title}需要你决定下一步。`
    : `Step ${title} needs your decision on what to do next.`;
}
