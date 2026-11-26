// Score saved reply receipts and summarize token-weighted cache hits by evaluation group.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Request = {
  api: string;
  provider: string;
  usage?: Usage;
  cacheFields?: string[];
  startedAt: number;
};
type Turn = {
  status: string;
  text: string;
  error?: string;
  verdict?: string;
  task?: string;
  group?: string;
  sequence?: number;
  requests?: Request[];
  legacyUsage?: Usage;
  firstTokenMs: number | null;
  totalMs: number | null;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usage(value: unknown): Usage | undefined {
  const row = record(value);
  const input = amount(row?.input);
  const output = amount(row?.output);
  const cacheRead = amount(row?.cacheRead);
  const cacheWrite = amount(row?.cacheWrite);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  )
    return;
  return { input, output, cacheRead, cacheWrite };
}

export function parseLines(lines: string[]): Turn {
  const turn: Turn = { status: "none", text: "", firstTokenMs: null, totalMs: null };
  let runId: unknown;
  for (const line of lines) {
    let row: ReturnType<typeof record>;
    try {
      row = record(JSON.parse(line));
    } catch {
      // A child that exits mid-line can leave an incomplete receipt.
      continue;
    }
    if (!row) continue;
    switch (row.type) {
      case "run":
        runId = row.runId;
        if (row.modelMetrics === true) turn.requests = [];
        break;
      case "model_request":
        if (row.runId === runId && typeof row.api === "string" && typeof row.provider === "string")
          turn.requests?.push({
            api: row.api,
            provider: row.provider,
            startedAt: amount(row.startedAt) ?? 0,
            usage: usage(row.usage),
            cacheFields: Array.isArray(row.cacheFields)
              ? row.cacheFields.filter((field): field is string => typeof field === "string")
              : undefined,
          });
        break;
      case "error":
        turn.status = "error";
        turn.error = typeof row.code === "string" ? row.code : "error";
        break;
      case "done":
        turn.status = typeof row.status === "string" ? row.status : "done";
        turn.text = typeof row.text === "string" ? row.text : "";
        turn.legacyUsage = usage(row.usage);
        turn.firstTokenMs = amount(record(row.timing)?.firstTokenMs) ?? null;
        turn.totalMs = amount(record(row.timing)?.totalMs) ?? null;
        break;
      case "eval":
        if (typeof row.verdict === "string") turn.verdict = row.verdict;
        if (typeof row.task === "string") turn.task = row.task;
        if (typeof row.group === "string") turn.group = row.group;
        turn.sequence = amount(row.sequence);
        break;
    }
  }
  // eval-ab copies the CLI into old revisions whose brain lacks the metrics port.
  if (turn.requests?.length === 0 && turn.legacyUsage) delete turn.requests;
  turn.requests?.sort((left, right) => left.startedAt - right.startedAt);
  return turn;
}

function sumUsage(reports: readonly Usage[]): Usage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of reports) {
    total.input += row.input;
    total.output += row.output;
    total.cacheRead += row.cacheRead;
    total.cacheWrite += row.cacheWrite;
  }
  return total;
}

export function turnUsage(turn: Turn) {
  if (!turn.requests) return turn.legacyUsage;
  return {
    ...sumUsage(turn.requests.flatMap((request) => request.usage ?? [])),
    requests: turn.requests.length,
    requestsWithUsage: turn.requests.filter((request) => request.usage !== undefined).length,
  };
}

function hitRate({ input, cacheRead, cacheWrite }: Usage) {
  const prompt = input + cacheRead + cacheWrite;
  return prompt > 0 ? (100 * cacheRead) / prompt : null;
}

