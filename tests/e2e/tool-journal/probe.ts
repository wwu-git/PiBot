import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { LocalToolCall } from "../../../packages/agent/src/core/types.ts";
import { ToolJournal } from "../../../packages/brain/src/runtime/tools/journal/journal.ts";
import { LocalRun } from "../../../packages/brain/src/runtime/tools/local-run.ts";
import { createRedactor } from "../../../packages/secrets/src/index.ts";
import { AuditRepo, openDatabase, runMigrations } from "../../../packages/storage/src/index.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { type Fixture, fixture, sessionEntries, until } from "../chat/harness.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";

const CONTENT = "journal probe content\n";
const SEND_ONCE = "JOURNAL-SEND-ONCE";
const SEND_RETRY = "JOURNAL-SEND-RETRY";
const REPLY = "JOURNAL-PROBE-REPLY 完成";

/** The e2e echo MCP fixture as a user-identity connector the researcher may use. */
export async function echoConnector(f: Fixture) {
  const server = fileURLToPath(
    new URL("../../../tools/e2e/fixtures/mcp-echo/server.mjs", import.meta.url),
  );
  const manifest = {
    schemaVersion: 1,
    id: "rs1.echo",
    version: "1",
    name: { zh: "合成发送", en: "Synthetic send" },
    description: { zh: "本机合成夹具", en: "Local synthetic fixture" },
    servers: [
      {
        id: "echo",
        transport: "stdio",
        command: process.execPath,
        args: [server],
        auth: { kind: "none", secretNames: [] },
        networkDomains: [],
      },
    ],
  };
  const preview = await f.client.call("plugins.previewImport", {
    source: { kind: "json", text: JSON.stringify(manifest) },
  });
  const imported = await f.client.call("plugins.import", {
    previewId: preview.previewId,
    enable: true,
    expectedDigest: preview.digest,
  });
  const id = imported.connectors[0]?.id;
  assert(id);
  const ready = await until(
    "连接就绪",
    async () => (await f.client.call("connectors.get", { id })).connector,
    (connector) => connector.status === "ready",
  );
  await f.client.call("connectors.update", {
    id,
    expectedRevision: ready.revision,
    tools: [
      { tool: "echo_read", enabled: true, readOnly: true },
      { tool: "echo_write", enabled: true, readOnly: false },
    ],
    access: { mode: "selected", bots: [f.researcher.id] },
  });
  const tools = await until(
    "工具已启用",
    async () => (await f.client.call("connectors.tools", { id })).items,
    (items) => items.some((tool) => tool.tool === "echo_write" && tool.enabled && !tool.readOnly),
  );
  assert(tools);
  return {
    id,
    catalogVersion: (await f.client.call("connectors.get", { id })).connector.catalogVersion,
  };
}

/** Peak overlap of the four synthetic reads, at the authorized execution boundary. */
function observeReads(f: Fixture) {
  const descriptor = Object.getOwnPropertyDescriptor(LocalRun.prototype, "execute");
  assert(descriptor && typeof descriptor.value === "function");
  const original = descriptor.value;
  let active = 0,
    peak = 0;
  Object.defineProperty(LocalRun.prototype, "execute", {
    ...descriptor,
    async value(
      this: LocalRun,
      call: LocalToolCall,
      signal: AbortSignal,
      output: (text: string) => void,
    ) {
      const path = typeof call.input.path === "string" ? basename(call.input.path) : "";
      if (
        this.context.botId !== f.researcher.id ||
        call.tool !== "read_file" ||
        !/^journal-read-[0-3]\.txt$/.test(path)
      )
        return Reflect.apply(original, this, [call, signal, output]);
      peak = Math.max(peak, ++active);
      try {
        await wait(100, undefined, { signal });
        return await Reflect.apply(original, this, [call, signal, output]);
      } finally {
        active--;
      }
    },
  });
  return {
    peak: () => peak,
    restore: () => Object.defineProperty(LocalRun.prototype, "execute", descriptor),
  };
}

