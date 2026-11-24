import type { ChatPeer } from "@pibot/client-core";
import { RpcError } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../chat.module.css";

export function CompactionActions({
  peer,
  botId,
  conversationId,
  disabled,
  dismiss,
}: {
  peer: ChatPeer;
  botId: string;
  conversationId: string;
  disabled: boolean;
  dismiss(): void;
}) {
  const t = useT();
  const active = useRef<{ requestId: string; signal: AbortController } | undefined>(undefined);
  const successTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<"done" | "mechanical" | "failed" | "nothing">();
  const cancel = useCallback(() => {
    const current = active.current;
    if (!current) return;
    void peer
      .call("chat.compact.cancel", { botId, conversationId, requestId: current.requestId })
      .catch(() => {
        // Local disconnect cannot certify server cancellation; the server retains its operation lease.
      });
  }, [peer, botId, conversationId]);
  useEffect(
    () => () => {
      cancel();
      active.current?.signal.abort();
    },
    [cancel],
  );
  useEffect(
    () => () => {
      clearTimeout(successTimer.current);
      successTimer.current = undefined;
    },
    [],
  );
  const compact = async (fork: boolean) => {
    if (active.current || disabled) return;
    clearTimeout(successTimer.current);
    successTimer.current = undefined;
    const current = { requestId: crypto.randomUUID(), signal: new AbortController() };
    active.current = current;
    setPending(true);
    setResult(undefined);
    try {
      const result = await peer.call(
        "chat.compact",
        { botId, conversationId, requestId: current.requestId, fork },
        { timeoutMs: 1_210_000, signal: current.signal.signal },
      );
      if (!current.signal.signal.aborted) {
        setResult(result.mechanical ? "mechanical" : "done");
        if (!result.mechanical) {
          const timer = setTimeout(() => {
            // An earlier completion must not close a newer compaction or a different topic.
            if (successTimer.current !== timer || current.signal.signal.aborted) return;
            successTimer.current = undefined;
            setResult(undefined);
            dismiss();
          }, 5_000);
          successTimer.current = timer;
        }
      }
    } catch (error) {
      // A topic whose replies never created a model session (welcome text, a failed first turn)
      // has nothing to summarize; that is not a failure worth retrying.
      if (!current.signal.signal.aborted)
        setResult(
          error instanceof RpcError && error.message === "session_unavailable"
            ? "nothing"
            : "failed",
        );
    } finally {
      if (active.current === current) {
        active.current = undefined;
        if (!current.signal.signal.aborted) setPending(false);
      }
    }
  };
  return (
    <div className={`${styles.notice} ${styles.band}`} data-tone="info" role="status">
      {pending ? (
        <>
          {t("chat.compacting")}{" "}
          <Button variant="ghost" onClick={cancel}>
            {t("chat.compactCancel")}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" disabled={disabled} onClick={() => void compact(false)}>
            {t("chat.compactNow")}
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={() => void compact(true)}>
            {t("chat.compactNewTopic")}
          </Button>
        </>
      )}
      {result && (
        <span>
          {t(
            result === "mechanical"
              ? "chat.compactMechanical"
              : result === "nothing"
                ? "chat.compactNothing"
                : result === "failed"
                  ? "chat.compactFailed"
                  : "chat.compactDone",
          )}
        </span>
      )}
    </div>
  );
}
