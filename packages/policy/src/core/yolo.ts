import { BOT_SEND_CONFIRMATION_REASON, WINDOWS_ORDINARY_COMMAND } from "./confirmation-reasons.ts";
import { yoloMustAsk } from "./connection-confirmation.ts";
import { createPolicyTrace, explainPolicyResult } from "./explain.ts";
import type { PolicyResult } from "./types.ts";

/** Reason code for a decision the conversation's YOLO switch allowed. */
export const YOLO_REASON = "yolo";

/**
 * Inside a conversation with YOLO on, a decision that would ask is allowed instead (except
 * sending as the user, a Bot that confirms every send, and paid image generation, which keep their
 * card). A deny
 * (never level, hard boundaries, blocklists, private addresses, read-only roots) stays a deny,
 * and nothing becomes rememberable: YOLO writes no grant and no routine preauthorization.
 * Dangerous calls keep asking, including when YOLO releases already pending cards; install,
 * background and network command consents are answered by YOLO (`yoloMustAsk`). Only brain's
 * explicit Windows-consent path supplies unisolatedCommands; generic callers cannot answer that question.
 */
export function applyYolo(
  result: PolicyResult,
  yolo: boolean | undefined,
  options: { unisolatedCommands?: boolean } = {},
): PolicyResult {
  // The stored Windows consent is explicit consent for ordinary unisolated commands, never for danger or other cards.
  const explicitUnisolated =
    options.unisolatedCommands === true && result.reason === "windows_unisolated";
  const unchanged =
    !yolo ||
    result.decision !== "ask" ||
    result.risk === "danger" ||
    result.reason === "user_send_confirmation" ||
    result.reason === BOT_SEND_CONFIRMATION_REASON ||
    (yoloMustAsk(result) && !explicitUnisolated) ||
    // Owner decision 2026-10-23: spending money is never implied by "stop asking"; only a
    // remembered paid_image grant or a routine pre-approval skips the paid card.
    result.reason === "paid_generation_confirmation";
  const last = result.explanation?.findLast((step) => step.effect !== "info");
  if (unchanged && last?.effect === result.decision) return result;
  // Brain can still supply legacy results (phase one). Never copy its free-form reason text.
  const trace = createPolicyTrace(result.explanation);
  if (!trace.steps.length) trace.step("category", "legacy_policy_result", "info");
  if (last?.effect !== result.decision)
    trace.step("boundary", "current_policy_decision", result.decision);
  if (unchanged) return { ...result, explanation: trace.steps };
  const allowed: PolicyResult = {
    ...result,
    decision: "allow",
    reason: YOLO_REASON,
    canRemember: false,
    explanation: trace.steps,
  };
  trace.step("yolo", YOLO_REASON, "allow");
  if (result.category === "read_ai_config") delete allowed.grantScope;
  return allowed;
}

/** The stored Windows consent covers ordinary Windows commands after the Windows risk and confirmation checks. */
export function applyWindowsCommandConsent(result: PolicyResult, consent: boolean): PolicyResult {
  if (
    result.decision !== "ask" ||
    result.risk !== "normal" ||
    result.reason !== WINDOWS_ORDINARY_COMMAND
  )
    return result;
  const bounded = explainPolicyResult(
    { ...result, reason: "windows_unisolated", canRemember: false },
    "boundary",
    "windows_unisolated",
  );
  return applyYolo(bounded, consent, { unisolatedCommands: true });
}
