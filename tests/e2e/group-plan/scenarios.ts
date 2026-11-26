// The supervisor and the probe share this list so the suite's deadline follows the
// scenarios it actually runs. One fixed cap for the whole run went stale as scenarios were added:
// on a loaded machine it expired before any scenario finished, which read as a hang.
export const KINDS = [
  "delivery-correction",
  "verdict-repair",
  "retry",
  "retry-exhausted",
  "replan",
  "budget",
  "confirmation",
  "replan-limit",
  "round-limit",
  "progress",
  "reassign-replan",
  "execution-child",
  "user-stop",
  "string-plan",
  "parallel-writers",
  "opc-weekly-review",
] as const;
export type Kind = (typeof KINDS)[number];
/**
 * Per scenario, not per suite. Measured on a Mac at load 10: the fixture costs ~2s and the runs
 * 30-80s of real CPU work (retry 30s, confirmation 82s), so a scenario that exceeds this is stuck
 * rather than merely slow, and the supervisor can name it instead of reporting one opaque timeout.
 */
export const SCENARIO_BUDGET_MS = 120_000;
/**
 * parallel-writers runs two plans (the coordinator's redo replaces the first), five member runs
 * and about ten sandboxed Git operations (create, commit, merge, remove per workspace); measured
 * ~155 s on an idle Mac, so the ordinary cap would name it stuck while it is only longer.
 */
// opc-weekly-review starts a stdio connector, runs four member steps in their own workspaces (one
// waits on the owner's draft cards), then four direct-chat sends that prove the send mark;
// measured 223 s at load 20-40 and over 300 s at load 200+, so it has its own longer cap.
const LONGER: Partial<Record<Kind, number>> = {
  "parallel-writers": 300_000,
  "verdict-repair": 300_000,
  "opc-weekly-review": 480_000,
};
export function scenarioBudget(name: string) {
  return (isKind(name) && LONGER[name]) || SCENARIO_BUDGET_MS;
}
/** Loading the brain, jiti and the fake model before the first scenario starts. */
export const SETUP_BUDGET_MS = 120_000;
export function isKind(value: string): value is Kind {
  return KINDS.some((kind) => kind === value);
}
