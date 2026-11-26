// Open and configure a managed pi session for a Bot run.
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { sanitizeBrainEnv } from "../../core/env.ts";
import { AgentError, mapAgentError } from "../../core/errors.ts";
import type { AgentRuntime } from "../../core/types.ts";
import { type CompactionState, claimOverflowRecovery } from "../../extensions/compaction.ts";
import { compactBeforePrompt } from "../../extensions/compaction-preflight.ts";
import type { PromptState } from "../../extensions/prompt-context.ts";
import { fitRequest } from "../../extensions/request-budget.ts";
import { collapseRecentToolResults } from "../../extensions/tool-result-trim.ts";
import { showsGroupReference } from "../../extensions/transcript-entries.ts";
import { NETWORK_RETRY_SETTINGS } from "../../network/network-reconnect.ts";
import { staticResourceLoader, wrapSession } from "../../session/session.ts";
import { SessionAdditions } from "../../session/session-additions.ts";
import { storedSessionFile } from "../../session/session-files.ts";
import { CacheDiagnostics } from "../cache-diagnostic.ts";
import { contextBudget, responseMaxTokens } from "../context-budget.ts";
import { historyTokens, referenceTokens, textTokens } from "../context-estimate.ts";
import { providerDetail } from "../provider-diagnostic.ts";
import { RequestAccounting } from "../request-observer.ts";
import { retryStream } from "../retry-stream.ts";
import type { RuntimeContext } from "../runtime.ts";
import { skillsPrompt } from "../skills-prompt.ts";
import { toolVersion } from "../tool-identity.ts";
import { modelInfo, sessionPaths } from "./runtime-shared.ts";

