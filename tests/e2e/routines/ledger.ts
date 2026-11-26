import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "../chat/harness.ts";
import type { M3Fixture } from "./fixture.ts";
import { approval, draft, type Exercise, terminal } from "./shared.ts";

function requestText(value: unknown): string[] {
  if (typeof value === "string") {
    // Tool results may themselves be JSON text. Compare decoded text, never JSON escaping.
    try {
      return [value, ...requestText(JSON.parse(value))];
    } catch {
      // Ordinary prompt text is not JSON and already has the real platform paths.
      return [value];
    }
  }
  if (Array.isArray(value)) return value.flatMap(requestText);
  if (value && typeof value === "object") return Object.values(value).flatMap(requestText);
  return [];
}
const bodyOf = (f: M3Fixture, from: number) =>
  f.requests.slice(from).flatMap((request) => requestText(request.body.messages)).join("\n");

/** The run ledger, per-period folders and send idempotency across a resume. */
export async function ledgerAcceptance(exercise: Exercise) {
  await exercise("本期写入本期目录、下期拿到上期清单且上期只读", async (f) => {
    const name = "周期简报";
    const r = await f.rpc.call(
      "routines.create",
      draft(f, {
        name,
        triggers: [{ kind: "cron", expr: "30 8 * * *", timezone: "UTC" }],
        preauth: [{ category: "write_file", scope: { kind: "workplace", root: f.primary } }],
      }),
    );
    const trigger = r.triggers[0];
    assert(trigger);
    const earlier = new Date(Date.now() - 2 * 86400000);
    earlier.setUTCHours(8, 30, 0, 0);
    const firstKey = earlier.toISOString().slice(0, 10);
    const secondKey = new Date().toISOString().slice(0, 10);
    const root = join(f.primary, ".pibot/out", name);
    const firstFile = join(root, firstKey, "简报.md");
    const secondFile = join(root, secondKey, "简报.md");
    await f.replies([
      {
        toolCalls: [
          { name: "write_file", arguments: { path: firstFile, content: "# 简报\n共 3 项" } },
        ],
        delayMs: 0,
      },
      { text: "第一期完成", delayMs: 0 },
    ]);
    // A past occurrence of the trigger, enqueued as the scheduler would have (trusted fixture).
    const first = f.service.runs.enqueue(
      {
        routineId: r.id,
        botId: f.bot.id,
        triggerId: trigger.id,
        reason: "cron",
        scheduledFor: earlier.toISOString(),
        dedupeKey: `cron:${trigger.id}:${earlier.toISOString()}`,
      },
      f.service.timing.queueWaitMs,
    );
    const before = f.requests.length;
    await f.service.publish(first, f.service.repo.require(r.id));
    assert.equal((await terminal(f, first.id)).status, "done");
    assert(bodyOf(f, before).includes(join(root, firstKey)), "本期目录写进运行状态");
    assert.equal(await readFile(firstFile, "utf8"), "# 简报\n共 3 项");
    await until(
      "第一期产出清单",
      () => f.rpc.call("routines.runLedger", { id: first.id }),
      (ledger) => ledger.outputs.some((o) => o.path === firstFile && o.sha256 !== null),
    );

    await f.replies([
      // The previous period is read-only for this run: policy refuses this write.
      {
        toolCalls: [{ name: "write_file", arguments: { path: firstFile, content: "改写上期" } }],
        delayMs: 0,
      },
      {
        toolCalls: [
          {
            name: "write_file",
            arguments: { path: secondFile, content: "# 简报\n与上期相比：+1 项" },
          },
        ],
        delayMs: 0,
      },
      { text: "第二期完成", delayMs: 0 },
    ]);
    const second = f.requests.length;
    const now = await f.rpc.call("routines.runNow", { id: r.id });
    assert.equal((await terminal(f, now.runId)).status, "done");
    const seen = bodyOf(f, second);
    assert(
      seen.includes(join(root, firstKey)) && seen.includes("简报.md"),
      "上期目录与清单交给本期",
    );
    assert.equal(await readFile(firstFile, "utf8"), "# 简报\n共 3 项", "上期目录只读");
    assert.equal(await readFile(secondFile, "utf8"), "# 简报\n与上期相比：+1 项");
    const ledger = await until(
      "第二期产出清单",
      () => f.rpc.call("routines.runLedger", { id: now.runId }),
      (value) => value.outputs.some((o) => o.path === secondFile),
    );
    assert.equal(ledger.periodKey, secondKey);
    assert.equal(ledger.outputFolder, join(root, secondKey));
    const previous = ledger.inputs.find((i) => i.kind === "previous_period");
    assert(previous?.kind === "previous_period");
    assert.equal(previous.runId, first.id);
    assert.equal(previous.periodKey, firstKey);
    assert.equal(previous.files, 1);
    assert(!ledger.outputs.some((o) => o.path === firstFile), "本期清单不含上期文件");
    assert(
      (await f.rpc.call("audit.list", { limit: 200 })).some((e) => e.kind === "policy.denied"),
      "写上期被策略拒绝并审计",
    );
  });

  await exercise("人为中断后续跑，已发送的不再发送", async (f) => {
    const id = await echoConnector(f);
    const catalogVersion = (await f.rpc.call("connectors.get", { id })).connector.catalogVersion;
    const send = {
      name: "connector_call",
      arguments: {
        connectorId: id,
        catalogVersion,
        tool: "echo_write",
        args: { target: "合成收件人", content: "第一期简报已生成" },
      },
    };
    const r = await f.rpc.call("routines.create", draft(f, { name: "发送简报" }));
    // Attempt 1: sends (user confirms the draft), then hangs until the user stops the run.
    await f.replies([{ toolCalls: [send], delayMs: 0 }, { hang: true }]);
    const first = await f.rpc.call("routines.runNow", { id: r.id });
    const card = await approval(f);
    assert(card.draft, "对外发送走草稿");
    await f.rpc.call("drafts.resolve", { approvalId: card.id, action: "send" });
    await until(
      "草稿已发送",
      async () =>
        f.db.prepare("SELECT status FROM send_drafts WHERE approval_id=?").get(card.id)?.status,
      (status) => status === "sent",
    );
    const running = await until(
      "等到模型挂起",
      async () => f.service.runs.require(first.runId),
      (run) => run.status === "running" && f.requests.length > 0,
    );
    assert(running.runId);
    await until(
      "发送后的那一轮已开始",
      async () => bodyOf(f, 0),
      (body) => body.includes('"status":"sent"'),
    );
    await f.rpc.call("chat.abort", { runId: running.runId });
    assert.equal((await terminal(f, first.runId)).status, "cancelled");

    // Attempt 2: the model repeats the same send; the send layer answers with the earlier receipt.
    await f.replies([
      { toolCalls: [send], delayMs: 0 },
      { text: "续跑完成", delayMs: 0 },
    ]);
    const from = f.requests.length;
    const resumed = await f.rpc.call("routines.resumeRun", { id: first.runId });
    assert.notEqual(resumed.runId, first.runId);
    assert.equal((await terminal(f, resumed.runId)).status, "done");
    const sent = f.db
      .prepare("SELECT COUNT(*) AS n FROM send_drafts WHERE connector_id=? AND status='sent'")
      .get(id);
    assert.equal(Number(sent?.n), 1, "同一次调度只发送一次");
    assert.equal(
      Number(f.db.prepare("SELECT COUNT(*) AS n FROM send_drafts WHERE connector_id=?").get(id)?.n),
      1,
      "续跑没有新建发送草稿",
    );
    assert.equal((await f.rpc.call("approvals.pending", {})).length, 0);
    const seen = bodyOf(f, from);
    assert(seen.includes("Already sent"), "续跑拿到已发送清单");
    assert(seen.includes('"duplicate":true'), "重复发送返回之前的回执");
    const run = f.service.runs.require(resumed.runId);
    assert.equal(run.resumeOf, first.runId);
    assert.equal(run.occurrenceId, first.runId);
    const before = await f.rpc.call("routines.runLedger", { id: first.runId });
    const after = await f.rpc.call("routines.runLedger", { id: resumed.runId });
    assert.equal(before.sends[0]?.delivery, "sent");
    assert.equal(after.sends[0]?.delivery, "duplicate");
    assert.equal(after.sends[0]?.key, before.sends[0]?.key, "两次尝试的幂等键相同");
    assert.deepEqual(after.attempts, [first.runId, resumed.runId]);
    // One resume per run: asking again returns the same resume.
    assert.equal(
      (await f.rpc.call("routines.resumeRun", { id: first.runId })).runId,
      resumed.runId,
    );
    assert(
      (await f.rpc.call("audit.list", { limit: 200 })).some(
        (e) => e.kind === "connector.called" && e.detail.reasonCode === "draft_duplicate",
      ),
      "跳过的重复发送写入审计",
    );
  });
}

