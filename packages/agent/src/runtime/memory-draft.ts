import { memoryDraftPrompts } from "./prompts/memory-draft.ts";
/** Post-hoc extraction from a finished conversation; output is validated by brain. */
export function memoryDraftInstruction() {
  return [
    memoryDraftPrompts.memoryDraftInstruction.item1,
    memoryDraftPrompts.memoryDraftInstruction.item2,
    memoryDraftPrompts.memoryDraftInstruction.item3,
    memoryDraftPrompts.memoryDraftInstruction.item4,
    memoryDraftPrompts.memoryDraftInstruction.item5,
    memoryDraftPrompts.memoryDraftInstruction.item6,
    memoryDraftPrompts.memoryDraftInstruction.item7,
    memoryDraftPrompts.memoryDraftInstruction.item8,
    memoryDraftPrompts.memoryDraftInstruction.item9,
    memoryDraftPrompts.memoryDraftInstruction.item10,
    memoryDraftPrompts.memoryDraftInstruction.item11,
    memoryDraftPrompts.memoryDraftInstruction.item12,
    memoryDraftPrompts.memoryDraftInstruction.item13,
  ].join("\n");
}

/** Models sometimes wrap JSON in fences or add prose; the shape itself is checked by the caller. */
export function parseMemoryDraft(text: string): unknown {
  const value = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
  const body = fenced?.[1] ?? value;
  // Match the outer value, including a bare candidate array, without treating braces inside
  // JSON strings or trailing explanatory prose as part of the envelope.
  const start = body.search(/[[{]/);
  if (start < 0) throw new TypeError("No memory draft");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if ((char === "}" || char === "]") && --depth === 0)
      return JSON.parse(body.slice(start, i + 1));
  }
  throw new TypeError("Incomplete memory draft");
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number; totalFromProvider?: boolean };
}

/**
 * Custom and unlisted models carry -1 as "price unknown". Multiplying by it produced negative
 * costs that were stored and then failed every read that requires cost >= 0, so an unknown
 * rate counts as nothing here; the token budget still bounds those requests.
 */
export function knownRate(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Same accounting as a run: reported cost first, catalog price only when it is known. */
export function memoryDraftUsage(
  model: { cost: { input: number; output: number; cacheRead: number; cacheWrite: number } },
  raw: unknown,
): { tokens: number; costUsd?: number } {
  const usage = (raw && typeof raw === "object" ? raw : undefined) as Usage | undefined;
  const tokens =
    usage?.totalTokens ??
    (usage
      ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      : 0);
  const reported = usage?.cost?.total;
  if (reported !== undefined && (reported > 0 || usage?.cost?.totalFromProvider)) {
    return { tokens, costUsd: knownRate(reported) };
  }
  const priced = Object.values(model.cost).some((value) => Number.isFinite(value) && value > 0);
  if (!priced || !usage) return { tokens };
  const costUsd =
    ((usage.input ?? 0) * knownRate(model.cost.input) +
      (usage.output ?? 0) * knownRate(model.cost.output) +
      (usage.cacheRead ?? 0) * knownRate(model.cost.cacheRead) +
      (usage.cacheWrite ?? 0) * knownRate(model.cost.cacheWrite)) /
    1_000_000;
  return { tokens, costUsd };
}
