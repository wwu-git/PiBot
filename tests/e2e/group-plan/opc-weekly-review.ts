// The one-person company group runs a weekly business review to the end: finance, operations and
// support report from local files, the chief of staff checks and briefs, and the customer replies
// support prepares stay drafts until the owner answers each one; nothing is sent or remembered.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { GroupPlan } from "../../../packages/protocol/src/index.ts";
import type { Plugin } from "../../../sdk/plugin-sdk/src/index.ts";
import type { Reply, Scenario } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { type Fixture, fixture, until } from "../chat/harness.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";

const FAKE_SANDBOX_HOST = fileURLToPath(
  new URL("../connected-app/fake-sandbox-host.mjs", import.meta.url),
);
const SEND = "send_message";
// Tool answers that say "nothing ran, try again" when the machine is busy.
const BUSY = [
  "Another operation is using the execution service",
  "The permission check took too long",
];
// A bank export as the owner would drop it into the working folder: one opening line, four
// movements, so the scripted finance report can state a closing balance the CSV supports.
const BANK_CSV = [
  "date,counterparty,memo,amount,currency,balance",
  "2030-01-06,Opening,opening balance,0,USD,5000.00",
  "2030-01-07,Acme Ltd,invoice 1001,1200.00,USD,6200.00",
  "2030-01-08,Cloud Host,subscription,-49.00,USD,6151.00",
  "2030-01-09,Design Co,contractor,-800.00,USD,5351.00",
  "2030-01-10,Beta LLC,invoice 1002,650.00,USD,6001.00",
].join("\n");

const mailServer = String.raw`
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const tools = [
  { name: "list_messages", description: "Synthetic bounded inbox read", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "${SEND}", description: "Synthetic outbound message", inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"], additionalProperties: false } }
];
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let response = {};
  if (request.method === "initialize") response = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pibot-fake-mail", version: "1" } };
  else if (request.method === "tools/list") response = { tools };
  else if (request.method === "tools/call") {
    await appendFile(process.env.CALLS_FILE, "call:" + JSON.stringify(request.params) + "\n");
    response = { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response }) + "\n");
}
`;

function mailPlugin(script: string, calls: string): Plugin {
  const trustedReads = new Set(["list_messages"]);
  return {
    id: "mailbox",
    version: "1.0.0",
    card: () => ({
      id: "mailbox",
      name: { zh: "合成邮箱", en: "Synthetic mailbox" },
      description: { zh: "合成邮箱", en: "Synthetic mailbox" },
      category: "local",
      supported: true,
      unsupportedReason: null,
      modes: [
        {
          id: "system",
          auth: "system",
          capability: { zh: "合成", en: "Synthetic" },
          help: { zh: "合成", en: "Synthetic" },
          documentationUrl: "https://example.com/mailbox",
        },
      ],
    }),
    mcp: {
      server: () => ({
        id: "mailbox",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        env: { CALLS_FILE: calls },
        auth: { kind: "system", secretNames: [] },
        networkDomains: [],
      }),
      trustedReads,
      defaultEnabled: () => true,
      draftBinding: () => undefined,
      trustedStdio: { hostScriptPath: FAKE_SANDBOX_HOST },
    },
  };
}

const done = (): Reply => ({ text: "合成步骤完成" });
const write = (content: string): Reply => ({
  toolCalls: [{ name: "write_file", arguments: { path: "__REPORT__", content } }],
});
const reply = (to: string): Reply => ({
  toolCalls: [{ name: "connector_call", arguments: { tool: SEND, args: { to, body: `回复 ${to}` } } }],
});

function requestText(body: Record<string, unknown>) {
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(body.messages ?? body.input);
  return strings.join("\n");
}

