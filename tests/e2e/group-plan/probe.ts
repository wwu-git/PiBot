import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type GroupPlan,
  type GroupPlanCard,
  GroupWorkflowDecisionSchema,
} from "../../../packages/protocol/src/index.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";
import { deliveryCorrectionScenario } from "./delivery-correction.ts";
import { opcWeeklyReviewScenario } from "./opc-weekly-review.ts";
import { verdictRepairScenario } from "./verdict-repair.ts";
import type { Reply, Scenario } from "../../../tools/fake-llm/scenario.ts";
import { type Fixture, fixture, until } from "../chat/harness.ts";
import { isKind, type Kind } from "./scenarios.ts";

const write = (): Reply => ({
  delayMs: 0,
  toolCalls: [
    {
      name: "write_file",
      arguments: { path: "__OUTPUT__", content: "# 来源\n\n合成研究证据 [1]\n\n[1] Fixture\n" },
    },
  ],
});
const done = (): Reply => ({ text: "合成步骤完成", delayMs: 0 });
/** Maintainers 2026-11-14: filled in per step from the delivery contract it receives (see onRequest). */
const stepWrite = (): Reply => ({
  delayMs: 0,
  toolCalls: [{ name: "write_file", arguments: { path: "__STEP__", content: "" } }],
});
// Not a document: the analyst's own delivery check judges new .md files as deliverables.
const SHARED = "shared.txt";
/** Each writer's own file plus the one file both change: the second merge must conflict. */
function stepFiles(deliverable: string) {
  const content = "# 来源\n\n合成研究证据 [1]\n\n[1] Fixture\n";
  const calls = [{ name: "write_file", arguments: { path: "__OUTPUT__", content } }];
  const own = deliverable === "data.md" ? "a.txt" : deliverable === "sources.md" ? "b.txt" : "";
  if (own)
    calls.push(
      { name: "write_file", arguments: { path: own, content: `${deliverable} own file\n` } },
      { name: "write_file", arguments: { path: SHARED, content: `${deliverable} line\n` } },
    );
  return calls;
}
const slowWrite = (delayMs: number): Reply => ({ ...write(), delayMs });
const spawn = (): Reply => ({
  delayMs: 0,
  toolCalls: [
    {
      name: "task_spawn",
      arguments: { title: "写入步骤产物", prompt: "按产物目录写入步骤交付文件。" },
    },
  ],
});
const SUPPLEMENT = "Plan progress (program facts)";
const PENDING = "The plan card awaits the user's Start / Modify";
const REPLAN_FACTS = "Executed plan and progress (untrusted reference data):\n";
const propose = (): Reply => ({
  delayMs: 0,
  toolCalls: [{ name: "group_plan", arguments: { plan: {} } }],
});
function dbRead<T>(f: Fixture, read: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(join(f.root, "data", "pibot.db"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function records(f: Fixture) {
  return dbRead(f, (db) =>
    db
      .prepare(
        "SELECT id,status,workflow_json,budget_root_run_id FROM group_workflow_runs WHERE json_extract(workflow_json,'$.progress.implementation') IS NULL ORDER BY rowid",
      )
      .all(),
  ) as { id: string; status: string; workflow_json: string; budget_root_run_id: string }[];
}
function stepRows(f: Fixture) {
  return dbRead(f, (db) =>
    db
      .prepare(
        "SELECT workflow_run_id,step_id,status,attempt,task_id,execution_run_id,owner_bot_id,decision_message_id FROM group_workflow_steps ORDER BY rowid",
      )
      .all(),
  ) as {
    workflow_run_id: string;
    step_id: string;
    status: string;
    attempt: number;
    task_id: string | null;
    execution_run_id: string | null;
    owner_bot_id: string;
    decision_message_id: string | null;
  }[];
}
async function groupSettled(f: Fixture, groupId: string) {
  await until(
    "group runs settled",
    () => f.client.call("chat.runs", { groupId }),
    (runs) => runs.every((run) => run.status !== "queued" && run.status !== "running"),
  );
}
function step(id: string, botId: string, dependencies: string[] = []): GroupPlan["steps"][number] {
  return {
    id,
    title: id,
    owner: { botId },
    task: `完成研究步骤 ${id}，按产物目录写文件。`,
    dependsOn: dependencies,
    inputs: dependencies.map((stepId) => ({ stepId, deliverableId: "output" })),
    deliverables: [{ id: "output", path: `${id}.md`, kind: "md" }],
    acceptance: [{ id: "exists", check: "exists", deliverable: "output" }],
    maxFixRounds: 2,
  };
}
async function approve(f: Fixture) {
  for (const card of await f.client.call("approvals.pending", {}))
    await f.client.call("approvals.resolve", { id: card.id, decision: "allow", remember: false });
}

/** The card's 「停止计划」 mid-step: running step aborted, passed outputs kept, nothing queued. */
async function userStop(f: Fixture, groupId: string) {
  const rows = await until(
    "report step running after data passed",
    async () => {
      await approve(f);
      return stepRows(f);
    },
    (steps) =>
      steps.some((r) => r.step_id === "data" && r.status === "passed") &&
      steps.some((r) => r.step_id === "report" && r.status === "running" && !!r.execution_run_id),
  );
  const report = rows.find((r) => r.step_id === "report");
  const record = records(f)[0];
  assert(report?.execution_run_id && record);
  const live = await f.client.call("groups.plan.progress", { groupId, workflowRunId: record.id });
  assert.equal(live.status, "running");
  assert.equal(live.passed, 1, "progress counts the passed step");
  // A double click: both requests settle on the same stopped plan.
  const stops = await Promise.all(
    [0, 1].map(() =>
      f.client.call("groups.plan.stop", { groupId, workflowRunId: record.id, confirmed: true }),
    ),
  );
  for (const stopped of stops) {
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.stoppedReason, "user_stopped");
  }
  await groupSettled(f, groupId);
  const aborted = dbRead(f, (db) =>
    db.prepare("SELECT status FROM runs WHERE id=?").get(report.execution_run_id),
  );
  assert.equal(aborted?.status, "aborted", "the running step's run is aborted");
  const after = stepRows(f);
  assert.equal(after.find((r) => r.step_id === "data")?.status, "passed", "passed step kept");
  const folder = (JSON.parse(records(f)[0]?.workflow_json ?? "{}") as { folder?: string }).folder;
  assert(folder && existsSync(join(folder, "data.md")), "passed deliverable kept");
  const count = () =>
    dbRead(f, (db) => Number(db.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n ?? 0));
  const settled = count();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(count(), settled, "nothing is queued or replayed after the stop");
  assert.equal(records(f).length, 1, "a stop never replans");
  const audit = dbRead(f, (db) =>
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE kind='group.workflow.step_blocked' AND json_extract(detail,'$.reasonCode')='user_stopped' AND json_extract(detail,'$.actor')='user'",
      )
      .get(),
  );
  assert.equal(audit?.n, 1, "the user's stop is audited once");
  const again = await f.client.call("groups.plan.progress", { groupId, workflowRunId: record.id });
  assert.equal(again.stoppedReason, "user_stopped");
  assert.equal(f.blocked(), 0);
  return { stopped: true, runs: settled, steps: after.length };
}

/** Exhausts coordinator dispositions into a pending user card, never an arbitrary failure. */
async function dispositionLimit(f: Fixture, groupId: string, workflowRunId: string) {
  const report = stepRows(f).find(
    (step) => step.workflow_run_id === workflowRunId && step.step_id === "report",
  );
  assert(report?.decision_message_id);
  const message = (await f.client.call("chat.history", { groupId, limit: 100 })).find(
    (item) => item.id === report.decision_message_id,
  );
  const decision = GroupWorkflowDecisionSchema.parse(
    (message?.usage as { groupWorkflowDecision?: unknown } | null)?.groupWorkflowDecision,
  );
  assert.equal(decision.state, "pending");
  assert.equal(decision.reasonCode, "dispositions_exhausted");
  assert.equal(decision.groupId, groupId);
  assert.equal(decision.workflowRunId, workflowRunId);
  assert.equal(decision.stepId, "report");
  assert.equal(decision.ownerBotId, report.owner_bot_id);
  assert.equal(decision.attempt, report.attempt);
  assert(decision.note, "the card retains the coordinator's fixed failure facts");
  const ledger = JSON.parse(
    records(f).find((record) => record.id === workflowRunId)?.workflow_json ?? "{}",
  ) as { progress?: { replans?: number; requested?: boolean; replanRunId?: string } };
  assert(ledger.progress);
  assert.equal(ledger.progress.replans, 2);
  assert.equal(ledger.progress.requested, false);
  assert.equal(ledger.progress.replanRunId, undefined);
  assert.deepEqual(
    stepRows(f)
      .filter((step) => step.step_id === "report")
      .map((step) => step.attempt),
    [0, 1, 2],
    "each disposition preserves spent attempts and counts the rewrite once",
  );
  const progress = await f.client.call("groups.plan.progress", { groupId, workflowRunId });
  assert.equal(progress.status, "waiting");
  assert.equal(progress.stoppedReason, null);
  await until(
    "dispositions drained before waiting for the user",
    () => f.client.call("chat.runs", { groupId }),
    (runs) => runs.every((run) => ["done", "error", "aborted"].includes(run.status)),
  );
  const runs = () =>
    dbRead(f, (db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n, SUM(kind='wake' AND trigger_key LIKE 'group-replan:%') AS wakes FROM runs WHERE group_id=?",
        )
        .get(groupId),
    );
  const before = runs();
  assert.equal(before?.wakes, 2, "coordinator wakes share the existing two-replan cap");
  const requests = f.counts();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.deepEqual(runs(), before, "no new run is queued while the user card remains pending");
  assert.deepEqual(
    f.counts(),
    requests,
    "no automatic model request after dispositions are exhausted",
  );
  assert.equal(records(f).at(-1)?.status, "waiting");
  assert.equal(
    stepRows(f).find((step) => step.workflow_run_id === workflowRunId && step.step_id === "report")
      ?.decision_message_id,
    report.decision_message_id,
  );
}

const OWN_WORKSPACE = "You write in your own workspace";

/** A clean repository the topic works in; `.pibot/` is ignored like a real project would. */
function gitRepository(root: string) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  writeFileSync(join(repo, ".gitignore"), ".pibot/\n");
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "base"]])
    execFileSync(
      "git",
      [
        "-c",
        "init.defaultBranch=main",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@localhost",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: root }, stdio: "pipe" },
    );
  return repo;
}

