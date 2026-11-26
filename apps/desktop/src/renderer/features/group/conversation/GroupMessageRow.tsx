// Renders one group message without re-rendering the full streaming conversation.
import { type ChatPeer, silentWake } from "@pibot/client-core";
import {
  GroupExecutionReceiptSchema,
  GroupWorkflowDecisionSchema,
  type Message,
  memoryNoted,
} from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { type ComponentProps, memo, type ReactNode, useMemo } from "react";
import { AdditionStatus } from "../../chat/composer/SendOptions.tsx";
import { ChatMessage } from "../../chat/messages/ChatMessage.tsx";
import { MessageTime } from "../../chat/messages/MessageTime.tsx";
import type { ActivityState } from "../../chat/tools/local-activity.ts";
import { GroupExecutionFact } from "../../receipt/GroupExecutionFact.tsx";
import { CorrectionMemoryNotice } from "../../workspace/memory/CorrectionMemoryNotice.tsx";
import type { GroupSnapshot } from "../data.ts";
import { assignmentPresentation, GroupAssignments } from "../tasks/Assignments.tsx";
import { GroupPlanCard } from "../tasks/GroupPlanCard.tsx";
import { GroupPlanSave } from "../tasks/GroupPlanSave.tsx";
import { GroupQuickStarts, quickStartCardMessage } from "./GroupQuickStarts.tsx";
import { GroupRunStop } from "./RunList.tsx";

type Assignments = ComponentProps<typeof GroupAssignments>;

/**
 * One group message. Every prop is a stable reference or a primitive, and the objects ChatMessage
 * needs are built here, so a streaming delta re-renders only the message whose content changed.
 */
