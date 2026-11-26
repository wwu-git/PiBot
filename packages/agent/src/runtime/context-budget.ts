/**
 * Token budgets derived from one model's context window. Pure numbers, no pi types, so runtime
 * settings, the compaction hook and the context hook all read the same figures.
 */
export interface ContextBudget {
  /** pi `compaction.reserveTokens`: lowers the trigger independently of summary output limits. */
  reserveTokens: number;
  inputLimit: number;
  outputReserve: number;
  backgroundFromTokens: number;
  /** pi `compaction.keepRecentTokens`: the raw tail kept after a checkpoint; also the tail whose tool results are never trimmed. */
  keepRecentTokens: number;
  /** pi compacts once context tokens exceed this (`contextWindow - reserveTokens`). */
  triggerTokens: number;
  /** Output limit for our checkpoint request, before the model's own maxTokens cap. */
  summaryMaxTokens: number;
  /** Older long tool results are shortened in the request copy only above this estimate. */
  trimFromTokens: number;
}

/**
 * Large windows start compacting here instead of at `window - reserve` (~983k for 1M models).
 * Long contexts cost more per request and models attend worse to their middle; 160k bounds
 * long-running sessions; smaller windows retain response and estimation headroom.
 */
export const COMPACTION_TRIGGER_CAP = 160_000;

/** A catalog capability can be almost the whole window; it is not a per-response budget. */
export const RESPONSE_MAX_TOKENS = 32_768;

/**
 * A manual or provider-overflow checkpoint still has to summarise when the model reports no
 * window. Plan it as if the window were small, so the chunks fit whatever the real window is.
 */
export const UNKNOWN_WINDOW_FOR_SUMMARY = 32_000;
const UNKNOWN_WINDOW_SUMMARY_TOKENS = 2048;

export function responseMaxTokens(modelMaxTokens: number, requested?: number) {
  return Math.max(
    1,
    Math.min(modelMaxTokens, requested ?? RESPONSE_MAX_TOKENS, RESPONSE_MAX_TOKENS),
  );
}

export function contextBudget(contextWindow?: number): ContextBudget {
  const window = Math.floor(contextWindow ?? 0);
  // A missing/virtual model window is unknown, not a one-token window. Treating it as zero would
  // make every threshold comparison true and compact immediately.
  if (!Number.isFinite(window) || window <= 0)
    return {
      reserveTokens: 0,
      inputLimit: Number.POSITIVE_INFINITY,
      // Not a window-derived cap: the model's own maxTokens still bounds the response. Zero here
      // became maxTokens 1 (pi-ai clamps to at least one token).
      outputReserve: RESPONSE_MAX_TOKENS,
      backgroundFromTokens: Number.POSITIVE_INFINITY,
      keepRecentTokens: 0,
      triggerTokens: Number.POSITIVE_INFINITY,
      summaryMaxTokens: UNKNOWN_WINDOW_SUMMARY_TOKENS,
      trimFromTokens: Number.POSITIVE_INFINITY,
    };
  // The pre-cap reserve (20% of the window, 256..16384) still bounds small-window summaries.
  const baseReserve = Math.min(16384, Math.max(256, Math.floor(window * 0.2)));
  // pi has no separate trigger setting; raising reserveTokens is the public way to lower it.
  // Verified in pi 1.6.0 dist: shouldCompact still reads reserveTokens; generateSummary ignores
  // it. Our checkpoint has its own output budget. Request max output is clamped against the
  // real contextWindow (pi-ai clampMaxTokensToContext), and the cut point uses keepRecentTokens.
  const outputReserve = Math.min(RESPONSE_MAX_TOKENS, Math.max(256, Math.floor(window * 0.2)));
  const safety = Math.min(8192, Math.max(128, Math.floor(window * 0.04)));
  const inputLimit = Math.max(1, window - outputReserve - safety);
  const triggerTokens = Math.min(COMPACTION_TRIGGER_CAP, inputLimit);
  const reserveTokens = window - triggerTokens;
  return {
    reserveTokens,
    inputLimit,
    outputReserve,
    backgroundFromTokens: Math.floor(triggerTokens * 0.65),
    keepRecentTokens: Math.min(20000, Math.max(256, Math.floor(triggerTokens * 0.25))),
    triggerTokens,
    // ~2048 at 32K growing to 8192 at 128K: bigger windows can afford a fuller checkpoint, so
    // less detail is lost per compaction. Half the base reserve keeps tiny windows as before.
    summaryMaxTokens: Math.min(
      Math.min(8192, Math.max(2048, Math.floor(window / 16))),
      Math.floor(baseReserve / 2),
    ),
    // Same-turn repeated file reads also need trimming before the large-window 80k mark.
    trimFromTokens:
      triggerTokens > 0
        ? Math.min(40_000, Math.floor(triggerTokens / 2))
        : Number.POSITIVE_INFINITY,
  };
}

/** Checkpoint byte cap: Chinese is ~3 UTF-8 bytes per character, often more than one per token. */
export function summaryMaxBytes(maxTokens: number) {
  return Math.max(32768, maxTokens * 8);
}
