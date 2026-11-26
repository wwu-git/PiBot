import type { LoadExtensionsResult, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AgentError } from "../core/errors.ts";
import type { LocalToolPorts } from "../core/types.ts";
import { loadPiSdk } from "../runtime/pi-sdk.ts";
import type { SessionAdditions } from "../session/session-additions.ts";
import type { CompactionState } from "./compaction.ts";
import { activityExtension } from "./pibot-activity.ts";
import { isConnectorTool, pibotAppsExtension } from "./pibot-apps.ts";
import { pibotCapabilitiesExtension } from "./pibot-capabilities.ts";
import { policyExtension } from "./pibot-policy.ts";
import { toolsExtension } from "./pibot-tools.ts";
import type { PromptState } from "./prompt-context.ts";
import { ToolLoadout } from "./tool-loadout.ts";

export async function loadLocalExtensions(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  ports?: LocalToolPorts,
  promptState?: PromptState,
  compaction?: CompactionState,
  additions?: SessionAdditions,
  toolLoading: "grouped" | "eager" = "grouped",
): Promise<LoadExtensionsResult & { loadout?: ToolLoadout }> {
  const { createExtensionRuntime, DefaultResourceLoader } = await loadPiSdk();
  const runtime = createExtensionRuntime();
  if (!ports) return { runtime, extensions: [], errors: [] };
  // Registration shares one catalog view; execution and later synchronization keep live ports.
  const definitions = ports.definitions;
  const capabilityDefinitions = ports.capabilityDefinitions ?? [];
  const permits = new Map<string, string>();
  const loadout = new ToolLoadout(ports, toolLoading, definitions);
  const builtinDefinitions = capabilityDefinitions.length
    ? definitions.filter((tool) => !tool.capabilityImplementation)
    : definitions;
  // pibot-apps joins the whitelist only when the brain wires connector tools;
  // the count check below keeps the set exact either way.
  const factories: { name: string; factory: ReturnType<typeof toolsExtension> }[] = [
    {
      name: "pibot-tools",
      factory: toolsExtension(ports, permits, loadout, builtinDefinitions),
    },
    { name: "pibot-policy", factory: policyExtension(ports, permits) },
    {
      name: "pibot-activity",
      factory: activityExtension(ports, promptState, compaction, additions),
    },
  ];
  if (capabilityDefinitions.length)
    factories.push({
      name: "pibot-capabilities",
      factory: pibotCapabilitiesExtension(ports, permits, loadout, capabilityDefinitions),
    });
  if (definitions.some((definition) => isConnectorTool(definition.name)))
    factories.push({
      name: "pibot-apps",
      factory: pibotAppsExtension(ports, permits, loadout, definitions),
    });
  const toolFactories = factories.map((entry) => entry.name);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: factories,
  });
  // Explicitly permits this one locked-version private call; reload would restore disk discovery.
  const bridge = loader as unknown as {
    loadExtensionFactories(
      runtime: LoadExtensionsResult["runtime"],
    ): Promise<Omit<LoadExtensionsResult, "runtime">>;
  };
  if (typeof bridge.loadExtensionFactories !== "function") throw new AgentError("internal");
  const loaded = await bridge.loadExtensionFactories(runtime);
  const names = toolFactories;
  if (
    loaded.errors.length ||
    loaded.extensions.length !== names.length ||
    names.some((name) => !loaded.extensions.some((e) => e.path === `<inline:${name}>`))
  )
    throw new AgentError("internal");
  if (
    compaction &&
    !loaded.extensions
      .find((e) => e.path === "<inline:pibot-activity>")
      ?.handlers.get("session_before_compact")?.length
  )
    throw new AgentError("internal");
  if (
    !loaded.extensions.find((e) => e.path === "<inline:pibot-policy>")?.handlers.get("tool_call")
      ?.length
  )
    throw new AgentError("internal");
  if (
    additions &&
    !loaded.extensions
      .find((e) => e.path === "<inline:pibot-activity>")
      ?.handlers.get("agent_before_settle")?.length
  )
    throw new AgentError("internal");
  return { ...loaded, runtime, loadout };
}
