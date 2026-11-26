import type { Memory, MemoryOwner, MethodParams, MethodResults } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useState } from "react";
import { MemoryDetails } from "./MemoryDetails.tsx";
import { MemoryEditor } from "./MemoryEditor.tsx";
import { MemoryMenu } from "./MemoryMenu.tsx";
import styles from "./memory-settings.module.css";

export function MemoryEntry({
  memory,
  owner,
  busy,
  change,
  presentation,
}: {
  memory: Memory;
  owner: MemoryOwner;
  busy: boolean;
  change(value: MethodParams["memory.manage"]["change"]): Promise<boolean>;
  presentation?: NonNullable<MethodResults["memory.browse"]["presentation"]>[number];
}) {
  const t = useT();
  const [editing, setEditing] = useState<Memory>();
  const [details, setDetails] = useState(false);
  const metrics = presentation?.recallMetrics;
  const unused =
    metrics &&
    Date.parse(metrics.lastUsedAt ?? metrics.measuredSince) < Date.now() - 90 * 86400_000;
  return (
    <article className={styles.entry} data-memory-entry={memory.id}>
      {editing ? (
        <MemoryEditor
          initial={editing}
          busy={busy}
          cancel={() => setEditing(undefined)}
          save={(text, category) =>
            change({ action: "update", id: memory.id, expected: editing, text, category })
          }
        />
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.entryText}
            disabled={busy}
            onClick={() => setEditing(memory)}
          >
            <span className={styles.rowText}>{memory.text}</span>
            <small className={styles.meta}>
              {presentation?.botName
                ? t("memorySettings.rememberedBy", { name: presentation.botName })
                : t("memorySettings.addedByYou")}{" "}
              · {new Date(memory.createdAt).toLocaleDateString()}
              {!!presentation?.edits &&
                ` · ${t("memorySettings.edits", { count: presentation.edits })}`}
              {` · ${
                metrics?.lastUsedAt
                  ? t("memorySettings.recallUsed", {
                      date: new Date(metrics.lastUsedAt).toLocaleDateString(),
                      used: metrics.usedCount,
                      injected: metrics.injectedCount,
                    })
                  : metrics
                    ? t("memorySettings.recallUnused", { injected: metrics.injectedCount })
                    : t("memorySettings.recallUnavailable")
              }`}
              {unused && ` · ${t("memorySettings.unused")}`}
              {memory.archivedAt && ` · ${t("memorySettings.archived")}`}
            </small>
          </button>
          <div className={styles.rowMenu}>
            <MemoryMenu compact label={t("memorySettings.actions")}>
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(memory)}>
                <IconTile icon="edit" tone="blue" size="sm" />
                {t("memorySettings.edit")}
              </Button>
              <Button variant="ghost" aria-expanded={details} onClick={() => setDetails(!details)}>
                <IconTile icon="audit" tone="teal" size="sm" />
                {t("memorySettings.details")}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void change({
                    action: "archive",
                    id: memory.id,
                    expected: memory,
                    archived: !memory.archivedAt,
                  })
                }
              >
                <IconTile
                  icon={memory.archivedAt ? "refresh" : "archive"}
                  tone={memory.archivedAt ? "green" : "orange"}
                  size="sm"
                />
                {t(memory.archivedAt ? "memorySettings.restore" : "memorySettings.archive")}
              </Button>
              <Button
                variant="ghost"
                className={styles.danger}
                disabled={busy}
                onClick={() => void change({ action: "remove", id: memory.id, expected: memory })}
              >
                <IconTile icon="trash" tone="red" size="sm" />
                {t("memorySettings.delete")}
              </Button>
            </MemoryMenu>
          </div>
        </div>
      )}
      {details && (
        <div className={styles.details}>
          <MemoryDetails key={`${memory.id}:${memory.updatedAt}`} owner={owner} id={memory.id} />
        </div>
      )}
    </article>
  );
}