export function createSessionOperations({
  dataDir,
  deps,
  checkpointCache,
  cacheDiagnosticsMemory,
  catalog,
  configs,
  injectKey,
  summaryModel,
  auxiliaryModel,
  buildRuntime,
  onCustomModelLimit,
}: RuntimeContext): Pick<AgentRuntime, "openSession"> {
  return {
    async openSession(opts) {
      if (opts.model.provider === "openai-codex")
        throw new AgentError("chatgpt_reconnect_required");
      try {
        opts.signal?.throwIfAborted();
        type OpenPhase = "runtime" | "model" | "session_load" | "extensions" | "create" | "bind";
        let activePhase: OpenPhase = "runtime";
        let phaseStarted = performance.now();
        const phase = (next: OpenPhase) => {
          if (next !== activePhase) {
            opts.phaseTiming?.(activePhase, Math.round(performance.now() - phaseStarted));
            activePhase = next;
            phaseStarted = performance.now();
          }
          opts.phase?.(next);
        };
        phase("runtime");
        const { pi, runtime, custom } = await buildRuntime();
        phase("model");
        opts.signal?.throwIfAborted();
        // A workflow's `cheap` tier runs on the auxiliary model when one is usable.
        const model =
          opts.modelTier === "cheap"
            ? await auxiliaryModel(
                runtime,
                opts.model,
                "workflow",
                opts.signal ?? AbortSignal.timeout(20_000),
              )
            : (await runtime.getAvailable(opts.model.provider)).find(
                (entry) => entry.id === opts.model.id,
              );
        if (!model) throw new AgentError("no_model");
        await injectKey(runtime, model.provider);
        opts.signal?.throwIfAborted();
        const sessionFile = await sessionPaths(dataDir, opts);
        opts.signal?.throwIfAborted();
        phase("session_load");
        const { openSessionAsync } = await import("@earendil-works/pi-coding-agent/async-session");
        const deadline = AbortSignal.timeout(15_000);
        const loadSignal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
        const manager = sessionFile
          ? await openSessionAsync(sessionFile, opts.sessionDir, opts.homeDir, loadSignal)
          : pi.SessionManager.create(opts.homeDir, opts.sessionDir);
        const budget = contextBudget(model.contextWindow);
        const settings = pi.SettingsManager.inMemory({
          enableInstallTelemetry: false,
          cacheWarming: "off",
          compaction: {
            enabled: !!opts.localTools,
            reserveTokens: budget.reserveTokens,
            keepRecentTokens: budget.keepRecentTokens,
          },
          retry: { ...NETWORK_RETRY_SETTINGS },
        });
        const providerName =
          custom.find((entry) => entry.id === model.provider)?.name ??
          catalog.find((entry) => entry.id === model.provider && entry.auth === "apiKey")?.name ??
          model.provider;
        const identityPrompt =
          typeof opts.systemPrompt === "function"
            ? opts.systemPrompt(modelInfo(model), providerName)
            : opts.systemPrompt;
        const skills = opts.skills
          ? skillsPrompt(pi.formatSkillsForPrompt, opts.skills.entries, opts.skills.language)
          : "";
        // Only program-authored text here: identity, the skill index and a workflow's contract
        // block. SEC: the skill's own text goes to the run's context reference message, which
        // only the prompt-context extension (loaded with `context`) places.
        const systemPrompt = `${identityPrompt}${skills}${opts.workflowPrompt ?? ""}`;
        if (opts.workflowSkill && !opts.context) throw new AgentError("internal");
        const { loadLocalExtensions } = await import("../../extensions/load.ts");
        const promptState: PromptState = opts.workflowSkill
          ? { workflowSkill: opts.workflowSkill }
          : {};
        let retryBound = false;
        const additions = opts.localTools ? new SessionAdditions() : undefined;
        const context = opts.context;
        const accounting = new RequestAccounting(
          opts.requestObserver,
          deps.network?.observeRequest,
        );
        const compaction: CompactionState | undefined = opts.localTools
          ? {
              signal: opts.signal,
              summaryModel: (signal) => summaryModel(runtime, model, signal),
              cache: checkpointCache,
              contextWindow: model.contextWindow,
              selfRetainingBoundary: () =>
                manager.appendCustomEntry("pibot_checkpoint_boundary", { version: 1 }),
              identity: () =>
                JSON.stringify([manager.getSessionId(), opts.botId, compaction?.scopeVersion?.()]),
              unattended: opts.unattended,
              redact: opts.localTools.redact,
              activity: opts.onCompaction,
              accounting,
              metricToolNames: new Set(opts.localTools.definitions.map((tool) => tool.name)),
            }
          : undefined;
        const safeContext = (snapshot: import("../../core/types.ts").PromptContext) => ({
          ...(snapshot.routineTopicReference
            ? {
                routineTopicReference: (
                  context?.redact(snapshot.routineTopicReference) ?? snapshot.routineTopicReference
                ).slice(0, 9000),
              }
            : {}),
          ...(snapshot.backgroundResults
            ? {
                backgroundResults:
                  context?.redact(snapshot.backgroundResults) ?? snapshot.backgroundResults,
              }
            : {}),
          memory: context?.redact(snapshot.memory) ?? snapshot.memory,
          ...(snapshot.availableSecrets
            ? {
                availableSecrets:
                  context?.redact(snapshot.availableSecrets) ?? snapshot.availableSecrets,
              }
            : {}),
          ...(snapshot.workplace
            ? { workplace: context?.redact(snapshot.workplace) ?? snapshot.workplace }
            : {}),
          ...(snapshot.projectNotes
            ? { projectNotes: context?.redact(snapshot.projectNotes) ?? snapshot.projectNotes }
            : {}),
          ...(snapshot.execution
            ? { execution: context?.redact(snapshot.execution) ?? snapshot.execution }
            : {}),
          ...(snapshot.routineResume
            ? {
                routineResume: (
                  context?.redact(snapshot.routineResume) ?? snapshot.routineResume
                ).slice(0, 1000),
              }
            : {}),
          ...(snapshot.runResume
            ? {
                runResume: (context?.redact(snapshot.runResume) ?? snapshot.runResume).slice(
                  0,
                  2000,
                ),
              }
            : {}),
          ...(snapshot.routineLedger
            ? {
                routineLedger: (
                  context?.redact(snapshot.routineLedger) ?? snapshot.routineLedger
                ).slice(0, 6000),
              }
            : {}),
          ...(snapshot.routineSummary
            ? {
                routineSummary: (
                  context?.redact(snapshot.routineSummary) ?? snapshot.routineSummary
                ).slice(0, 2000),
              }
            : {}),
          ...(snapshot.group
            ? {
                group: {
                  ...snapshot.group,
                  information:
                    context?.redact(snapshot.group.information) ?? snapshot.group.information,
                  ...(snapshot.group.parts
                    ? {
                        parts: snapshot.group.parts.map((part) => ({
                          ...part,
                          text: context?.redact(part.text) ?? part.text,
                          ...(part.compact !== undefined
                            ? { compact: context?.redact(part.compact) ?? part.compact }
                            : {}),
                        })),
                      }
                    : {}),
                  workplace: snapshot.group.workplace
                    ? context?.redact(snapshot.group.workplace)
                    : undefined,
                  messages: snapshot.group.messages.map((m) => ({
                    ...m,
                    text: context?.redact(m.text) ?? m.text,
                    ...(m.botName ? { botName: context?.redact(m.botName) } : {}),
                    ...(m.imageDelivery
                      ? {
                          imageDelivery: {
                            ...m.imageDelivery,
                            workspace: m.imageDelivery.workspace.map((saved) => ({
                              ...saved,
                              ...(saved.targetPath
                                ? {
                                    targetPath:
                                      context?.redact(saved.targetPath) ?? saved.targetPath,
                                  }
                                : {}),
                              ...(saved.savedPath
                                ? { savedPath: context?.redact(saved.savedPath) ?? saved.savedPath }
                                : {}),
                            })),
                          },
                        }
                      : {}),
                    ...(m.attachments
                      ? {
                          attachments: m.attachments.map((a) => ({
                            ...a,
                            name: context?.redact(a.name) ?? a.name,
                          })),
                        }
                      : {}),
                  })),
                },
              }
            : {}),
        });
        // Reference text has a small fixed share; raw transcript length is handled by token budgets.
        promptState.maxBytes = Math.max(4096, Math.floor(budget.triggerTokens * 0.2) * 3);
        if (compaction)
          compaction.scopeVersion = () =>
            toolVersion({
              workplaceIdentity: opts.localTools?.permissionsSnapshot?.().workplaceVersion,
              workplace: promptState.current?.workplace,
              groupWorkplace: promptState.current?.group?.workplace,
            });
        if (context?.refresh)
          promptState.refresh = async (signal) =>
            safeContext((await context.refresh?.(signal, modelInfo(model))) ?? { memory: "" });
        promptState.signal = opts.signal;
        // State and reference messages go into the session file where the request shows
        // them, so later runs carry them in place (the provider's cached prefix stays valid).
        promptState.transcript = {
          append: (customType, content, details) =>
            void manager.appendCustomMessageEntry(customType, content, false, details),
          entries: () => manager.getEntries(),
        };
        if (opts.context && !opts.localTools) throw new AgentError("internal");
        phase("extensions");
        // Registration can follow the last JSONL batch in the same microtask drain.
        if (opts.localTools) await yieldToLoop(undefined, { signal: opts.signal });
        const extensions = await loadLocalExtensions(
          opts.homeDir,
          join(dataDir, "pi"),
          settings,
          opts.localTools,
          opts.context ? promptState : undefined,
          compaction,
          additions,
          opts.toolLoading,
        );
        if (compaction)
          compaction.toolSet = () => ({
            catalogVersion: toolVersion([]),
            visible: [],
            ...(opts.localTools?.permissionsSnapshot
              ? { permissions: opts.localTools.permissionsSnapshot() }
              : {}),
          });
        if (compaction)
          compaction.estimateHistory = (messages) =>
            historyTokens(messages, extensions.loadout?.synchronize());
        phase("create");
        const { session } = await pi.createAgentSession({
          cwd: opts.homeDir,
          agentDir: join(dataDir, "pi"),
          modelRuntime: runtime,
          model,
          thinkingLevel: opts.thinkingLevel,
          settingsManager: settings,
          sessionManager: manager,
          resourceLoader: staticResourceLoader(systemPrompt, extensions.runtime, extensions),
          noTools: opts.localTools ? "builtin" : "all",
        });
        const file = manager.getSessionFile();
        let stored: string;
        try {
          if (!file) throw new AgentError("internal");
          stored = storedSessionFile(dataDir, file);
        } catch (error) {
          session.dispose();
          throw error;
        }
        // A restored JSONL can name another model. Explicit caller selection wins.
        try {
          opts.signal?.throwIfAborted();
          phase("bind");
          if (opts.localTools) {
            await yieldToLoop(undefined, { signal: opts.signal });
            await session.bindExtensions({});
          }
          // Tool groups the transcript still declares stay loaded when still allowed.
          extensions.loadout?.reset(session.messages);
          await session.setModel(model);
          session.setThinkingLevel(opts.thinkingLevel);
          opts.phaseTiming?.(activePhase, Math.round(performance.now() - phaseStarted));
        } catch (error) {
          session.dispose();
          throw error;
        }
        // Public Agent.streamFunction is the final fail-closed boundary. pi catches context-hook errors
        // and can enter streamFn even after ctx.abort(); never reach the provider in that case.
        const streamRequest = session.agent.streamFunction;
        const cacheDiagnostics = opts.requestObserver?.cacheDiagnostic
          ? new CacheDiagnostics({ store: cacheDiagnosticsMemory, key: stored })
          : undefined;
        let providerMaxTokens = model.maxTokens;
        session.agent.streamFunction = async (model, request, options) => {
          opts.signal?.throwIfAborted();
          if (compaction?.failure) throw new AgentError(compaction.failure);
          if (promptState.failure) throw new AgentError(promptState.failure);
          if (accounting.blocked) throw new AgentError(accounting.blocked);
          const projected = extensions.loadout?.project(request) ?? request;
          let fitted: ReturnType<typeof fitRequest>;
          try {
            fitted = fitRequest(projected.messages, model.contextWindow, compaction?.estimateScale);
          } catch (error) {
            if (error instanceof AgentError && error.code === "context_too_large")
              promptState.failure = "context_too_large";
            throw error;
          }
          const scopedRequest = { ...projected, messages: fitted.messages };
          const requestSignal =
            options?.signal && opts.signal
              ? AbortSignal.any([options.signal, opts.signal])
              : (options?.signal ?? opts.signal);
          return retryStream({
            model,
            signal: requestSignal,
            accounting,
            describeFailure: (error) =>
              opts.redactProviderDetail && providerDetail(error, opts.redactProviderDetail),
            toolSet: extensions.loadout?.snapshot(scopedRequest),
            open: async (recovery) => {
              const onPayload = options?.onPayload;
              const retryRequest = recovery.hint
                ? {
                    ...scopedRequest,
                    messages: [
                      ...scopedRequest.messages,
                      {
                        role: "user" as const,
                        content: recovery.hint,
                        timestamp: Date.now(),
                      },
                    ],
                  }
                : scopedRequest;
              const stream = await streamRequest(model, retryRequest, {
                ...options,
                signal: requestSignal,
                maxTokens: Math.min(
                  responseMaxTokens(providerMaxTokens, options?.maxTokens),
                  budget.outputReserve,
                ),
                maxRetries: 0,
                onResponse: async (response, selected) => {
                  recovery.response(response);
                  await options?.onResponse?.(response, selected);
                },
                // Sees the payload exactly as sent, after every extension's provider hook.
                ...(cacheDiagnostics
                  ? {
                      onPayload: async (payload: unknown, payloadModel: typeof model) => {
                        const next = await onPayload?.(payload, payloadModel);
                        try {
                          cacheDiagnostics.request(next ?? payload, model.api, options?.transport);
                        } catch {
                          // A diagnostic must never fail the request it describes; the line is
                          // simply missing for this request.
                        }
                        return next;
                      },
                    }
                  : {}),
              });
              const result = stream.result();
              if (cacheDiagnostics)
                void result
                  .then((response) =>
                    cacheDiagnostics.settle(
                      response.stopReason === "error" || response.stopReason === "aborted"
                        ? undefined
                        : response.usage,
                      model.api,
                      options?.sessionId,
                    ),
                  )
                  .then(
                    (line) => line && opts.requestObserver?.cacheDiagnostic?.(line),
                    () => {
                      /* Diagnostics are best effort; the SDK and accounting own request failures. */
                    },
                  );
              if (compaction)
                void result.then(
                  (response) => {
                    if (response.stopReason === "error" || response.stopReason === "aborted")
                      return;
                    const input =
                      response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
                    const estimate = historyTokens(scopedRequest.messages);
                    if (estimate > 0 && input > 0) {
                      compaction.estimateScale = Math.max(1, Math.min(4, input / estimate));
                      checkpointCache.scale(
                        compaction.identity?.() ?? "",
                        compaction.estimateScale,
                      );
                    }
                  },
                  () => {
                    /* The SDK and request accounting own this failure. */
                  },
                );
              return stream;
            },
            onLimit: (limit) => {
              providerMaxTokens = Math.min(providerMaxTokens, limit.maxTokens);
              onCustomModelLimit?.(model.provider, model.id, { maxTokens: providerMaxTokens });
            },
          });
        };
        const wrapped = wrapSession(
          session,
          stored,
          async () => {
            sanitizeBrainEnv(process.env, dataDir);
            if (
              custom.some((config) => config.id === model.provider) &&
              !configs().some((config) => config.id === model.provider)
            )
              return false;
            await injectKey(runtime, model.provider);
            return (await runtime.getAvailable(model.provider)).some(
              (entry) => entry.id === model.id,
            );
          },
          async (text, images) => {
            if (opts.retryBoundary && !retryBound) {
              const entry = manager.appendCustomEntry("pibot_retry_boundary", {
                messageId: opts.retryBoundary.messageId,
              });
              opts.retryBoundary.record(entry, manager.getSessionFile() as string);
              retryBound = true;
            }
            if (compaction) compaction.failure = undefined;
            promptState.failure = undefined;
            if (context) {
              // Required context is prepared outside hooks: pi catches hook errors and continues.
              const signal = opts.signal ?? AbortSignal.timeout(20_000);
              signal.throwIfAborted();
              const snapshot = await context.prepare(signal, modelInfo(model));
              signal.throwIfAborted();
              promptState.failure = undefined;
              promptState.current = safeContext(snapshot);
            }
            if (compaction)
              compaction.estimateScale =
                checkpointCache.scale(compaction.identity?.() ?? "") ?? compaction.estimateScale;
            const nextTokens = () => {
              // A collapsed request copy has to count as collapsed here too, or the loop below
              // would judge a reduction it already made as no progress.
              const historyMessages = compaction?.collapseRecent
                ? (collapseRecentToolResults(session.messages) ?? session.messages)
                : session.messages;
              return (
                (compaction?.estimateHistory?.(historyMessages) ?? historyTokens(historyMessages)) +
                textTokens(text) +
                (images?.length ?? 0) * 1200 +
                referenceTokens(
                  promptState.current,
                  // With a group reference already in the session (persisted, counted in the
                  // history above), the next run opens with an update, bounded by a quarter.
                  Math.floor(
                    (budget.triggerTokens * 0.2) / (showsGroupReference(session.messages) ? 4 : 1),
                  ),
                )
              );
            };
            if (
              compaction &&
              Number.isFinite(budget.triggerTokens) &&
              session.messages.some((message) => message.role === "assistant") &&
              nextTokens() * (compaction.estimateScale ?? 1) >= budget.triggerTokens
            ) {
              compaction.operationSignal?.throwIfAborted();
              let previous = nextTokens();
              for (let pass = 0; pass < 64; pass++) {
                await compactBeforePrompt(session, compaction);
                if (compaction.failure) throw new AgentError(compaction.failure);
                const remaining = nextTokens();
                if (remaining * (compaction.estimateScale ?? 1) < budget.triggerTokens) break;
                if (remaining >= previous) {
                  // A checkpoint never rewrites the raw tail it keeps verbatim, so a few whole-file
                  // reads or long logs there hold the estimate up however often we summarize.
                  // Collapse those results in the copy we send (session file, run records and audit
                  // log keep the originals) and try once more before giving up.
                  if (compaction.collapseRecent) {
                    if (!claimOverflowRecovery(compaction))
                      throw new AgentError("context_overflow");
                    // No request has been sent yet. Compact the retained tail once and retry
                    // admission of the same prompt without appending or replaying it.
                    await compactBeforePrompt(session, compaction, true, "overflow");
                    if (nextTokens() * (compaction.estimateScale ?? 1) >= budget.triggerTokens)
                      throw new AgentError("context_overflow");
                    break;
                  }
                  compaction.collapseRecent = true;
                }
                previous = remaining;
              }
            }
          },
          opts.signal,
          compaction,
          additions,
          () => promptState.failure ?? extensions.loadout?.failure ?? accounting.blocked,
          accounting,
          (enabled) => settings.setRetryEnabled(enabled),
          opts.retryBoundary
            ? (messageId) => {
                const entry = manager.appendCustomEntry("pibot_retry_boundary", { messageId });
                opts.retryBoundary?.record(entry, manager.getSessionFile() as string, messageId);
              }
            : undefined,
        );
        return Object.assign(wrapped, { model: { provider: model.provider, id: model.id } });
      } catch (error) {
        throw new AgentError(mapAgentError(error));
      }
    },
  };
}
