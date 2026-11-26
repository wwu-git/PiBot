// Drive the same headless task suite against each evaluation group.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseLines, printReport, turnUsage } from "./eval-report.ts";
import { fail, projectRoot } from "./process.ts";

/**
 * A and B comparison for prompt changes: same task set, one conversation each, then a table.
 * The model calls are made by `pibot run` (which needs a real provider); this file only drives it,
 * parses the JSON lines and adds up the numbers. Nothing here reaches the network by itself.
 */
const USAGE = `用法 / usage:
  pnpm eval run   --suite <file.json> --data <dir> --out <dir> [--group name] [--limit N] [--only a,b] [--repeat N] [provider flags]
  pnpm eval report <dir> [<dir> ...]

provider flags: --base-url <url> --model <id> --api <provider>
密钥走环境变量 PIBOT_EVAL_API_KEY，不放命令行（会进 shell 历史和进程列表）。`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    suite: { type: "string" },
    data: { type: "string" },
    out: { type: "string" },
    group: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    api: { type: "string" },
    timeout: { type: "string" },
    limit: { type: "string" },
    repeat: { type: "string" },
    only: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [mode, ...rest] = positionals;

try {
  if (values.help === true || mode === undefined) {
    console.log(USAGE);
  } else if (mode === "run") await runSuite();
  else if (mode === "report") printReport(rest);
  else fail(`未知命令 / unknown command: ${mode}\n\n${USAGE}`);
} catch (error) {
  fail(error);
  process.exitCode = 1;
}

function parseSuite(suitePath: string): Task[] {
  const text = readFileSync(resolve(suitePath), "utf8");
  try {
    return JSON.parse(text) as Task[];
  } catch {
    // The usual cause is a copy that put a .ts file where the suite should be; quote it back.
    throw new Error(
      `任务集不是合法 JSON / not valid JSON: ${suitePath}\n  开头 / starts with: ${JSON.stringify(text.slice(0, 40))}`,
    );
  }
}

type Task = { id: string; category: string; prompt: string; checks?: string[] };

async function runSuite() {
  const suitePath = require(values.suite, "--suite");
  const dataDir = resolve(require(values.data, "--data"));
  const outDir = resolve(require(values.out, "--out"));
  const group = values.group ?? "run";
  const apiKey = process.env.PIBOT_EVAL_API_KEY;
  if (!apiKey) throw new Error("缺少 PIBOT_EVAL_API_KEY / missing PIBOT_EVAL_API_KEY");
  if (!values["base-url"] || !values.model)
    throw new Error("缺少 --base-url 或 --model / missing --base-url or --model");

  const all: Task[] = parseSuite(suitePath);
  let tasks = all;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("任务集为空 / empty suite");
  if (values.only) {
    const ids = values.only
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const known = new Set(tasks.map((task) => task.id));
    const missing = ids.filter((id) => !known.has(id));
    // A typo would otherwise run zero tasks and look like a clean, empty report.
    if (!ids.length || missing.length)
      throw new Error(`--only 未知任务 / unknown task: ${missing.join(",") || "(empty)"}`);
    tasks = ids.map((id) => tasks.find((task) => task.id === id) as Task);
  }
  if (values.limit) {
    // A two-task trial run keeps a broken provider or bad key from burning the whole budget.
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("--limit 必须是正整数 / --limit must be positive");
    tasks.splice(limit);
  }
  if (tasks.length > 20) throw new Error("任务集上限 20 条 / at most 20 tasks");
  // Compiling every pattern up front keeps a typo in the suite from wasting a paid run.
  for (const task of tasks) for (const pattern of task.checks ?? []) new RegExp(pattern);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const repeat = Number(values.repeat ?? 1);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || !Number.isSafeInteger(repeat * tasks.length))
    throw new Error("--repeat 必须是正整数 / --repeat must be a positive integer");
  const count = repeat * tasks.length;
  console.log(`任务集 ${tasks.length} 条 × ${repeat}，组 ${group}，数据目录 ${dataDir}`);
  let failed = 0;
  for (let sample = 1; sample <= repeat; sample++) {
    for (const [index, task] of tasks.entries()) {
      const sequence = (sample - 1) * tasks.length + index + 1;
      const passed = await runTask(task, {
        group,
        sample,
        sequence,
        count,
        dataDir,
        outDir,
        apiKey,
      });
      if (!passed) failed++;
    }
  }
  if (failed) {
    console.log(`\n${failed}/${count} 条未通过 / failed`);
    process.exitCode = 1;
  }
}

async function runTask(
  task: Task,
  run: {
    group: string;
    sample: number;
    sequence: number;
    count: number;
    dataDir: string;
    outDir: string;
    apiKey: string;
  },
) {
  const { group, sample, sequence, count, dataDir, outDir, apiKey } = run;
  const order = String(sequence).padStart(Math.max(2, String(count).length), "0");
  const file = join(outDir, `${group}-${order}-${task.id}.jsonl`);
  // Repeat the whole suite in order on one conversation, including the stateful tasks.
  const args = [
    "apps/cli/bin/pibot.mjs",
    "run",
    "--data",
    dataDir,
    `--message=${task.prompt}`,
    "--base-url",
    require(values["base-url"], "--base-url"),
    "--model",
    require(values.model, "--model"),
    "--json",
  ];
  if (values.api) args.push("--api", values.api);
  if (values.timeout) args.push("--timeout", values.timeout);
  const result = await call(args, apiKey, (Number(values.timeout ?? 600) + 60) * 1000);
  const turn = parseLines(result.lines);
  const verdict = result.code !== 0 && turn.status === "done" ? "child_exit" : judge(task, turn);
  const record = JSON.stringify({
    type: "eval",
    task: task.id,
    group,
    sample,
    sequence,
    verdict,
    usage: turnUsage(turn),
    exit: result.code,
  });
  writeFileSync(file, `${[...result.lines, record].join("\n")}\n`, { mode: 0o600 });
  const label = verdict === "pass" ? "pass" : `FAIL(${verdict})`;
  console.log(
    `${task.id} #${sample} exit=${result.code} ${label} requests=${turn.requests?.length ?? "-"} first=${turn.firstTokenMs ?? "-"}ms`,
  );
  return verdict === "pass";
}

function judge(task: Task, turn: ReturnType<typeof parseLines>): string {
  if (turn.status !== "done") return turn.error ?? "no_done";
  if (!turn.text.trim()) return "empty";
  const missing = (task.checks ?? []).filter(
    (pattern) => !new RegExp(pattern, "i").test(turn.text),
  );
  return missing.length ? `missing:${missing.join("|")}` : "pass";
}

function call(args: string[], apiKey: string, hardMs: number) {
  return new Promise<{ code: number; lines: string[] }>((done, reject) => {
    // The key is the one variable the child needs: leaving the eval ones in place would hand them
    // to the brain, to a Bot's commands and to anything they start.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["PIBOT_EVAL_API_KEY", "OPENROUTER_API_KEY", "PIBOT_API_KEY"])
      delete env[name];
    env.PIBOT_API_KEY = apiKey;
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      // The key reaches the child through its environment, never through argv.
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const push = (line: string) => {
      if (line.trim()) lines.push(line);
    };
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // A long answer splits its JSON line across chunks; only whole lines can be parsed.
      const parts = (pending + chunk).split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) push(line);
    });
    // Child diagnostics may contain provider data. Structured stdout supplies the verdict.
    child.stderr.resume();
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
    }, hardMs);
    child.once("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(killer);
      push(pending);
      done({ code: code ?? 1, lines });
    });
  });
}

function require(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`缺少 ${flag} / missing ${flag}`);
  return value;
}
