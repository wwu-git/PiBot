import { replyCitationText } from "@pibot/client-core";
import { type Message, replyProgressStart } from "@pibot/protocol";
import { useSettings, useT } from "@pibot/renderer-kit";
import { Icon } from "@pibot/ui";
import { useId, useState } from "react";
import chatStyles from "../chat.module.css";
import { imageMessageContent } from "./image-message-content.ts";
import { Markdown } from "./Markdown.tsx";
import { messageClock, messageDateTime } from "./message-time-label.ts";
import styles from "./reply-content.module.css";

export function ReplyContent({
  message,
  botId,
  mentionNames,
  streaming,
  paused = false,
  generating,
}: {
  message: Message;
  botId?: string;
  mentionNames?: readonly string[];
  streaming: boolean;
  /** The run waits for the person (a card): the text is complete for now, no caret. */
  paused?: boolean;
  generating: string;
}) {
  const t = useT();
  const { language } = useSettings();
  const [expanded, setExpanded] = useState(false);
  // Maintainers 2026-11-13: each reply's send time shows quietly on hover; separators stay gap-based.
  const sent = new Date(message.createdAt);
  const sentValid = !Number.isNaN(sent.getTime());
  const historyId = useId();
  const text = imageMessageContent(message);
  const start = replyProgressStart(message, text);
  const history = text.slice(0, start);
  const current = text.slice(start);
  // The last note always says what the check covers; the ones before it are the findings.
  const citations = replyCitationText(message, t);
  const markdown = (content: string, settled: boolean) => (
    <Markdown
      text={content}
      mentionNames={mentionNames}
      botId={botId ?? message.botId ?? undefined}
      messageId={message.id}
      settled={settled}
    />
  );
  return (
    <>
      {history.trim() && (
        <div className={styles.history}>
          <button
            type="button"
            className={styles.toggle}
            aria-label={t(expanded ? "chat.progress.collapse" : "chat.progress.expand")}
            aria-expanded={expanded}
            aria-controls={historyId}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon
              name="chevron"
              size={14}
              style={{ transform: expanded ? undefined : "rotate(-90deg)" }}
            />
            <span>{t("chat.progress.label")}</span>
          </button>
          <div id={historyId} hidden={!expanded} className={styles.details}>
            {expanded && markdown(history, true)}
          </div>
        </div>
      )}
      <div className={chatStyles.bubbleRow}>
        <div className={chatStyles.bubble}>
          {markdown(current, message.status !== "streaming")}
          {streaming && !paused && (
            <span className={chatStyles.cursor} role="status" aria-label={generating} />
          )}
        </div>
        {sentValid && !streaming && (
          <time
            className={chatStyles.sentAt}
            dateTime={message.createdAt}
            title={messageDateTime(sent, language)}
          >
            {sent.toDateString() === new Date().toDateString()
              ? messageClock(sent, language)
              : messageDateTime(sent, language)}
          </time>
        )}
      </div>
      {citations.length > 0 && (
        // C-cite: unread or unchecked sources read as a warn band under the reply.
        <div
          className={`${chatStyles.band} ${styles.citations}`}
          data-tone={citations.length > 1 ? "warn" : "info"}
          role="note"
        >
          {citations.slice(0, -1).map((note) => (
            <p key={note}>{note}</p>
          ))}
          <small>{citations.at(-1)}</small>
        </div>
      )}
    </>
  );
}
