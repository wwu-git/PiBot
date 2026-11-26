// Owns bounded discovery requests to the Magpie loopback gateway.
import { MAGPIE_PROVIDER, magpieBaseUrl, RpcError } from "@pibot/models-contract/full";
import { z } from "zod";

const hello = z.object({
  name: z.literal(MAGPIE_PROVIDER.id),
  version: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9.+_-]+$/),
});
const modelList = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(512) })).max(10000),
});

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("No Magpie response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  try {
    if (!response.ok) throw new Error("Magpie HTTP error");
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("Magpie response too large");
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } finally {
    await reader.cancel().catch(() => {
      // A stream that failed or was aborted is already closed by fetch.
    });
    reader.releaseLock();
  }
}

export async function detectMagpie(port: number, parent: AbortSignal) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(1500)]);
  try {
    const response = await fetch(new URL("/api/hello", magpieBaseUrl(port)), {
      signal,
      redirect: "error",
    });
    const result = hello.parse(await readJson(response, 4096));
    signal.throwIfAborted();
    return { running: true, port, version: result.version } as const;
  } catch {
    parent.throwIfAborted();
    // Connection, timeout and identity failures all leave the port editable.
    return { running: false } as const;
  }
}

export async function fetchMagpieModels(port: number, signal: AbortSignal) {
  try {
    const response = await fetch(`${magpieBaseUrl(port)}/models`, {
      signal,
      redirect: "error",
      headers: { Authorization: `Bearer ${MAGPIE_PROVIDER.attribution}` },
    });
    const { data } = modelList.parse(await readJson(response, 2 * 1024 * 1024));
    const ids = new Set(data.map((model) => model.id));
    if (ids.size === 0) throw new Error("Magpie model list empty");
    signal.throwIfAborted();
    return [...ids].map((id) => ({ id }));
  } catch {
    throw new RpcError(-32602, "magpie_models_unavailable");
  }
}
