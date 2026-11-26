import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPowerLease } from "../../../packages/routines/src/host/power/lease.ts";
import { until } from "../chat/harness.ts";
import { filesAcceptance } from "./files.ts";
import { exerciseTray } from "./host.ts";
import { draft, type Exercise, terminal, watermark } from "./shared.ts";

export async function schedulerAcceptance(exercise: Exercise) {
  await exercise("cron三策略、多次一次、24h及201分页取消", async (f) => {
    await f.replies(Array.from({ length: 12 }, () => ({ text: "自动补跑结果", delayMs: 0 })));
    for (const policy of ["catchup", "skip", "ask"] as const) {
      const r = await f.rpc.call(
        "routines.create",
        draft(f, {
          name: policy,
          missedPolicy: policy,
          triggers: [{ kind: "cron", expr: "* * * * *", timezone: "UTC" }],
        }),
      );
      await f.dev({
        type: "dev-power",
        supply: "ac",
        event: "suspend",
        at: new Date().toISOString(),
      });
      watermark(f, r, new Date(Date.now() - 10 * 60000).toISOString());
      await f.dev({
        type: "dev-power",
        supply: "ac",
        event: "resume",
        at: new Date().toISOString(),
      });
      const rows = f.service.runs.list(r.id);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert(row);
      if (policy === "catchup") assert.equal((await terminal(f, row.id)).status, "done");
      else if (policy === "skip") assert.equal(rows[0]?.status, "skipped_missed");
      else {
        assert.equal(rows[0]?.status, "missed");
        await f.rpc.call("routines.missed.resolve", {
          runId: row.id,
          action: "skip",
          missedPolicy: "ask",
        });
        assert.equal((await f.rpc.call("routines.settings.get", undefined)).missedPolicy, "ask");
      }
      await f.rpc.call("routines.setEnabled", { id: r.id, enabled: false });
      watermark(f, r, new Date(Date.now() - 10 * 60000).toISOString());
      await f.rpc.call("routines.setEnabled", { id: r.id, enabled: true });
      f.service.recovered();
      await f.service.tick();
      assert.equal(f.service.runs.list(r.id).length, 1);
      await f.rpc.call("routines.setEnabled", { id: r.id, enabled: false });
    }
    const old = await f.rpc.call(
      "routines.create",
      draft(f, { name: "太旧", triggers: [{ kind: "cron", expr: "0 0 1 1 *", timezone: "UTC" }] }),
    );
    // Stop the service's own timer first: a timer tick already scanning when the direct recovery
    // tick started cleared the recovery flag under it, so the run landed as an ordinary one
    // ("running") or not within the wait (both seen under a niced run on 2026-11-25). Resuming
    // is a real recovery: it marks the downtime and ticks through the same queue.
    await f.service.pauseAutomation();
    watermark(f, old, "2025-01-01T00:00:00.000Z");
    await f.service.resumeAutomation();
    // The service's own 1 s timer ticks through its queue as well; when it takes this routine
    // first, the direct tick above finds nothing new and the run lands a moment later. Wait for
    // the scheduler to go idle instead of racing it (failed under load on 2026-11-15).
    for (let i = 0; i < 100 && (!f.service.automationIdle() || !f.service.runs.list(old.id).length); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const skipped = f.service.runs.list(old.id)[0];
    assert.equal(skipped?.status, "skipped_missed");
    assert.equal(skipped?.errorCode, "missed_too_old");
    const foreign = await f.rpc.call("routines.create", draft(f, { name: "外国记录" }));
    for (let i = 0; i < 201; i++)
      f.service.runs.enqueue({
        routineId: foreign.id,
        botId: f.bot.id,
        triggerId: null,
        reason: "cron",
        scheduledFor: new Date().toISOString(),
        dedupeKey: randomUUID(),
        status: "missed",
      });
    const target = await f.rpc.call("routines.create", draft(f, { name: "末页目标" }));
    const pending = f.service.runs.enqueue({
      routineId: target.id,
      botId: f.bot.id,
      triggerId: null,
      reason: "cron",
      scheduledFor: new Date().toISOString(),
      dedupeKey: randomUUID(),
      status: "missed",
    });
    f.db
      .prepare("UPDATE routine_runs SET created_at=? WHERE id=?")
      .run("2001-01-01T00:00:00.000Z", pending.id);
    assert(!f.service.runs.page("missed", { limit: 200 }).some((r) => r.id === pending.id));
    const rows = await f.rpc.call("routines.rows", { ids: [foreign.id, target.id] });
    assert.equal(rows.rows.find((row) => row.routineId === foreign.id)?.attentionCount, 201);
    assert.equal(rows.rows.find((row) => row.routineId === target.id)?.attentionCount, 1);
    await f.rpc.call("routines.delete", { id: target.id });
    assert.equal(f.service.runs.require(pending.id).status, "cancelled");
    assert.equal(f.service.runs.list(foreign.id, { limit: 200 }).length, 200);
    assert.equal(
      Number(
        f.db
          .prepare("SELECT COUNT(*) n FROM routine_runs WHERE routine_id=? AND status='missed'")
          .get(foreign.id)?.n,
      ),
      201,
    );
  });
  await filesAcceptance(exercise);
  await exercise("AC租约、等待30分钟缩时、away及活动预算", async (f) => {
    let now = 0,
      live = 0;
    const lease = createPowerLease({
      now: () => now,
      monotonic: () => now,
      blocker: {
        start() {
          live++;
          return 1;
        },
        stop() {
          live--;
        },
      },
      changed() {},
      warn() {
        throw new Error("lease failed");
      },
    });
    lease.begin(1);
    lease.supply("ac");
    lease.waitingLimit(1000);
    const request = {
      mode: "on_ac" as const,
      reason: "waiting" as const,
      leaseId: randomUUID(),
      leaseMs: 1000,
    };
    assert.equal(lease.request(1, request).status, "requested");
    lease.supply("battery");
    assert.equal(live, 0);
    lease.supply("ac");
    assert.equal(live, 1);
    now = 900;
    lease.request(1, { ...request, leaseId: randomUUID() });
    now = 1001;
    assert.equal(lease.request(1, request).status, "off");
    lease.end();
    assert.equal(live, 0);
    assert.throws(() => lease.request(1, request));
    const a = await f.rpc.call("routines.create", draft(f)),
      b = await f.rpc.call("routines.create", draft(f, { name: "第二暂停" }));
    await f.dev({
      type: "dev-ui-active",
      lastActiveAt: new Date(Date.now() - 8 * 86400000).toISOString(),
    });
    await f.dev({ type: "dev-check-away" });
    assert.equal((await f.rpc.call("routines.summary", undefined)).counts.awayPaused, 2);
    await f.rpc.call("routines.resumeAway", { ids: [a.id] });
    assert.equal(f.service.require(b.id).pausedReason, "away_7d");
    await f.rpc.call("routines.resumeAway", {});
    assert.equal((await f.rpc.call("routines.summary", undefined)).counts.awayPaused, 0);
    assert.equal(f.service.runs.list(a.id).length, 0);
    await f.rpc.call("routines.pauseAll", { until: new Date(Date.now() + 3600000).toISOString() });
    assert((await f.rpc.call("routines.summary", undefined)).pausedUntil);
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    await f.rpc.call("routines.pauseAll", { until: tomorrow.toISOString() });
    assert.equal(
      (await f.rpc.call("routines.summary", undefined)).pausedUntil,
      tomorrow.toISOString(),
    );
    await f.rpc.call("routines.resumeAll", undefined);
    assert.equal((await f.rpc.call("routines.summary", undefined)).pausedUntil, null);
    assert(f.maxBlockers() <= 1);
    await exerciseTray(f);
    const today = new Date().toISOString().slice(0, 10),
      midnight = Date.parse(`${today}T00:00:00.000Z`);
    const initialPower = await f.rpc.call("routines.timeline", {
      date: today,
      timezone: "UTC",
      source: "power",
    });
    assert.equal(initialPower.source, "power");
    assert(initialPower.source === "power");
    assert.equal(initialPower.context.state, "unknown");
    await f.dev({
      type: "dev-power",
      supply: "ac",
      event: "suspend",
      at: new Date(midnight - 3600000).toISOString(),
    });
    await f.dev({
      type: "dev-power",
      supply: "ac",
      event: "resume",
      at: new Date(Math.min(Date.now(), midnight + 3600000)).toISOString(),
    });
    const power = await f.rpc.call("routines.timeline", {
      date: today,
      timezone: "UTC",
      source: "power",
    });
    assert(power.source === "power");
    assert.equal(power.context.state, "suspended");
    assert(power.events.some((event) => event.kind === "resume"));
    await f.stop();
    await f.boot(undefined, false);
    assert(!f.devRegistered());
    await f.rpc.call("routines.summary", undefined);
  });
  await exercise("真实一分钟cron、全局过期暂停与权威日历", async (f) => {
    await f.replies([{ text: "真实cron自动完成", delayMs: 0 }]);
    const r = await f.rpc.call(
      "routines.create",
      draft(f, { triggers: [{ kind: "cron", expr: "* * * * *", timezone: "UTC" }] }),
    );
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const planned = await f.rpc.call("routines.planned", { date, timezone: "UTC", limit: 1 });
    assert.equal(planned.points.length, 1);
    assert(planned.nextCursor);
    const next = await f.rpc.call("routines.planned", {
      date,
      timezone: "UTC",
      cursor: planned.nextCursor,
      limit: 1,
    });
    const firstPoint = planned.points[0];
    assert(firstPoint);
    assert(next.points[0] && next.points[0].at > firstPoint.at);
    // Real cron fires on the minute boundary; wait for the run it produces instead of sleeping
    // until that boundary and reading, which on a loaded machine can still be too early.
    const boundary = (Math.floor(Date.now() / 60000) + 1) * 60000;
    const [automatic] = await until(
      "原定时器自动cron",
      async () => f.service.runs.list(r.id),
      (rows) => rows.length > 0,
      Math.max(0, boundary - Date.now()) + 60_000,
    );
    assert(automatic);
    assert.equal(automatic.reason, "cron");
    assert.equal((await terminal(f, automatic.id)).status, "done");
    await f.rpc.call("routines.pauseAll", { until: new Date(Date.now() + 3600000).toISOString() });
    const expired = await f.rpc.call(
      "routines.create",
      draft(f, {
        name: "已到期暂停后的任务",
        triggers: [{ kind: "cron", expr: "* * * * *", timezone: "UTC" }],
      }),
    );
    // Seed an expired persisted pause in this fixture, rather than submitting an invalid past deadline RPC.
    f.db
      .prepare("UPDATE settings SET value=? WHERE key='routines.pausedUntil'")
      .run(JSON.stringify(new Date(Date.now() - 2 * 60000).toISOString()));
    const past = new Date(Date.now() - 10 * 60000).toISOString();
    f.db
      .prepare("UPDATE routine_triggers SET created_at=? WHERE routine_id=?")
      .run(past, expired.id);
    watermark(f, expired, past);
    await f.service.tick();
    const catchups = f.service.runs.list(expired.id).filter((row) => row.reason === "catchup");
    assert.equal(catchups.length, 1, "暂停结束之后的真实停机周期仍可补跑");
    const catchup = catchups[0];
    assert(catchup);
    await terminal(f, catchup.id);
  });
}
