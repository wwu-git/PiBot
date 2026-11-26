import assert from "node:assert/strict";
import { lstat, mkdir, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type {
  Routine,
  RoutineDraftInput,
  RoutineRun,
} from "../../../packages/protocol/src/index.ts";
import { until } from "../chat/harness.ts";
import type { M3Fixture } from "./fixture.ts";
import { draft, terminal, watermark } from "./shared.ts";

function metadata(f: M3Fixture, messageId: string | null) {
  return JSON.parse(
    String(
      f.db.prepare("SELECT routine_trigger value FROM messages WHERE id=?").get(messageId)?.value,
    ),
  );
}
// A pause window has to fit the pause-time writes on a loaded machine too: with 1.5 s those writes
// could land after expiry and then legitimately count as post-expiry facts, so the run carried the
// during-* paths and the scenario failed for a reason that was not the product's.
const PAUSE_WINDOW_MS = 5_000;
// The native watcher keeps a 10 s quiet period (packages/scheduler/src/folders/folder-watch.ts) and
// its loop polls every 1 s, so a duplicate event that was already pending when the facts were
// consumed can still arrive ~11 s later. Negatives below have to outlast that whole window, or they
// would pass before the very event they exist to rule out.
const NATIVE_QUIET_MS = 10_000;
const WATCH_TICK_MS = 1_000;
/** Persist a pause and return the deadline the store actually holds (not the requested one). */
async function pause(f: M3Fixture, atMs: number) {
  await f.rpc.call("routines.pauseAll", { until: new Date(atMs).toISOString() });
  const persisted = f.service.settings.pausedUntil();
  assert(persisted);
  return Date.parse(persisted);
}
/** Wait until that persisted deadline has really passed; real timers, but read back from the store. */
async function waitPast(deadline: number, marginMs = 700) {
  for (
    let left = deadline + marginMs - Date.now();
    left > 0;
    left = deadline + marginMs - Date.now()
  )
    await wait(left);
}
/** The first real minute boundary at least `leadMs` away; cron fire times are never faked here. */
function cronBoundary(leadMs: number) {
  return (Math.floor((Date.now() + leadMs) / 60_000) + 1) * 60_000;
}
/** This UTC minute is the only occurrence within the acceptance window. */
function cronForUtcOccurrence(at: number): RoutineDraftInput["triggers"][number] {
  const date = new Date(at);
  return {
    kind: "cron",
    expr: `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`,
    timezone: "UTC",
  };
}
/** Facts meant to happen *during* the pause must land inside it; say so instead of failing later. */
function assertDuringPause(deadline: number, step: string) {
  assert(Date.now() < deadline, `暂停在${step}完成前到期`);
}
async function folderTask(
  f: M3Fixture,
  name: string,
  extra: RoutineDraftInput["triggers"] = [],
  events: "new" | "new_and_changed" = "new_and_changed",
) {
  const directory = join(f.primary, name);
  await mkdir(directory);
  await writeFile(join(directory, "during-existing.txt"), "original");
  await writeFile(join(directory, "later-existing.txt"), "original");
  const routine = await f.rpc.call(
    "routines.create",
    draft(f, {
      name,
      triggers: [{ kind: "folder", path: directory, events, cooldownMin: 1 }, ...extra],
    }),
  );
  return { directory, routine };
}
/**
 * The resumed routine must re-baseline the folder and consume the pause-time facts. Waiting for
 * that baseline to contain the pause-time file proves it happened; a fixed 11 s sleep proved
 * nothing and was too short whenever the resume scan landed later on a busy machine.
 */
async function assertNoRun(f: M3Fixture, r: Routine, resumeFile: string) {
  await until(
    `恢复后基线包含暂停期文件:${r.name}`,
    () => Promise.resolve(f.service.require(r.id).triggers[0]?.state.snapshot),
    (snapshot) => snapshot?.entries.some((entry) => entry.relativePath === resumeFile) === true,
  );
  await wait(NATIVE_QUIET_MS + WATCH_TICK_MS + 500);
  assert.equal(f.service.runs.list(r.id).length, 0);
}
export async function pauseFolderAcceptance(f: M3Fixture) {
  await f.replies(
    Array.from({ length: 16 }, () => ({ text: "暂停到期后的正常文件结果", delayMs: 0 })),
  );
  const early = await folderTask(f, "manual-early");
  await pause(f, Date.now() + 60000);
  await writeFile(join(early.directory, "during-new.txt"), "during");
  await writeFile(join(early.directory, "during-existing.txt"), "changed during");
  await f.rpc.call("routines.resumeAll", undefined);
  await assertNoRun(f, early.routine, "during-new.txt");
  await f.rpc.call("routines.setEnabled", { id: early.routine.id, enabled: false });

  const automatic = await folderTask(f, "automatic-expiry");
  const deadline = await pause(f, Date.now() + PAUSE_WINDOW_MS);
  await writeFile(join(automatic.directory, "during-new.txt"), "during");
  await writeFile(join(automatic.directory, "during-existing.txt"), "modified during");
  assertDuringPause(deadline, "暂停期写入");
  await until(
    "真实定时器解除到期暂停",
    () => f.rpc.call("routines.summary", undefined),
    (summary) => summary.pausedUntil === null,
  );
  await assertNoRun(f, automatic.routine, "during-new.txt");
  await writeFile(join(automatic.directory, "after-new.txt"), "after expiry");
  await writeFile(join(automatic.directory, "later-existing.txt"), "modified after");
  const [automaticRun] = await until(
    "自动到期正常native folder",
    async () => f.service.runs.list(automatic.routine.id),
    (rows) => rows.length === 1,
  );
  assert(automaticRun);
  await terminal(f, automaticRun.id);
  assert.deepEqual(
    new Set(metadata(f, automaticRun.triggerMessageId).paths),
    new Set([
      join(automatic.directory, "after-new.txt"),
      join(automatic.directory, "later-existing.txt"),
    ]),
  );
  await f.rpc.call("routines.setEnabled", { id: automatic.routine.id, enabled: false });

  const newlyCreated = await folderTask(f, "new-only-expiry", [], "new");
  const creationDeadline = await pause(f, Date.now() + PAUSE_WINDOW_MS);
  await writeFile(join(newlyCreated.directory, "during-new.txt"), "during");
  assertDuringPause(creationDeadline, "暂停期写入");
  await f.stop();
  await waitPast(creationDeadline);
  await writeFile(
    join(newlyCreated.directory, "during-new.txt"),
    "modified after, not newly created",
  );
  const newPath = join(newlyCreated.directory, "known-new.txt");
  await writeFile(newPath, "created after expiry");
  const ambiguous = join(newlyCreated.directory, "restored-timestamps.txt");
  await writeFile(ambiguous, "copied after expiry");
  // Some filesystems also backdate birthtime when restoring mtime. Do not invent unavailable creation history.
  await utimes(ambiguous, new Date("2020-01-01"), new Date("2020-01-01"));
  const restored = await lstat(ambiguous);
  await f.boot();
  // The recovery scan of a freshly booted owner creates the run asynchronously.
  const [createdRun] = await until(
    "重启后新文件事实",
    async () => f.service.runs.list(newlyCreated.routine.id),
    (rows) => rows.length === 1,
  );
  assert(createdRun);
  await terminal(f, createdRun.id);
  assert.deepEqual(
    new Set(metadata(f, createdRun.triggerMessageId).paths),
    new Set([
      newPath,
      ...(restored.birthtimeMs > creationDeadline && restored.birthtimeMs <= Date.now()
        ? [ambiguous]
        : []),
    ]),
  );
  await f.rpc.call("routines.setEnabled", { id: newlyCreated.routine.id, enabled: false });

  for (const policy of ["catchup", "skip", "ask"] as const) {
    await f.rpc.call("routines.settings.set", { missedPolicy: policy });
    // Leave room for fixture creation and pause-time writes before the intended occurrence.
    const cronAt = policy === "ask" ? cronBoundary(PAUSE_WINDOW_MS + 7_000) : null;
    const { directory, routine } = await folderTask(
      f,
      `expired-${policy}`,
      cronAt === null ? [] : [cronForUtcOccurrence(cronAt)],
    );
    const assertSingleRun = (rows: RoutineRun[], stage: string) => {
      if (rows.length === 1) return;
      // Put reasons first because the supervisor truncates failure lines.
      const runs = rows
        .slice(0, 3)
        .map(({ reason, triggerId, scheduledFor, dedupeKey }) => [
          reason,
          triggerId?.slice(-8),
          scheduledFor?.slice(11, 19),
          dedupeKey?.slice(-12),
        ]);
      assert.equal(
        rows.length,
        1,
        `恢复和native不能重复消费同一批事实 ${JSON.stringify({
          policy,
          stage,
          "runs[reason,trigger,timeUTC,key]": runs,
          cronAt: cronAt === null ? null : new Date(cronAt).toISOString(),
        })}`,
      );
    };
    const expires = await pause(f, cronAt === null ? Date.now() + PAUSE_WINDOW_MS : cronAt - 2_000);
    await writeFile(join(directory, "during-new.txt"), "during");
    await writeFile(join(directory, "during-existing.txt"), "changed during");
    assertDuringPause(expires, "暂停期写入");
    if (cronAt !== null) watermark(f, routine, new Date(cronAt - 600_000).toISOString());
    await f.stop();
    // Recovery must see both the eligible folder facts and the same real cron occurrence.
    await waitPast(cronAt ?? expires);
    const lateNames =
      policy === "catchup" ? Array.from({ length: 60 }, (_, i) => `late-${i}.txt`) : ["late.txt"];
    await Promise.all(lateNames.map((name) => writeFile(join(directory, name), "after expiry")));
    await writeFile(join(directory, "later-existing.txt"), "changed after expiry");
    const beforeRequests = f.requests.length;
    await f.boot();
    const [run] = await until(
      "重启后暂停到期事实",
      async () => {
        const rows = f.service.runs.list(routine.id);
        if (rows.length > 1) assertSingleRun(rows, "recovery");
        return rows;
      },
      (rows) => rows.length === 1,
    );
    assert(run);
    assert.equal((await terminal(f, run.id)).status, "done");
    assert.equal(run.reason, "folder");
    assertSingleRun(f.service.runs.list(routine.id), "after-folder-completed");
    const trigger = metadata(f, run.triggerMessageId);
    assert(trigger.paths.length <= 50);
    assert.equal(trigger.paths.length + trigger.extraCount, lateNames.length + 1);
    assert(!trigger.paths.includes(join(directory, "during-new.txt")));
    assert(!trigger.paths.includes(join(directory, "during-existing.txt")));
    if (policy !== "catchup")
      assert.deepEqual(
        new Set(trigger.paths),
        new Set([join(directory, "late.txt"), join(directory, "later-existing.txt")]),
      );
    assert.equal(f.requests.length, beforeRequests + 1);
    const input = JSON.stringify(f.requests.at(-1)?.body.messages);
    assert(input.includes(policy === "catchup" ? "late-" : "late.txt"));
    if (policy !== "catchup") assert(input.includes("later-existing.txt"));
    assert(!input.includes("during-new.txt"));
    assert(!input.includes("during-existing.txt"));
    if (cronAt !== null) {
      const cron = f.service.require(routine.id).triggers.find((t) => t.config.kind === "cron");
      const lastScheduledAt = cron?.state.lastScheduledAt;
      assert(
        lastScheduledAt && Date.parse(lastScheduledAt) >= cronAt,
        `恢复必须消费指定 UTC cron 时点 ${new Date(cronAt).toISOString()}，实际 ${lastScheduledAt ?? "无"}`,
      );
    }
    // The recovery scan and the live watcher must not consume the same facts twice. Waiting for the
    // fired trigger state (facts consumed, live baseline advanced) proves the consumption happened,
    // then the full native window has to pass: a duplicate event was already pending at that point
    // and only surfaces after the quiet period, so a shorter wait would pass before it.
    await until(
      "folder事实已消费",
      async () => f.service.require(routine.id),
      (row) => {
        const folder = row.triggers.find((t) => t.config.kind === "folder");
        return (
          folder?.state.snapshot?.entries.some((entry) => entry.relativePath === lateNames[0]) ===
            true && !folder.state.pendingCount
        );
      },
    );
    await wait(NATIVE_QUIET_MS + WATCH_TICK_MS + 500);
    assertSingleRun(f.service.runs.list(routine.id), "after-native-quiet-window");
    const folder = f.service.require(routine.id).triggers.find((t) => t.config.kind === "folder");
    assert(folder);
    assert.equal(folder.state.pendingCount ?? 0, 0, `${policy} 已消费的文件批次不能重新待处理`);
    await f.rpc.call("routines.setEnabled", { id: routine.id, enabled: false });
    await f.stop();
    await f.boot();
    assertSingleRun(f.service.runs.list(routine.id), "after-second-restart");
  }

  const empty = await folderTask(f, "no-snapshot");
  const emptyDeadline = await pause(f, Date.now() + PAUSE_WINDOW_MS);
  const trigger = f.service.require(empty.routine.id).triggers[0];
  assert(trigger);
  const { snapshot: _snapshot, ...without } = trigger.state;
  assert(f.service.triggers.checkpoint(trigger.id, trigger.state, without));
  assertDuringPause(emptyDeadline, "去除快照");
  await f.stop();
  await waitPast(emptyDeadline);
  await writeFile(join(empty.directory, "known-late.txt"), "provable later creation");
  await f.boot();
  const [newRun] = await until(
    "无快照重启后的新文件",
    async () => f.service.runs.list(empty.routine.id),
    (rows) => rows.length === 1,
  );
  assert(newRun);
  await terminal(f, newRun.id);
  assert.deepEqual(metadata(f, newRun.triggerMessageId).paths, [
    join(empty.directory, "known-late.txt"),
  ]);
  await f.rpc.call("routines.setEnabled", { id: empty.routine.id, enabled: false });

  const invalid = await folderTask(f, "missing-directory");
  const invalidDeadline = await pause(f, Date.now() + PAUSE_WINDOW_MS);
  await f.stop();
  await waitPast(invalidDeadline);
  await rename(invalid.directory, `${invalid.directory}-moved`);
  await f.boot();
  await until(
    "失效目录暂停",
    async () => f.service.require(invalid.routine.id),
    (row) => row.pausedReason === "trigger_error",
  );
  assert.equal(f.service.runs.list(invalid.routine.id).length, 0);
  await rename(`${invalid.directory}-moved`, invalid.directory);
  await f.rpc.call("routines.setEnabled", { id: invalid.routine.id, enabled: false });

  const cancelled = await folderTask(f, "cancel-baseline");
  const cancelledUntil = Date.now() + 60000;
  await pause(f, cancelledUntil);
  const before = f.service.require(cancelled.routine.id).triggers;
  await writeFile(join(cancelled.directory, "unconsumed.txt"), "during pause");
  const pending = f.service.resumeAll();
  queueMicrotask(() => f.service.lifetime.abort());
  await assert.rejects(pending);
  assert.equal(f.service.settings.pausedUntil(), new Date(cancelledUntil).toISOString());
  assert.deepEqual(f.service.require(cancelled.routine.id).triggers, before);
  assert.equal(f.service.runs.list(cancelled.routine.id).length, 0);
}
