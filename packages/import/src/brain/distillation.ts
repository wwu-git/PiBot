// Bound the redacted sample and send it only through the explicitly quoted local memory port.
import { randomUUID } from "node:crypto";
import type { CapabilityContext } from "@pibot/brain/kit";
import type { ImportStore } from "../store/index.ts";
import type { MemorySelection } from "../store/memories.ts";
import { ImportFailure } from "./adapter.ts";
import { redactImportText } from "./records.ts";

type Port = NonNullable<CapabilityContext["local"]["memoryImportDistillation"]>;
const MAX_SAMPLE_BYTES = 3000;

export function sampleImport() {
  let text = "";
  return {
    add(content: string, role: "user" | "assistant") {
      if (role !== "user") return;
      const available = MAX_SAMPLE_BYTES - Buffer.byteLength(text);
      if (available <= 0) return;
      const bytes = Buffer.from(`${content}\n\n`);
      let end = Math.min(available, bytes.length);
      // Keep a whole UTF-8 code point when the first long message fills the sample.
      while (end < bytes.length && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
      text += bytes.subarray(0, end).toString("utf8");
    },
    text: () => text,
  };
}

export async function distilImport(
  port: Port,
  request: { importId: string; botId: string; modelId: string; text: string },
  signal: AbortSignal,
  store: ImportStore,
  redactor: CapabilityContext["redactor"],
): Promise<MemorySelection | undefined> {
  if (!request.text.trim()) return undefined;
  let candidates: Awaited<ReturnType<Port["run"]>>;
  try {
    candidates = await port.run(request, signal);
  } catch {
    signal.throwIfAborted();
    throw new ImportFailure("distillation");
  }
  const inspect = store.memories.inspection(request.botId, "bot");
  const selected = candidates
    .map(({ text, category }) =>
      inspect({
        id: randomUUID(),
        text: redactImportText(redactor, text).trim(),
        category,
      }),
    )
    .filter(({ item }) => item.outcome === "add" && !!item.text && !item.text.includes("\0"));
  return { scope: "bot", selected };
}
