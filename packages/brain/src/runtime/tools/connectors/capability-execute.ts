import type { LocalToolResult } from "@pibot/agent";
import { assertPublicWebTarget } from "@pibot/execution";
import { connectorResultCount, type ImageContent, ImageContentSchema } from "@pibot/protocol-base";
import { finalizeWebFetch, webFetchInputChars } from "@pibot/tools/web";
import { auditToolFields } from "../../../core/audit-fields.ts";
import type { PreparedTool } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";
import { auditInput } from "../input-audit.ts";
import type { LocalRun } from "../local-run.ts";
import type { ToolInput } from "../tools.ts";
import { snapshotCalendarName } from "./calendar-name.ts";
import { capabilitySelectionMatches } from "./capability-adapter.ts";
import {
  ConnectorToolError,
  connectorDraftResult,
  dispatchReadConnector,
  redactedConnectorJson,
} from "./connector-tools.ts";
import { localAppEmptyHint } from "./local-app-result.ts";

function connectorContent(
  value: unknown,
  local: LocalService,
): { text: string; images: ImageContent[] } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { text: redactedConnectorJson(value, local.deps.redactor), images: [] };
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content))
    return { text: redactedConnectorJson(value, local.deps.redactor), images: [] };
  const text: string[] = [];
  const images: ImageContent[] = [];
  for (const part of content.slice(0, 100)) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string")
      text.push(local.deps.redactor.redact(item.text));
    if (item.type === "image") {
      // The schema is strict and requires the discriminator; without it every image was dropped.
      const image = ImageContentSchema.safeParse({
        type: "image",
        data: item.data,
        mimeType: item.mimeType ?? item.mime_type,
      });
      if (image.success) images.push(image.data);
      else text.push("[image omitted: unsupported format / 已省略图片：格式不支持]");
    }
  }
  return { text: text.join("\n"), images: images.slice(0, 5) };
}

function readFileResult(
  prepared: PreparedTool,
  input: Extract<ToolInput, { tool: "read_file" }>,
  text: string,
) {
  const offset = input.args.offset ?? 0;
  const limit = input.args.limit ?? 2000;
  const lines = text.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const selected = lines.slice(offset, offset + limit).join("");
  const bytes = Buffer.byteLength(selected);
  const bounded =
    bytes <= 256 * 1024
      ? selected
      : Buffer.from(selected)
          .subarray(0, 256 * 1024)
          .toString("utf8")
          .replace(/\uFFFD$/u, "");
  return {
    path: prepared.result.path?.path ?? input.args.path,
    type: "text" as const,
    size: Buffer.byteLength(text),
    text: bounded,
    truncated: lines.length > offset + limit || bounded.length < selected.length,
  };
}

function namedLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 500);
}

export async function executeCapabilityConnector(
  run: LocalRun,
  prepared: PreparedTool,
  input: ToolInput,
  signal: AbortSignal,
): Promise<LocalToolResult> {
  const capability = prepared.capabilityConnector;
  const approved = prepared.connector;
  if (!capability || !approved) throw new ConnectorToolError("connector_unavailable");
  if (!capabilitySelectionMatches(run.context, capability.capabilityId, approved.connector.id))
    throw new ConnectorToolError("capability_served_elsewhere");
  if (input.tool === "web_fetch") {
    // Pi Bot's own fetcher refuses private and loopback targets in exec; an MCP fetch server
    // would not, so the same check runs before it is asked.
    await assertPublicWebTarget(prepared.result.url ?? input.args.url, signal);
    const allowed = await run.allowPage(prepared.call, signal);
    if (!allowed) throw new ConnectorToolError("connector_context_denied");
  }
  run.assertDispatch(prepared);
  if (!approved.tool.readOnly) {
    await snapshotCalendarName(run, capability.input, approved, signal);
    const result = await run.local.drafts.execute(
      run.context,
      prepared.call,
      capability.input,
      prepared,
      signal,
    );
    return connectorDraftResult(result, run.local.deps.redactor);
  }
  const capabilityImpl =
    run.context.capabilities?.get(capability.capabilityId) === "builtin"
      ? ("builtin" as const)
      : ("connector" as const);
  const value = await dispatchReadConnector(
    {
      local: run.local,
      context: run.context,
      assertDispatch: () => run.assertDispatch(prepared),
    },
    { call: prepared.call, explanation: prepared.result.explanation },
    capability.input,
    approved,
    signal,
    capability.capabilityId,
    capabilityImpl,
  );
  const details = { resultCount: connectorResultCount(value) };
  const content = connectorContent(value, run.local);
  const audit = {
    ...auditToolFields(
      prepared.call,
      run.local.deps.redactor,
      undefined,
      run.local.deps.capabilityTools,
    ),
    toolCallId: prepared.call.id,
    capabilityId: capability.capabilityId,
    capabilityImpl,
  };
  if (input.tool === "read_file") {
    const result = readFileResult(
      prepared,
      input as Extract<ToolInput, { tool: "read_file" }>,
      content.text,
    );
    auditInput(run.local, run.context, audit, { kind: "file", path: result.path });
    return { details, text: JSON.stringify(result) };
  }
  if (input.tool === "list_dir") {
    const path = prepared.result.path?.path ?? input.args.path;
    auditInput(run.local, run.context, audit, { kind: "file", path });
    return {
      details,
      text: JSON.stringify({
        path,
        entries: namedLines(content.text).map((name) => ({
          name,
          type: "unknown",
          size: 0,
          modifiedAt: "",
        })),
        truncated: false,
      }),
    };
  }
  if (input.tool === "find_files") {
    const path = prepared.result.path?.path ?? input.args.path ?? ".";
    auditInput(run.local, run.context, audit, { kind: "file", path });
    return {
      details,
      text: JSON.stringify({
        path,
        files: namedLines(content.text).map((name) => ({ name, size: 0 })),
        truncated: false,
        skippedUnreadable: 0,
      }),
    };
  }
  if (input.tool === "web_fetch") {
    const url = new URL(prepared.result.url ?? input.args.url);
    const sourceLimit = webFetchInputChars(input.args);
    return {
      details,
      ...(await finalizeWebFetch(run, input.args, audit, signal, JSON.stringify, {
        url: url.href,
        domain: url.hostname,
        title: url.hostname,
        text: content.text.slice(0, sourceLimit),
        truncated: content.text.length > sourceLimit,
        mimeType: "text/plain",
        length: content.text.length,
      })),
      ...(content.images.length ? { images: content.images } : {}),
    };
  }
  if (input.tool === "browser_snapshot") {
    const limit = input.args.maxChars ?? 20_000;
    return {
      details,
      text:
        content.text.length > limit
          ? `${content.text.slice(0, limit)}\n[已截断 / Truncated]`
          : content.text,
    };
  }
  return {
    details,
    text:
      (content.text || redactedConnectorJson(value, run.local.deps.redactor)) +
      localAppEmptyHint(value, capability.capabilityId),
    ...(content.images.length ? { images: content.images } : {}),
  };
}
