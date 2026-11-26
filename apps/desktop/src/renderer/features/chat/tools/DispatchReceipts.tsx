import type { PiDispatch } from "@pibot/protocol";
import {
  approvalStyles as styles,
  useNavigation,
  useRpc,
  useRpcEvent,
  useSettings,
} from "@pibot/renderer-kit";
import { Button, Icon, type IconName } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import lively from "./lively.module.css";
import own from "./manager-card.module.css";

const ICONS: Record<PiDispatch["status"], IconName> = {
  working: "clock",
  waiting: "hand",
  done: "check",
  failed: "warning",
  stopped: "stop",
};

/** The work the default Pi handed out in this reply, one receipt card each (live). */
export function DispatchReceipts({ messageId }: { messageId: string }) {
  const { peer } = useRpc();
  const [items, setItems] = useState<PiDispatch[]>([]);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (!peer) return;
    try {
      setItems(await peer.call("teams.dispatches", { messageId }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [peer, messageId]);
  useEffect(() => {
    void load();
  }, [load]);
  useRpcEvent("teams.dispatch.changed", (event) => {
    if (event.messageId === messageId) void load();
  });
  const { t } = useSettings();
  if (failed)
    return (
      <p role="alert">
        {t("workspace.failed")}{" "}
        <Button variant="pill" onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      </p>
    );
  return items.map((item) => <DispatchReceipt key={item.id} item={item} />);
}

function DispatchReceipt({ item }: { item: PiDispatch }) {
  const { t } = useSettings();
  const { navigate } = useNavigation();
  const finished = item.finishedAt ? Date.parse(item.finishedAt) : undefined;
  const seconds = finished
    ? Math.max(1, Math.round((finished - Date.parse(item.createdAt)) / 1000))
    : 0;
  const status = t(`dispatch.status.${item.status}`);
  const result = finished
    ? t("dispatch.duration", {
        status,
        time:
          seconds >= 60
            ? t("dispatch.minutes", { count: Math.round(seconds / 60) })
            : t("dispatch.seconds", { count: seconds }),
      })
    : status;
  const conversationId = item.targetConversationId;
  return (
    <section
      className={`${styles.approval} ${lively.card}`}
      aria-label={t("dispatch.label")}
      data-tone={item.status === "failed" ? "red" : undefined}
    >
      <header>
        <span aria-hidden="true">
          <Icon name={ICONS[item.status]} />
        </span>
        <strong>{t(`dispatch.title.${item.status}`, { target: item.targetName, pi: "Pi" })}</strong>
      </header>
      <dl className={styles.facts}>
        <div>
          <dt>{t("dispatch.row.result")}</dt>
          <dd>{result}</dd>
        </div>
        {item.summary && (
          <div>
            <dt>{t("dispatch.row.summary")}</dt>
            <dd>{item.summary}</dd>
          </div>
        )}
        {item.outputs.length > 0 && (
          <div>
            <dt>{t("dispatch.row.outputs")}</dt>
            <dd>{item.outputs.join(t("tool.group.separator"))}</dd>
          </div>
        )}
      </dl>
      {conversationId && (
        <footer className={own.choices}>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={() =>
                navigate(
                  item.targetKind === "bot"
                    ? { name: "chat", botId: item.targetId, topicId: conversationId }
                    : { name: "chat", groupId: item.targetId, topicId: conversationId },
                )
              }
            >
              {t("dispatch.open", { target: item.targetName })}
            </Button>
          </div>
        </footer>
      )}
    </section>
  );
}
