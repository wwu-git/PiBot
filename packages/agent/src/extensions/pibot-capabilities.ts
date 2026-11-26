import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LocalToolDefinition, LocalToolPorts } from "../core/types.ts";
import { redactedToolText } from "./redacted-tool-text.ts";
import type { ToolLoadout } from "./tool-loadout.ts";
import { toolResultImages } from "./tool-result-images.ts";

/** Connector implementations keep stable tool contracts but never join the parallel reads. */
export function pibotCapabilitiesExtension(
  ports: LocalToolPorts,
  permits: Map<string, string>,
  loadout?: ToolLoadout,
  registration?: readonly LocalToolDefinition[],
): ExtensionFactory {
  return (pi) => {
    for (const tool of registration ?? ports.capabilityDefinitions ?? []) {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
        ...(loadout?.mode === "grouped" && tool.loadGroup ? { exposure: "deferred" as const } : {}),
        executionMode: "sequential",
        async execute(id, input, sdkSignal, update, ctx) {
          const signal = sdkSignal ? AbortSignal.any([sdkSignal, ports.signal]) : ports.signal;
          const permit = permits.get(id);
          permits.delete(id);
          if (!permit || permit !== JSON.stringify([tool.name, input]))
            throw new Error("Tool was not authorized / 工具未获授权");
          signal.throwIfAborted();
          try {
            loadout?.assertBound(tool.name);
          } catch (error) {
            ports.blocked(
              { id, tool: tool.name, input },
              "工具定义或可用范围已变化，请重试当前任务 / Tool definitions or availability changed; retry this task",
            );
            throw error;
          }
          const result = await ports.execute({ id, tool: tool.name, input }, signal, (text) => {
            update?.({ content: [{ type: "text", text: ports.redact(text) }], details: undefined });
          });
          signal.throwIfAborted();
          return {
            content: [
              {
                type: "text" as const,
                text: redactedToolText(result.text, (text) => ports.redact(text)),
              },
              ...(await toolResultImages(result.images, ctx.model, signal)),
            ],
            details: result.details,
            isError: result.isError,
          };
        },
      });
    }
  };
}