/** Tool result texts the model received, in order, by tool call id. */
async function toolResults(root: string) {
  const texts = new Map<string, string>();
  for (const entry of await sessionEntries(root)) {
    const message = entry.message as
      | { role?: string; toolCallId?: string; content?: { type: string; text?: string }[] }
      | undefined;
    if (message?.role === "toolResult" && message.toolCallId)
      texts.set(
        message.toolCallId,
        (message.content ?? []).map((block) => block.text ?? "").join(""),
      );
  }
  return [...texts.values()];
}

/**
 * Items 1, 3, 4, 6 in one direct-message turn:
 * - write_file twice with the same content → the second is answered from the journal;
 * - four read_file in one batch → run in parallel and leave no journal rows;
 * - an MCP send twice → sent once, the second answered from the journal;
 * - an MCP send the user discards (explicit failure), then the same call again → it runs again.
 */
export async function runToolJournalProbe(root: string) {
  const scenario: Scenario = { replies: [{ text: "未匹配到演练身份。" }], routes: {} };
  const f = await fixture(scenario, root);
  const observed = observeReads(f);
  try {
    const target = join(f.root, "journal.txt");
    for (let i = 0; i < 4; i++)
      await writeFile(join(f.root, `journal-read-${i}.txt`), `synthetic ${i}\n`);
    const echo = await echoConnector(f);
    const send = (content: string) => ({
      name: "connector_call",
      arguments: {
        connectorId: echo.id,
        catalogVersion: echo.catalogVersion,
        tool: "echo_write",
        args: { target: "合成收件人", content },
      },
    });
    const write = { name: "write_file", arguments: { path: target, content: CONTENT } };
    const late = join(f.root, "journal-late.txt");
    const sendFile = { name: "send_file", arguments: { paths: [late] } };
    scenario.routes = {
      researcher: withToolDiscovery(
        [
          { toolCalls: [write] },
          { toolCalls: [write] },
          {
            toolCalls: [0, 1, 2, 3].map((i) => ({
              name: "read_file",
              arguments: { path: join(f.root, `journal-read-${i}.txt`) },
            })),
          },
          { toolCalls: [send(SEND_ONCE)] },
          { toolCalls: [send(SEND_ONCE)] },
          { toolCalls: [send(SEND_RETRY)] },
          { toolCalls: [send(SEND_RETRY)] },
          // send_file (external): refused before dispatch while the file is missing (no journal
          // row), sent once it exists, then answered from the journal.
          { toolCalls: [sendFile] },
          { toolCalls: [{ name: "write_file", arguments: { path: late, content: "late\n" } }] },
          { toolCalls: [sendFile] },
          { toolCalls: [sendFile] },
          { text: REPLY },
        ],
        toolLoadGroup,
      ),
    };

    const sent = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "JOURNAL-PROBE-PROMPT 执行本场登记剧本",
    });
    let cards = 0,
      retryDrafts = 0;
    const reply = await until(
      "登记剧本回复终态",
      async () => {
        for (const card of await f.client.call("approvals.pending", {})) {
          cards++;
          if (!card.draft) {
            await f.client.call("approvals.resolve", {
              id: card.id,
              decision: "allow",
              remember: false,
            });
            continue;
          }
          assert(sent.conversationId);
          const draft = await f.client.call("drafts.get", {
            approvalId: card.id,
            conversationId: sent.conversationId,
          });
          // The first retry draft is discarded by the user: an explicit failure.
          const discard = draft.content.includes(SEND_RETRY) && retryDrafts++ === 0;
          await f.client.call("drafts.resolve", {
            approvalId: card.id,
            action: discard ? "discard" : "send",
          });
        }
        const rows = await f.client.call("chat.history", {
          botId: f.researcher.id,
          topicId: sent.conversationId,
        });
        return rows.find((row) => row.id === sent.assistantMessageId);
      },
      (row) => !!row && row.status !== "streaming",
    ).catch(async (error) => {
      const rows = await f.client.call("chat.history", {
        botId: f.researcher.id,
        topicId: sent.conversationId,
      });
      const row = rows.find((r) => r.id === sent.assistantMessageId);
      console.error(JSON.stringify((row?.tools ?? []).map((t) => `${t.tool}:${t.status}`)));
      console.error(JSON.stringify((await toolResults(f.root)).map((t) => t.slice(0, 200))));
      throw error;
    });
    assert(reply?.runId);
    assert.equal(reply.status, "done");
    assert.equal(await readFile(target, "utf8"), CONTENT);

    const db = new DatabaseSync(join(f.root, "data", "pibot.db"), { readOnly: true });
    let rows: Array<Record<string, unknown>>;
    let statuses: string[];
    try {
      statuses = db
        .prepare("SELECT status FROM send_drafts WHERE connector_id=? ORDER BY status")
        .all(echo.id)
        .map((row) => String(row.status));
      rows = db
        .prepare(
          "SELECT tool,effect_class AS effectClass,state,attempts,result_summary AS summary FROM tool_executions WHERE run_id=? ORDER BY created_at",
        )
        .all(reply.runId) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
    // The draft layer is unchanged: within a run the same call gets the same (discarded) draft.
    assert.deepEqual(statuses, ["discarded", "sent"], "重复发送只发一次；放弃的草稿不重发");
    assert(!rows.some((r) => r.tool === "read_file"), "只读调用不登记");
    const writes = rows.filter((r) => r.tool === "write_file");
    assert.equal(writes.length, 2, "同内容写入只登记一次（另一条是补建的文件）");
    assert.deepEqual(
      { state: writes[0]?.state, attempts: writes[0]?.attempts },
      { state: "done", attempts: 1 },
    );
    const sends = rows.filter((r) => r.tool === "connector_call");
    assert.equal(sends.length, 2, "两种发送各一条登记");
    assert.deepEqual(
      sends.map((r) => [r.effectClass, r.state, r.attempts]),
      [
        ["external", "done", 1],
        ["external", "failed", 2],
      ],
      "重复发送不执行；放弃（明确失败）后允许再执行，由草稿层回答",
    );
    const files = rows.filter((r) => r.tool === "send_file");
    assert.deepEqual(
      files.map((r) => [r.effectClass, r.state, r.attempts]),
      [["external", "done", 1]],
      "缺文件时在授权阶段被拒（不登记）；补建后发送一次，之后不再重复",
    );

    const audit = (
      await f.client.call("audit.list", { botId: f.researcher.id, limit: 200 })
    ).filter((e) => e.runId === reply.runId);
    const journal = audit.filter((e) => e.kind.startsWith("tool.journal."));
    const reasons = journal.map((e) => e.detail.reasonCode).sort();
    const count = (code: string) => reasons.filter((r) => r === code).length;
    assert.equal(count("journal_replay_verified"), 1, "第二次写入按目标内容核对后交还");
    assert.equal(count("journal_replay_done"), 2, "重复的发送与发送文件交还上次结果");
    assert.equal(count("journal_retry"), 1, "明确失败（放弃草稿）的调用允许重试");
    assert.equal(
      audit.filter((e) => e.kind === "file.written" && e.detail.path === target).length,
      1,
      "同内容文件只真正写入一次",
    );
    const text = JSON.stringify(journal);
    for (const secret of [CONTENT.trim(), SEND_ONCE, SEND_RETRY, "JOURNAL-PROBE-PROMPT", REPLY])
      assert(!text.includes(secret), `登记审计不得包含 ${secret}`);

    const results = await toolResults(f.root);
    const replays = results.filter((t) => t.includes("already ran in this task")).length;
    assert.equal(replays, 3, "模型收到三次「已执行过」");
    assert.equal(observed.peak(), 4, "四个只读调用并行");

    const connector = (await f.client.call("connectors.get", { id: echo.id })).connector;
    assert.equal(connector.identity, "user");
    const direct = await f.client.call("connectors.update", {
      id: echo.id,
      expectedRevision: connector.revision,
      confirmationMode: "direct_read_write",
    });
    assert.equal(direct.confirmationMode, "direct_read_write");
    const directContent = "JOURNAL-DIRECT-WRITE";
    scenario.routes.researcher?.push(
      ...withToolDiscovery(
        [
          { toolCalls: [send(directContent)] },
          { toolCalls: [send(directContent)] },
          { text: "direct write complete" },
        ],
        toolLoadGroup,
      ),
    );
    const directRun = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "验证连接级直接写入",
      newTopic: true,
    });
    await until(
      "直接写入无需确认即可完成",
      async () => {
        const audit = await f.client.call("audit.list", { botId: f.researcher.id, limit: 200 });
        const entries = audit.filter((entry) => entry.runId === directRun.runId);
        return {
          writes: entries.filter((entry) => entry.detail.reasonCode === "draft_sent"),
          replayed: entries.some((entry) => entry.detail.reasonCode === "journal_replay_done"),
        };
      },
      ({ writes, replayed }) => {
        assert(writes.length <= 1);
        return (
          replayed &&
          writes.length === 1 &&
          writes[0]?.detail.toolName === "echo_write" &&
          writes[0].detail.policySteps?.includes("connector_direct_write") === true
        );
      },
      20_000,
    );

    return {
      scenario: "执行登记与防重放",
      status: "脚本化通过",
      journalRows: rows.map((r) => `${r.tool}:${r.effectClass}:${r.state}:${r.attempts}`),
      journalAudit: reasons,
      draftStatuses: statuses,
      readPeak: observed.peak(),
      approvalCards: cards,
      replaysSeenByModel: replays,
      overhead: await measureOverhead(join(f.root, "overhead.db")),
      nonFixtureNetworkAttempts: f.blocked(),
    };
  } finally {
    observed.restore();
    await f.cleanup();
  }
}

