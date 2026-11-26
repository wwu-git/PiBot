// Brain-side connector orchestration: the 13 registered RPCs, lifecycle
// operations, the connection pool and tool catalog publishing live here. The
// pool borrows connections; dispatch permissions are enforced per call and
// never inherited from a plugin manifest.

import type { PluginSkillsHost, RegisterRpc, UserSecretsPort } from "@pibot/brain/kit";
import type { Plugin } from "@pibot/plugin-sdk";
import type {
  ConnectorCommandConfirmation,
  ConnectorConnectionFactory,
  ConnectorImportHost,
  EventPayloads,
} from "@pibot/plugins-contract/full";
import { ConnectorToolSchema } from "@pibot/plugins-contract/full";
import type { AuditRepo, DraftsRepo, SecretStore } from "@pibot/storage";
import { z } from "zod";
import type {
  ConnectorCatalogRepo,
  ConnectorOperationsRepo,
  ConnectorsRepo,
  PluginsRepo,
} from "../../../store/index.ts";
import type { ConnectorPool } from "../../pool/pool.ts";
import type { ConnectorService } from "../connector-service.ts";

export const discoveryCursor = z.strictObject({
  snapshot: z.string().length(64),
  after: z.number().int().nonnegative().safe(),
});

export const MAX_DISCOVERY_PAGES = 40;

export const remotePageSchema = z.strictObject({
  tools: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(4096)
          .refine((name) => name === name.trim() && !name.includes("\0")),
        title: z.string().max(200).optional(),
        description: z.string().max(4096).optional(),
        inputSchema: ConnectorToolSchema.shape.schema,
        readOnlyHint: z.boolean().optional(),
        idempotentHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
      }),
    )
    .max(50),
  nextCursor: z.string().min(1).max(2048).optional(),
});

export type Emit = <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void;

/** The 13 registered connector RPCs, through brain's single RPC wrapper. */
export function registerConnectorRpc(handle: RegisterRpc, service: ConnectorService) {
  handle("apps.list", () => Promise.resolve(service.apps.list()));
  handle("plugins.pickImport", (params) => service.pickImport(params));
  handle("apps.connect", (params) => service.apps.connect(params));
  handle("connectors.authorize", (params) => service.apps.authorize(params));
  handle("connectors.cancelAuthorization", (params) =>
    Promise.resolve(service.apps.cancel(params.authorizationId)),
  );
  handle("plugins.list", (params) => Promise.resolve(service.listPlugins(params)));
  handle("plugins.setEnabled", (params) => Promise.resolve(service.setPluginEnabled(params)));
  handle("plugins.previewImport", (params, context) =>
    Promise.resolve(service.previewImport(params.source, context.signal)),
  );
  handle("plugins.cancelPreview", (params) => Promise.resolve(service.cancelPreview(params)));
  handle("plugins.import", (params, context) => service.import(params, context.signal));
  handle("plugins.uninstall", (params) => Promise.resolve(service.uninstall(params)));
  handle("connectors.list", (params) => Promise.resolve(service.listConnectors(params)));
  handle("connectors.get", (params) => Promise.resolve(service.getConnector(params)));
  handle("connectors.update", (params) => Promise.resolve(service.updateConnector(params)));
  handle("connectors.updateFromSource", (params) => service.updateFromSource(params));
  handle("connectors.operation", (params) => Promise.resolve(service.getOperation(params)));
  handle("connectors.tools", (params) => Promise.resolve(service.listTools(params)));
  handle("connectors.setEnabled", (params, context) => service.setEnabled(params, context.signal));
  handle("connectors.disconnect", (params) => Promise.resolve(service.disconnect(params)));
  handle("connectors.restart", (params, context) => service.restart(params, context.signal));
  handle("connectors.diagnostics", (params) => service.diagnostics(params));
  handle("connectors.setOutsideSandbox", (params, context) =>
    service.setOutsideSandbox(params, context.signal),
  );
}

export interface ConnectorServiceDeps {
  commandRisk?(
    command: string,
    signal: AbortSignal,
  ): Promise<"dangerous" | "unverified" | undefined>;
  logStderr?(connectorId: string, tail: string): void;
  /** One structured line per failed stdio start; codes only (startFailureLog). */
  logStartFailure?(event: Record<string, unknown>): void;
  logNativeState?(result: {
    connectorId: string;
    errorCode: string;
    status: number | null;
    containerCount: number | null;
  }): void;
  logCallResult?(result: {
    botId: string;
    connectorId: string;
    tool: string;
    ok: boolean;
    errorCode: string | null;
    count: number | null;
    status: number | null;
    containerCount: number | null;
    durationMs: number;
  }): void;
  displayRedact?: (value: string) => string;
  skillCopies?: {
    status(id: string): { unassignedCount: number; pendingTargetCount: number };
    validate(targets: { bots: string[]; groups: string[] }): unknown;
    enqueue(id: string, targets: { bots: string[]; groups: string[] }): void;
    run(id: string, signal?: AbortSignal): Promise<void>;
  };
  pluginDefinitions: readonly Plugin[];
  importHost?: ConnectorImportHost;
  confirmUnisolated?(
    input: ConnectorCommandConfirmation,
    signal?: AbortSignal,
  ): Promise<{ approved: boolean }>;
  openExternal?(url: string): Promise<void>;
  registerSecret?(value: string): void;
  onNeedsAuth?(connectorId: string): void;
  onCleanupRetry?(installationId: string, attempt: number): void;
  platform?: string;
  drafts?: DraftsRepo;
  plugins: PluginsRepo;
  connectors: ConnectorsRepo;
  operations: ConnectorOperationsRepo;
  catalog: ConnectorCatalogRepo;
  audit: AuditRepo;
  secrets: SecretStore;
  userSecrets?: UserSecretsPort;
  pluginSkills: PluginSkillsHost;
  pool: ConnectorPool;
  factory: ConnectorConnectionFactory;
  emit: Emit;
  /** Reduced base environment for stdio servers; sanitized at the entrypoint. */
  commandEnv: NodeJS.ProcessEnv;
  /** Settings → Permissions extra command folders; read at each start so a change applies then. */
  pathEntries?(): readonly string[];
  home: string;
  dataDir?: string;
  tempDir: string;
  actorBotId: string;
}
