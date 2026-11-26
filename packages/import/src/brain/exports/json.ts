// Decode one bounded JSON record at a time while keeping archive-size memory independent.
import { ImportFailure } from "../adapter.ts";

const MAX_RECORD_CHARS = 8 * 1024 * 1024;
const MAX_DEPTH = 96;
const MAX_RECORD_TOKENS = 150_000;

function invalid(): never {
  throw new ImportFailure("format");
}

function decode(decoder: TextDecoder, chunk?: Buffer) {
  try {
    return decoder.decode(chunk, { stream: chunk !== undefined });
  } catch {
    return invalid();
  }
}

async function* textChunks(input: AsyncIterable<Buffer>) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of input) yield decode(decoder, chunk);
  yield decode(decoder);
}

class RecordScanner {
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private parts: string[] = [];
  private size = 0;
  private tokenCount = 0;
  private tokens = /["\\{}[\]]/g;

  finishAt(chunk: string, start: number) {
    const { tokens } = this;
    tokens.lastIndex = start + (this.escaped ? 1 : 0);
    if (start < chunk.length) this.escaped = false;
    for (let match = tokens.exec(chunk); match; match = tokens.exec(chunk)) {
      if (++this.tokenCount > MAX_RECORD_TOKENS) throw new ImportFailure("limit");
      const token = match[0];
      if (this.quoted) {
        if (token === "\\") {
          if (tokens.lastIndex === chunk.length) this.escaped = true;
          else tokens.lastIndex++;
        }
        if (token === '"') this.quoted = false;
      } else if (token === '"') {
        this.quoted = true;
      } else if (token === "{" || token === "[") {
        if (++this.depth > MAX_DEPTH) throw new ImportFailure("limit");
      } else if (token === "}" || token === "]") {
        this.depth--;
      } else {
        invalid();
      }
      if (this.depth === 0 && !this.quoted) return tokens.lastIndex;
    }
    return undefined;
  }

  append(text: string) {
    this.size += text.length;
    if (this.size > MAX_RECORD_CHARS) throw new ImportFailure("limit");
    this.parts.push(text);
  }

  value(): unknown {
    try {
      return JSON.parse(this.parts.join(""));
    } catch {
      return invalid();
    }
  }
}

function whitespace(char: string) {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

export async function* jsonRecords(
  input: AsyncIterable<Buffer>,
  signal: AbortSignal,
  allowSingleObject = false,
): AsyncGenerator<unknown> {
  let state: "start" | "first" | "item" | "separator" | "end" = "start";
  let scanner: RecordScanner | undefined;
  let array = false;
  for await (const chunk of textChunks(input)) {
    signal.throwIfAborted();
    for (let offset = 0; offset < chunk.length; ) {
      const char = chunk.charAt(offset);
      if (!scanner) {
        if (whitespace(char)) {
          offset++;
          continue;
        }
        if (state === "start" && char === "[") {
          array = true;
          state = "first";
        } else if ((state === "first" || state === "separator") && char === "]") {
          state = "end";
        } else if (state === "separator" && char === ",") {
          state = "item";
        } else if (
          ((state === "first" || state === "item") && (char === "{" || char === '"')) ||
          (state === "start" && allowSingleObject && char === "{")
        ) {
          scanner = new RecordScanner();
        } else {
          invalid();
        }
        if (!scanner) {
          offset++;
          continue;
        }
      }
      const end = scanner.finishAt(chunk, offset);
      scanner.append(chunk.slice(offset, end));
      if (end === undefined) break;
      yield scanner.value();
      scanner = undefined;
      state = array ? "separator" : "end";
      offset = end;
    }
  }
  if (state !== "end" || scanner) invalid();
}
