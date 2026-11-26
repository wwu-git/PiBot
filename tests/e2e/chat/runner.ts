import assert from "node:assert/strict";
import type { AcceptanceResult } from "../supervisor.ts";
import { dmDone, type Fixture, fixture, groupIdle, sessionEntries, until } from "./harness.ts";
import { parallelToolScenarios } from "./parallel-tools.ts";

// ASCII keeps the SDK's chars/4 cut-point estimate aligned with the runtime's CJK-aware budget.
// The history outgrows keepRecentTokens so the older turn is worth checkpointing, and the two
// turns together stay well inside the 64K input limit even with longer tool descriptions.
const firstHistory = "Synthetic evidence. ".repeat(4000);
const secondHistory = "Synthetic evidence. ".repeat(1600);
type ExerciseAction = (
  f: Fixture,
) => Promise<void> | Promise<NonNullable<AcceptanceResult["toolConcurrency"]>>;

async function exercise(root: string, name: string, scenario: string, action: ExerciseAction) {
  if (process.argv[2] && process.argv[2] !== scenario) return;
  const f = await fixture(scenario, root);
  let toolConcurrency: AcceptanceResult["toolConcurrency"];
  try {
    toolConcurrency = (await action(f)) || undefined;
    assert.equal(f.blocked(), 0, "不得尝试访问其他网络地址");
  } finally {
    await f.cleanup();
  }
  assert.equal(f.blocked(), 0, "收尾期间也不得访问其他网络地址");
  return {
    scenario: name,
    status: "脚本化通过",
    requests: f.counts(),
    nonFixtureNetworkAttempts: f.blocked(),
    window: "未验证",
    ...(toolConcurrency ? { toolConcurrency } : {}),
  } satisfies AcceptanceResult;
}

