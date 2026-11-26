import type { MemoryDreamSummary, MethodResults } from "@pibot/protocol";
import { useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button, IconTile, Switch } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../workspace/memory/settings/memory-settings.module.css";
import menu from "./app-menu.module.css";

type Changes = MethodResults["memory.dream.changes"];

export function MemoryDreamCards() {
  const { peer } = useRpc();
  const { t, settings, update } = useSettings();
  const [snapshot, setSnapshot] = useState<{
    peer: typeof peer;
    revision: number;
    summary: MemoryDreamSummary | null;
  }>();
  const summary = snapshot?.peer === peer ? (snapshot?.summary ?? null) : null;
  const [changes, setChanges] = useState<Changes>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"empty" | "busy" | "failed">();
  const [revision, setRevision] = useState(0);
  const live = useRef<AbortController | null>(null);
  useRpcEvent("memory.dream.finished", () => setRevision((value) => value + 1));
  useEffect(() => {
    setChanges(undefined);
    if (!peer) return;
    const controller = new AbortController();
    void peer
      .call("memory.dream.last", {}, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSnapshot({ peer, revision, summary: value });
      })
      .catch(() => {
        /* An older or disconnected brain cannot provide a summary. */
      });
    return () => controller.abort();
  }, [peer, revision]);
  useEffect(() => {
    if (!peer) return;
    return () => {
      live.current?.abort();
      live.current = null;
    };
  }, [peer]);
  const action = async (name: "run" | "undo" | "changes") => {
    if (!peer || live.current) return;
    const controller = new AbortController();
    live.current = controller;
    setPending(true);
    setStatus(undefined);
    try {
      if (name === "run") {
        const next = await peer.call(
          "memory.dream.run",
          { ownerInitiated: true },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setSnapshot({ peer, revision, summary: next });
        if (next.status === "done" && !next.merged && !next.retired && !next.proposed)
          setStatus("empty");
      } else if (summary && name === "undo") {
        await peer.call("memory.dream.undo", { id: summary.id }, { signal: controller.signal });
      } else if (summary) {
        if (changes) setChanges(undefined);
        else {
          const rows = await peer.call(
            "memory.dream.changes",
            { id: summary.id },
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) setChanges(rows);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setStatus(
          error instanceof Error && error.message === "memory_dream_busy" ? "busy" : "failed",
        );
    } finally {
      if (live.current === controller) {
        live.current = null;
        setPending(false);
      }
    }
  };
  const changeSettings = async (patch: Parameters<typeof update>[0]) => {
    try {
      await update(patch);
    } catch {
      setStatus("failed");
    }
  };
  const changed = summary && (summary.merged || summary.retired || summary.proposed);
  return (
    <>
      {!!changed && summary && (
        <div className={`${styles.card} ${menu.sortCard} ${menu.dreamCard}`}>
          <div className={menu.sortHead}>
            <IconTile icon="moon" tone="violet" />
            <p className={styles.meta}>
              <strong>{t("memorySettings.dream.title")}</strong>{" "}
              {t("memorySettings.dream.summary", {
                merged: summary.merged,
                retired: summary.retired,
                proposed: summary.proposed,
              })}
            </p>
            <div className={styles.toolbar}>
              {summary.undoable && (
                <Button
                  variant="pill"
                  className={styles.small}
                  disabled={pending}
                  onClick={() => void action("undo")}
                >
                  {t("memorySettings.dream.undo")}
                </Button>
              )}
              <Button
                variant="pill"
                className={styles.small}
                disabled={pending}
                aria-expanded={!!changes}
                onClick={() => void action("changes")}
              >
                {t("memorySettings.dream.changes")}
              </Button>
            </div>
          </div>
          {changes && (
            <ul aria-label={t("memorySettings.dream.changes")} className={menu.dreamChanges}>
              {changes.map((item) => (
                <li key={item.proposalId}>
                  <strong>{item.botName}</strong> · {item.text}
                </li>
              ))}
              {summary.proposed > 0 && <li>{t("memorySettings.dream.waiting")}</li>}
            </ul>
          )}
        </div>
      )}
      <div className={`${styles.card} ${menu.sortCard}`} aria-busy={pending}>
        <div className={menu.sortHead}>
          <IconTile icon="refresh" tone="pink" />
          <p className={styles.meta}>{t("memorySettings.dream.lead")}</p>
          <Button
            variant="pill"
            className={styles.small}
            disabled={!peer || pending}
            onClick={() => void action("run")}
          >
            {t("memorySettings.dream.run")}
          </Button>
        </div>
        <details className={menu.dreamOptions}>
          <summary>{t("memorySettings.dream.options")}</summary>
          <div className={menu.dreamSwitch}>
            {t("memorySettings.dream.automatic")}
            <Switch
              label={t("memorySettings.dream.automatic")}
              checked={!!settings?.memoryDreamEnabled}
              disabled={!settings || pending}
              onCheckedChange={(value) => void changeSettings({ memoryDreamEnabled: value })}
            />
          </div>
          <div className={menu.dreamSwitch}>
            {t("memorySettings.dream.localOnly")}
            <Switch
              label={t("memorySettings.dream.localOnly")}
              checked={!!settings?.memoryDreamLocalOnly}
              disabled={!settings || pending}
              onCheckedChange={(value) => void changeSettings({ memoryDreamLocalOnly: value })}
            />
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input = new FormData(event.currentTarget).get("budget");
              if (typeof input === "string" && input.trim())
                void changeSettings({ memoryDreamCostUsd: Number(input) });
            }}
          >
            <label>
              {t("memorySettings.dream.budget")}
              <input
                type="number"
                name="budget"
                min={0}
                max={100}
                step={0.01}
                required
                key={settings?.memoryDreamCostUsd ?? 0.05}
                defaultValue={settings?.memoryDreamCostUsd ?? 0.05}
                disabled={!settings || pending}
              />
            </label>
            <Button
              type="submit"
              variant="pill"
              className={styles.small}
              disabled={!settings || pending}
            >
              {t("memorySettings.dream.save")}
            </Button>
          </form>
        </details>
        {status && (
          <p role={status === "failed" ? "alert" : "status"}>
            {t(`memorySettings.dream.${status}`)}
          </p>
        )}
        {summary &&
          (summary.status === "limited" ||
            summary.status === "interrupted" ||
            summary.status === "failed") && (
            <p role="status">
              {t(
                `memorySettings.dream.${summary.status === "failed" ? "runFailed" : summary.status}`,
              )}
            </p>
          )}
      </div>
    </>
  );
}