/**
 * Maintainers 2026-11-14: two members write at the same time, each in its own worktree; Pi Bot merges
 * the first, the second conflicts on the shared file and goes back to the coordinator, is redone
 * from the merged base and merges; the dependent report starts only after both are merged.
 */
async function parallelWriters(
  f: Fixture,
  groupId: string,
  repo: string,
  /** The step whose merge conflicted; known once the coordinator redid it. */
  conflicted: () => string | undefined,
) {
  const rows = await until(
    "parallel plan passes",
    async () => {
      await approve(f);
      return records(f);
    },
    (items) => items.at(-1)?.status === "passed",
    280_000,
  );
  // A passed plan starts cleanup asynchronously; its status alone does not prove Git removal.
  const { workspaces } = await until(
    "parallel workspaces cleaned",
    async () => {
      // Cleanup can still request an approval after the plan reaches passed.
      await approve(f);
      const workspaces = dbRead(f, (db) =>
        db
          .prepare(
            "SELECT w.task_id,w.state,w.integration_path,t.path FROM group_member_workspaces w JOIN managed_worktrees t ON t.id=w.worktree_id ORDER BY w.updated_at",
          )
          .all(),
      ) as { task_id: string; state: string; integration_path: string; path: string }[];
      const left = existsSync(join(repo, ".pibot", "wt"))
        ? readdirSync(join(repo, ".pibot", "wt"))
        : [];
      return { workspaces, left };
    },
    ({ workspaces, left }) =>
      workspaces.length === 3 &&
      workspaces
        .map((row) => row.state)
        .sort()
        .join(",") === "integrated,integrated,removed" &&
      left.length === 0,
    60_000,
  );
  assert.equal(workspaces.length, 3, "data, sources and the redo each had a workspace");
  assert(workspaces.every((row) => row.integration_path === repo), "Git repository: no copy");
  assert(workspaces.every((row) => row.path.startsWith(join(repo, ".pibot", "wt"))));
  assert.equal(new Set(workspaces.map((row) => row.path)).size, workspaces.length);
  assert.deepEqual(
    workspaces.map((row) => row.state).sort(),
    ["integrated", "integrated", "removed"],
    "every merged step is integrated; the conflicted attempt was discarded",
  );
  const merges = rows
    .map((row) => (JSON.parse(row.workflow_json) as { progress?: { merges?: Record<string, { code: string; files: string[] }> } }).progress?.merges)
    .find(Boolean);
  const conflict = Object.values(merges ?? {})[0];
  assert.equal(conflict?.code, "merge_conflict");
  assert(conflict?.files.includes(SHARED), "the conflict names the shared file");
  const roots = dbRead(f, (db) =>
    db
      .prepare(
        "SELECT COUNT(DISTINCT s.step_id) AS n FROM group_workflow_steps s JOIN runs r ON r.id=s.execution_run_id WHERE s.step_id IN ('data','sources') AND r.after_run_id IS NULL",
      )
      .get(),
  );
  assert.equal(roots?.n, 2, "independent writers start together");
  const output = (JSON.parse(rows.at(-1)?.workflow_json ?? "{}") as { folder?: string }).folder;
  assert(output);
  for (const file of ["data.md", "sources.md", "report.md"])
    assert(existsSync(join(output, file)), `${file} merged into the real output folder`);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "data.md own file\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "sources.md own file\n");
  assert(
    readFileSync(join(repo, SHARED), "utf8").startsWith(
      conflicted() === "data" ? "data.md" : "sources.md",
    ),
    "the redone step's version of the shared file is final",
  );
  const left = existsSync(join(repo, ".pibot", "wt"))
    ? readdirSync(join(repo, ".pibot", "wt"))
    : [];
  assert.deepEqual(left, [], "no worktree is left behind");
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", HOME: f.root },
  }).toString();
  assert.equal(status, "", "the repository is clean after the merges");
  await groupSettled(f, groupId);
  assert.equal(f.blocked(), 0);
  return { workspaces: workspaces.length, merged: 2 };
}

