import type { AgentAuthPorts, AgentRuntimeDeps } from "@pibot/agent";
import type { Bot, KernelMethodParams, Settings } from "@pibot/protocol-base";

/** Model selection is used by the kernel, while its persistence belongs to the capability. */
export interface ModelSettingsPort {
  setSettings(
    params: KernelMethodParams["settings.set"],
    signal: AbortSignal,
  ): Promise<{ settings: Settings; main: Bot | undefined }>;
  updateBot(params: KernelMethodParams["bots.update"], signal?: AbortSignal): Promise<Bot>;
}

/** Secrets stay behind the brain's model adapter; no DTO carries this port to a client. */
export interface ModelProvidersPort
  extends Pick<AgentRuntimeDeps, "hasApiKey" | "getApiKey" | "customProviders" | "addedModels"> {
  /** Capability-owned UI invalidation; the kernel never names the provider event. */
  changed(): void;
  readonly auth: AgentAuthPorts;
  readonly settings: ModelSettingsPort;
  credentials(providerId: string): Promise<void>;
  providerName(providerId: string): string | null;
  /** Only public persisted configuration participates in an image operation's authority snapshot. */
  configurationKey(providerId: string): string | null;
  updateCustomModelLimits?(
    providerId: string,
    modelId: string,
    limits: { maxTokens?: number; contextWindow?: number },
  ): void;
  drainInteractive(): Promise<void>;
  cancelAll(): void;
  /** Called after agent consumers drain, so a rotated OAuth token can still be persisted. */
  stop(): Promise<void>;
  settled(): Promise<void>;
}
