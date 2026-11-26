// Run one headless chat while keeping streaming and committed reply order separate.
import { setTimeout as wait } from "node:timers/promises";
import { type Events, type Methods, type Peer, RpcError } from "@pibot/protocol";
import type { Api, RunOptions } from "./args.ts";
import { appDataDirReason, protectedDataDirReason } from "./data-dir-guard.ts";
import { createHeadless, type Headless } from "./headless.ts";
import { committedReply, type Receipt } from "./run-reply.ts";

export interface Emit {
  /** `--json`: one object per line. */
  event(record: Record<string, unknown>): void;
  /** Human mode: streamed assistant text. */
  text(chunk: string): void;
  /** Human mode: a line the caller must see regardless of the answer. */
  notice(line: string): void;
}

const POLL_MS = 250;
/** A stop that hangs would keep the process alive after the answer was already reported. */
const STOP_GRACE_MS = 10_000;

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Client = Peer<typeof Methods, typeof Events>;

/**
 * One turn, end to end: boot the brain in this process, send a message, stream the answer, stop.
 * Everything the desktop app does through Electron is replaced by an in-memory port and a host
 * without dialogs, so this proves the brain runs without Electron instead of asserting it.
 */
export async function runOnce(options: RunOptions, out: Emit): Promise<number> {
  const appRefused = appDataDirReason(options.dataDir);
  const refused = appRefused ?? (await protectedDataDirReason(options.dataDir));
  if (refused) {
    out.event({
      type: "error",
      code: appRefused ? "app_data_dir" : "protected_data_dir",
      message: refused,
    });
    out.notice(`error: ${refused}`);
    return 1;
  }
  // Receipts may arrive before chat.send returns its run id.
  const requests: Record<string, unknown>[] = [];
  const owner = createHeadless(options.dataDir, {
    ...(options.json && {
      modelRequest: (runId, metrics) => requests.push({ type: "model_request", runId, ...metrics }),
    }),
  });
  const client = owner.client;
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  const deadline = Date.now() + options.timeoutMs;
  // Every await shares one budget: a hung startup, send or history poll must not outlive --timeout.
  const bounded = <T>(work: Promise<T>, what: string) => withDeadline(work, what, deadline);
  let targetRun: string | undefined;
  try {
    await bounded(owner.ready, "startup");
    const botId = await bounded(targetBot(client, options.bot), "bot list");
    if (options.provider)
      await bounded(configureModel(client, botId, options.provider), "model setup");

    let lastMessage: string | undefined;
    let firstTokenAt: number | undefined;
    const accept = (id: string, text: string, at: number) => {
      if (!text) return;
      firstTokenAt ??= at;
      if (lastMessage && lastMessage !== id) out.text("\n\n");
      lastMessage = id;
      out.text(text);
    };
    // Headless: nobody can answer a card, so deny this run's cards instead of hanging out --timeout.
    const denyApproval = (id: string, category: string) => {
      out.notice(`approval required (headless, denied): ${category}`);
      void client
        .call("approvals.resolve", { id, decision: "deny", remember: false })
        // The run may already be finished or aborted; the denied card is not worth failing over.
        .catch(() => undefined);
    };
    // `chat.send` returns the message id after the first tokens may already have streamed.
    const early: { id: string; runId: string; text: string; at: number }[] = [];
    const earlyApprovals: { id: string; runId: string; category: string }[] = [];
    client.on("chat.delta", (delta) => {
      if (targetRun === undefined) {
        early.push({
          id: delta.messageId,
          runId: delta.runId,
          text: delta.text,
          at: performance.now(),
        });
        return;
      }
      if (delta.runId === targetRun) accept(delta.messageId, delta.text, performance.now());
    });
    client.on("approval.requested", (approval) => {
      if (targetRun === undefined) {
        earlyApprovals.push({
          id: approval.id,
          runId: approval.runId,
          category: approval.category,
        });
        return;
      }
      // Cards from other runs (routines sharing this data directory) are not ours to answer.
      if (approval.runId === targetRun) denyApproval(approval.id, approval.category);
      else out.notice(`approval required (not this run, left pending): ${approval.category}`);
    });
    // An abort that arrived during startup must stop before the message is sent and billed.
    if (abort.signal.aborted) {
      out.event({ type: "done", status: "aborted", text: "" });
      return 130;
    }
    const startedAt = performance.now();
    const receipt = await bounded(
      client.call("chat.send", {
        botId,
        text: options.message,
        ...(options.newTopic ? { newTopic: true as const } : {}),
      }),
      "chat.send",
    );
    targetRun = receipt.runId;
    for (const delta of early)
      if (delta.runId === targetRun) accept(delta.id, delta.text, delta.at);
    for (const approval of earlyApprovals)
      if (approval.runId === targetRun) denyApproval(approval.id, approval.category);
    out.event({
      type: "run",
      modelMetrics: options.json,
      botId,
      runId: receipt.runId,
      conversationId: receipt.conversationId,
      assistantMessageId: receipt.assistantMessageId,
    });

    const final = await settle(client, botId, receipt, deadline, abort.signal, bounded);
    // Keep committed bubbles even if the terminal attempt failed or was aborted.
    out.event({
      type: "done",
      status: final.status,
      text: final.content,
      usage: final.usage,
      timing: {
        firstTokenMs: firstTokenAt === undefined ? null : Math.round(firstTokenAt - startedAt),
        totalMs: Math.round(performance.now() - startedAt),
      },
    });
    if (final.status === "aborted") return 130;
    if (final.status === "error")
      throw new CliError(final.errorCode ?? "run_failed", "The run failed");
    return 0;
  } catch (error) {
    return report(error, out);
  } finally {
    process.off("SIGINT", onSignal);
    client.dispose();
    // Stopping the brain is what releases the database and the run; never leave it half started.
    await shutdown(owner, out);
    for (const request of requests) if (request.runId === targetRun) out.event(request);
  }
}

