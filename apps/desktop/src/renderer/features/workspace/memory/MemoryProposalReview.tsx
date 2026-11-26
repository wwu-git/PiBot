import type { Memory, MemoryProposal } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { ReactNode } from "react";
import { useTopicReference } from "../../../app/topic-reference.tsx";
import styles from "../workspace.module.css";
import { MemoryScopeLabel } from "./MemoryScopeLabel.tsx";

export function MemoryProposalReview({
  proposal,
  memories,
  loading = false,
  busy,
  resolve,
  retry,
  showSource = false,
  mark,
}: {
  proposal: MemoryProposal;
  memories?: Memory[];
  loading?: boolean;
  busy: boolean;
  resolve(accept: boolean): void;
  retry?(): void;
  /** The inbox header already names the origin; other review screens ask for this line. */
  showSource?: boolean;
  /** A small tile before the title puts title and scope on one line (chat notices). */
  mark?: ReactNode;
}) {
  const t = useT();
  const { open, busy: opening, error: sourceError } = useTopicReference();
  const target = memories?.find(
    (memory) =>
      memory.id === proposal.memoryId &&
      (memory.scope === "user" ? proposal.scope === "user" : memory.botId === proposal.botId),
  );
  const action = proposal.action;
  const title = (
    <strong>
      {t(`workspace.propose.${action}`)} · {t(`workspace.category.${proposal.category ?? "other"}`)}
    </strong>
  );
  return (
    <>
      {mark ? (
        <div className={styles.noticeHead}>
          {mark}
          {title}
          <MemoryScopeLabel scope={proposal.scope} />
        </div>
      ) : (
        <>
          {title}
          <MemoryScopeLabel scope={proposal.scope} />
        </>
      )}
      {showSource && proposal.sourceConversationId && (
        <p>
          {t("workspace.memorySource")}{" "}
          <button
            type="button"
            className={styles.memoryLink}
            disabled={opening}
            onClick={() =>
              proposal.sourceConversationId &&
              open(proposal.sourceConversationId, proposal.messageId)
            }
          >
            {proposal.sourceTitle || t("workspace.memorySourceOpen")}
          </button>
        </p>
      )}
      {showSource && sourceError && (
        <p role="alert" className={styles.error}>
          {t(sourceError)}
        </p>
      )}
      {proposal.projectPath && proposal.projectDiff && (
        <div className={styles.memoryProposal}>
          <p>{proposal.projectPath}</p>
          <pre>{proposal.projectDiff}</pre>
        </div>
      )}
      {action === "move" ? (
        <>
          <p>
            {t("workspace.memoryMoveTo", { bot: proposal.moveTargetBotName ?? "Bot" })}{" "}
            {proposal.text}
          </p>
          {proposal.moveTargetMemoryId && proposal.moveTargetText && (
            <p>
              {t("workspace.memoryMoveMerged")} {proposal.moveTargetText}
            </p>
          )}
        </>
      ) : (
        action !== "add" &&
        (target ? (
          <p>
            {t(action === "remove" ? "workspace.memoryRemoveTarget" : "workspace.memoryTarget")}{" "}
            {target.text} · {t(`workspace.category.${target.category ?? "other"}`)}
          </p>
        ) : (
          <p role={loading ? "status" : "alert"}>
            {t(loading ? "common.loading" : "workspace.memoryTargetUnavailable")}
            {!loading && retry && (
              <Button variant="ghost" disabled={busy} onClick={retry}>
                {t("common.retry")}
              </Button>
            )}
          </p>
        ))
      )}
      {action !== "remove" && action !== "move" && (
        <p>
          {t("workspace.memoryReplacement")} {proposal.text}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          disabled={busy || (action !== "add" && action !== "move" && (!target || loading))}
          onClick={() => resolve(true)}
        >
          {t(`workspace.confirmMemory.${action}`)}
        </Button>
        <Button variant="pill" disabled={busy} onClick={() => resolve(false)}>
          {t(action === "move" ? "workspace.memoryMoveKeep" : "workspace.reject")}
        </Button>
      </div>
    </>
  );
}
