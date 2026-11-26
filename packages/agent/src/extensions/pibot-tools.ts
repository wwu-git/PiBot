import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { normalizeComputerInput, normalizeTodoPauseInput } from "@pibot/protocol-base";
import { Type } from "typebox";
import { PARALLEL_READS } from "../core/tool-effects.ts";
import type { LocalToolDefinition, LocalToolPorts } from "../core/types.ts";
import { isConnectorTool } from "./pibot-apps.ts";
import { redactedToolText } from "./redacted-tool-text.ts";
import type { ToolLoadout } from "./tool-loadout.ts";
import { toolResultImages } from "./tool-result-images.ts";

/** Bounded so a huge string is rejected by the schema instead of being parsed. */
const JSON_TEXT_MAX_CHARS = 256 * 1024;

function parseJsonTextArguments(args: unknown, names: readonly string[]) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return args as Record<string, unknown>;
  const input = args as Record<string, unknown>;
  let changed: Record<string, unknown> | undefined;
  for (const name of names) {
    const value = input[name];
    if (typeof value !== "string" || value.length > JSON_TEXT_MAX_CHARS) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        changed = { ...(changed ?? input), [name]: parsed };
    } catch {
      // Not JSON: left as it is, so schema validation reports the wrong type.
    }
  }
  return changed ?? input;
}

export function toolsExtension(
  ports: LocalToolPorts,
  permits: Map<string, string>,
  loadout?: ToolLoadout,
  registration?: readonly LocalToolDefinition[],
): ExtensionFactory {
  return (pi) => {
    loadout?.bind(pi);
    for (const tool of registration ?? ports.definitions) {
      if (isConnectorTool(tool.name)) continue;
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
        ...(loadout?.mode === "grouped" && tool.loadGroup ? { exposure: "deferred" as const } : {}),
        // Commands keep their effect class; brain gates each approved call by policy analysis.
        executionMode:
          tool.name === "run_command" || PARALLEL_READS.has(tool.name) ? "parallel" : "sequential",
        ...(tool.name === "todo_pause"
          ? {
              // The SDK checks this result against parameters before executing or authorizing it.
              prepareArguments: (args: unknown) =>
                normalizeTodoPauseInput(args) as Record<string, unknown>,
            }
          : tool.name === "keys" || tool.name === "ui_action" || tool.name === "pointer"
            ? {
                // Placeholder fields from strict-mode providers; authorization and the permit
                // below both see the normalised call.
                prepareArguments: (args: unknown) =>
                  normalizeComputerInput(tool.name, args) as Record<string, unknown>,
              }
            : tool.jsonTextArguments?.length
              ? {
                  prepareArguments: (args: unknown) =>
                    parseJsonTextArguments(args, tool.jsonTextArguments ?? []),
                }
              : {}),
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
          if (tool.name === "tool_discover" && !result.isError)
            loadout?.activate(result.loadedTools, input.groups);
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
