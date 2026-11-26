import { createCommandAnalyzer } from "./commands/commands.ts";
import { createEvaluator } from "./core/evaluate.ts";
import { createPolicyTrace } from "./core/explain.ts";
import { preparePolicyFacts } from "./core/prepare-facts.ts";
import { parseInput } from "./core/request-input.ts";
import type { EvaluationInput, Policy, PolicyOptions } from "./core/types.ts";

export async function createPolicy(options: PolicyOptions): Promise<
  Policy & {
    prepare(input: EvaluationInput): Promise<import("./core/request-facts.ts").RequestFacts>;
  }
> {
  const analyzer = await createCommandAnalyzer(options);
  const lifetime = new AbortController();
  const evaluate = createEvaluator(options, analyzer.analyze);
  return {
    evaluate: (input) =>
      evaluate({ ...input, signal: AbortSignal.any([input.signal, lifetime.signal]) }),
    analyzeCommand: analyzer.analyze,
    prepare: (raw) =>
      preparePolicyFacts(
        parseInput(
          {
            ...raw,
            signal: AbortSignal.any([raw.signal, lifetime.signal, AbortSignal.timeout(10_000)]),
          },
          raw.boundary?.location?.platform ?? options.platform,
        ),
        options,
        analyzer.analyze,
        createPolicyTrace(),
      ),
    dispose() {
      lifetime.abort();
      analyzer.dispose();
    },
  };
}
export { createCommandAnalyzer } from "./commands/commands.ts";
export { DANGEROUS_RULES, dangerousReasons } from "./commands/dangerous.ts";
export { isReadonlyCommand, READONLY_PROGRAMS } from "./commands/readonly-programs.ts";
export { agentLaunchPolicy } from "./core/agent-launch.ts";
export {
  BOT_SEND_CONFIRMATION_REASON,
  PRIVATE_NETWORK_REASON,
  WINDOWS_ORDINARY_COMMAND,
  WINDOWS_READ_ONLY,
  WINDOWS_REQUIRES_APPROVAL,
} from "./core/confirmation-reasons.ts";
export {
  CONNECTION_CONFIRMATION_REASON,
  CONNECTION_READ_ONLY_REASON,
  type ConnectorCallTarget,
  connectionConfirmation,
  connectionUnattendedAllowed,
  connectionWriteRememberable,
  connectorCallRequest,
  effectiveConfirmationMode,
  mustAskNow,
  REVEAL_CONFIRMATION_REASON,
  yoloMustAsk,
} from "./core/connection-confirmation.ts";
export {
  applyEditorTerminal,
  EDITOR_SESSION_REASON,
  EDITOR_TERMINAL_READONLY_REASON,
  EDITOR_TERMINAL_UNISOLATED,
  editorSessionShape,
  editorTerminalReadonly,
} from "./core/editor-terminal.ts";
export { createEvaluator, effectiveLevel } from "./core/evaluate.ts";
export {
  createPolicyTrace,
  explainPolicyResult,
  type PolicyTrace,
  recordPolicyStep,
} from "./core/explain.ts";
export * from "./core/git-configuration.ts";
export { GIT_CONFIGURATION_CONFIRMATION_REASON } from "./core/git-configuration-policy.ts";
export { GIT_ENTRY_CONFIRMATION_REASON } from "./core/git-entry-policy.ts";
export { GIT_HOOK_CONFIRMATION_REASON } from "./core/git-hook-policy.ts";
export { GIT_HOOKS_PATH_CONFIRMATION_REASON } from "./core/git-hooks-path-policy.ts";
export { jev } from "./core/jev.ts";
export { type MemoryWriteFacts, memoryWritePolicy } from "./core/memory-write.ts";
export {
  automaticOutsidePatterns,
  automaticOutsideShape,
  fixedOutsideCommand,
  LISTED_OUTSIDE_SANDBOX_REASON,
  type ListedFilter,
  LOCAL_SERVICE_REASON,
  listedOutsideFilters,
  OUTSIDE_SANDBOX_REASON,
  type OutsideSandboxFacts,
  soleInvokedProgram,
} from "./core/outside-sandbox.ts";
export {
  OUTSIDE_WRITE_DENIED_REASON,
  OUTSIDE_WRITE_REASON,
  PROTECTED_PATH_REASON,
} from "./core/outside-write.ts";
export { pinnedScriptFile, scriptPinnedScope } from "./core/script-consent.ts";
export type * from "./core/types.ts";
export { applyWindowsCommandConsent, applyYolo, YOLO_REASON } from "./core/yolo.ts";
export { createGrantScope, matchesGrant, siteCovers } from "./grants/grants.ts";
export {
  matchesRoutinePreauth,
  preauthInvalidReason,
  preauthorizableOperation,
} from "./grants/routine-preauth.ts";
export {
  canonicalPath,
  containsPath,
  expandHome,
  nodeFileSystem,
  resolvePath,
} from "./paths/paths.ts";
export { protectedPaths } from "./paths/protected-paths.ts";
export { browserSecretPolicy } from "./secrets/browser-secret-policy.ts";
export { type SecretUsePolicyInput, secretUsePolicy } from "./secrets/secret-use.ts";
export { secretWriteOutDenied } from "./secrets/secret-write-out.ts";
export {
  browserPrivateNetworkHost,
  privateCommandHosts,
  privateNetworkHost,
  privateNetworkOrigin,
} from "./targets/private-network.ts";
