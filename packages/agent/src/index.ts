// The patched version-only entry is the locked 1.6.0 constant; it imports no SDK/config module.
export { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent/version";
export {
  type ChatGPTUnavailableReason,
  chatGPTSignInAvailability,
} from "./auth/chatgpt-access.ts";
export { type ChatGPTSignInFailure, chatGPTSignInFailure } from "./auth/chatgpt-callback.ts";
export { assertSupportedCredential, assertSupportedHeaders } from "./auth/claude-subscription.ts";
export { BRAIN_AUTH_ENV_NAMES, sanitizeBrainEnv } from "./core/env.ts";
export { AgentError, mapAgentError } from "./core/errors.ts";
export {
  type ConnectorToolHints,
  connectorEffectClass,
  PARALLEL_READS,
  type ToolEffectClass,
  toolEffectClass,
} from "./core/tool-effects.ts";
export { toolErrorLog } from "./core/tool-error-log.ts";
export type * from "./core/types.ts";
export { createConnectorConnectionFactory } from "./mcp/lazy-connection.ts";
export { listProviderCatalog } from "./models/catalog.ts";
export { chatGPTPlanModels } from "./models/chatgpt-plan-models.ts";
export { type AgentNetwork, installAgentNetwork } from "./network/network.ts";
export { contextBudget, responseMaxTokens } from "./runtime/context-budget.ts";
export { createAgentRuntime } from "./runtime/runtime.ts";
export { localToolIdentity } from "./runtime/tool-identity.ts";
export { resolveSessionFile } from "./session/session-files.ts";
export { readSessionOperation } from "./session/session-operation.ts";
export {
  purgeSessionReferences,
  REMOVED_REFERENCE_TYPE,
  type ReferenceMatch,
} from "./session/session-purge.ts";
export { readSessionRecovery } from "./session/session-recovery.ts";
export { forkRetrySession, inspectRetrySession } from "./session/session-retry.ts";
