// Frames a JSON array one bounded object at a time without buffering the archive member.
import { ImportFailure } from "../adapter.ts";
import { parseJson, textChunks } from "./text.ts";

type State = "open" | "first" | "item" | "separator" | "end";
const MAX_OBJECT = 2 * 1024 * 1024;
const whitespace = /^[ \r\n\t]$/;

class ArrayFramer {
  private state: State = "open";
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private pending = "";

  private nested(char: string) {
    if (this.escaped) {
      this.escaped = false;
      return;
    }
    if (this.quoted && char === "\\") this.escaped = true;
    else if (char === '"') this.quoted = !this.quoted;
    else if (!this.quoted) {
      if (char === "{" || char === "[") this.depth++;
      if (char === "}" || char === "]") this.depth--;
      if (this.depth > 64) throw new ImportFailure("limit");
    }
  }

  private delimiter(char: string) {
    if (whitespace.test(char)) return;
    if (this.state === "open" && char === "[") this.state = "first";
    else if ((this.state === "separator" || this.state === "first") && char === "]")
      this.state = "end";
    else if (this.state === "separator" && char === ",") this.state = "item";
    else if ((this.state === "first" || this.state === "item") && char === "{") this.depth = 1;
    else throw new ImportFailure("format");
  }

  *feed(text: string) {
    let start = this.depth ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const char = text.charAt(i);
      if (!this.depth) {
        this.delimiter(char);
        if (this.depth) start = i;
        continue;
      }
      this.nested(char);
      if (this.pending.length + i - start >= MAX_OBJECT) throw new ImportFailure("limit");
      if (this.depth) continue;
      const item = this.pending + text.slice(start, i + 1);
      this.pending = "";
      this.state = "separator";
      start = -1;
      yield parseJson(item);
    }
    if (start >= 0) this.pending += text.slice(start);
  }

  finish() {
    if (this.state !== "end" || this.depth) throw new ImportFailure("format");
  }
}

export async function* jsonArray(input: AsyncIterable<Buffer>, signal: AbortSignal) {
  const framer = new ArrayFramer();
  for await (const text of textChunks(input, signal)) {
    for (const item of framer.feed(text)) {
      signal.throwIfAborted();
      yield item;
    }
  }
  framer.finish();
}