/** The e2e echo MCP fixture as a user-identity connector the main Bot may use. */
async function echoConnector(f: M3Fixture) {
  const manifest = {
    schemaVersion: 1,
    id: "r1.echo",
    version: "1",
    name: { zh: "合成发送", en: "Synthetic send" },
    description: { zh: "本机合成夹具", en: "Local synthetic fixture" },
    servers: [
      {
        id: "echo",
        transport: "stdio",
        command: process.execPath,
        args: [f.echoServer],
        auth: { kind: "none", secretNames: [] },
        networkDomains: [],
      },
    ],
  };
  const preview = await f.rpc.call("plugins.previewImport", {
    source: { kind: "json", text: JSON.stringify(manifest) },
  });
  const imported = await f.rpc.call("plugins.import", {
    previewId: preview.previewId,
    enable: true,
    expectedDigest: preview.digest,
  });
  const id = imported.connectors[0]?.id;
  assert(id);
  const ready = await until(
    "连接就绪",
    async () => (await f.rpc.call("connectors.get", { id })).connector,
    (connector) => connector.status === "ready",
  );
  await f.rpc.call("connectors.update", {
    id,
    expectedRevision: ready.revision,
    tools: [
      { tool: "echo_read", enabled: true, readOnly: true },
      { tool: "echo_write", enabled: true, readOnly: false },
    ],
    access: { mode: "selected", bots: [f.bot.id] },
  });
  await until(
    "工具已启用",
    async () => (await f.rpc.call("connectors.tools", { id })).items,
    (items) => items.some((tool) => tool.tool === "echo_write" && tool.enabled && !tool.readOnly),
  );
  return id;
}
