import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Worker } from "node:worker_threads";

export interface AcceptanceResult {
  scenario: string;
  status: "脚本化通过";
  requests: Record<string, number>;
  nonFixtureNetworkAttempts: number;
  window: "未验证";
  toolConcurrency?: { readPeak: number; cancelled: number };
}

// Resolve the existing protocol dependency without importing brain/SDK in the supervisor.
const { z } = createRequire(new URL("../../packages/protocol/package.json", import.meta.url))(
  "zod",
);
const messageSchema = z.discriminatedUnion("type", [
  // `reason`: the first line of the worker's error (our own assertion text), so an intermittent
  // failure can be diagnosed from one run instead of re-running with ad-hoc logging.
  z.strictObject({ type: z.literal("failed"), reason: z.string().max(300).optional() }),
  z.strictObject({
    type: z.literal("done"),
    results: z
      .array(
        z.strictObject({
          scenario: z.string().min(1).max(100),
          status: z.literal("脚本化通过"),
          requests: z.partialRecord(
            z.enum(["default", "coordinator", "researcher", "writer"]),
            z.number().int().min(0).max(256),
          ),
          nonFixtureNetworkAttempts: z.literal(0),
          window: z.literal("未验证"),
          toolConcurrency: z
            .strictObject({
              readPeak: z.number().int().min(0).max(16),
              cancelled: z.number().int().min(0).max(16),
            })
            .optional(),
        }),
      )
      .min(1)
      .max(32),
  }),
]);

export async function runSupervised(
  options: { entry?: URL; deadlineMs?: number; scenario?: string } = {},
): Promise<AcceptanceResult[]> {
  const deadlineMs = options.deadlineMs ?? 600_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 900_000)
    throw new Error("演练总期限必须为 1–900000 毫秒");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-e2e-")));
  let worker: Worker | undefined;
  let exited = false;
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    worker = new Worker(options.entry ?? new URL("./chat/index.ts", import.meta.url), {
      workerData: { root },
      argv: options.scenario ? [options.scenario] : [],
      execArgv: [],
      env,
      stdout: true,
      stderr: true,
    });
    // Never forward SDK errors/assertion bodies; report only validated structural results.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const executor = worker;
    return await new Promise<AcceptanceResult[]>((resolve, reject) => {
      let failure: Error | undefined;
      let results: AcceptanceResult[] | undefined;
      let settled = false;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = setTimeout(() => stop("演练总期限已到，执行者已终止"), deadlineMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(terminationTimer);
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
        if (exited) {
          executor.off("message", message);
          executor.off("error", failed);
        } else executor.unref();
        if (error) reject(error);
        else resolve(results as AcceptanceResult[]);
      };
      const stop = (reason: string) => {
        if (failure || settled) return;
        failure = new Error(reason);
        // A termination failure cannot authorize directory deletion or a passing result.
        terminationTimer = setTimeout(
          () => finish(new Error(`执行者退出未确认，保留临时目录：${root}`)),
          10_000,
        );
        void executor.terminate().catch(() => {
          finish(new Error(`执行者终止失败，保留临时目录：${root}`));
        });
      };
      const cancel = () => stop("演练已取消");
      const failed = () => stop("演练执行者异常");
      const message = (raw: unknown) => {
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success || results) stop("演练执行者返回无效或重复结果");
        else if (parsed.data.type === "failed")
          stop(
            parsed.data.reason ? `演练断言或收尾失败：${parsed.data.reason}` : "演练断言或收尾失败",
          );
        else results = parsed.data.results as AcceptanceResult[];
      };
      executor.on("message", message);
      executor.on("error", failed);
      executor.once("exit", (code) => {
        exited = true;
        finish(failure ?? (code !== 0 || !results ? new Error("演练执行者未正常完成") : undefined));
      });
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
    });
  } finally {
    // Worker exit certifies that its DB, network and SDK cannot keep using this root.
    if (!worker || exited) await rm(root, { recursive: true, force: true });
  }
}

// One line, no home path: assertion text and synthetic fixture values only (never prompts or keys).
export function failureReason(error: unknown) {
  const assertion = error as { code?: string; actual?: unknown; expected?: unknown };
  const [first = "", ...rest] = String((error as Error)?.message ?? error).split("\n");
  // A deepEqual failure only says what differs in the +/- lines below the first one, so keep them;
  // an intermittent failure that reports `actual={} expected={}` is otherwise unplaceable. Those
  // empty braces came from JSON.stringify rendering Set/Map/BigInt values.
  const diff = rest
    .filter((entry) => /^\s*[+-]/.test(entry))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  const values =
    assertion?.code !== "ERR_ASSERTION"
      ? ""
      : ` actual=${inspect(assertion.actual, { breakLength: Number.POSITIVE_INFINITY, depth: 2, maxArrayLength: 20, maxStringLength: 120 })} expected=${inspect(assertion.expected, { breakLength: Number.POSITIVE_INFINITY, depth: 2, maxArrayLength: 20, maxStringLength: 120 })}`;
  const detail = diff ? ` | diff: ${diff}` : (values?.slice(0, 120) ?? "");
  const line = first + detail;
  // The first frame inside our acceptance scripts says which step failed; an intermittent
  // failure is otherwise impossible to place after the fact.
  const frame = String((error as Error)?.stack ?? "")
    .split("\n")
    .find((entry) =>
      /(?:tests\/e2e\/[\w-]+|tools\/fake-llm)\/[\w/-]+\.ts:\d+/.test(entry),
    )
    ?.match(/(?:tests\/e2e\/[\w-]+|tools\/fake-llm)\/[\w/-]+\.ts:\d+/)?.[0];
  // Keep a fixed source step beside bare internal failures. It is a file/line identifier only;
  // never include the original error text, prompts, paths or model output.
  const reason = frame ? `${line} @ ${frame}` : line;
  return reason.replaceAll(homedir(), "~").slice(0, 300);
}
