import type { LiveActivity } from "@pibot/protocol-base";
import type { LiveActivityRepo } from "@pibot/storage";

/** At most two snapshots a second: a streaming reply changes plan steps and status often. */
const MIN_INTERVAL_MS = 500;

/**
 * Project committed run, plan, routine and approval facts into the live island's busy-Bot list.
 * Reads happen after the publishing event's transaction (like the active-run count) and at most
 * every MIN_INTERVAL_MS; a snapshot equal to the last one is not sent again.
 */
export function createLiveActivity(
  repo: LiveActivityRepo,
  emit: (value: LiveActivity) => void,
  failed: () => void,
) {
  const changes = new Set([
    "chat.status",
    "chat.done",
    "chat.error",
    "inbox.changed",
    "routines.changed",
    "approval.requested",
    "approval.resolved",
    "execution.todo.changed",
    "group.task",
    "groups.plan.changed",
    "bots.changed",
  ]);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;
  let lastAt = 0;
  // The owner starts from an empty island, so an empty first snapshot needs no event.
  let previous = "[]";
  const refresh = () => {
    if (disposed) return;
    lastAt = Date.now();
    const items = repo.list();
    const snapshot = JSON.stringify(items);
    if (snapshot === previous) return;
    previous = snapshot;
    emit({ items });
  };
  const run = () => {
    timer = undefined;
    scheduled = false;
    try {
      refresh();
    } catch {
      // A failed read (database closing) leaves the island on its last snapshot; the next
      // change event tries again.
      failed();
    }
  };
  return {
    refresh,
    changed(method: string) {
      if (disposed || scheduled || !changes.has(method)) return;
      scheduled = true;
      const wait = Math.max(0, lastAt + MIN_INTERVAL_MS - Date.now());
      // Even with no wait, read after the publisher's synchronous transaction has committed.
      if (wait === 0) queueMicrotask(run);
      else timer = setTimeout(run, wait);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