function mean(values: number[]) {
  if (!values.length) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function passed(turn: Turn) {
  return turn.verdict ? turn.verdict === "pass" : turn.status === "done" && !!turn.text.trim();
}

function fieldSummary(requests: Request[]) {
  const providers = new Map<
    string,
    { provider: string; api: string; observed: number; requests: number; fields: Set<string> }
  >();
  for (const { api, provider, cacheFields } of requests) {
    const key = JSON.stringify([provider, api]);
    const row = providers.get(key) ?? {
      api,
      provider,
      observed: 0,
      requests: 0,
      fields: new Set(),
    };
    row.requests++;
    if (cacheFields) row.observed++;
    for (const field of cacheFields ?? []) row.fields.add(field);
    providers.set(key, row);
  }
  return [...providers.values()].map((row) => ({ ...row, fields: [...row.fields].sort() }));
}

function summarize(group: string, turns: Turn[]) {
  const requests = turns.flatMap((turn) => turn.requests ?? []);
  const legacyTurns = turns.filter((turn) => turn.requests === undefined);
  const tokenRows = requests.flatMap((request) => (request.usage ? [request.usage] : []));
  const total = sumUsage([
    ...tokenRows,
    ...legacyTurns.flatMap((turn) => (turn.legacyUsage ? [turn.legacyUsage] : [])),
  ]);
  const warmRows = requests.slice(1).flatMap((request) => (request.usage ? [request.usage] : []));
  const answers = turns.filter((turn) => turn.status === "done" && turn.text.trim());
  const firsts = answers.flatMap((turn) => turn.firstTokenMs ?? []).sort((a, b) => a - b);
  const perTask = new Map<string, { passed: number; samples: number }>();
  for (const turn of turns) {
    const task = turn.task ?? "?";
    const row = perTask.get(task) ?? { passed: 0, samples: 0 };
    row.samples++;
    if (passed(turn)) row.passed++;
    perTask.set(task, row);
  }
  return {
    group,
    tasks: turns.length,
    passed: turns.filter(passed).length,
    perTask: Object.fromEntries(perTask),
    ...total,
    requests: legacyTurns.length ? null : requests.length,
    requestsWithUsage: tokenRows.length,
    legacyTurns: legacyTurns.length,
    hitRate: hitRate(total),
    warmHitRate: legacyTurns.length ? null : hitRate(sumUsage(warmRows)),
    cacheFields: fieldSummary(requests),
    firstP50: firsts[Math.floor(firsts.length / 2)] ?? null,
    firstMean: mean(firsts),
    totalMean: mean(answers.flatMap((turn) => turn.totalMs ?? [])),
  };
}

export function printReport(dirs: string[]) {
  if (!dirs.length) throw new Error("报告需要至少一个结果目录 / report needs a directory");
  const groups = new Map<string, Turn[]>();
  for (const dir of dirs) {
    for (const name of readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()) {
      const turn = parseLines(readFileSync(join(dir, name), "utf8").split("\n"));
      const parts = /^(.*?)-(\d+)-(.+)\.jsonl$/.exec(name);
      const group = turn.group ?? parts?.[1] ?? "run";
      turn.task ??= parts?.[3];
      turn.sequence ??= Number(parts?.[2] ?? 0);
      const list = groups.get(group) ?? [];
      list.push(turn);
      groups.set(group, list);
    }
  }
  if (!groups.size) throw new Error("没有评测 JSONL / no eval JSONL files");
  const order = ["before", "after"];
  const rows = [...groups.entries()]
    .sort(([left], [right]) => order.indexOf(left) - order.indexOf(right))
    .map(([group, turns]) =>
      summarize(
        group,
        turns.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)),
      ),
    );
  const rate = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);
  console.log(
    "组  成功/样本  请求(有用量/总数)  input  cacheRead  cacheWrite  output  总命中  热命中  首字p50/ms  总时均值/ms",
  );
  for (const row of rows) {
    console.log(
      `${row.group}  ${row.passed}/${row.tasks}  ${row.requestsWithUsage}/${row.requests ?? "—"}  ${row.input}  ${row.cacheRead}  ${row.cacheWrite}  ${row.output}  ${rate(row.hitRate)}  ${rate(row.warmHitRate)}  ${row.firstP50 ?? "—"}  ${row.totalMean ?? "—"}`,
    );
    console.log(
      `  逐任务：${Object.entries(row.perTask)
        .map(([task, n]) => `${task} ${n.passed}/${n.samples}`)
        .join(" · ")}`,
    );
    for (const provider of row.cacheFields)
      console.log(
        `  ${provider.provider}/${provider.api} [${provider.observed}/${provider.requests} HTTP 已观测]：${provider.fields.join(", ") || "—"}`,
      );
    if (row.legacyTurns)
      console.log(`  ${row.legacyTurns} 个旧样本仅含历史回复用量，无法确认请求总数或热命中。`);
  }
  console.log(JSON.stringify(rows, null, 2));
}
