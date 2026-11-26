import { type ToolPaths, toolGroupSummary, toolSteps } from "@pibot/client-core";
import {
  ComputerRunNotice,
  isComputerTool,
  isDesktopComputerTool,
  lastDesktopToolCall,
  StepList,
  useRunSteps,
} from "@pibot/computer-use/ui";
import type { Approval, Message, ToolCallRecord } from "@pibot/protocol";
import { approvalStyles as styles, useT } from "@pibot/renderer-kit";
import { Icon } from "@pibot/ui";
import { useEffect, useId, useState } from "react";
import { BackgroundLine } from "../status/BackgroundLine.tsx";
import { SandboxBlockLine, useSandboxNotices } from "../status/SandboxNotices.tsx";
import yoloStyles from "../status/yolo.module.css";
import { ApprovalCard, type ApprovalDecision, ApprovalResult } from "./ApprovalCard.tsx";
import lively from "./lively.module.css";
import type { ActivityTool } from "./local-activity.ts";
import { ToolCallRow } from "./ToolCallRow.tsx";

export function ToolActivity({
  messageId,
  conversationId,
  runId,
  botId,
  messageStatus,
  paths,
  records = [],
  live,
  approvals,
  approvalContext,
  refresh,
  decide,
  focusToolCallId,
  slim = false,
}: {
  messageId: string;
  conversationId?: string;
  runId: string;
  botId: string;
  messageStatus: Message["status"];
  paths?: ToolPaths;
  records?: ToolCallRecord[];
  live: ActivityTool[];
  approvals: Approval[];
  approvalContext?: { botName: string; groupName: string };
  refresh(): Promise<void>;
  decide: ApprovalDecision;
  focusToolCallId?: string;
  /** Maintainers 2026-11-13 (layout A): under a direct chat's sentence the finished steps are one quiet line. */
  slim?: boolean;
}) {
  const t = useT();
  const sandboxNotices = useSandboxNotices();
  const [expanded, setExpanded] = useState(false);
  // A step moves from current to history without losing the user's explicit choice.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const contentId = useId();
  const { steps, unmatched } = toolSteps(messageId, records, live, approvals);
  const ended = messageStatus !== "streaming";
  // Computer steps are read once per run and only when the reply used computer or browser tools.
  const computer = steps.some((step) => isComputerTool(step.tool.tool));
  const computerSteps = useRunSteps(runId, computer);
  // The run-level "stopped" line went under every step group of the run (4 times, owner
  // 2026-11-14); it belongs once, under the group whose step was the last to operate the computer.
  const lastDesktop = lastDesktopToolCall(computerSteps.byToolCall);
  const stoppedHere = lastDesktop
    ? steps.some((step) => step.tool.toolCallId === lastDesktop)
    : steps.some((step) => isDesktopComputerTool(step.tool.tool));
  // Pending approvals remain actionable even when message and tool events settle out of order.
  const needsAttention = (step: (typeof steps)[number]) => step.approval?.status === "pending";
  const attention = steps.filter(needsAttention);
  const grouped = steps.filter(
    (step) =>
      !needsAttention(step) && (ended || !["pending", "running"].includes(step.tool.status)),
  );
  const visibleUnmatched = unmatched.filter((approval) => approval.status === "pending");
  const settledUnmatched = unmatched.filter((approval) => approval.status !== "pending");
  const focusesStep =
    !!focusToolCallId &&
    (grouped.some((step) => step.tool.toolCallId === focusToolCallId) ||
      settledUnmatched.some((approval) => approval.toolCallId === focusToolCallId));
  const showGroup = expanded || focusesStep;
  useEffect(() => {
    if (focusesStep) setExpanded(true);
  }, [focusesStep]);
  const current = ended
    ? []
    : steps.filter(
        (step) => !needsAttention(step) && ["pending", "running"].includes(step.tool.status),
      );
  const isPinned = (step: (typeof steps)[number]) =>
    opened.has(step.tool.toolCallId) || !!sandboxNotices(runId, step.tool.toolCallId)?.length;
  const pinned = grouped.filter(isPinned);
  const folded = grouped.filter((step) => !isPinned(step));
  // Allowed by YOLO (no card, or a card YOLO let through) reads that way, not "You allowed".
  const yoloOf = (step: (typeof steps)[number]) =>
    !step.approval || step.approval.status === "allowed" ? step.tool.yolo : undefined;
  const renderStep = (step: (typeof steps)[number], forceOpen = false, executing = false) => (
    <ToolCallRow
      key={step.tool.toolCallId}
      tool={step.tool}
      messageId={messageId}
      step={step.number}
      target={step.target}
      paths={paths}
      forceOpen={forceOpen}
      expanded={opened.has(step.tool.toolCallId)}
      onExpandedChange={(value) =>
        setOpened((previous) => {
          const next = new Set(previous);
          if (value) next.add(step.tool.toolCallId);
          else next.delete(step.tool.toolCallId);
          return next;
        })
      }
      focusOpen={step.tool.toolCallId === focusToolCallId}
      current={executing}
      runId={runId}
      botId={botId}
      notice={
        sandboxNotices(runId, step.tool.toolCallId) && (
          <SandboxBlockLine notices={sandboxNotices(runId, step.tool.toolCallId) ?? []} />
        )
      }
      steps={
        computer && (
          <StepList
            steps={computerSteps.byToolCall.get(step.tool.toolCallId) ?? []}
            error={computerSteps.error && isComputerTool(step.tool.tool)}
            retry={computerSteps.retry}
          />
        )
      }
    >
      {step.approval &&
        !yoloOf(step) &&
        ("id" in step.approval ? (
          <ApprovalCard
            key={step.approval.id}
            conversationId={conversationId}
            approval={step.approval}
            context={approvalContext}
            refresh={refresh}
            decide={decide}
          />
        ) : (
          <ApprovalResult result={step.approval} botId={botId} />
        ))}
      {yoloOf(step) && (
        <div
          role="status"
          className={`${yoloStyles.step} ${yoloOf(step)?.risk === "danger" ? yoloStyles.stepDanger : ""}`}
        >
          {yoloOf(step)?.risk === "danger" && <Icon name="warning" size={13} />}
          {t(yoloOf(step)?.risk === "danger" ? "yolo.stepAllowedDanger" : "yolo.stepAllowed")}
        </div>
      )}
    </ToolCallRow>
  );
  const renderUnmatched = (approval: Approval) => (
    <div key={approval.id} data-tool-call-id={approval.toolCallId}>
      <ApprovalCard
        conversationId={conversationId}
        approval={approval}
        context={approvalContext}
        refresh={refresh}
        decide={decide}
      />
    </div>
  );
  if (!steps.length && !unmatched.length) return null;
  return (
    <div className={styles.toolGroup}>
      {computer && <ComputerRunNotice botId={botId} runId={runId} showStopped={stoppedHere} />}
      {/* Steps read in order: finished ones first, then the one waiting for you or running. */}
      {(grouped.length > 0 || settledUnmatched.length > 0) && (
        <>
          <button
            type="button"
            className={`${styles.groupToggle} ${lively.fold} ${slim ? lively.slim : ""}`}
            aria-expanded={showGroup}
            aria-controls={contentId}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon
              name="chevron"
              size={slim ? 13 : undefined}
              style={{ transform: showGroup ? undefined : "rotate(-90deg)" }}
            />
            <span>
              {!ended && !slim && `${t("tool.fold.completed")} · `}
              {toolGroupSummary(
                grouped.map((step) => ({ ...step.tool, approval: step.approval })),
                t,
                settledUnmatched,
                slim,
              )}
            </span>
          </button>
          {/* An opened step's detail belongs under the group's title, not above it. */}
          {!showGroup && pinned.map((step) => renderStep(step))}
          <div id={contentId} hidden={!showGroup} className={lively.foldBody}>
            {showGroup && grouped.map((step) => renderStep(step))}
            {showGroup && settledUnmatched.map(renderUnmatched)}
          </div>
        </>
      )}
      {attention.map((step) => renderStep(step, true))}
      {visibleUnmatched.map(renderUnmatched)}
      {current.map((step) => renderStep(step, false, true))}
      {/* A server still running stays visible (and stoppable) with its step folded away. */}
      {!showGroup &&
        folded
          .filter((step) => step.tool.tool === "run_command")
          .map((step) => (
            <BackgroundLine
              key={`bg-${step.tool.toolCallId}`}
              botId={botId}
              runId={runId}
              toolCallId={step.tool.toolCallId}
              runningOnly
            />
          ))}
    </div>
  );
}
