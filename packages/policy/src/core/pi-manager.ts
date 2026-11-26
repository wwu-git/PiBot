import { deny } from "./deny.ts";
import type { PolicyTrace } from "./explain.ts";
import { effectiveLevel } from "./levels.ts";
import type { EvaluationInput, PolicyResult } from "./types.ts";

/**
 * The default Pi manages Bots and groups and hands work to them (owner decision 2026-11-24).
 * Only a call the kernel marked `mainDirect` (Pi's own direct chat, typed by the person on this
 * computer) gets past the first step; every other caller is refused whatever its levels say.
 * Pi's own level then decides (never / ask / always). Listing reads names and states only and
 * needs no card. "Remember" on a card sets Pi's level to always, which the brain does; no grant
 * is created. What the receiving Bot then does is judged under its own permissions.
 */
export function piManagerPolicy(input: EvaluationInput, trace: PolicyTrace): PolicyResult {
  const request = input.request;
  const category = request.category === "work_dispatch" ? "work_dispatch" : "bot_management";
  const result: PolicyResult = {
    decision: "ask",
    reason: "permission_ask",
    risk: "normal",
    category,
    facts: [],
    canRemember: true,
    explanation: [],
  };
  const mainDirect =
    (request.category === "bot_management" || request.category === "work_dispatch") &&
    request.mainDirect === true;
  trace.step("boundary", "pi_manager_main_direct", mainDirect ? "info" : "deny");
  if (!mainDirect) return deny(result, "pi_manager_main_only", trace, "boundary");
  if (request.category === "bot_management" && request.operation === "list") {
    result.decision = "allow";
    result.reason = "pi_manager_list";
    result.canRemember = false;
    return trace.result(result, "category");
  }
  const level = effectiveLevel(input.settings.levels[category], input.botOverrides?.[category]);
  trace.step("level", "permission_level", "info", {
    level,
    source:
      input.permissionSources?.[category] ??
      (input.botOverrides?.[category] === undefined ? "default" : "bot"),
  });
  if (level === "never") return deny(result, "permission_never", trace, "level");
  if (level === "always") {
    result.decision = "allow";
    result.reason = "permission_always";
    result.canRemember = false;
  }
  return trace.result(result, "level");
}
