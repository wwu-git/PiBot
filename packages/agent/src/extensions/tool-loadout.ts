import type { TranscriptContext } from "@earendil-works/pi-ai";
import { declarationsEqual, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";
import type {
  AgentErrorCode,
  LocalToolDefinition,
  LocalToolPorts,
  ToolSetSnapshot,
} from "../core/types.ts";
import { localToolIdentity, toolBinding, toolVersion } from "../runtime/tool-identity.ts";

const loadedSchema = z.array(z.string().min(1).max(100)).max(64);

/**
 * Per opened run. JSONL tool changes are history, never an authority: a tool the transcript
 * declares is kept loaded only when this run could load it itself (`reset`).
 */
export class ToolLoadout {
  private api?: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
  private readonly registered: Map<string, string>;
  private readonly loaded = new Set<string>();
  failure?: AgentErrorCode;
  constructor(
    private readonly ports: LocalToolPorts,
    readonly mode: "grouped" | "eager",
    registration?: readonly LocalToolDefinition[],
  ) {
    const definitions = registration ?? ports.definitions;
    this.registered = new Map(definitions.map((tool) => [tool.name, toolBinding(tool)]));
    if (
      this.registered.size !== definitions.length ||
      new Set(definitions.map((tool) => localToolIdentity(tool).id)).size !== definitions.length
    )
      this.changed();
  }
  bind(api: ExtensionAPI) {
    this.api = api;
  }
  /**
   * A new run. Tool groups the session transcript still declares stay loaded, so the run
   * does not declare them removed (a removal makes pi re-send the whole tool list at the top from
   * then on, a full prompt-cache miss for every later request of the session). Only tools this
   * run could load itself survive: present with a load group in this run's catalog, which the
   * brain filters by the current permissions, mode and context, with an unchanged binding;
   * exactly what tool_discover could return now. Discovery grants no permission, and every call
   * is still authorized by policy. Anything else is dropped and declared removed.
   */
  reset(transcript: readonly { role: string }[] = []) {
    const definitions = this.currentDefinitions();
    this.loaded.clear();
    if (this.mode === "grouped") {
      const declared = new Set(getCurrentTools(transcript as never).map((tool) => tool.name));
      const recent = this.ports.initialToolGroups;
      const always = this.ports.initialToolGroupsAlways ?? [];
      const legacy = definitions
        .filter((tool) => tool.loadGroup && declared.has(tool.name))
        .reverse()
        .flatMap((tool) => tool.loadGroup?.id ?? []);
      // `always` comes first so a role default (code navigation) survives the three-group cap.
      const groups = new Set([...new Set([...always, ...(recent ?? legacy)])].slice(0, 3));
      for (const tool of definitions)
        if (
          tool.loadGroup &&
          groups.has(tool.loadGroup.id) &&
          this.registered.get(tool.name) === toolBinding(tool)
        )
          this.loaded.add(tool.name);
    }
    return this.synchronizeCatalog(definitions);
  }
  synchronize(): ReadonlySet<string> {
    return this.synchronizeCatalog(this.currentDefinitions());
  }
  private currentDefinitions() {
    this.ports.signal.throwIfAborted();
    if (this.failure) throw new AgentError(this.failure);
    return this.ports.definitions;
  }
  private synchronizeCatalog(definitions: readonly LocalToolDefinition[]): ReadonlySet<string> {
    this.ports.signal.throwIfAborted();
    if (this.failure) throw new AgentError(this.failure);
    const current = definitions.filter((tool) => this.registered.has(tool.name));
    if (
      new Set(current.map((tool) => tool.name)).size !== current.length ||
      new Set(current.map((tool) => localToolIdentity(tool).id)).size !== current.length
    )
      this.changed();
    for (const tool of current)
      if (this.registered.get(tool.name) !== toolBinding(tool)) this.changed();
    const available = new Set(current.map((tool) => tool.name));
    for (const name of this.loaded) if (!available.has(name)) this.loaded.delete(name);
    const names = current
      .filter((tool) => this.mode === "eager" || !tool.loadGroup || this.loaded.has(tool.name))
      .map((tool) => tool.name);
    const active = this.api?.getActiveTools() ?? [];
    const desired = new Set(names);
    if (this.api && (active.length !== desired.size || active.some((name) => !desired.has(name))))
      this.api.setActiveTools(names);
    this.ports.activeToolGroups?.([
      ...new Set(
        current.flatMap((tool) =>
          tool.loadGroup && desired.has(tool.name) ? [tool.loadGroup.id] : [],
        ),
      ),
    ]);
    return desired;
  }
  activate(receipt: unknown, requested: unknown) {
    this.ports.signal.throwIfAborted();
    if (this.failure) throw new AgentError(this.failure);
    const parsed = loadedSchema.safeParse(receipt);
    const selection = z.array(z.string()).min(1).max(3).safeParse(requested);
    if (!parsed.success || !selection.success) this.changed();
    const names = parsed.data;
    const groups = selection.data;
    const definitions = this.currentDefinitions();
    const allowed = new Set(
      definitions
        .filter(
          (tool) =>
            tool.loadGroup && groups.includes(tool.loadGroup.id) && this.registered.has(tool.name),
        )
        .map((tool) => tool.name),
    );
    if (names.some((name) => !allowed.has(name))) this.changed();
    for (const name of names) this.loaded.add(name);
    this.synchronizeCatalog(definitions);
  }
  private changed(): never {
    this.failure = "tool_catalog_changed";
    throw new AgentError(this.failure);
  }
  assertBound(name: string) {
    this.ports.signal.throwIfAborted();
    if (this.failure) throw new AgentError(this.failure);
    const tool = this.ports.definitions.find((entry) => entry.name === name);
    return this.bound(name, tool);
  }
  private bound(name: string, tool: LocalToolDefinition | undefined) {
    if (
      !tool ||
      this.registered.get(name) !== toolBinding(tool) ||
      (tool.schemaVersion && tool.schemaVersion !== localToolIdentity(tool).schemaVersion)
    )
      this.changed();
    return tool;
  }
  snapshot(request: TranscriptContext): ToolSetSnapshot {
    this.ports.signal.throwIfAborted();
    if (this.failure) throw new AgentError(this.failure);
    const current = new Map(this.ports.definitions.map((tool) => [tool.name, tool]));
    const declarations = getCurrentTools(request.messages);
    const visible = declarations.map((declared) => {
      const tool = this.bound(declared.name, current.get(declared.name));
      const identity = localToolIdentity(tool);
      if (toolVersion(declared.parameters) !== identity.schemaVersion) this.changed();
      return identity;
    });
    const discovery = visible.some((tool) => tool.name === "tool_discover")
      ? this.ports.discoverySnapshot?.()
      : undefined;
    return {
      catalogVersion: toolVersion(declarations),
      visible,
      ...(discovery ? { discovery } : {}),
      ...(this.ports.permissionsSnapshot ? { permissions: this.ports.permissionsSnapshot() } : {}),
    };
  }
  project(request: TranscriptContext): TranscriptContext {
    const definitions = this.currentDefinitions();
    const visible = this.synchronizeCatalog(definitions);
    const current = new Map(definitions.map((tool) => [tool.name, tool]));
    // tool_discover's description carries the connected-app index; the current one is what the
    // model may rely on.
    const messages = projectToolHistory(request.messages, visible, (tool) =>
      tool.name === "tool_discover"
        ? { ...tool, description: current.get(tool.name)?.description ?? tool.description }
        : tool,
    );
    return { ...request, messages };
  }
}

type Declared = Parameters<typeof declarationsEqual>[0];

/**
 * The transcript's tool declarations as this request may replay them: only tools visible now.
 * Pi 1.1.0 declares tools in system-message deltas, not a request.tools array; filtering an
 * addition also invalidates its later removal on native-delta APIs. The persisted transcript
 * stays intact; only this request's copy changes.
 *
 * A visible tool whose every declaration in the history is the same keeps only its first
 * one; its later removals and re-additions are left out. Older sessions unloaded
 * groups at each run's start, and one removal anywhere makes pi send the whole current tool list
 * at the top of every request (so every later load is a full cache miss). The tool is callable
 * now, so declaring it from its first appearance tells the model nothing false; what it may call
 * is still the active set, and policy checks every call. Deterministic, so the same history
 * projects the same way on every request.
 */
export function projectToolHistory<M extends { role: string }>(
  messages: M[],
  visible: ReadonlySet<string>,
  declaration: <T extends Declared>(tool: T) => T = (tool) => tool,
): M[] {
  type System = { role: "system"; toolsAdded?: Declared[]; toolsRemoved?: { name: string }[] };
  const systems = (m: M): m is M & System => m.role === "system";
  const first = new Map<string, Declared>();
  const changed = new Set<string>();
  for (const message of messages)
    if (systems(message))
      for (const tool of message.toolsAdded ?? []) {
        if (!visible.has(tool.name)) continue;
        const seen = first.get(tool.name);
        if (!seen) first.set(tool.name, declaration(tool));
        else if (!declarationsEqual(seen, declaration(tool))) changed.add(tool.name);
      }
  const steady = new Set([...first.keys()].filter((name) => !changed.has(name)));
  const declared = new Set<string>();
  return messages.map((message) => {
    if (!systems(message)) return message;
    const toolsRemoved = message.toolsRemoved?.filter(
      (tool) => !steady.has(tool.name) && declared.delete(tool.name),
    );
    const toolsAdded = message.toolsAdded
      ?.filter(
        (tool) => visible.has(tool.name) && !(steady.has(tool.name) && declared.has(tool.name)),
      )
      .map((tool) => {
        declared.add(tool.name);
        return declaration(tool);
      });
    return {
      ...message,
      ...(toolsRemoved ? { toolsRemoved } : {}),
      ...(toolsAdded ? { toolsAdded } : {}),
    };
  });
}
