// Use Ollama's native loopback server only when it attests that cloud features are disabled.
import { request as httpRequest } from "node:http";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";
import type { MemoryDraftRequest } from "../core/types.ts";
import { memoryDraftInstruction, parseMemoryDraft } from "./memory-draft.ts";

const statusSchema = z.object({ cloud: z.object({ disabled: z.literal(true) }) });
const resultSchema = z.object({
  message: z.object({ content: z.string().min(1).max(50_000) }),
  done: z.literal(true),
  done_reason: z.literal("stop"),
  prompt_eval_count: z.number().int().nonnegative(),
  eval_count: z.number().int().nonnegative(),
});

function requestJson(path: "/api/status" | "/api/chat", signal: AbortSignal, body?: string) {
  return new Promise<unknown>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: 11434,
        path,
        method: body ? "POST" : "GET",
        signal,
        agent: false,
        ...(body
          ? {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              },
            }
          : {}),
      },
      async (response) => {
        try {
          if (response.statusCode !== 200) throw new AgentError("provider_error");
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            bytes += chunk.length;
            if (bytes > 128 * 1024) throw new AgentError("output_limit");
            chunks.push(chunk);
          }
          resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

export async function draftLocalMemories(request: MemoryDraftRequest, signal: AbortSignal) {
  const { model, text, budget } = request;
  if (
    model.provider !== "ollama" ||
    !/^[\w.-]+(?:\/[\w.-]+)?(?::[\w.-]+)?$/u.test(model.id) ||
    /cloud/i.test(model.id)
  )
    throw new AgentError("no_model");
  const instruction = request.instruction ?? memoryDraftInstruction();
  const tokens = Buffer.byteLength(instruction) + Buffer.byteLength(text) + 1152;
  if (!budget || tokens > budget.tokens || tokens > 8192) throw new AgentError("budget_exhausted");
  const status = await requestJson("/api/status", signal);
  if (!statusSchema.safeParse(status).success) throw new AgentError("no_model");
  const usage = { tokens, costUsd: 0, modelProvider: model.provider, modelId: model.id };
  request.onUsage?.(usage);
  const result = resultSchema.parse(
    await requestJson(
      "/api/chat",
      signal,
      JSON.stringify({
        model: model.id,
        stream: false,
        think: false,
        format: "json",
        options: { num_ctx: 8192, num_predict: 1024 },
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: text },
        ],
      }),
    ),
  );
  const actual = result.prompt_eval_count + result.eval_count;
  request.onUsage?.({ ...usage, tokens: actual });
  return { draft: parseMemoryDraft(result.message.content), tokens: actual, costUsd: 0 };
}
