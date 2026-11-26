// Decodes untrusted bytes with explicit per-line and per-document resource limits.
import { ImportFailure, type ImportInput } from "../adapter.ts";

const LINE_LIMIT = 8 * 1024 * 1024;

export async function* textChunks(chunks: AsyncIterable<Buffer>, signal: AbortSignal) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const bytes of chunks) {
    signal.throwIfAborted();
    yield decode(() => decoder.decode(bytes, { stream: true }));
  }
  yield decode(() => decoder.decode());
}

function decode(run: () => string) {
  try {
    return run();
  } catch (error) {
    if (error instanceof TypeError) throw new ImportFailure("format");
    throw error;
  }
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ImportFailure("format");
    throw error;
  }
}

/** Stands for a line past LINE_LIMIT; its bytes were dropped as they arrived, never buffered. */
export const OVERSIZED_LINE: unique symbol = Symbol("oversized_line");

export async function* jsonLines(
  input: ImportInput,
  signal: AbortSignal,
): AsyncGenerator<unknown | typeof OVERSIZED_LINE> {
  let pending = "";
  let skipping = false;
  for await (const text of textChunks(input(signal), signal)) {
    const lines = text.split("\n");
    const head = lines.shift() ?? "";
    if (!skipping) pending += head;
    if (!skipping && pending.length > LINE_LIMIT) {
      // One oversized row (a compaction summary, a huge tool output) must not fail the file.
      skipping = true;
      pending = "";
    }
    if (!lines.length) continue;
    if (skipping) yield OVERSIZED_LINE;
    else if (pending.trim()) yield parseJson(pending);
    skipping = false;
    pending = lines.pop() ?? "";
    for (const line of lines) {
      signal.throwIfAborted();
      if (line.trim()) yield parseJson(line);
    }
    if (pending.length > LINE_LIMIT) {
      skipping = true;
      pending = "";
    }
  }
  if (skipping) yield OVERSIZED_LINE;
  else if (pending.trim()) yield parseJson(pending);
}

export async function readProjectNote(input: ImportInput, signal: AbortSignal) {
  if (!input.projectNote) throw new ImportFailure("format");
  let text = "";
  for await (const chunk of textChunks(input(signal), signal)) {
    text += chunk;
    if (Buffer.byteLength(text) > 256 * 1024) throw new ImportFailure("limit");
  }
  if (!text.trim() || text.includes("\u0000")) throw new ImportFailure("format");
  return text;
}
