import { type BrainCapability, startBrain as startKernel } from "@pibot/brain";
import { browserCapability } from "@pibot/browser/brain";
import { computerUseCapability } from "@pibot/computer-use/brain";
import { credentialsCapability } from "@pibot/credentials/brain";
import { externalAgentsCapability } from "@pibot/external-agents/brain";
import { imagesCapability } from "@pibot/images/brain";
import { importCapability } from "@pibot/import/brain";
import { memoryCapability } from "@pibot/memory/brain";
import { providersCapability } from "@pibot/models/brain";
import { officeCapability } from "@pibot/office/brain";
import { createOrchestrationFactory } from "@pibot/orchestration";
import type { Plugin } from "@pibot/plugin-sdk";
import { pluginsCapability } from "@pibot/plugins/brain";
import {
  type CapabilityToolRegistry,
  capabilityToolGroups,
  capabilityToolSpecs,
  Events,
  endpointCapabilityCatalog,
  InboxItemSchema,
  Methods,
} from "@pibot/protocol";
import {
  type RemoteKernelPort,
  type RemoteOptions,
  remoteCapability,
  remoteKernelBridge,
} from "@pibot/remote/brain";
import {
  type RoutineDevAdapter,
  type RoutineHostAdapter,
  routinesCapability,
} from "@pibot/routines/brain";
import { skillsCapability } from "@pibot/skills/brain";
import { teamsCapability } from "@pibot/teams/brain";
import { workspacesCapability } from "@pibot/workspaces/brain";
import { endpointCapability } from "./endpoints/capability.ts";

export * from "@pibot/brain";
export type { RoutineHostAdapter } from "@pibot/routines/brain";

/** Single product-owned registry shared by startup and development harnesses. */
export const productCapabilityTools: CapabilityToolRegistry = {
  specs: capabilityToolSpecs,
  groups: capabilityToolGroups,
} as const;

export type BrainOptions = Omit<
  Parameters<typeof startKernel>[0],
  "capabilities" | "composition" | "orchestration"
> & {
  /** Desktop main-process half of routines (power, tray); absent on a server or the CLI. */
  routineHost?: RoutineHostAdapter;
  /** Trusted dev channel for routines (manual triggers, clock); never set in a packaged app. */
  routineDev?: RoutineDevAdapter;
  /** Optional built-in resource override, owned by the teams capability. */
  builtinDir?: string;
  /** The real link/host adapters are supplied at the outer application boundary. */
  remote?: Omit<RemoteOptions, "kernel">;
  /** Composition/test seam; production omits this and receives the five shipped plugins. */
  plugins?: readonly Plugin[];
  /** Built-in declarative plugin resources. Production passes an application resource directory. */
  pluginDir?: string;
  /** Private local builds may opt into source-only built-ins excluded from the public package. */
  includeLocalGmail?: boolean;
};

/**
 * Composition root: the capability packages this build enables, in start order. The brain
 * kernel never imports a capability; adding one is a new package plus one entry here (and its host
 * and UI parts in the desktop app).
 */
export function capabilities(
  opts: Pick<
    BrainOptions,
    | "routineDev"
    | "routineHost"
    | "builtinDir"
    | "remote"
    | "plugins"
    | "pluginDir"
    | "includeLocalGmail"
  > &
    (
      | { remoteKernel: RemoteKernelPort; isPhoneRequest: () => boolean }
      | { remoteKernel?: undefined; isPhoneRequest?: undefined }
    ),
): BrainCapability[] {
  // Providers supply authentication; connectors need credentials before routines register.
  return [
    providersCapability(),
    officeCapability(),
    imagesCapability(),
    // Bots of kind "agent" (external coding agents over ACP).
    externalAgentsCapability(),
    memoryCapability(),
    importCapability(),
    credentialsCapability(),
    // Plugin skills register through the generic capability port; their host must exist first.
    skillsCapability(),
    pluginsCapability({
      ...(opts.plugins ? { plugins: opts.plugins } : {}),
      builtinDir: opts.pluginDir,
      includeLocalGmail: opts.includeLocalGmail,
    }),
    computerUseCapability(),
    browserCapability(),
    workspacesCapability(),
    teamsCapability({ builtinDir: opts.builtinDir }),
    routinesCapability({ routineDev: opts.routineDev, host: opts.routineHost }),
    endpointCapability(endpointCapabilityCatalog, opts.isPhoneRequest ?? (() => false)),
    remoteCapability({ ...opts.remote, kernel: opts.remoteKernel }),
  ];
}

/** The kernel with every enabled capability registered; what the desktop and CLI start. */
export async function startBrain(opts: BrainOptions) {
  const {
    routineDev,
    routineHost,
    builtinDir,
    remote,
    plugins,
    pluginDir,
    includeLocalGmail,
    ...kernel
  } = opts;
  const bridge = remoteKernelBridge(kernel.port);
  try {
    return await startKernel({
      ...kernel,
      orchestration: createOrchestrationFactory(),
      port: bridge.port,
      isPhoneRequest: bridge.isPhoneRequest,
      capabilities: capabilities({
        routineDev,
        routineHost,
        builtinDir,
        remote,
        plugins,
        pluginDir,
        includeLocalGmail,
        remoteKernel: bridge.kernel,
        isPhoneRequest: bridge.isPhoneRequest,
      }),
      composition: {
        methods: Methods,
        events: Events,
        tools: productCapabilityTools,
        inboxItemSchema: InboxItemSchema,
      },
    });
  } catch (error) {
    bridge.port.dispose?.();
    throw error;
  }
}