export const GroupMessageRow = memo(function GroupMessageRow({
  message,
  executionFooter,
  previousAt,
  first,
  today,
  bot,
  activity,
  refreshApprovals,
  decideApproval,
  run,
  batch,
  collaborations,
  assignmentTasks,
  highlighted,
  focusToolCallId,
  group,
  bots,
  mentionNames,
  peer,
  refresh,
  sendPlanChanges,
  fillComposer,
  openTask,
  openTasks,
  thread,
  confirmed,
  loading,
  onRetry,
  onModelsSettings,
  onWorkplaceSettings,
}: {
  message: Message;
  executionFooter?: ReactNode;
  previousAt?: string;
  first: boolean;
  today: string;
  bot?: GroupSnapshot["bots"][number];
  activity: ActivityState;
  refreshApprovals?: ComponentProps<typeof ChatMessage>["refreshApprovals"];
  decideApproval?: ComponentProps<typeof ChatMessage>["decideApproval"];
  run?: GroupSnapshot["runs"][number];
  batch?: Assignments["batch"];
  collaborations?: Assignments["collaborations"];
  assignmentTasks?: Assignments["tasks"];
  highlighted: boolean;
  focusToolCallId?: string;
  group: GroupSnapshot["group"];
  bots: GroupSnapshot["bots"];
  mentionNames: readonly string[];
  peer: ChatPeer;
  refresh(): Promise<void>;
  sendPlanChanges?(text: string): Promise<boolean>;
  /** Puts an example request into the group composer (quick starts). */
  fillComposer?(text: string): void;
  openTask?: (threadId: string) => void;
  openTasks?: () => void;
  thread: boolean;
  confirmed: boolean;
  loading: boolean;
  onRetry: ComponentProps<typeof ChatMessage>["onRetry"];
  onModelsSettings: () => void;
  onWorkplaceSettings?: () => void;
}) {
  const t = useT();
  const name = bot?.name ?? t("group.member");
  const presentation = useMemo(
    () => assignmentPresentation(message, activity, !!batch, !!collaborations, focusToolCallId),
    [message, activity, batch, collaborations, focusToolCallId],
  );
  const cardMessage = useMemo(() => {
    const value = fillComposer ? quickStartCardMessage(presentation.message) : presentation.message;
    const usage = value.usage;
    const decision = GroupWorkflowDecisionSchema.safeParse(
      usage && typeof usage === "object" && !Array.isArray(usage)
        ? usage.groupWorkflowDecision
        : undefined,
    );
    // The structured card replaces its program notice, including old bilingual notices.
    return value.role === "assistant" &&
      !value.runId &&
      decision.success &&
      decision.data.groupId === group?.id
      ? { ...value, content: "" }
      : value;
  }, [presentation.message, group?.id, fillComposer]);
  const imageActor = useMemo(
    () =>
      group
        ? { botId: group.coordinatorBotId, conversationId: group.conversationId, groupId: group.id }
        : undefined,
    [group],
  );
  const approvalContext = useMemo(
    () => (group ? { botName: name, groupName: group.name } : undefined),
    [group, name],
  );
  const active = run && (run.status === "queued" || run.status === "running");
  if (silentWake(message)) return null;
  const execution = GroupExecutionReceiptSchema.safeParse(
    !message.runId &&
      message.role === "assistant" &&
      message.status === "done" &&
      message.usage &&
      typeof message.usage === "object" &&
      !Array.isArray(message.usage)
      ? message.usage.groupExecution
      : undefined,
  );
  // Plan steps can belong to the original user message; both message roles need this footer.
  const assignments = (
    <GroupAssignments
      batch={batch}
      collaborations={collaborations}
      name={name}
      bots={bots}
      openTasks={openTasks}
      openTask={openTask}
      tasks={assignmentTasks}
      groupName={group?.name}
      onUserBubble={message.role === "user"}
    />
  );
  return (
    <>
      <MessageTime
        at={message.createdAt}
        previousAt={previousAt}
        firstTopicMessage={first}
        today={today}
      />
      <ChatMessage
        imageActor={imageActor}
        message={cardMessage}
        mentionNames={mentionNames}
        highlighted={highlighted}
        focusToolCallId={focusToolCallId}
        name={name}
        bot={bot}
        unknownAvatar
        queued={run?.status === "queued"}
        showProgress={run ? !!active : loading}
        botId={message.botId ?? undefined}
        busy
        onRetry={onRetry}
        onModelsSettings={onModelsSettings}
        onWorkplaceSettings={onWorkplaceSettings}
        activity={presentation.activity}
        refreshApprovals={refreshApprovals}
        decideApproval={decideApproval}
        heading={name}
        approvalContext={approvalContext}
        userFooter={
          <>
            <AdditionStatus
              message={message}
              {...(group
                ? {
                    target: {
                      kind: "group" as const,
                      groupId: group.id,
                      conversationId: message.conversationId,
                      agent: bot?.kind === "agent",
                    },
                  }
                : {})}
            />
            {assignments}
          </>
        }
        footer={
          <>
            {executionFooter}
            {!thread && execution.success && <GroupExecutionFact fact={execution.data} />}
            {!thread && (
              <GroupQuickStarts
                message={message}
                fill={fillComposer}
                disabled={loading || !confirmed}
              />
            )}
            {!thread && (
              <GroupPlanCard message={message} bots={bots} sendChanges={sendPlanChanges} />
            )}
            {!thread && group && <GroupPlanSave message={message} group={group} />}
            {assignments}
            {!thread && message.taskResult && openTask ? (
              <Button
                variant="ghost"
                onClick={() => {
                  if (message.taskResult) openTask(message.taskResult.threadId);
                }}
              >
                {t("group.viewThread")}
              </Button>
            ) : undefined}
            {active && (
              <GroupRunStop
                peer={peer}
                run={run}
                name={name}
                bot={bot}
                refresh={refresh}
                task={thread}
                showLabel={false}
              />
            )}
          </>
        }
        generatingLabel={t(
          !confirmed
            ? "group.statusUnknown"
            : run?.status === "queued"
              ? "group.runQueued"
              : "group.runRunning",
          { name },
        )}
      />
      {!thread && message.botId && memoryNoted(message.usage)?.length ? (
        <CorrectionMemoryNotice peer={peer} botId={message.botId} message={message} />
      ) : null}
    </>
  );
});
