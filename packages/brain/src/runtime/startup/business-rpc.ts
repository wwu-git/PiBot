import { AgentError, mapAgentError } from "@pibot/agent";
import { ExecError } from "@pibot/execution";
import {
  type createPeer,
  type KernelEvents,
  type KernelMethodParams,
  type KernelMethodResults,
  type KernelMethods,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { BotNameTakenError, ConversationsRepo } from "@pibot/storage";
import type { RpcRequestContext } from "../../core/business-rpc.ts";
import type { BrainSleep } from "../queue/brain-sleep.ts";

interface StartupContext {
  startupDiagnostics?: ReturnType<typeof import("./first-rpcs.ts").firstRpcDiagnostics>;
  loopWatch?: { mark(phase: string): void };
  /** A request from the user's side (not background scheduling) just arrived. */
  noteUserActivity?(): void;
  stopping: boolean;
  waitForContent(signal: AbortSignal): Promise<void>;
  opts?: {
    requestSource?: () => "acp" | "desktop-main" | undefined;
    isPhoneRequest?: () => boolean;
  };
  sleep: BrainSleep | undefined;
  interactiveAttached: boolean;
  offlineAllowed: Set<string>;
  db: import("node:sqlite").DatabaseSync;
  requests: Set<Promise<unknown>>;
  backgroundPrefixes: string[];
  interactiveRequests: Set<Promise<unknown>>;
  logger: import("@pibot/observability").Logger;
  peer: ReturnType<typeof createPeer<typeof KernelMethods, typeof KernelEvents>>;
}

/**
 * What an RPC failure is called in the log. A defined refusal (RpcError) keeps its code and, when
 * it is a plain code word, its message: before this every refusal such as `yolo_unavailable`
 * was logged as `internal`, which reads like a bug. Free-form messages (paths etc.) stay out.
 */
function rpcLogLabel(error: unknown): string {
  if (!(error instanceof RpcError)) return `${mapAgentError(error)}${internalDetail(error)}`;
  // Reason codes, and plain-word messages such as "Unknown topic" (a failed ACP load once logged
  // only -32602). Anything with digits, paths or punctuation may quote user data and stays out.
  return /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ||
    /^[A-Za-z][A-Za-z ]{0,47}$/.test(error.message)
    ? `rpc ${error.code} ${error.message}`
    : `rpc ${error.code}`;
}

/**
 * A bare `internal` gives nothing to diagnose. The class name and ExecError's enum code/reason are
 * fixed identifiers; the message is not logged because it may quote paths or content.
 */
function internalDetail(error: unknown): string {
  if (!(error instanceof Error)) return ` type=${typeof error}`;
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  if (!(error instanceof ExecError)) return ` error=${name}`;
  return ` error=${name} code=${error.code}${error.reason ? ` reason=${error.reason}` : ""}`;
}
const contentIndependent = new Set<string>([
  "runtime.health.get",
  "runtime.forceRelease",
  "runtime.commands.get",
  "runtime.commands.recheck",
  "chat.abort",
  "groups.abort",
  "app.about",
  "credentials.status",
]);

export function registerBusinessRpc<K extends keyof typeof KernelMethods>(
  ctx: StartupContext,
  method: K,
  action: (
    params: KernelMethodParams[K],
    context: RpcRequestContext,
  ) => Promise<KernelMethodResults[K]>,
) {
  // Peer validates this method's schema before dispatch. Keep the common lifecycle wrapper
  // erased so TypeScript does not expand every RPC payload union inside Promise inference.
  const execute = action as (params: unknown, context: RpcRequestContext) => Promise<unknown>;
  const invoke = async (params: unknown, context: RpcRequestContext): Promise<unknown> => {
    const source = ctx.opts?.requestSource?.();
    context = {
      ...context,
      source: source === "acp" ? source : undefined,
      desktopMain: source === "desktop-main",
      ...(ctx.opts?.isPhoneRequest?.() ? { phone: true } : {}),
    };
    context.signal.throwIfAborted();
    if (ctx.stopping) throw new RpcError(-32001, "Brain stopping");
    ctx.sleep?.assertAdmission();
    const finishTiming = ctx.startupDiagnostics?.begin(method);
    // Method names are fixed protocol identifiers; parameters never reach the stall log.
    ctx.loopWatch?.mark(method);
    if (!ctx.backgroundPrefixes.some((prefix) => method.startsWith(prefix)))
      ctx.noteUserActivity?.();
    const request = Promise.resolve().then(async () => {
      context.signal.throwIfAborted();
      if (!ctx.interactiveAttached && !ctx.offlineAllowed.has(method))
        throw new RpcError(RpcErrorCodes.closed, "Interactive client unavailable");
      // Internal task sessions have a dedicated, source-scoped API, never normal topic RPCs.
      if (params && typeof params === "object") {
        const scope = params as Record<string, unknown>;
        for (const key of ["conversationId", "topicId", "threadId"])
          if (
            typeof scope[key] === "string" &&
            new ConversationsRepo(ctx.db).isInternal(scope[key])
          )
            throw new RpcError(RpcErrorCodes.invalidParams, "internal_task_scope");
      }
      // Stops and fixed health facts must remain available even with a locked keyring.
      if (!contentIndependent.has(method)) await ctx.waitForContent(context.signal);
      context.signal.throwIfAborted();
      if (ctx.stopping) throw new RpcError(RpcErrorCodes.closed, "Brain stopping");
      ctx.sleep?.assertAdmission();
      if (!ctx.interactiveAttached && !ctx.offlineAllowed.has(method))
        throw new RpcError(RpcErrorCodes.closed, "Interactive client unavailable");
      return execute(params, context);
    });
    ctx.requests.add(request);
    // Background methods (scheduling) keep working without a desktop client, so they never
    // hold up the interactive drain.
    if (!ctx.backgroundPrefixes.some((prefix) => method.startsWith(prefix)))
      ctx.interactiveRequests.add(request);
    try {
      const result = await request;
      context.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (context.signal.aborted) throw new RpcError(RpcErrorCodes.closed, "RPC cancelled");
      // The repository refuses a taken Bot name; the window shows it under the field.
      if (error instanceof BotNameTakenError) {
        ctx.logger.warn(`RPC ${method} bot_name_taken`);
        throw new RpcError(RpcErrorCodes.botNameTaken, "bot_name_taken");
      }
      const expected =
        error instanceof RpcError ||
        error instanceof AgentError ||
        (error instanceof Error && error.message === "Secret encryption unavailable");
      ctx.logger[expected ? "warn" : "error"](`RPC ${method} ${rpcLogLabel(error)}`);
      if (error instanceof RpcError) throw error;
      if (error instanceof Error && error.message === "Secret encryption unavailable")
        throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
      throw new RpcError(-32603, mapAgentError(error));
    } finally {
      finishTiming?.();
      ctx.requests.delete(request);
      ctx.interactiveRequests.delete(request);
    }
  };
  ctx.peer.handle(
    method,
    invoke as (
      params: import("@pibot/protocol-base").Params<typeof KernelMethods, K>,
      context: RpcRequestContext,
    ) => Promise<import("@pibot/protocol-base").Result<typeof KernelMethods, K>>,
  );
}