function read<T>(f: Fixture, query: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(join(f.root, "data", "pibot.db"), { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

/**
 * Test-only setup on the synthetic fixture: production connections all act as the user, and only
 * a Bot-identity connection can hold a remembered send consent, which is what the mark overrides.
 */
function setup(f: Fixture, sql: string, ...args: string[]) {
  const db = new DatabaseSync(join(f.root, "data", "pibot.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
}

const sends = async (calls: string) =>
  (await readFile(calls, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("call:"))
    .map((line) => JSON.parse(line.slice(5)) as { name: string; arguments: { to: string } })
    .filter((call) => call.name === SEND);

function step(
  id: string,
  botId: string,
  file: string,
  task: string,
  dependsOn: { stepId: string }[] = [],
): GroupPlan["steps"][number] {
  const verdict = dependsOn.length > 0;
  return {
    id, title: id, owner: { botId }, task,
    dependsOn: dependsOn.map((item) => item.stepId),
    inputs: dependsOn.map(({ stepId }) => ({ stepId, deliverableId: "report" })),
    deliverables: [{ id: "report", kind: "md", path: file }],
    acceptance: verdict
      ? [{ id: "exists", check: "exists", deliverable: "report" }, { id: "verdict", check: "verdict", deliverable: "report" }]
      : [{ id: "exists", check: "exists", deliverable: "report" }],
    maxFixRounds: verdict ? 1 : 0,
  };
}

export async function opcWeeklyReviewScenario(root: string) {
  const script = join(root, "fake-mail-mcp.mjs");
  const calls = join(root, "fake-mail-calls.ndjson");
  await writeFile(script, mailServer, { mode: 0o600 });
  await writeFile(calls, "", { mode: 0o600 });
  let plan: GroupPlan = { name: "本周经营复盘", estimatedCostUsd: 0, steps: [] };
  let connection: { id: string; catalogVersion: number } | undefined;
  const inputsSeen = new Set<string>();
  const served = new Map<string, number>();
  const source: Scenario = {
    replies: [done()],
    routes: {
      coordinator: [
        { toolCalls: [{ name: "group_plan", arguments: { plan: {} } }] },
        done(),
        write("# 周经营复盘\n## 现金\n期末 6001.00 USD（来源：cash-flow.md）\n## 运营指标\n见 weekly-metrics.md\n## 客服\n2 条回复草稿待你确认（来源：support-weekly.md）\n## 要你拍板\n- 两条客户回复是否发送\n## 缺口与待办\n- 无\n结论：通过（Verdict: PASS）\n"),
        done(),
      ],
      researcher: [
        { toolCalls: [{ name: "read_file", arguments: { path: "bank.csv" } }] },
        write("# 现金流 2030-01-06 至 2030-01-10\n来源：bank.csv\n| 项目 | 金额 |\n|---|---|\n| 期初 | 5000.00 |\n| 收入 | 1850.00 |\n| 支出 | 849.00 |\n| 期末 | 6001.00 |\n只出报告，未付款或转账。\n"),
        done(),
      ],
      writer: [write("# 周指标\n| 指标 | 本周 | 上周 |\n|---|---|---|\n| 访问 | 1200 | 1000 |\n"), done()],
      support: [reply("customer-a"), reply("customer-b"), write("# 客服周报\n工单 2 条；两条回复都先写成草稿，由老板逐条决定是否发送。\n"), done()],
    },
  };
  const f = await fixture(source, root, {}, { plugins: [mailPlugin(script, calls)] }, {
    onRequest(body, route, index) {
      served.set(route, index + 1);
      const text = requestText(body);
      // Three members write at once on a loaded machine, so a tool may answer "busy, try again";
      // a real model retries the same call, and so does the script.
      const messages = (body.messages ?? body.input) as unknown[] | undefined;
      const replies = source.routes?.[route];
      const previous = replies?.[index - 1];
      const answer = requestText({ messages: messages?.slice(-1) });
      if (replies && previous?.toolCalls && BUSY.some((marker) => answer.includes(marker)))
        replies.splice(index, 0, structuredClone(previous));
      const last = (pattern: RegExp) => [...text.matchAll(pattern)].at(-1)?.[1];
      if (route === "coordinator")
        for (const [stepId, file] of [["cash", "cash-flow.md"], ["metrics", "weekly-metrics.md"], ["support", "support-weekly.md"]] as const)
          if (text.includes(`"stepId":"${stepId}","deliverableId":"report","path":"${file}"`)) inputsSeen.add(stepId);
      for (const call of source.routes?.[route]?.[index]?.toolCalls ?? []) {
        if (call.name === "group_plan") call.arguments.plan = plan;
        if (call.name === "connector_call") {
          assert(connection, "mail connection is ready before the plan starts");
          call.arguments.connectorId = connection.id;
          call.arguments.catalogVersion = connection.catalogVersion;
        }
        if (call.name === "write_file" && call.arguments.path === "__REPORT__") {
          const folder = last(/产物目录 \/ Output folder:\n([^\n]+)/g);
          const raw = last(/交付合同 \/ Delivery contract:\n([^\n]+)/g);
          assert(folder && raw, "member prompt includes the output folder and contract");
          const contract = JSON.parse(raw) as { deliverables: { path: string }[] };
          assert(contract.deliverables[0]);
          call.arguments.path = join(folder, contract.deliverables[0].path);
        }
      }
    },
  });
  try {
    await writeFile(join(f.root, "bank.csv"), `${BANK_CSV}\n`);
    const connected = await f.client.call("apps.connect", { appId: "mailbox", mode: "system", enable: true });
    const connectorId = connected.connectors[0]?.id;
    assert(connectorId);
    const ready = await until(
      "synthetic mailbox ready",
      () => f.client.call("connectors.get", { id: connectorId }),
      (row) => !["starting", "disabled"].includes(row.connector.status),
    );
    assert.equal(ready.connector.status, "ready", `mailbox MCP: ${ready.connector.statusDetailCode ?? "unknown"}`);
    assert.equal(ready.connector.identity, "user");
    connection = { id: connectorId, catalogVersion: ready.connector.catalogVersion };

    const created = await f.client.call("builtin.create", { groups: ["opc-team"], source: "template" });
    const groupId = created.groupIds[0];
    assert(groupId);
    const group = await f.client.call("groups.get", { groupId });
    const bots = await f.client.call("bots.list", {});
    const member = (role: string) => {
      const bot = bots.find((item) => group.members.some((m) => m.botId === item.id) && item.role?.id === role);
      assert(bot, `opc-team has a ${role}`);
      return bot;
    };
    const chief = member("chief-of-staff"), finance = member("finance-assistant");
    const developer = member("fullstack-dev"), ops = member("operations-manager");
    const support = member("customer-support");
    const reviewer = member("code-reviewer");
    assert.equal(group.members.length, 6);
    for (const bot of [chief, finance, ops, support])
      assert.equal(bot.permissionOverrides?.confirmEverySend, true, `${bot.role?.id} confirms every send`);
    assert.equal(developer.permissionOverrides?.confirmEverySend, undefined);
    assert.equal(group.coordinatorBotId, chief.id);
    const provider = bots.find((bot) => bot.id === f.main.id)?.modelProvider;
    assert(provider);
    // The fixture's provider lists three models; support gets its own route on the same fake server.
    const { id: second } = await f.client.call("customProviders.upsert", {
      name: "本地假模型（客服）",
      baseUrl: `${f.serverUrl}/v1`,
      api: "openai-completions",
      apiKey: "synthetic-chat-key-only",
      models: [{ id: "support", contextWindow: 65536, maxTokens: 2048 }],
    });
    for (const [bot, modelProvider, modelId] of [
      [chief, provider, "coordinator"],
      [finance, provider, "researcher"],
      [ops, provider, "writer"],
      [support, second, "support"],
    ] as const)
      await f.client.call("bots.update", { botId: bot.id, modelProvider, modelId, thinkingLevel: "off", memoryExtraction: false });
    // Developer and reviewer have no step in this plan; they keep the default model but must not
    // extract memory.
    for (const bot of [developer, reviewer])
      await f.client.call("bots.update", { botId: bot.id, memoryExtraction: false });
    f.pickFolderNext(f.root);
    const bound = await f.client.call("groups.folders.add", { groupId });
    const folder = bound.folders?.find((item) => item.path === f.root);
    assert(folder);
    await f.client.call("groups.folders.setPrimary", { groupId, folderId: folder.id });

    plan = {
      name: "本周经营复盘",
      estimatedCostUsd: 0,
      steps: [
        step("cash", finance.id, "cash-flow.md", "读工作文件夹里的 bank.csv，交本周现金收支和期末余额；只出报告，不付款、不转账。"),
        step("metrics", ops.id, "weekly-metrics.md", "交本周固定指标与上周对比；只用已有报表。"),
        step("support", support.id, "support-weekly.md", "分诊本周工单，客户回复经邮箱连接只写成草稿，交客服周报。"),
        step("review", chief.id, "weekly-business-review.md", "合并三份报告并核对口径，写周经营复盘和要老板拍板的事，文末写结论。", [
          { stepId: "cash" }, { stepId: "metrics" }, { stepId: "support" },
        ]),
      ],
    };
    const started = Date.now();
    await f.client.call("chat.send", { groupId, text: "做本周经营复盘：财务看现金，运营看指标，客服做工单摘要，最后出简报。" });
    // A connector send waits on its draft card, like the owner's card in the app. The owner sends
    // the first reply and discards the second; each card must arrive before anything leaves.
    const answered: { id: string; action: "send" | "discard" }[] = [];
    const runs = await until("weekly review plan passed", async () => {
      for (const card of await f.client.call("approvals.pending", {})) {
        if (!card.draft) {
          await f.client.call("approvals.resolve", { id: card.id, decision: "allow", remember: false });
          continue;
        }
        if (answered.some((item) => item.id === card.id)) continue;
        assert.equal(card.draft.identity, "user");
        assert.notEqual(card.draft.canRememberTool, true, "sending as the owner can never be remembered");
        assert.notEqual(card.draft.canRememberTarget, true, "no remembered target for owner sends");
        assert(card.explanation?.some((item) => item.code === "bot_send_confirmation"), "the mark reaches policy");
        const sentBefore = answered.filter((item) => item.action === "send").length;
        assert.equal((await sends(calls)).length, sentBefore, "nothing leaves before the owner answers");
        const action = answered.length ? "discard" : "send";
        answered.push({ id: card.id, action });
        await f.client.call("drafts.resolve", { approvalId: card.id, action });
      }
      return read(f, (db) => db.prepare("SELECT id,status FROM group_workflow_runs WHERE group_id=? ORDER BY rowid").all(groupId));
      // Inside the 480 s scenario cap, leaving room for the direct-chat phase after the plan.
    }, (rows) => rows.length === 1 && (rows[0]?.status === "passed" || rows[0]?.status === "failed"), 300_000);
    const elapsedMs = Date.now() - started;
    assert.equal(runs[0]?.status, "passed");
    const steps = read(f, (db) => db.prepare(
      "SELECT step_id,status,attempt,execution_run_id FROM group_workflow_steps WHERE workflow_run_id=? ORDER BY rowid",
    ).all(String(runs[0]?.id))) as { step_id: string; status: string; attempt: number; execution_run_id: string | null }[];
    assert.deepEqual(steps.map((row) => [row.step_id, row.status]), [
      ["cash", "passed"], ["metrics", "passed"], ["support", "passed"], ["review", "passed"],
    ]);
    assert(steps.every((row) => row.attempt === 0), "no step was sent back or retried");
    assert.deepEqual([...inputsSeen].sort(), ["cash", "metrics", "support"], "the briefing step received all three reports");
    const blocked = read(f, (db) => db.prepare("SELECT COUNT(*) n FROM audit_log WHERE kind='group.workflow.step_blocked'").get());
    assert.equal(blocked?.n, 0);
    await until("group runs settled", () => f.client.call("chat.runs", { groupId }),
      (rows) => rows.every((run) => run.status !== "queued" && run.status !== "running"));

    // Exactly the approved reply left, once; the discarded one never reached the service.
    assert.deepEqual(answered.map((item) => item.action), ["send", "discard"]);
    const sent = await sends(calls);
    assert.deepEqual(sent.map((call) => call.arguments.to), ["customer-a"]);
    const statuses = read(f, (db) => db.prepare("SELECT approval_id,status FROM send_drafts").all()) as { approval_id: string; status: string }[];
    assert.deepEqual(answered.map(({ id }) => statuses.find((row) => row.approval_id === id)?.status), ["sent", "discarded"]);
    const grants = await f.client.call("grants.list", { connectorId, botId: support.id, limit: 20 });
    assert.equal(grants.length, 0, "answering a draft leaves no remembered send permission");

    // Receipts: every step run has one, no failed check, and only support's shows the one send.
    const receipts = await Promise.all(steps.map(async (row) => {
      assert(row.execution_run_id);
      return [row.step_id, await f.client.call("runs.receipt", { runId: row.execution_run_id })] as const;
    }));
    for (const [stepId, receipt] of receipts) {
      assert.equal(receipt.unverified.failedCheck, null, `${stepId} receipt has no failed check`);
      assert.equal(receipt.actions.sentDrafts, stepId === "support" ? 1 : 0, `${stepId} sent drafts`);
    }
    const markProof = await markedSupportNeverAutoSends(f, { calls, connectorId, supportId: support.id, source, served });
    return { passed: true, elapsedMs, steps: steps.length, drafts: answered.length, sent: sent.length, ...markProof };
  } finally {
    await f.cleanup();
  }
}

/**
 * Phase two, in a direct chat with support: on a Bot-identity connection a remembered tool consent
 * sends without a card (control), but once the Bot carries `confirmEverySend` neither that consent
 * nor YOLO sends; each draft waits for the person and its card offers nothing to remember.
 */
async function markedSupportNeverAutoSends(
  f: Fixture,
  input: { calls: string; connectorId: string; supportId: string; source: Scenario; served: Map<string, number> },
) {
  const { calls, connectorId, supportId, source, served } = input;
  const route = source.routes?.support;
  assert(route);
  route.length = served.get("support") ?? route.length;
  route.push(...withToolDiscovery(
    ["customer-c", "customer-d", "customer-e", "customer-f"].flatMap((to) => [reply(to), done()]),
    toolLoadGroup,
  ));
  setup(f, "UPDATE connectors SET identity='bot' WHERE id=?", connectorId);
  const mark = (on: boolean) => setup(f, on
    ? "UPDATE bots SET permission_overrides=json_set(permission_overrides,'$.confirmEverySend',json('true')) WHERE id=?"
    : "UPDATE bots SET permission_overrides=json_remove(permission_overrides,'$.confirmEverySend') WHERE id=?", supportId);
  const pending = async (seen: Set<string>) => {
    const cards = await until("support draft card", () => f.client.call("approvals.pending", { botId: supportId }),
      (items) => items.some((item) => item.draft && !seen.has(item.id)));
    const card = cards.find((item) => item.draft && !seen.has(item.id));
    assert(card?.draft);
    seen.add(card.id);
    return card;
  };
  const finished = async (sent: { conversationId?: string; assistantMessageId: string }) => {
    assert(sent.conversationId);
    await until("support reply settled", () => f.client.call("chat.history", { botId: supportId, topicId: sent.conversationId }),
      (items) => items.some((item) => item.id === sent.assistantMessageId && item.status !== "streaming"));
  };
  const seen = new Set<string>();
  const to = async () => (await sends(calls)).map((call) => call.arguments.to);

  // Control: without the mark, answering one card with "remember this tool" lets the next send go
  // out on its own; that is the consent the mark must override.
  mark(false);
  const first = await f.client.call("chat.send", { botId: supportId, text: "回复客户 C" });
  const remembered = await pending(seen);
  assert.equal(remembered.draft?.identity, "bot");
  assert.equal(remembered.draft?.canRememberTool, true, "an unmarked Bot can remember the tool");
  await f.client.call("drafts.resolve", { approvalId: remembered.id, action: "send", rememberTool: true });
  await finished(first);
  assert((await f.client.call("grants.list", { connectorId, botId: supportId, limit: 20 })).length > 0);
  const topicId = first.conversationId;
  assert(topicId);
  const second = await f.client.call("chat.send", { botId: supportId, topicId, text: "回复客户 D" });
  await finished(second);
  assert.deepEqual(await to(), ["customer-a", "customer-c", "customer-d"], "the remembered tool sent without a card");

  // With the mark the same remembered consent no longer sends, and the card offers no remember.
  mark(true);
  const third = await f.client.call("chat.send", { botId: supportId, topicId, text: "回复客户 E" });
  const held = await pending(seen);
  assert.notEqual(held.draft?.canRememberTool, true);
  assert.notEqual(held.draft?.canRememberTarget, true);
  assert.equal(held.canRemember, false);
  assert(held.explanation?.some((item) => item.code === "bot_send_confirmation"));
  // Turning YOLO on releases eligible pending cards; this one must stay with the person.
  await f.client.call("conversations.yolo.set", { conversationId: topicId, enabled: true });
  assert((await f.client.call("approvals.pending", { botId: supportId })).some((item) => item.id === held.id));
  assert.equal((await to()).length, 3, "neither the remembered tool nor YOLO sent the marked draft");
  await f.client.call("drafts.resolve", { approvalId: held.id, action: "discard" });
  await finished(third);
  // A new send while YOLO is on asks as well.
  const fourth = await f.client.call("chat.send", { botId: supportId, topicId, text: "回复客户 F" });
  const yolo = await pending(seen);
  assert.equal((await to()).length, 3, "YOLO did not send for the marked Bot");
  await f.client.call("drafts.resolve", { approvalId: yolo.id, action: "discard" });
  await finished(fourth);
  await f.client.call("conversations.yolo.set", { conversationId: topicId, enabled: false });
  assert.deepEqual(await to(), ["customer-a", "customer-c", "customer-d"]);
  return { markHeld: 2, controlAutoSent: 1 };
}
