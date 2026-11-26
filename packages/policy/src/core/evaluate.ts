import { evaluateComputer } from "../targets/computer.ts";
import { agentDelegationPolicy } from "./agent-delegation.ts";
import { ownBackgroundDecision } from "./background-decision.ts";
import { commandNetwork } from "./command-consent.ts";
import { createPolicyTrace } from "./explain.ts";
import { finish } from "./finish.ts";
import { intrinsicDecision } from "./intrinsic-decisions.ts";
import { effectiveLevel } from "./levels.ts";
import { memoryWritePolicy } from "./memory-write.ts";
import { piManagerPolicy } from "./pi-manager.ts";
import { preparePolicyFacts } from "./prepare-facts.ts";
import { parseInput } from "./request-input.ts";
import type { CommandAnalysis, EvaluationInput, PolicyOptions, PolicyResult } from "./types.ts";
import { applyYolo } from "./yolo.ts";

export { effectiveLevel } from "./levels.ts";

export function createEvaluator(
  options: PolicyOptions,
  analyze: (
    command: string,
    platform?: PolicyOptions["platform"],
    home?: string,
  ) => CommandAnalysis,
) {
  const decide = judge(options, analyze);
  // YOLO is one more input of the single gate, applied to the final decision.
  return async (raw: EvaluationInput): Promise<PolicyResult> =>
    applyYolo(await decide(raw), raw.yolo === true);
}
function judge(
  options: PolicyOptions,
  analyze: (
    command: string,
    platform?: PolicyOptions["platform"],
    home?: string,
  ) => CommandAnalysis,
) {
  return async (raw: EvaluationInput): Promise<PolicyResult> => {
    raw.signal.throwIfAborted();
    const platform = raw.boundary?.location?.platform ?? options.platform;
    const input = parseInput(raw, platform);
    const effectiveOptions = platform === options.platform ? options : { ...options, platform };
    const trace = createPolicyTrace();
    trace.step("category", input.request.category, "info");
    const intrinsic = intrinsicDecision(input, trace);
    if (intrinsic) return intrinsic;
    if (input.request.category === "computer")
      return evaluateComputer({ ...input, request: input.request }, trace);
    if (input.request.category === "memory") return memoryWritePolicy(input.request);
    if (input.request.category === "agent_delegation") return agentDelegationPolicy(input, trace);
    if (input.request.category === "bot_management" || input.request.category === "work_dispatch")
      return piManagerPolicy(input, trace);
    // The Bot's own background commands, which the user already approved when they started;
    // listing, reading their output and stopping them reach nothing new.
    if (input.request.category === "background") return ownBackgroundDecision(trace);
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
    const prepared = await preparePolicyFacts(
      { ...input, signal },
      effectiveOptions,
      analyze,
      trace,
    );
    const result = finish(input, effectiveOptions, prepared, trace);
    if (
      input.request.category === "run_command" &&
      effectiveLevel(input.settings.levels.run_command, input.botOverrides?.run_command) ===
        "always" &&
      !prepared.outside &&
      !input.request.background &&
      !input.request.stdin &&
      !input.request.outsideSandbox &&
      !result.facts.some(
        (fact) => fact.kind === "warning" && fact.value === "sandbox_outside_auto",
      ) &&
      !result.outsideWrites?.length &&
      result.risk === "normal" &&
      (result.reason === "permission_always" || result.reason === "incomplete_analysis") &&
      platform !== "win32" &&
      (await input.commandIsolation?.(signal)) === true
    ) {
      signal.throwIfAborted();
      result.commandNetwork = commandNetwork(input);
      result.decision = "allow";
      result.reason = "sandboxed_command";
      result.canRemember = false;
      delete result.grantScope;
      delete result.scriptScope;
      return trace.result(result, "boundary");
    }
    signal.throwIfAborted();
    return result;
  };
}
