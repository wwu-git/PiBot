import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask, GroupTaskBrief } from "@pibot/protocol";
import { useEffect, useState } from "react";

/**
 * The step facts behind a task's brief. `null`: not a plan step (or the read failed), so the
 * panel keeps the plain text; `undefined` while the first read is in flight.
 */
export function useTaskBrief(peer: ChatPeer, task: GroupTask) {
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{ key: string; brief: GroupTaskBrief | null }>();
  const key = `${task.groupId}:${task.id}`;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Step states and file writes arrive in bursts while a member works; one read per burst.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((v) => v + 1), 400);
    };
    const off = [
      peer.on("groups.changed", (event) => {
        if (event.groupId === task.groupId) schedule();
      }),
      peer.on("chat.tool", (item) => {
        if (item.groupId === task.groupId && item.phase === "end") schedule();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const stop of off) stop();
    };
  }, [peer, task.groupId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: task status and check changes invalidate the facts.
  useEffect(() => {
    const controller = new AbortController();
    peer
      .call(
        "groups.tasks.brief",
        { groupId: task.groupId, taskId: task.id },
        { signal: controller.signal, timeoutMs: 10000 },
      )
      .then((brief) => {
        if (!controller.signal.aborted) setValue({ key, brief });
      })
      .catch(() => {
        // The text view is the complete fallback; a later event or task change reads again.
        if (!controller.signal.aborted)
          setValue((old) => (old?.key === key ? old : { key, brief: null }));
      });
    return () => controller.abort();
  }, [peer, key, revision, task.status, task.handoff?.state, task.handoff?.items.length]);
  return value?.key === key ? value.brief : undefined;
}
