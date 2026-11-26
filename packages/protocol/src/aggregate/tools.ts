import { agentDelegationToolGroup, agentDelegationTools } from "@pibot/external-agents-contract";
import { knowledgeToolGroup, knowledgeTools, pluginInstallTools } from "@pibot/plugins-contract";
import {
  appCapabilityTools,
  type CapabilityToolGroup,
  type CapabilityToolSpec,
} from "@pibot/protocol-base";
import { phoneToolGroup, phoneTools, runnerToolGroup, runnerTools } from "@pibot/remote-contract";
import { routineToolGroup, routineTools } from "@pibot/routines-contract";
import { skillReferenceTools } from "@pibot/skills-contract";
import { piManagerTools } from "@pibot/teams-contract";

/**
 * Model-facing tools the enabled capabilities contribute, composed here at the
 * aggregation layer like their RPC schemas, so the brain kernel can build its static tool catalog
 * without naming any capability. Adding a capability's tools is one spread here.
 */
export const capabilityTools = {
  ...appCapabilityTools,
  ...routineTools,
  ...phoneTools,
  ...runnerTools,
  ...knowledgeTools,
  ...pluginInstallTools,
  ...agentDelegationTools,
  ...skillReferenceTools,
  ...piManagerTools,
} as const satisfies Record<string, CapabilityToolSpec>;

export const capabilityToolGroups = [
  routineToolGroup,
  phoneToolGroup,
  runnerToolGroup,
  knowledgeToolGroup,
  agentDelegationToolGroup,
] as const satisfies readonly CapabilityToolGroup[];

export type CapabilityToolName = keyof typeof capabilityTools;

/** The same specs widened, for code that iterates and reads optional fields (group, rule). */
export const capabilityToolSpecs: Readonly<Record<string, CapabilityToolSpec>> = capabilityTools;

export function isCapabilityTool(name: string): name is CapabilityToolName {
  return Object.hasOwn(capabilityTools, name);
}
