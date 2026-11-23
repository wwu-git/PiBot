import type { PolicyResult } from "@pibot/policy";
import type {
  Connector,
  ConnectorAccess,
  DraftMetadata,
  PermissionsSettings,
} from "@pibot/protocol-base";
import type { DraftPayload } from "@pibot/storage";
import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { evaluateDraft } from "./draft-authorization.ts";

const digest = "a".repeat(64);
const payload: DraftPayload = {
  args: { title: "A test issue" },
  content: '{"title":"A test issue"}',
  contentField: null,
  snapshotDigest: digest,
  definitionDigest: digest,
  targetDigest: digest,
};

function fixture({
  kind = "mcp_remote",
  confirmationMode = "direct_read_write",
  access = "all",
  identity = "bot",
  decision = "ask",
}: {
  kind?: Connector["kind"];
  confirmationMode?: Connector["confirmationMode"];
  access?: ConnectorAccess["mode"];
  identity?: DraftMetadata["identity"];
  decision?: PolicyResult["decision"];
} = {}) {
  const permissions = {
    levels: { connector: "always" },
  } as PermissionsSettings;
  const local = {
    connectors: {
      get: () => ({ kind, confirmationMode, enabled: true }),
      access: () => ({ mode: access }),
      tool: () => undefined,
    },
    tasks: { settings: () => permissions },
    permissions: { effective: () => permissions, sources: () => undefined },
    grants: () => [],
    taskAuthority: { source: () => ({}), yolo: () => false },
    deps: { dataDir: "/test" },
    getPolicy: async () => ({
      evaluate: async (): Promise<PolicyResult> => ({
        decision,
        reason: decision === "deny" ? "send_permission_denied" : "draft_confirmation_required",
        risk: "normal",
        facts: [],
        canRemember: false,
        explanation: [],
      }),
    }),
  } as unknown as LocalService;
  const draft: DraftMetadata = {
    identity,
    connectorId: "connector",
    tool: "create_issue",
    target: "Test repository",
    revision: 1,
    catalogVersion: 1,
    contentDigest: digest,
    contentLength: payload.content.length,
    editable: false,
    canRememberTarget: false,
  };
  return (overrides: Partial<ToolRunContext> = {}) => {
    const context: ToolRunContext = {
      botId: "bot",
      messageId: "message",
      runId: "run",
      language: "en",
      signal: new AbortController().signal,
      interactiveChat: true,
      ...overrides,
    };
    return evaluateDraft(local, context, draft, payload, context.signal);
  };
}

describe("MCP direct write authorization", () => {
  it.each([
    ["mcp_remote", "user"],
    ["mcp_remote", "bot"],
    ["mcp_stdio", "user"],
    ["mcp_stdio", "bot"],
  ] as const)("allows an interactive %s write with %s identity", async (kind, identity) => {
    const result = await fixture({ kind, identity })();
    expect(result.decision).toBe("allow");
    expect(result.explanation).toContainEqual({
      axis: "connector",
      code: "connector_direct_write",
      effect: "allow",
    });
  });

  it.each([
    ["missing source", { interactiveChat: undefined }],
    ["external agent", { auditSource: "external_agent" }],
    ["scheduled run", { routineRunId: "routine" }],
    ["routine trial source", { routineSource: "trial" }],
    ["execution task", { executionTaskId: "task" }],
  ] as const)("requires confirmation for %s", async (_, context) => {
    const result = await fixture()(context);
    expect(result.decision).toBe("ask");
  });

  it.each([
    ["default confirmation", { confirmationMode: "read_write" }],
    ["ask-first access", { access: "ask_first" }],
    ["non-MCP connector", { kind: "builtin" }],
  ] as const)("requires confirmation with %s", async (_, options) => {
    const result = await fixture(options)();
    expect(result.decision).toBe("ask");
  });

  it("preserves an explicit policy denial", async () => {
    const result = await fixture({ decision: "deny" })();
    expect(result.decision).toBe("deny");
    expect(result.explanation).toContainEqual({
      axis: "connector",
      code: "send_permission_denied",
      effect: "deny",
    });
  });
});
