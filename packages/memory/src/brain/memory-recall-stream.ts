/** Unfinished words are bounded and never scored as prefixes of a later completed word. */
export interface RecallStream {
  word: string;
  wordBytes: number;
  dropped: boolean;
  high: string;
}
export const recallStream = (): RecallStream => ({
  word: "",
  wordBytes: 0,
  dropped: false,
  high: "",
});

export function recallSegment(
  state: RecallStream,
  text: string,
  end: boolean,
  budget: number,
  word: (value: string) => void,
) {
  const input = state.high + text.slice(0, budget + 1);
  state.high = "";
  let consumed = 0;
  const flush = () => {
    if (!state.dropped && state.word) word(state.word);
    state.word = "";
    state.wordBytes = 0;
    state.dropped = false;
  };
  for (let index = 0; index < input.length; ) {
    const point = input.codePointAt(index) ?? 0;
    const value = String.fromCodePoint(point);
    index += value.length;
    if (!end && index === input.length && point >= 0xd800 && point <= 0xdbff) {
      state.high = value;
      break;
    }
    const bytes = Buffer.byteLength(value);
    if (consumed + bytes > budget) {
      // The following delimiter is outside coverage, so a truncated prefix is not a word.
      state.word = "";
      state.wordBytes = 0;
      state.high = "";
      state.dropped = true;
      return { consumed, exhausted: true };
    }
    consumed += bytes;
    if (/^[\p{L}\p{N}\p{M}_-]$/u.test(value)) {
      if (state.dropped) continue;
      state.wordBytes += bytes;
      if (state.wordBytes > 4096) {
        state.word = "";
        state.dropped = true;
      } else state.word += value;
    } else flush();
  }
  if (end) flush();
  return { consumed, exhausted: false };
}