async function scenario(root: string, kind: Kind) {
  const source: Scenario = {
    replies: [done()],
    routes: {
      coordinator: [propose(), done(), propose(), done(), propose(), done()],
      researcher:
        kind === "retry"
          ? [done(), write(), done()]
          : kind === "retry-exhausted"
            ? // Stalls through the first attempt's in-run corrections; the fresh attempt writes.
              [...Array.from({ length: 3 }, done), write(), done()]
            : [write(), done()],
      writer:
        kind === "replan"
          ? // Fails through the in-run correction and the fix round, so only a replan helps.
            [...Array.from({ length: 6 }, done), write(), done()]
          : kind === "replan-limit" || kind === "round-limit"
            ? Array.from({ length: 12 }, done)
            : [write(), done(), write(), done()],
    },
  };
  // The replacement that changes a completed step is accepted at once (the archive
  // wins), so the coordinator submits twice in all.
  if (kind === "replan" && source.routes)
    source.routes.coordinator = [propose(), done(), propose(), done()];
  if (kind === "confirmation" && source.routes) {
    // The extra coordinator reply answers the user's question while the card is pending.
    source.routes.coordinator = [propose(), done(), done()];
    source.routes.researcher = [write(), done(), write(), done()];
    source.routes.writer = [write(), done(), write(), done(), write(), done()];
  }
  if (kind === "progress" && source.routes) {
    source.routes.coordinator = [propose(), done(), done()];
    source.routes.researcher = [slowWrite(2_500), done()];
    source.routes.writer = [write(), done()];
  }
  if (kind === "reassign-replan" && source.routes) {
    // data is stopped mid-run by the user, reassigned to writer; report then stalls through its
    // in-run corrections and fix round, so only the replan gets it written.
    source.routes.researcher = [slowWrite(8_000), done()];
    source.routes.writer = [write(), done(), ...Array.from({ length: 6 }, done), write(), done()];
  }
  if (kind === "user-stop" && source.routes) {
    // report is still waiting on the model when the user stops the plan from its card.
    source.routes.coordinator = [propose(), done(), done(), done()];
    source.routes.writer = [slowWrite(8_000), done(), done()];
  }
  if (kind === "parallel-writers" && source.routes) {
    // data (researcher) and sources (writer) run at once; report (writer) needs both merged.
    source.routes.coordinator = [propose(), done(), propose(), done(), done()];
    // Either writer may merge first; the other conflicts and is redone (both orders are checked).
    source.routes.researcher = [stepWrite(), done(), stepWrite(), done()];
    source.routes.writer = [stepWrite(), done(), stepWrite(), done(), stepWrite(), done()];
  }
  if (kind === "execution-child" && source.routes)
    // Parent spawns a child and ends; the child writes; the parent's continuation summarizes.
    source.routes.researcher = [spawn(), done(), write(), done(), done()];
  let plan: GroupPlan = {
    name: "调研报告",
    estimatedCostUsd: 0,
    steps: [step("data", randomUUID())],
  };
  let proposals = 0;
  let dependencyPrompts = 0;
  // A missing deliverable is corrected inside the same run with the shared fix text.
  let correctionPrompts = 0;
  let supplementPrompts = 0;
  let pendingPrompts = 0;
  let replanFromFacts = false;
  let lastFolder: string | undefined;
  let lastContract: string | undefined;
  const verificationOutputs = new Set<string>();
  // parallel-writers: the topic's Git repository, the fixture once built, and what was observed.
  let repo: string | undefined;
  let current: Fixture | undefined;
  let conflicted: string | undefined;
  let ownWorkspacePrompts = 0;
  let reportSawMerged = false;
  const f = await fixture(
    source,
    root,
    {},
    {},
    {
      onRequest(body, route, index) {
        const strings: string[] = [];
        const collect = (v: unknown) => {
          if (typeof v === "string") strings.push(v);
          else if (Array.isArray(v)) v.forEach(collect);
          else if (v && typeof v === "object") Object.values(v).forEach(collect);
        };
        collect(body.messages ?? body.input);
        const text = strings.join("\n");
        // An execution child's prompt is the parent's own text, so it inherits the step's place.
        // The latest match is the step's own prompt: Pi Bot's reference entries (which may quote
        // an earlier brief) sit before the user message they belong to.
        const last = (pattern: RegExp) => [...text.matchAll(pattern)].at(-1)?.[1];
        const folder = last(/产物目录 \/ Output folder:\n([^\n]+)/g) ?? lastFolder;
        const contract = last(/交付合同 \/ Delivery contract:\n([^\n]+)/g) ?? lastContract;
        lastFolder = folder;
        lastContract = contract;
        if (route === "coordinator" && text.includes(SUPPLEMENT)) supplementPrompts++;
        // General artifact verification is an extra program plan, not a replacement of this DAG.
        // Consume its verdict contract rather than letting the scripted model run out of replies.
        if (contract && folder && source.routes?.[route]) {
          const check = JSON.parse(contract) as { acceptance?: { check: string }[]; deliverables: { path: string }[] };
          const key = `${folder}:${check.deliverables[0]?.path}`;
          if (check.acceptance?.some((item) => item.check === "verdict") && !verificationOutputs.has(key)) {
            verificationOutputs.add(key);
            const reply = write();
            if (reply.toolCalls?.[0]) reply.toolCalls[0].arguments.content = "# 核对报告\nVerdict: PASS\n";
            source.routes[route].splice(index, 0, ...withToolDiscovery([reply, done()], toolLoadGroup));
          }
        }
        const scripted = source.routes?.[route]?.[index];
        if (
          scripted?.toolCalls?.some((call) => call.arguments.path === "__STEP__") &&
          contract
        ) {
          const parsed = JSON.parse(contract) as { deliverables: { path: string }[] };
          const deliverable = parsed.deliverables[0]?.path ?? "";
          scripted.toolCalls = stepFiles(deliverable);
          ownWorkspacePrompts += text.includes(OWN_WORKSPACE) ? 1 : 0;
          if (deliverable === "report.md" && repo && folder)
            // The dependent starts only after both inputs were merged into the real folder.
            // report overlaps nothing, so its brief names the real (absolute) output folder.
            reportSawMerged = ["data.md", "sources.md"].every((file) =>
              existsSync(isAbsolute(folder) ? join(folder, file) : join(repo as string, folder, file)),
            );
        }
        if (route === "coordinator" && text.includes(PENDING)) pendingPrompts++;
        const facts = text.lastIndexOf(REPLAN_FACTS);
        if (text.includes('"stepId":"data","deliverableId":"output","path":"data.md"'))
          dependencyPrompts++;
        if (
          route === "researcher" &&
          (text.includes("交付检查未通过（修复第") || text.includes("Delivery check failed (fix round"))
        )
          correctionPrompts++;
        for (const call of source.routes?.[route]?.[index]?.toolCalls ?? []) {
          if (call.name === "group_plan") {
            proposals++;
            if (proposals > 1 && kind !== "parallel-writers")
              plan = {
                ...plan,
                steps: plan.steps.map((s) =>
                  s.id === "report" ? { ...s, task: `${s.task} 使用改进方案 ${proposals}。` } : s,
                ),
              };
            call.arguments.plan = structuredClone(plan);
            // A real coordinator copies the executed plan it is shown, including reassignments.
            if (kind === "reassign-replan" && proposals > 1 && facts >= 0) {
              const executed = JSON.parse(
                text.slice(facts + REPLAN_FACTS.length).split("\n")[0] ?? "",
              ) as { plan: GroupPlan };
              call.arguments.plan = {
                ...executed.plan,
                steps: executed.plan.steps.map((s) =>
                  s.id === "report" ? { ...s, task: `${s.task} 使用改进方案。` } : s,
                ),
              };
              replanFromFacts = true;
            }
            if (kind === "parallel-writers" && proposals > 1 && current) {
              // The coordinator redoes the step whose merge conflicted, from the merged base.
              const stuck = stepRows(current).find((row) => row.status === "blocked")?.step_id;
              assert(stuck, "a merge conflict blocked one writing step");
              conflicted = stuck;
              call.arguments.plan = {
                ...plan,
                steps: plan.steps.map((s) =>
                  s.id === stuck ? { ...s, task: `${s.task} 从合并后的结果重做。` } : s,
                ),
                disposition: {
                  action: "rewrite_step",
                  stepId: stuck,
                  reason: "合并冲突，从合并后的结果重做 / Merge conflict; redo from the merged result",
                },
              };
            }
            // DeepSeek V4 Flash sends the plan object as JSON text; it must still start.
            if (kind === "string-plan") call.arguments.plan = JSON.stringify(call.arguments.plan);
            if (kind === "replan" && proposals === 2) {
              const invalid = structuredClone(plan);
              const completed = invalid.steps[0];
              assert(completed);
              invalid.steps[0] = { ...completed, task: "重复已完成的副作用" };
              call.arguments.plan = invalid;
            }
            // Replacements must state the one permitted change, including the deliberately
            // changed completed-step proposal: archived definitions retain its original protection.
            if (
              proposals > 1 &&
              ["replan", "replan-limit", "round-limit", "reassign-replan"].includes(kind)
            ) {
              assert(facts >= 0, "replacement responds to the program's executed-plan facts");
              call.arguments.plan = {
                ...(call.arguments.plan as Record<string, unknown>),
                disposition: {
                  action: "rewrite_step",
                  stepId: "report",
                  reason: "改写卡住的报告步骤后重做 / Rewrite the stalled report step and retry",
                },
              };
            }
          }
          if (call.name === "write_file" && call.arguments.path === "__OUTPUT__") {
            assert(folder && contract, "member prompt includes actual folder and acceptance");
            const parsed = JSON.parse(contract) as { deliverables: { path: string }[] };
            assert(parsed.deliverables[0]);
            call.arguments.path = join(folder, parsed.deliverables[0].path);
          }
        }
      },
    },
  );
  current = f;
  try {
    const available = await f.client.call("bots.list", {});
    const provider = available.find((bot) => bot.id === f.main.id)?.modelProvider;
    assert(provider);
    const created = await f.client.call("builtin.create", {
      groups: ["research-group"],
      source: "template",
    });
    const groupId = created.groupIds[0];
    assert(groupId);
    const built = await f.client.call("groups.get", { groupId });
    const bots = await f.client.call("bots.list", {});
    const coordinator = bots.find((bot) => bot.id === built.coordinatorBotId);
    const analyst = bots.find(
      (bot) =>
        built.members.some((member) => member.botId === bot.id) && bot.role?.id === "data-analyst",
    );
    assert(coordinator && analyst);
    f.main = await f.client.call("bots.update", {
      botId: coordinator.id,
      modelProvider: provider,
      modelId: "coordinator",
      thinkingLevel: "off",
      memoryExtraction: false,
    });
    f.researcher = await f.client.call("bots.update", {
      botId: analyst.id,
      modelProvider: provider,
      modelId: "researcher",
      thinkingLevel: "off",
      memoryExtraction: false,
    });
    f.writer = await f.client.call("bots.update", {
      botId: f.writer.id,
      memoryExtraction: false,
    });
    f.group = await f.client.call("groups.addMember", { groupId, botId: f.writer.id });
    if (kind === "parallel-writers") repo = gitRepository(f.root);
    const primary = repo ?? f.root;
    f.pickFolderNext(primary);
    const group = await f.client.call("groups.folders.add", { groupId: f.group.id });
    const folder = group.folders?.find((item) => item.path === primary);
    assert(folder);
    await f.client.call("groups.folders.setPrimary", { groupId: group.id, folderId: folder.id });
    plan = {
      name: "调研报告",
      estimatedCostUsd: 0,
      steps: [
        step("data", f.researcher.id),
        step("sources", f.writer.id),
        step("report", f.writer.id, ["data", "sources"]),
      ],
    };
    if (
      kind === "replan" ||
      kind === "replan-limit" ||
      kind === "round-limit" ||
      kind === "progress" ||
      kind === "reassign-replan" ||
      kind === "user-stop" ||
      kind === "string-plan"
    )
      plan.steps = [step("data", f.researcher.id), step("report", f.writer.id, ["data"])];
    if (kind === "execution-child") plan.steps = [step("data", f.researcher.id)];
    if (kind === "replan-limit")
      // Isolate the two-disposition cap before the separate shared repair/replan budget stops it.
      plan.steps = plan.steps.map((item) =>
        item.id === "report" ? { ...item, maxFixRounds: 0 } : item,
      );
    if (kind === "round-limit")
      await f.client.call("groups.update", { groupId: group.id, autoRoundLimit: 1 });
    if (kind === "confirmation")
      plan.steps.push(
        step("appendix", f.writer.id, ["report"]),
        step("review", f.researcher.id, ["appendix"]),
      );
    if (kind === "budget") {
      const settings = await f.client.call("groups.execution.get", { groupId: group.id });
      await f.client.call("groups.execution.set", {
        groupId: group.id,
        expectedVersion: settings.version,
        limits: { ...settings.limits, modelRequests: 4 },
      });
    }
    await f.client.call("chat.send", {
      groupId: group.id,
      text: "按研究小组方法完成调研报告，先提交动态计划。",
    });
    if (kind === "confirmation") {
      const card = await until(
        "complex confirmation",
        async () => {
          const messages = await f.client.call("chat.history", { groupId: group.id, limit: 100 });
          return messages
            .map((m) => ({
              id: m.id,
              card: (m.usage as { groupPlan?: GroupPlanCard } | null)?.groupPlan,
            }))
            .find((m) => m.card?.status === "pending");
        },
        Boolean,
      );
      assert(card?.card);
      assert.equal(records(f).length, 0, "pending plan dispatches nothing");
      // A question while the card is pending is a supplement, not a new request.
      await f.client.call("chat.send", { groupId: group.id, text: "这个计划大概要多久？" });
      await until("pending-card question reaches coordinator", async () => pendingPrompts, Boolean);
      await groupSettled(f, group.id);
      const still = (await f.client.call("chat.history", { groupId: group.id, limit: 100 })).find(
        (m) => m.id === card.id,
      );
      assert.equal(
        (still?.usage as { groupPlan?: GroupPlanCard } | null)?.groupPlan?.status,
        "pending",
        "a question keeps the pending card current",
      );
      await f.client.call("groups.plan.resolve", {
        groupId: group.id,
        messageId: card.id,
        decision: "start",
      });
      await f.client.call("groups.plan.resolve", {
        groupId: group.id,
        messageId: card.id,
        decision: "start",
      });
      assert.equal(records(f).length, 1, "double start durably deduplicated");
      await until(
        "confirmed plan completes",
        async () => {
          await approve(f);
          return records(f);
        },
        (rows) => rows[0]?.status === "passed",
      );
      return { confirmation: true, admissions: 1, pendingQuestions: pendingPrompts };
    }
    if (kind === "user-stop") return await userStop(f, group.id);
    if (kind === "parallel-writers") {
      assert(repo);
      const facts = await parallelWriters(f, group.id, repo, () => conflicted);
      // report overlaps nothing: it runs in the real folder after both merges, without a workspace.
      assert.equal(ownWorkspacePrompts, 3, "the parallel writers ran with their own-workspace brief");
      assert(conflicted, "the coordinator redid the conflicted step");
      assert(reportSawMerged, "the dependent step started after both merges");
      return { ...facts, conflicted, proposals };
    }
    const cycleBefore =
      kind === "progress"
        ? await (async () => {
            await until(
              "data step running",
              async () => f.counts().researcher ?? 0,
              (count) => count > 0,
            );
            const state = await f.client.call("groups.state", { groupId: group.id });
            // The user asks for progress in the main chat while a step runs.
            await f.client.call("chat.send", { groupId: group.id, text: "现在进度怎么样？" });
            return state.cycleId;
          })()
        : undefined;
    if (kind === "reassign-replan") {
      const running = await until(
        "data step running",
        async () => (f.counts().researcher ? stepRows(f) : []),
        (rows) => rows.some((r) => r.step_id === "data" && r.status === "running"),
      );
      const data = running.find((r) => r.step_id === "data");
      assert(data?.execution_run_id);
      // The user's explicit stop on the running step yields a disposition card, not a dead plan.
      await f.client.call("chat.abort", { runId: data.execution_run_id });
      const blocked = await until(
        "data disposition card",
        async () => stepRows(f),
        (rows) => rows.some((r) => r.step_id === "data" && !!r.decision_message_id),
      );
      const card = blocked.find((r) => r.step_id === "data");
      assert(card);
      await f.client.call("groups.workflow.resolve", {
        groupId: group.id,
        workflowRunId: card.workflow_run_id,
        stepId: "data",
        action: "reassign",
        ownerBotId: f.writer.id,
        confirmed: true,
      });
    }
    const result = await until(
      `dynamic ${kind}`,
      async () => {
        await approve(f);
        return records(f);
      },
      (rows) =>
        !!rows.length &&
        (kind === "replan-limit"
          ? rows.length === 3 &&
            rows.at(-1)?.status === "waiting" &&
            stepRows(f).some(
              (step) =>
                step.workflow_run_id === rows.at(-1)?.id &&
                step.step_id === "report" &&
                step.status === "blocked" &&
                !!step.decision_message_id,
            )
          : ["round-limit", "budget"].includes(kind)
            ? rows.at(-1)?.status === "failed"
            : rows.at(-1)?.status === "passed"),
    );
    assert.equal(
      new Set(result.map((r) => r.budget_root_run_id)).size,
      1,
      "all replacements share one budget root",
    );
    if (kind === "replan" || kind === "replan-limit" || kind === "round-limit") {
      assert.equal(result.length, kind === "replan-limit" ? 3 : 2, "bounded replan lineage");
      const dataRuns = dbRead(f, (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM group_workflow_steps WHERE step_id='data' AND task_id IS NOT NULL",
          )
          .get(),
      );
      assert.equal(dataRuns?.n, 1, "completed step never replays");
      if (kind === "replan")
        assert.equal(proposals, 2, "completed-step differences use archived definitions without a format retry");
      if (kind === "replan-limit") {
        const last = result.at(-1);
        assert(last);
        await dispositionLimit(f, group.id, last.id);
        assert.equal(proposals, 3, "initial plan plus exactly two coordinator dispositions");
      }
      if (kind === "round-limit") {
        assert.equal((await f.client.call("groups.state", { groupId: group.id })).limited, true);
        const last = result.at(-1);
        assert(last);
        const progress = await f.client.call("groups.plan.progress", {
          groupId: group.id,
          workflowRunId: last.id,
        });
        assert.equal(progress.status, "failed");
        assert.equal(
          progress.stoppedReason,
          "round_limit",
          "only the real cycle cap ends this case",
        );
      }
    }
    if (kind === "progress") {
      assert.equal(result.length, 1, "a progress question never replaces the running plan");
      assert(supplementPrompts > 0, "coordinator received the question as a plan supplement");
      const state = await f.client.call("groups.state", { groupId: group.id });
      assert.equal(state.cycleId, cycleBefore, "the plan's cycle survives a main-chat message");
      await groupSettled(f, group.id);
    }
    if (kind === "reassign-replan") {
      assert.equal(result.length, 2, "reassigned plan replans once");
      assert(replanFromFacts, "replacement copied the executed plan");
      const data = stepRows(f).filter((r) => r.step_id === "data");
      assert(data.every((r) => r.owner_bot_id === f.writer.id && r.status === "passed"));
      assert.equal(data.filter((r) => r.task_id).length, 1, "reassigned step never replays");
      const ledger = JSON.parse(result.at(-1)?.workflow_json ?? "{}") as {
        progress?: { replans?: number };
      };
      assert.equal(ledger.progress?.replans, 1, "replan count retained");
    }
    if (kind === "string-plan") {
      assert.equal(proposals, 1, "the JSON-text plan was accepted on the first submission");
      assert.equal(result.length, 1);
    }
    if (kind === "execution-child") {
      const data = stepRows(f).find((r) => r.step_id === "data");
      assert(data?.task_id && data.execution_run_id);
      assert.equal(data.attempt, 0, "task auto-completed without a fix round");
      const continuation = dbRead(f, (db) =>
        db
          .prepare(
            // The summary continuation hangs off the budget root; its task binding is the point.
            "SELECT COUNT(*) AS n FROM runs WHERE task_id=? AND id<>? AND parent_run_id IS NOT NULL AND status='done'",
          )
          .get(data.task_id, data.execution_run_id),
      );
      assert.equal(continuation?.n, 1, "the continuation summary carries the task binding");
      const task = (await f.client.call("groups.tasks", { groupId: group.id })).find(
        (t) => t.id === data.task_id,
      );
      assert.equal(task?.status, "done");
    }
    if (kind === "retry-exhausted") {
      const data = dbRead(f, (db) =>
        db.prepare("SELECT attempt, status FROM group_workflow_steps WHERE step_id='data'").get(),
      );
      // The step is corrected inside the run first; when that is used up the step is still sent back
      // once as a fresh attempt (without in-run rounds of its own) and passes there.
      assert.equal(data?.attempt, 1, "exhausted in-run correction leads to one fresh attempt");
      assert.equal(data?.status, "passed");
      assert(correctionPrompts > 0, "the first attempt was corrected in-run before the send-back");
    }
    if (kind === "retry") {
      const data = dbRead(f, (db) =>
        db.prepare("SELECT attempt FROM group_workflow_steps WHERE step_id='data'").get(),
      );
      // The first turn's missing file is fixed inside the same run, not by a new one.
      assert.equal(data?.attempt, 0, "the missing deliverable is fixed without a fresh attempt");
      assert(correctionPrompts > 0, "the member got the in-run delivery correction");
      assert(dependencyPrompts > 0, "explicit upstream deliverable identity reaches report");
      const independent = dbRead(f, (db) =>
        db
          .prepare(`SELECT COUNT(DISTINCT s.step_id) AS n
        FROM group_workflow_steps s JOIN runs r ON r.id=s.execution_run_id
        WHERE s.step_id IN ('data','sources') AND r.after_run_id IS NULL`)
          .get(),
      );
      assert.equal(
        independent?.n,
        2,
        "independent roots admit without an artificial serial dependency",
      );
    }
    if (kind === "budget") {
      assert.equal(proposals, 1, "hard budget stop never replans");
      const first = result[0];
      assert(first);
      const budget = dbRead(f, (db) =>
        db
          .prepare("SELECT snapshot_json FROM execution_budgets WHERE root_run_id=?")
          .get(first.budget_root_run_id),
      );
      assert(budget);
      const usage = JSON.parse(String(budget.snapshot_json)) as {
        requests: number;
        limits: { modelRequests: number };
      };
      assert(usage.requests <= usage.limits.modelRequests, "request cap cannot be reset by engine");
    }
    assert.equal(f.blocked(), 0);
    return {
      plans: result.length,
      proposals,
      dependencyPrompts,
      ...(kind === "progress" ? { supplementPrompts } : {}),
      requests: f.requests.length,
    };
  } catch (error) {
    const facts = dbRead(f, (db) => ({
      runs: db
        .prepare(
          "SELECT kind,status,error_code,stop_reason,task_id IS NOT NULL AS bound,parent_run_id IS NOT NULL AS child FROM runs ORDER BY rowid",
        )
        .all(),
      steps: db
        .prepare("SELECT step_id,status,attempt FROM group_workflow_steps ORDER BY rowid")
        .all(),
      cards: db
        .prepare(
          "SELECT json_extract(usage,'$.groupPlan.status') AS status FROM messages WHERE json_type(usage,'$.groupPlan')='object'",
        )
        .all(),
      workspaces: db
        .prepare("SELECT state, COUNT(*) AS count FROM group_member_workspaces GROUP BY state")
        .all(),
      blocks: db
        .prepare(
          "SELECT json_extract(detail,'$.reason') AS reason FROM audit_log WHERE kind='group.workflow.step_blocked' ORDER BY at",
        )
        .all(),
    }));
    throw new Error(
      `${kind}: ${error instanceof Error ? error.message : "failed"}; ${JSON.stringify(facts)}; counts=${JSON.stringify(f.counts())}`,
    );
  } finally {
    await f.cleanup();
  }
}

