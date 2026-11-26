import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalToolDefinition, LocalToolPorts } from "../src/core/types.ts";
import { loadLocalExtensions } from "../src/extensions/load.ts";
import { ToolLoadout } from "../src/extensions/tool-loadout.ts";

const registration = vi.hoisted(() => ({
  tools: [] as { name: string; description: string; execute: (...args: unknown[]) => unknown }[],
  handlers: new Map<string, Map<string, ((...args: unknown[]) => unknown)[]>>(),
}));

vi.mock("../src/runtime/pi-sdk.ts", () => ({
  loadPiSdk: async () => ({
    createExtensionRuntime: () => ({}),
    DefaultResourceLoader: class {
      constructor(
        private readonly options: {
          extensionFactories: { name: string; factory: (api: ExtensionAPI) => unknown }[];
        },
      ) {}
      async loadExtensionFactories() {
        const extensions = [];
        for (const entry of this.options.extensionFactories) {
          const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
          registration.handlers.set(entry.name, handlers);
          const api = {
            registerTool: (tool: (typeof registration.tools)[number]) =>
              registration.tools.push(tool),
            on: (name: string, handler: (...args: unknown[]) => unknown) =>
              handlers.set(name, [...(handlers.get(name) ?? []), handler]),
            getActiveTools: () => [],
            setActiveTools: () => {},
          } as unknown as ExtensionAPI;
          await entry.factory(api);
          extensions.push({ path: `<inline:${entry.name}>`, handlers });
        }
        return { extensions, errors: [] };
      }
    },
  }),
}));

const tool = (name: string, grouped = false): LocalToolDefinition => ({
  name,
  description: `${name} definition`,
  parameters: { type: "object", properties: {} },
  ...(grouped ? { loadGroup: { id: "images", description: "Image tools" } } : {}),
});
const read = tool("read_file");
const image = tool("inspect_image", true);
const connector = tool("connector_discover");
const capability: LocalToolDefinition = {
  ...tool("office_create"),
  capabilityImplementation: { capabilityId: "files.write", connectorId: "synthetic" },
};

function fixture() {
  let reads = 0;
  let capabilityReads = 0;
  let model = "text";
  let permitted = true;
  let allow = true;
  const ports: LocalToolPorts = {
    signal: new AbortController().signal,
    get definitions() {
      reads++;
      return [read, connector, capability, ...(model === "vision" && permitted ? [image] : [])];
    },
    get capabilityDefinitions() {
      capabilityReads++;
      return ports.definitions.filter((definition) => definition.capabilityImplementation);
    },
    initialToolGroupsAlways: ["images"],
    authorize: vi.fn(async () => ({ allow })),
    blocked: vi.fn(),
    execute: vi.fn(async () => ({ text: model })),
    activity: vi.fn(),
    errorText: () => "synthetic error",
    redact: (text) => text,
  };
  return {
    ports,
    reads: () => reads,
    capabilityReads: () => capabilityReads,
    clearReads: () => {
      reads = 0;
      capabilityReads = 0;
    },
    model: (value: string) => {
      model = value;
    },
    permit: (value: boolean) => {
      permitted = value;
    },
    allow: (value: boolean) => {
      allow = value;
    },
  };
}

beforeEach(() => {
  registration.tools.length = 0;
  registration.handlers.clear();
});

describe("live tool catalog reads", () => {
  it("registers from one view after model selection without freezing execution or policy", async () => {
    const f = fixture();
    f.model("vision");
    const loaded = await loadLocalExtensions("/synthetic", "/synthetic/pi", {} as never, f.ports);
    // One definitions read plus the compatibility capability getter's own read, never spread.
    expect(f.reads()).toBe(2);
    expect(f.capabilityReads()).toBe(1);
    expect(registration.tools.map((entry) => entry.name).sort()).toEqual(
      ["read_file", "connector_discover", "office_create", "inspect_image"].sort(),
    );
    expect(new Set(registration.tools.map((entry) => entry.name)).size).toBe(4);
    const policy = registration.handlers.get("pibot-policy")?.get("tool_call")?.[0];
    const registered = registration.tools.find((entry) => entry.name === "read_file");
    expect(policy).toBeDefined();
    expect(registered).toBeDefined();
    f.model("text");
    const event = { toolCallId: "synthetic-call", toolName: "read_file", input: {} };
    await policy?.(event, {});
    expect(await registered?.execute("synthetic-call", {}, undefined, undefined, {})).toMatchObject(
      {
        content: [{ type: "text", text: "text" }],
      },
    );
    f.allow(false);
    expect(await policy?.({ ...event, toolCallId: "denied-call" }, {})).toMatchObject({
      block: true,
    });
    await expect(registered?.execute("denied-call", {}, undefined, undefined, {})).rejects.toThrow(
      "Tool was not authorized",
    );
    expect(loaded.loadout).toBeDefined();
  });

  it("preserves explicitly supplied capability definitions", async () => {
    const f = fixture();
    const explicit = { ...capability, description: "explicit caller capability" };
    Object.defineProperty(f.ports, "capabilityDefinitions", { value: [explicit] });
    await loadLocalExtensions("/synthetic", "/synthetic/pi", {} as never, f.ports);
    expect(f.reads()).toBe(1);
    expect(registration.tools.find((entry) => entry.name === explicit.name)?.description).toBe(
      explicit.description,
    );
  });

  it("takes one fresh catalog per reset, synchronize, activate and projection", () => {
    const f = fixture();
    f.model("vision");
    const loadout = new ToolLoadout(f.ports, "grouped");
    const names = () => [...loadout.synchronize()];
    f.clearReads();
    expect([...loadout.reset()]).toContain("inspect_image");
    expect(f.reads()).toBe(1);
    f.permit(false);
    f.clearReads();
    expect(names()).not.toContain("inspect_image");
    expect(f.reads()).toBe(1);
    f.permit(true);
    f.clearReads();
    loadout.activate(["inspect_image"], ["images"]);
    expect(f.reads()).toBe(1);
    f.model("text");
    f.clearReads();
    loadout.project({ messages: [] } as never);
    expect(f.reads()).toBe(1);
    f.clearReads();
    expect(names()).not.toContain("inspect_image");
    expect(f.reads()).toBe(1);
    f.model("vision");
    expect([...loadout.reset()]).toContain("inspect_image");
  });

  it("rejects activation after permission removal and aborts before recomputing", () => {
    const f = fixture();
    f.model("vision");
    const loadout = new ToolLoadout(f.ports, "grouped");
    f.permit(false);
    f.clearReads();
    expect(() => loadout.activate(["inspect_image"], ["images"])).toThrow("tool_catalog_changed");
    expect(f.reads()).toBe(1);
    const aborted = fixture();
    const controller = new AbortController();
    aborted.ports.signal = controller.signal;
    const stopped = new ToolLoadout(aborted.ports, "grouped");
    controller.abort();
    aborted.clearReads();
    expect(() => stopped.reset()).toThrow();
    expect(aborted.reads()).toBe(0);
  });
});
