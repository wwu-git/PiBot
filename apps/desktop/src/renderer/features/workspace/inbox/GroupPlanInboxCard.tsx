import type { InboxItem } from "@pibot/protocol";
import { useNavigation, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { GroupWorkflowDecisionCard } from "../../execution/GroupWorkflowDecisionCard.tsx";
import { MessageExecutionPause } from "../../execution/MessageExecutionPause.tsx";
import { GroupPlanCard } from "../../group/tasks/GroupPlanCard.tsx";
import styles from "./inbox.module.css";

/**
 * The original plan RPC owns confirmation; an inbox item never becomes an approval grant. The
 * inbox card around it owns the frame and the "open chat" link, so the plan and decision cards
 * render embedded and only a plan still open for changes adds "modify in chat".
 */
export function GroupPlanInboxCard({
  item,
  close,
}: {
  item: Extract<InboxItem, { kind: "group_plan" | "group_plan_action" }>;
  close(): void;
}) {
  const t = useT();
  const data = useWorkspace();
  const { navigate } = useNavigation();
  if (item.kind === "group_plan_action")
    return (
      <>
        <GroupWorkflowDecisionCard message={item.message} embedded />
        <MessageExecutionPause message={item.message} />
      </>
    );
  const editable = ["pending", "ready", "modify"].includes(item.card.status);
  return (
    <>
      <GroupPlanCard
        message={{ id: item.messageId, usage: { groupPlan: item.card } }}
        bots={data.bots}
        embedded
      />
      {editable && (
        <div className={styles.links}>
          <Button
            variant="pill"
            onClick={() => {
              close();
              navigate({
                name: "chat",
                groupId: item.groupId,
                focus: { messageId: item.messageId },
              });
            }}
          >
            {t("group.plan.modifyInChat")}
          </Button>
        </div>
      )}
    </>
  );
}
