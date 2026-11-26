const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Byte limits apply before Unicode normalization or tokenization, including tool values. */
export function recallText(value: string, limit: number) {
  const bytes = encoder.encode(value.slice(0, limit));
  let end = Math.min(bytes.length, limit);
  if (end < bytes.length) while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

export function recallKeywords(value: string): string[] {
  const words =
    recallText(value, 4096)
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = new Set<string>();
  const common = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "will",
    "when",
    "your",
    "should",
    "always",
    "redacted",
    "以后",
    "用户",
    "使用",
    "需要",
    "默认",
  ]);
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      const characters = Array.from(word);
      for (let i = 0; i + 1 < characters.length && tokens.size < 32; i++) {
        const token = characters.slice(i, i + 2).join("");
        if (!common.has(token)) tokens.add(token);
      }
    } else if (word.length >= 3 && word.length <= 64 && !common.has(word)) tokens.add(word);
    if (tokens.size >= 32) break;
  }
  return [...tokens].slice(0, 32);
}

/** Walk a bounded part of structured tool parameters without serializing their full content. */
export function* recallValues(value: unknown): Generator<{ text: string; complete: boolean }> {
  let remaining = 8192;
  let visited = 0;
  const scan = function* (
    current: unknown,
    depth: number,
  ): Generator<{ text: string; complete: boolean }> {
    if (depth > 4 || remaining <= 0 || visited++ >= 128) return;
    if (typeof current === "string") {
      const text = recallText(current, Math.min(remaining, 4096));
      remaining -= encoder.encode(text).length;
      yield { text, complete: text === current };
    } else if (Array.isArray(current)) {
      for (const item of current.slice(0, 32)) yield* scan(item, depth + 1);
    } else if (current && typeof current === "object") {
      let count = 0;
      for (const key in current) {
        if (count++ >= 32) break;
        if (!Object.hasOwn(current, key)) continue;
        yield* scan((current as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  yield* scan(value, 0);
}