export function withDeadline<T>(work: Promise<T>, what: string, deadline: number): Promise<T> {
  // A caller that gives up on the deadline abandons this promise, and the peer rejects it later when
  // it disposes; an unhandled rejection there would crash the process after the report.
  work.catch(() => undefined);
  const budget = deadline - Date.now();
  const timeout = () => new CliError("timeout", `${what} exceeded --timeout`);
  if (budget <= 0) return Promise.reject(timeout());
  return new Promise<T>((done, fail) => {
    const timer = setTimeout(() => fail(timeout()), budget);
    work.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        fail(error);
      },
    );
  });
}

async function shutdown(brain: Headless, out: Emit) {
  const stopped = await Promise.race([
    brain.stop().then(
      () => "stopped" as const,
      (error: unknown) => {
        // The run is over; a failing stop must not replace the exit code already reported.
        out.notice(`brain stop failed: ${error instanceof Error ? error.message : "unknown"}`);
        return "failed" as const;
      },
    ),
    wait(STOP_GRACE_MS).then(() => "timeout" as const),
  ]);
  if (stopped === "timeout") out.notice("brain did not stop in time; the process may need to exit");
}

function report(error: unknown, out: Emit): number {
  if (error instanceof CliError) {
    out.event({ type: "error", code: error.code, message: error.message });
    out.notice(`error: ${error.code}`);
    return 1;
  }
  if (error instanceof RpcError) {
    out.event({ type: "error", code: String(error.code), message: error.message });
    out.notice(`error: ${error.message}`);
    return 1;
  }
  const message = error instanceof Error ? error.message : "unexpected failure";
  out.event({ type: "error", code: "internal", message });
  out.notice(`error: ${message}`);
  return 1;
}

export async function targetBot(client: Client, wanted: string | undefined): Promise<string> {
  const bots = await client.call("bots.list", {});
  if (wanted) {
    const match = bots.find((bot) => bot.id === wanted || bot.name === wanted);
    if (!match) throw new CliError("bot_not_found", `No Bot matches ${wanted}`);
    return match.id;
  }
  const main = bots.find((bot) => bot.isMain);
  if (!main) throw new CliError("bot_not_found", "No main Bot in this data directory");
  return main.id;
}

/** A scripted check needs a model without opening the app, so the endpoint is part of the command. */
export async function configureModel(
  client: Client,
  botId: string,
  provider: NonNullable<RunOptions["provider"]>,
) {
  // The output budget comes out of the window; half keeps room for the prompt at the smallest size.
  const model = {
    id: provider.model,
    contextWindow: provider.contextWindow,
    maxTokens: Math.min(8_192, Math.floor(provider.contextWindow / 2)),
  };
  const { id } = await client.call("customProviders.upsert", {
    id: "cli",
    name: "CLI endpoint",
    baseUrl: provider.baseUrl,
    api: provider.api as Api,
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    models: [model],
  });
  const modelSettings = { provider: id, id: provider.model, thinkingLevel: "off" as const };
  await client.call("settings.set", { defaultModel: modelSettings });
  await client.call("bots.update", {
    botId,
    modelProvider: id,
    modelId: provider.model,
    thinkingLevel: "off",
  });
}

/** The brain reports progress through events; the final status lives only in the message row. */
export async function settle(
  client: Client,
  botId: string,
  receipt: Receipt,
  deadline: number,
  signal: AbortSignal,
  bounded: <T>(work: Promise<T>, what: string) => Promise<T>,
) {
  let abortRequested = false;
  // Aborting is best effort: its failure must not replace the 130 or the timeout we owe the caller.
  const stopRun = () => client.call("chat.abort", { runId: receipt.runId }).catch(() => undefined);
  for (;;) {
    const reply = await committedReply(client, botId, receipt, bounded);
    if (reply) return reply;
    if (signal.aborted && !abortRequested) {
      // One abort is enough; the run turns into an `aborted` row that the next poll returns.
      abortRequested = true;
      await stopRun();
    }
    if (Date.now() > deadline) {
      await stopRun();
      throw new CliError("timeout", "Run exceeded --timeout");
    }
    await wait(POLL_MS);
  }
}
