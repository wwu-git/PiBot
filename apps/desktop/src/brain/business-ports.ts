import { type Port, RpcErrorCodes } from "@pibot/protocol";
import { z } from "zod";

const RequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().int().safe(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

// Both clients use the same brain dispatcher. Namespacing prevents renderer IDs spoofing main replies.
const acpMethodNames = Object.freeze([
  "bots.list",
  "settings.get",
  "workplaces.pick",
  "topics.create",
  "topics.acp.attach",
  "topics.workplace.update",
  "topics.archive",
  // Only for topics the ACP translator itself just created (session _meta pibot/yolo).
  "conversations.yolo.set",
  // Same scope: ACP task topics only (session _meta pibot/autocheck).
  "autoCheck.conversation.set",
  // The session "model" option (list configured models; change only a Bot's model).
  "models.list",
  "providers.list",
  "bots.update",
  "chat.send",
  "chat.abort",
  "approvals.resolve",
  "plugins.previewImport",
  "plugins.import",
  "plugins.cancelPreview",
]);
const acpEventNames = Object.freeze([
  "chat.delta",
  "chat.tool",
  "chat.done",
  "chat.error",
  "approval.requested",
  "approval.resolved",
]);

export function businessPorts(
  renderer: Port,
  main: Port,
  acp?: Port,
  withSource: (source: "acp" | "desktop-main" | undefined, action: () => void) => void = (
    _source,
    action,
  ) => action(),
): Port {
  const acpMethods = new Set(acpMethodNames);
  const acpEvents = new Set(acpEventNames);
  const destination = (owner: string) =>
    owner === "main" ? main : owner === "acp" ? acp : renderer;
  const hostOnly = new Set(["providerImport.stage", "providerImport.resolve"]);
  const methods = new Set([
    ...hostOnly,
    "routines.pauseAll",
    "routines.resumeAll",
    "credentials.takeoverAccounts",
    "credentials.fillForTakeover",
    "browser.takeover",
    "settings.get",
    "diagnostics.snapshot",
    "bots.list",
    // Tray "waiting for you" line: a count only, never inbox contents.
    "inbox.counts",
  ]);
  const mainEvents = new Set([
    "settings.changed",
    "credentials.changed",
    "bots.changed",
    "inbox.changed",
    "runtime.activeRuns",
    // Live island: Bot names, avatars and short titles only.
    "runtime.liveActivity",
  ]);
  return {
    post(raw) {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (typeof message.id === "string" && message.id.startsWith("desktop:")) {
        try {
          const [owner, id] = JSON.parse(message.id.slice(8)) as [string, unknown];
          if (owner === "main" || owner === "renderer" || owner === "acp")
            destination(owner)?.post({ ...message, id });
        } catch {
          /* Invalid internal response cannot address either client. */
        }
      } else if (message.id === undefined) {
        renderer.post(raw);
        if (typeof message.method === "string" && acpEvents.has(message.method)) acp?.post(raw);
        if (typeof message.method === "string" && mainEvents.has(message.method)) main.post(raw);
      }
    },
    onMessage(listener) {
      const receive = (owner: "main" | "renderer" | "acp", raw: unknown) => {
        const request = RequestSchema.safeParse(raw);
        if (!request.success) {
          destination(owner)?.post({
            jsonrpc: "2.0",
            id: null,
            error: { code: RpcErrorCodes.invalidRequest, message: "invalid_desktop_request" },
          });
          return;
        }
        const message = request.data;
        if (
          (owner === "main" && !methods.has(message.method)) ||
          (owner !== "main" && hostOnly.has(message.method)) ||
          (owner === "acp" && (!acpMethods.has(message.method) || message.id === undefined))
        ) {
          if (message.id !== undefined)
            destination(owner)?.post({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: RpcErrorCodes.methodNotFound, message: "desktop_method_unavailable" },
            });
          return;
        }
        listener(
          message.id === undefined
            ? raw
            : {
                ...message,
                id: `desktop:${JSON.stringify([owner, message.id])}`,
              },
        );
      };
      const a = renderer.onMessage((message) =>
        withSource(undefined, () => receive("renderer", message)),
      );
      const b = main.onMessage((message) =>
        withSource("desktop-main", () => receive("main", message)),
      );
      const c = acp?.onMessage((message) => withSource("acp", () => receive("acp", message)));
      return () => {
        a();
        b();
        c?.();
      };
    },
  };
}