export async function runAcceptance(root: string) {
  const results: AcceptanceResult[] = [];
  const exerciseCase = async (name: string, scenario: string, action: ExerciseAction) => {
    const result = await exercise(root, name, scenario, action);
    if (result) results.push(result);
  };
  if (
    process.argv[2] &&
    ![
      "connection-needed",
      "collaboration",
      "mentions",
      "paused",
      "approval",
      "memory",
      "compaction",
      "compaction-failure",
      "compaction-cancel",
      "compaction-overflow",
      "persona",
      "output-limit",
      "parallel-reads",
      "parallel-mixed",
      "parallel-cancel",
    ].includes(process.argv[2])
  )
    throw new Error("未知聊天演练场景");
  await exerciseCase("未连接原因条与同运行去重", "connection-needed", async (f) => {
    const reply = await dmDone(f, "请查询本机日历，并显示程序给出的连接入口");
    assert(reply?.runId);
    const notices = await f.client.call("chat.notices", { conversationId: reply.conversationId, limit: 50 });
    const rows = notices.filter((notice) => notice.kind === "connection_needed");
    assert.equal(rows.length, 1);
    // Linux has no local calendar service, so it reports the platform instead (the only
    // built-in connections left are the local calendar and contacts).
    assert.equal(
      rows[0]?.availability.reason,
      process.platform === "linux" ? "platform_unsupported" : "not_connected",
    );
    assert.equal(rows[0]?.availability.connection, "calendar");
    assert.equal(rows[0]?.availability.connectorId, undefined);
    assert.equal((await f.client.call("connectors.list", {limit: 100})).items.length, 0);
  });
  await exerciseCase("多 Bot / 两任务 / ask_bot / 唤醒", "collaboration", async (f) => {
    await f.client.call("chat.send", { groupId: f.group.id, text: "完成合成研究和写作" });
    const tasks = await until(
      "用户任务和两个派工任务完成",
      () => f.client.call("groups.tasks", { groupId: f.group.id }),
      // Group sends now create a user task for the coordinator as well as its assignments.
      (tasks) => tasks.length === 3 && tasks.every((task) => task.status === "done"),
    );
    const assignments = tasks.filter((task) => task.source?.kind === "coordinator");
    assert.equal(assignments.length, 2);
    const userTask = tasks.find((task) => task.source?.kind === "user");
    assert.equal(userTask?.assigneeBotId, f.main.id);
    assert.deepEqual(
      new Set(assignments.map((task) => task.assigneeBotId)),
      new Set([f.researcher.id, f.writer.id]),
    );
    const runs = await groupIdle(f);
    assert(runs.some((run) => run.kind === "wake" && run.botId === f.main.id));
    assert(runs.some((run) => run.botId === f.writer.id && run.parentRunId));
    assert(runs.every((run) => run.status === "done"));
  });
  await exerciseCase("显式 @ / 多 @ 顺序", "mentions", async (f) => {
    const receipt = await f.client.call("chat.send", {
      groupId: f.group.id,
      text: "@写手 @研究员 @写手 合成回复",
    });
    assert.deepEqual(
      receipt.runs?.map((run) => run.botId),
      [f.writer.id, f.researcher.id],
    );
    // Terminal is not enough: a context-hook abort also ends runs without any model request.
    assert((await groupIdle(f)).every((run) => run.status === "done"));
    assert.equal(f.counts().coordinator, undefined);
  });
  await exerciseCase("轮次上限 2", "collaboration", async (f) => {
    await f.client.call("groups.update", { groupId: f.group.id, autoRoundLimit: 2 });
    await f.client.call("chat.send", { groupId: f.group.id, text: "合成协作直到上限" });
    await groupIdle(f);
    const state = await f.client.call("groups.state", { groupId: f.group.id });
    assert.equal(state.rounds, 2);
    assert.equal(state.limited, true);
    const runs = await f.client.call("chat.runs", { groupId: f.group.id });
    assert.equal(runs.filter((run) => run.automatic).length, 2);
  });
  await exerciseCase("暂停 / 显式消息", "paused", async (f) => {
    await f.client.call("groups.update", { groupId: f.group.id, paused: true });
    await f.client.call("chat.send", { groupId: f.group.id, text: "@写手 合成显式回答" });
    const runs = await groupIdle(f);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.botId, f.writer.id);
    assert.equal(runs[0]?.status, "done");
    assert.equal(f.counts().researcher, undefined);
  });
  await exerciseCase("审批归属 / 群权限独立于单聊 / 拒绝不执行", "approval", async (f) => {
    await f.client.call("bots.update", {
      botId: f.researcher.id,
      permissionOverrides: { run_command: "never" },
    });
    await f.client.call("chat.send", { groupId: f.group.id, text: "@写手 @研究员 合成命令请求" });
    // Group permissions are independent of a member's DM override, including never.
    assert.equal(
      (await f.client.call("permissions.get", { botId: f.researcher.id })).levels.run_command,
      "never",
    );
    assert.equal(
      (await f.client.call("permissions.get", { groupId: f.group.id })).levels.run_command,
      "ask",
    );
    // Explicit mentions execute in order: the second card appears only after the first run ends.
    for (const botId of [f.writer.id, f.researcher.id]) {
      const pending = await until(
        "当前群成员的审批",
        () => f.client.call("approvals.pending", {}),
        (rows) => rows.some((row) => row.botId === botId),
      ).catch(async () => {
        const runs = await f.client.call("chat.runs", {groupId: f.group.id});
        const states = runs.map((run) => ({ role: run.botId === f.researcher.id ? "researcher" : "writer", status: run.status, error: ["context_too_large", "context_unavailable", "internal", "aborted"].includes(run.errorCode ?? "") ? run.errorCode : run.errorCode ? "other" : null }));
        throw new Error(`Approval wait failed for ${botId === f.researcher.id ? "researcher" : "writer"}: ${JSON.stringify(states)}`);
      });
      assert.equal(pending.length, 1);
      const approval = pending[0];
      assert(approval);
      assert.equal(approval.botId, botId);
      assert(approval.runId && approval.messageId);
      await f.client.call("approvals.resolve", {
        id: approval.id,
        decision: "deny",
        remember: false,
      });
    }
    await groupIdle(f);
    assert.equal((await f.client.call("approvals.pending", {})).length, 0);
    const audit = await f.client.call("audit.list", {});
    assert(!audit.some((entry) => entry.kind === "exec.started"));
  });
  await exerciseCase("记忆 auto / 新话题注入 / ask / 拒绝 / 删除", "memory", async (f) => {
    // This case scripts the Bot's own memory tool calls in order. Background extraction (topic
    // boundaries, corrections) sends extra model requests that would consume those scripted
    // replies; it has its own acceptance, so it is off here.
    await f.client.call("bots.update", {
      botId: f.researcher.id,
      memoryMode: "auto",
      memoryExtraction: false,
    });
    assert.equal((await dmDone(f, "以后报告先写结论"))?.status, "done");
    const notes = await f.client.call("memory.list", { botId: f.researcher.id });
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.category, "how_to");
    assert.equal((await dmDone(f, "写一个合成报告", true))?.status, "done");
    assert(f.requests.at(-1)?.memory, "新话题模型请求应收到当前记忆");
    await f.client.call("bots.update", { botId: f.researcher.id, memoryMode: "ask" });
    // Usage tracking updates lastUsedAt/useCount whenever memory is injected; this check
    // is about the saved content, not usage.
    const content = async () =>
      (await f.client.call("memory.list", { botId: f.researcher.id })).map(
        ({ lastUsedAt: _used, useCount: _count, ...note }) => note,
      );
    const beforeAsk = await content();
    await dmDone(f, "使用短段落");
    const profile = await f.client.call("bots.profile", { botId: f.researcher.id });
    const proposal = profile.proposals.find((p) => p.status === "pending");
    assert(proposal);
    assert.deepEqual(
      await content(),
      beforeAsk,
      "ask 提案待批时不得提前保存或改写记忆",
    );
    await f.client.call("memory.resolve", { proposalId: proposal.id, accept: false });
    assert.deepEqual(await content(), beforeAsk, "拒绝提案不得保存或改写记忆",
    );
    await f.client.call("memory.remove", { botId: f.researcher.id, id: notes[0].id });
    assert.equal((await f.client.call("memory.list", { botId: f.researcher.id })).length, 0);
  });
  for (const failure of [false, true])
    await exerciseCase(
      failure ? "压缩失败 / 机械兜底" : "压缩 threshold",
      failure ? "compaction-failure" : "compaction",
      async (f) => {
        assert.equal((await dmDone(f, firstHistory))?.status, "done");
        const second = await dmDone(f, secondHistory);
        if (!failure) assert.equal(second?.status, "done");
        const result = failure ? second : await dmDone(f, "继续合成报告");
        assert.equal(result?.status, "done");
        const entries = await sessionEntries(f.root);
        assert(f.requests.some((req) => req.summary && req.tools === 0));
        assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
        if (failure) {
          assert(
            entries.some(
              (entry) =>
                entry.type === "compaction" &&
                (entry.details as { mechanical?: boolean })?.mechanical,
            ),
          );
          assert.equal(f.counts().default, 4, "长度重试一次后采用机械检查点");
        }
      },
    );
  await exerciseCase("overflow / 摘要 / 一次重试", "compaction-overflow", async (f) => {
    assert.equal((await dmDone(f, firstHistory))?.status, "done");
    assert.equal((await dmDone(f, secondHistory))?.status, "done");
    assert.equal((await dmDone(f, "超限恢复"))?.status, "done");
    assert.equal(f.counts().default, 5);
    assert(f.requests.some((req) => req.summary && req.tools === 0));
    assert.equal(
      (await sessionEntries(f.root)).filter((entry) => entry.type === "compaction").length,
      1,
    );
  });
  await exerciseCase("压缩期间停止 / 等待实际终态", "compaction-cancel", async (f) => {
    assert.equal((await dmDone(f, firstHistory))?.status, "done");
    const receipt = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: secondHistory,
    });
    await until(
      "摘要请求已开始",
      async () => f.requests,
      (requests) => requests.some((req) => req.summary),
    );
    assert(
      f.statuses.some(
        (status) =>
          status.compacting &&
          status.botId === f.researcher.id &&
          status.runId === receipt.runId &&
          status.messageId === receipt.assistantMessageId,
      ),
    );
    await f.client.call("chat.abort", { runId: receipt.runId });
    const runs = await f.client.call("chat.runs", { botId: f.researcher.id });
    assert.equal(runs.find((run) => run.id === receipt.runId)?.status, "aborted");
    assert.equal(
      (await sessionEntries(f.root)).filter((entry) => entry.type === "compaction").length,
      0,
    );
  });
  await exerciseCase("一句话生成人设 / 改名 / 归档", "persona", async (f) => {
    const bot = await f.client.call("bots.create", {
      description: "合成验收助手",
      model: {
        provider: (await f.client.call("bots.profile", { botId: f.main.id })).bot
          .modelProvider as string,
        id: "coordinator",
      },
    });
    assert.equal(bot.name, "验收员");
    assert(bot.systemPrompt.startsWith("你"));
    const changed = await f.client.call("bots.update", {
      botId: bot.id,
      name: "验收改名",
      modelId: "writer",
    });
    assert.equal(changed.name, "验收改名");
    assert.equal(changed.modelId, "writer");
    await f.client.call("bots.archive", { botId: bot.id });
    assert(!(await f.client.call("bots.list", {})).some((entry) => entry.id === bot.id));
  });
  // A capped response continues inside the same run and the same reply: the user should
  // read one answer, not an output_limit error plus a manual "continue".
  await exerciseCase("输出上限 / 同运行续写", "output-limit", async (f) => {
    const reply = await dmDone(f, "继续写这段内容");
    assert.equal(reply?.status, "done");
    assert(String(reply?.content).includes("第一段"));
    assert(String(reply?.content).includes("续写："));
    assert.equal(f.counts().default, 2);
  });
  let exported = "";
  await exerciseCase("模板 RPC 导出", "mentions", async (f) => {
    assert.equal((await f.client.call("teams.export", { groupId: f.group.id })).saved, true);
    const template = JSON.parse(f.exportText());
    assert.equal(template.bots.length, 3);
    assert(!f.exportText().includes("synthetic-chat-key-only"));
    exported = f.exportFile();
  });
  await exerciseCase("第二独立临时库 / 模板预览 / 导入 / 聊天", "mentions", async (f) => {
    f.selectExport(exported);
    const preview = await f.client.call("teams.pickFile", {});
    assert(preview);
    const imported = await f.client.call("teams.import", { previewId: preview.previewId });
    assert.equal(imported.botIds.length, 3);
    assert.equal(imported.groupIds.length, 1);
    for (const botId of imported.botIds) {
      const profile = await f.client.call("bots.profile", { botId });
      assert.deepEqual(profile.permissionOverrides, {});
      assert.equal(profile.memories.length, 0);
    }
    const botId = imported.botIds[0];
    assert(botId);
    const receipt = await f.client.call("chat.send", { botId, text: "导入后的合成私聊" });
    const messages = await until(
      "导入 Bot 回答",
      () => f.client.call("chat.history", { botId }),
      (messages) =>
        messages.some(
          (message) => message.id === receipt.assistantMessageId && message.status === "done",
        ),
    );
    assert(messages.some((message) => message.id === receipt.assistantMessageId));
  });
  await parallelToolScenarios(exerciseCase);
  return results;
}
