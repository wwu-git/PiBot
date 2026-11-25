import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RuntimeContext } from "../src/runtime/runtime.ts";
import { createCompactionOperations } from "../src/runtime/runtime-parts/runtime-compaction.ts";
import { sessionPaths } from "../src/runtime/runtime-parts/runtime-shared.ts";

vi.mock("../src/runtime/runtime-parts/runtime-shared.ts", () => ({ sessionPaths: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

it.each(["first", "second"] as const)("cancels only the %s caller", async (cancelled) => {
  vi.clearAllMocks();
  const dir = await mkdtemp(join(tmpdir(), "pibot-context-estimate-"));
  const file = join(dir, "session.jsonl");
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = vi.fn(() => ({ getBranch: () => [] }));
  const runtime = {
    pi: { SessionManager: { open }, buildSessionProjection: () => ({ messages: [] }) },
  };
  const buildRuntime = vi.fn(async () => {
    await ready;
    return runtime;
  });
  const first = { controller: new AbortController(), failed: vi.fn() };
  const second = { controller: new AbortController(), failed: vi.fn() };
  const cancelledCaller = cancelled === "first" ? first : second;
  const activeCaller = cancelled === "first" ? second : first;
  const reason = new Error("caller cancelled");

  try {
    await writeFile(file, "{}\n");
    vi.mocked(sessionPaths).mockResolvedValue(file);
    const estimate = createCompactionOperations({
      dataDir: dir,
      buildRuntime,
    } as unknown as RuntimeContext).estimateContext;
    if (!estimate) throw new Error("Missing context estimator");
    const start = (caller: typeof first) =>
      estimate({
        botId: "bot",
        sessionFile: file,
        signal: caller.controller.signal,
      }).catch(caller.failed);

    const firstResult = start(first);
    await vi.waitFor(() => expect(buildRuntime).toHaveBeenCalledOnce());
    const secondResult = start(second);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(2));
    await Promise.all(vi.mocked(stat).mock.results.map((result) => result.value));
    cancelledCaller.controller.abort(reason);
    await vi.waitFor(() => expect(cancelledCaller.failed).toHaveBeenCalledWith(reason));

    release?.();
    const [firstEstimate, secondEstimate] = await Promise.all([firstResult, secondResult]);
    expect(cancelled === "first" ? secondEstimate : firstEstimate).toEqual({
      tokens: 0,
      model: undefined,
    });
    expect(activeCaller.failed).not.toHaveBeenCalled();
    expect(buildRuntime).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});
