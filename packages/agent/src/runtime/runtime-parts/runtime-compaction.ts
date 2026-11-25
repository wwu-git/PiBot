import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { untilAborted } from "../../core/abort.ts";
import { AgentError } from "../../core/errors.ts";
import type { AgentRuntime, ContextEstimate } from "../../core/types.ts";
import type { CompactionState } from "../../extensions/compaction.ts";
import { compactBeforePrompt } from "../../extensions/compaction-preflight.ts";
import { staticResourceLoader } from "../../session/session.ts";
import { storedSessionFile } from "../../session/session-files.ts";
import { historyTokens } from "../context-estimate.ts";
import { RequestAccounting } from "../request-observer.ts";
import type { RuntimeContext } from "../runtime.ts";
import { sessionPaths } from "./runtime-shared.ts";
export function createCompactionOperations({
  dataDir,
  checkpointCache,
  injectKey,
  summaryModel,
  buildRuntime,
}: RuntimeContext): Pick<AgentRuntime, "compactHistory" | "estimateContext"> {
  // Opening a session parses the whole JSONL synchronously on the brain's thread, and the UI
  // re-asks on every metadata refresh and every finished reply. One result per file version (and
  // one in-flight read per file) keeps that from turning into repeated full parses.
  const estimates = new Map<string, { size: number; mtimeMs: number; value: ContextEstimate }>();
  const estimating = new Map<string, Promise<ContextEstimate | undefined>>();
  return {
    async estimateContext(request) {
      request.signal.throwIfAborted();
      const homeDir = join(dataDir, "bots", request.botId, "home");
      const sessionDir = join(dataDir, "bots", request.botId, "sessions");
      const file = await sessionPaths(dataDir, {
        botId: request.botId,
        sessionFile: request.sessionFile,
        homeDir,
        sessionDir,
        thinkingLevel: "off",
        systemPrompt: "",
      });
      if (!file) return undefined;
      const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      request.signal.throwIfAborted();
      // A remembered filename legitimately has no JSONL until the first model turn, and pi writes
      // a header when it opens such a file; a session with no bytes has no context to warn about.
      if (!info?.isFile() || info.size === 0) return undefined;
      const cached = estimates.get(file);
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs)
        return cached.value;
      const running = estimating.get(file);
      if (running) return untilAborted(running, request.signal);
      // Cancel each caller's wait independently; the file read is shared by the other callers.
      const task = (async () => {
        const { pi } = await buildRuntime();
        const manager = pi.SessionManager.open(file, sessionDir, homeDir);
        // The compaction scheduler measures this same projection, so the hint compares against
        // the line at which the agent would really start organizing context.
        const projection = pi.buildSessionProjection(manager.getBranch());
        const lastAssistant = projection.messages.findLast(
          (message) => message.role === "assistant",
        );
        const value: ContextEstimate = {
          tokens: historyTokens(projection.messages),
          model: lastAssistant
            ? { provider: lastAssistant.provider, id: lastAssistant.model }
            : undefined,
        };
        estimates.delete(file);
        estimates.set(file, { size: info.size, mtimeMs: info.mtimeMs, value });
        // One entry per started topic; dropping the oldest bounds the map in a long-lived brain.
        if (estimates.size > 64) estimates.delete(estimates.keys().next().value as string);
        return value;
      })().finally(() => estimating.delete(file));
      estimating.set(file, task);
      return untilAborted(task, request.signal);
    },
    async compactHistory(request) {
      const { pi, runtime } = await buildRuntime();
      request.signal.throwIfAborted();
      const model = (await runtime.getAvailable(request.model.provider)).find(
        (entry) => entry.id === request.model.id,
      );
      if (!model) throw new AgentError("no_model");
      await injectKey(runtime, model.provider);
      const homeDir = join(dataDir, "bots", request.botId, "home");
      const sessionDir = join(dataDir, "bots", request.botId, "sessions");
      const file = await sessionPaths(dataDir, {
        ...request,
        homeDir,
        sessionDir,
        thinkingLevel: "off",
        systemPrompt: "",
      });
      if (!file || !(await lstat(file)).isFile()) throw new AgentError("session_unavailable");
      const manager = pi.SessionManager.open(file, sessionDir, homeDir);
      if (request.fork) {
        const leaf = manager.getLeafId();
        if (!leaf || !manager.createBranchedSession(leaf))
          throw new AgentError("session_unavailable");
      }
      const accounting = new RequestAccounting();
      const state: CompactionState = {
        signal: request.signal,
        summaryModel: (signal) => summaryModel(runtime, model, signal),
        unattended: request.fork,
        redact: request.redact,
        cache: checkpointCache,
        accounting,
        identity: () => manager.getSessionId(),
      };
      const { session } = await pi.createAgentSession({
        cwd: homeDir,
        agentDir: join(dataDir, "pi"),
        modelRuntime: runtime,
        model,
        sessionManager: manager,
        settingsManager: pi.SettingsManager.inMemory({
          enableInstallTelemetry: false,
          compaction: { enabled: false },
        }),
        resourceLoader: staticResourceLoader("", pi.createExtensionRuntime()),
        noTools: "all",
      });
      try {
        await compactBeforePrompt(session, state, true);
        request.signal.throwIfAborted();
        const last = manager.getBranch().findLast((entry) => entry.type === "compaction");
        if (last?.type !== "compaction") throw new AgentError("compaction_failed");
        return {
          sessionFile: storedSessionFile(dataDir, manager.getSessionFile() as string),
          summary: request.redact(last.summary),
          mechanical: !!(last.details as { mechanical?: boolean } | undefined)?.mechanical,
        };
      } finally {
        try {
          await accounting.drain();
        } finally {
          try {
            await session.waitForIdle();
          } finally {
            session.dispose();
          }
        }
      }
    },
  };
}