/**
 * Cost of the journal itself around a no-op call on a fresh file database: begin (look-up,
 * insert, audit) + settle (update, audit), and the replay answer path.
 */
async function measureOverhead(path: string) {
  const db = openDatabase(path);
  runMigrations(db);
  const redactor = createRedactor();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const local = {
    deps: { db, redactor, logger },
    approvals: { audit: new AuditRepo(db, redactor) },
    budgets: {
      root: (c: { runId: string; budgetRootRunId?: string }) => c.budgetRootRunId ?? c.runId,
    },
  };
  const journal = new ToolJournal(local as never);
  const context = {
    botId: randomUUID(),
    runId: randomUUID(),
    signal: AbortSignal.timeout(60_000),
  };
  const prepared = (i: number) =>
    ({
      call: { id: `call-${i}`, tool: "run_command", input: { command: `echo ${i}` } },
      result: {},
    }) as never;
  const noop = async () => ({ text: "ok" });
  const n = 300;
  try {
    let started = performance.now();
    for (let i = 0; i < n; i++)
      await journal.run(context as never, prepared(i), context.signal, noop);
    const journalled = (performance.now() - started) / n;
    const external = (i: number) =>
      ({
        call: { id: `send-${i}`, tool: "send_file", input: { paths: ["a"] } },
        result: {},
      }) as never;
    await journal.run(context as never, external(0), context.signal, noop);
    started = performance.now();
    for (let i = 1; i <= n; i++)
      await journal.run(context as never, external(i), context.signal, noop);
    const replay = (performance.now() - started) / n;
    started = performance.now();
    const read = (i: number) =>
      ({
        call: { id: `read-${i}`, tool: "read_file", input: { path: `${i}` } },
        result: {},
      }) as never;
    for (let i = 0; i < n; i++) await journal.run(context as never, read(i), context.signal, noop);
    const readCall = (performance.now() - started) / n;
    return {
      calls: n,
      journalledMsPerCall: Number(journalled.toFixed(3)),
      replayMsPerCall: Number(replay.toFixed(3)),
      readMsPerCall: Number(readCall.toFixed(4)),
    };
  } finally {
    db.close();
  }
}