export type ProbeEvent = { type: "start" | "end"; name: string; ms?: number };

export async function runGroupPlanProbe(
  root: string,
  selected?: string,
  onEvent?: (event: ProbeEvent) => void,
) {
  const started = Date.now();
  // Every scenario boundary is reported, so the supervisor can hold a budget for one
  // scenario at a time and still list the results that did finish instead of one opaque timeout.
  const report = async <T>(name: string, run: () => Promise<T>) => {
    const at = Date.now();
    onEvent?.({ type: "start", name });
    console.log(`[group-plan] start ${name}`);
    try {
      return await run();
    } finally {
      const ms = Date.now() - at;
      onEvent?.({ type: "end", name, ms });
      console.log(`[group-plan] end ${name} in ${ms}ms, total ${Date.now() - started}ms`);
    }
  };
  if (selected === "delivery-correction") return report(selected, () => deliveryCorrectionScenario(root));
  if (selected === "verdict-repair") return report(selected, () => verdictRepairScenario(root));
  if (selected === "opc-weekly-review") return report(selected, () => opcWeeklyReviewScenario(root));
  if (selected && isKind(selected)) return report(selected, () => scenario(root, selected));
  return {
    scenario: "动态调研报告",
    deliveryCorrection: await report("delivery-correction", () => deliveryCorrectionScenario(root)),
    verdictRepair: await report("verdict-repair", () => verdictRepairScenario(root)),
    retry: await report("retry", () => scenario(root, "retry")),
    retryExhausted: await report("retry-exhausted", () => scenario(root, "retry-exhausted")),
    replan: await report("replan", () => scenario(root, "replan")),
    replanLimit: await report("replan-limit", () => scenario(root, "replan-limit")),
    roundLimit: await report("round-limit", () => scenario(root, "round-limit")),
    budget: await report("budget", () => scenario(root, "budget")),
    confirmation: await report("confirmation", () => scenario(root, "confirmation")),
    progress: await report("progress", () => scenario(root, "progress")),
    reassignReplan: await report("reassign-replan", () => scenario(root, "reassign-replan")),
    executionChild: await report("execution-child", () => scenario(root, "execution-child")),
    userStop: await report("user-stop", () => scenario(root, "user-stop")),
    stringPlan: await report("string-plan", () => scenario(root, "string-plan")),
    parallelWriters: await report("parallel-writers", () => scenario(root, "parallel-writers")),
    opcWeeklyReview: await report("opc-weekly-review", () => opcWeeklyReviewScenario(root)),
  };
}
