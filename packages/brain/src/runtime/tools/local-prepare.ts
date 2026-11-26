import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LocalToolCall } from "@pibot/agent";
import {
  boundFileDiff,
  canonicalPath,
  dockerArguments,
  ExecError,
  resolveDockerConnection,
  sensitiveReadBoundary,
} from "@pibot/execution";
import {
  applyYolo,
  automaticOutsidePatterns,
  browserSecretPolicy,
  containsPath,
  expandHome,
  explainPolicyResult,
  fixedOutsideCommand,
  type PolicyRequest,
  type PolicyResult,
  REVEAL_CONFIRMATION_REASON,
  recordPolicyStep,
  secretWriteOutDenied,
} from "@pibot/policy";
import { CHAT_SEARCH_TARGET, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  GroupsRepo,
  GroupTasksRepo,
  SettingsRepo,
} from "@pibot/storage";
import { backgroundInputScope } from "@pibot/tools/command";
import { messageScope } from "../../conversations/chat/read-messages.ts";
import { abortable } from "../../core/abort.ts";
import { auditText } from "../../core/audit-fields.ts";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import { mainDirectRun } from "../../core/main-direct.ts";
import {
  explainRunScope,
  runPermissionScope,
  runPermissionSources,
  runPermissions,
} from "../../core/run-permissions.ts";
import { runYolo } from "../../core/yolo.ts";
import { searchRootPolicyResult } from "../../integrations/search/search-root-policy.ts";
import type { SearchRecipient } from "../../integrations/search/search-service.ts";
import type { LocalService } from "../../local-service.ts";
import {
  resolveRunWorkplace,
  routineSelection,
  topicWorkplaceSnapshot,
} from "../../resources/workplaces/run-workplace.ts";
import { projectNotesEdit, projectNotesPath } from "../notes/project-notes-edit.ts";
import { workflowOutputRoots } from "../workflows/workflow-folder.ts";
import { loginNeedsChoice } from "./browser/browser-login.ts";
import { isBrowserTool } from "./browser/browser-tools.ts";
import { localBrowserFileUnavailable } from "./browser/local-file.ts";
import { prepareBrowserSecrets } from "./browser/secret-handles.ts";
import { assertCommandWritePaths } from "./command-input.ts";
import {
  capabilityAdapterTarget,
  capabilityConnectorPolicy,
  connectionRuled,
  prepareCapabilityConnector,
} from "./connectors/capability-adapter.ts";
import { prepareConnector } from "./connectors/connector-tools.ts";
import {
  gitConfigurationFingerprint,
  gitHooksPathAdapter,
  prepareRunGitConfiguration,
} from "./git-configuration-prepare.ts";
import { gitEntriesFingerprint, prepareRunGitEntries } from "./git-entry-prepare.ts";
import { gitHookFingerprint, prepareRunGitHook } from "./git-hook-prepare.ts";
import { gitKnownFileAdapter, prepareWriteGitConfiguration } from "./git-known-file-prepare.ts";
import { hostSshFingerprint, prepareRunHostSsh } from "./host-ssh-prepare.ts";
import { memorySafetySnapshot, memoryWriteFacts } from "./memory-safety.ts";
import { outsideSandboxFacts } from "./outside-sandbox.ts";
import { protectedWriteRoots } from "./outside-write-protection.ts";
import { preparePatch } from "./patch-prepare.ts";
import { revealIntentReason } from "./reveal-intent.ts";
import { secretCommandPolicy } from "./secrets/secret-command.ts";
import { RunnerToolUnsupportedError, runnerHidesTool } from "./target-tools.ts";
import { toolSecretContent } from "./tool-secret-content.ts";
import { isCollaboration, parseTool, policyRequest, type ToolInput } from "./tools.ts";

/**
 * Maintainers 2026-11-14: a Bot-browser request and a sandboxed local command carry this run's allowed
 * local-network targets, so policy asks only for a new one. web_fetch, search, Windows (no
 * sandbox proxy), Docker, runners and commands run outside the sandbox keep the plain ban.
 */
function withPrivateNetwork(
  local: LocalService,
  context: ToolRunContext,
  input: ToolInput,
  browserCall: boolean,
  remote: boolean,
  request: PolicyRequest,
): PolicyRequest {
  if (request.category === "local_network" && request.operation === "ping")
    return { ...request, approved: local.privateNetwork.hosts(context.runId) };
  if (request.category === "web" && browserCall && !request.fetch && !request.search)
    return {
      ...request,
      privateNetwork: { approved: local.privateNetwork.origins(context.runId) },
    };
  if (
    request.category === "run_command" &&
    input.tool === "run_command" &&
    !remote &&
    local.deps.platform !== "win32" &&
    !request.outsideSandbox &&
    !input.args.docker
  )
    return { ...request, privateNetwork: { approved: local.privateNetwork.hosts(context.runId) } };
  return request;
}

export function toolFingerprint(prepared: PreparedTool, authorization = prepared.authorization) {
  const { result, roots, cwd } = prepared;
  return JSON.stringify([
    authorization,
    prepared.searchRecipient,
    prepared.docker,
    prepared.messageScope,
    prepared.sendPaths,
    prepared.patchPaths,
    prepared.patchFingerprints,
    prepared.sensitiveReadRoots,
    prepared.login,
    prepared.connector,
    prepared.capabilityConnector,
    prepared.secretUses,
    prepared.browserSecretUses,
    prepared.memorySafety,
    prepared.projectNotesWrite,
    gitConfigurationFingerprint(prepared.gitConfiguration),
    gitHookFingerprint(prepared.gitHook),
    gitEntriesFingerprint(prepared.gitEntries),
    hostSshFingerprint(prepared.hostSsh),
    prepared.call.id,
    prepared.call.tool,
    createHash("sha256").update(JSON.stringify(prepared.call.input)).digest("hex"),
    result.facts,
    withoutPiLevels(prepared.settings),
    result.path?.path,
    result.command,
    result.commandHome,
    result.commandNetwork,
    result.url,
    result.grantScope,
    result.category,
    // What a person opens for this one call must be exactly what they saw.
    result.outsideWrites,
    result.outsideWriteRoots,
    roots,
    cwd,
    prepared.home,
    prepared.boundary,
  ]);
}
export function prepareTool(
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  searchRecipient?: SearchRecipient,
  options: { submit?: boolean; deferBrowserLease?: boolean } = {},
): Promise<PreparedTool> {
  const action = () => prepareToolCurrent(local, context, call, signal, searchRecipient, options);
  return context.toolTiming?.(call.id)?.measure("policy", action) ?? action();
}

async function prepareToolCurrent(
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  searchRecipient?: SearchRecipient,
  /** Judge a browser_open call as submitting a form on that page (derived approval). */
  options: { submit?: boolean; deferBrowserLease?: boolean } = {},
): Promise<PreparedTool> {
  await local.tasks.guard(context, signal);
  local.reviews.guardTool(context, call.tool);
  local.collaboration?.guardTool?.(context, call.tool);
  await local.readyForContent(signal);
  await local.userSecrets.ready(signal);
  const input = parseTool(call, local.deps.capabilityTools);
  const resolved = await resolveRunWorkplace(local, context, signal);
  // An external agent's request is judged with the HOME the agent really uses, so `~` on
  // its approval card names the user's folder, not the Bot's home inside Pi Bot's data.
  const workplace = context.delegatedHome ? { ...resolved, home: context.delegatedHome } : resolved;
  // Every tool expands `~` against this home, as a command's HOME does: policy, the brain-side
  // checks below and the UI then name the same place.
  const policyWorkplace = { ...workplace.value, home: workplace.home };
  if (input.tool === "run_command")
    assertCommandWritePaths(
      input.args,
      workplace.boundary.location?.platform ?? local.deps.platform,
    );
  const remote = workplace.boundary.location?.target.startsWith("runner:") === true;
  // Reject before tool-specific rewrites (notably apply_patch and managed image reads).
  // The fixed table is the same one that filters the catalog, so a direct call still gets a
  // message naming the tool instead of the generic approval failure. Tools that never touch the
  // workplace pass through and run on the desktop brain.
  if (
    remote &&
    (runnerHidesTool(input.tool) ||
      (input.tool === "run_command" && (input.args.background || input.args.docker)))
  )
    throw new RunnerToolUnsupportedError(input.tool);
  await local.endpoints?.prepare?.(input.tool, context, signal);
  local.endpoints?.check(input.tool, context);
  const primary = workplace.boundary.roots.find((root) => root.role === "primary");
  const projectChange = context.projectNotesChange;
  if (projectChange && (call.id !== projectChange.callId || input.tool !== "write_file"))
    throw new RpcError(RpcErrorCodes.invalidParams, "project_notes_invalid");
  const projectEdit =
    projectChange ??
    (input.tool === "project_notes" ? projectNotesEdit(input.args, context.language) : undefined);
  if (projectEdit && (!primary || workplace.boundary.location?.target.startsWith("acp:")))
    throw new RpcError(RpcErrorCodes.unsupported, "project_notes_unsupported");
  const projectPath =
    projectEdit && primary
      ? projectNotesPath(
          primary.canonicalPath,
          workplace.boundary.location?.platform ?? local.deps.platform,
        )
      : undefined;
  const backgroundInput =
    input.tool === "write_stdin" ? local.background.inputTarget(context, input.args.id) : undefined;
  const frozenRead =
    !!local.reviews.profile(context) &&
    ["review_read", "read_file", "list_dir", "find_files", "search_text", "code_navigate"].includes(
      input.tool,
    );
  const submit = options.submit === true && input.tool === "browser_open";
  if (input.tool === "image_result") {
    local.images.assertVisible(context, input.args);
    // Managed cache paths are private. The original read-file gate controls this scoped result read.
    const prepared = await prepareTool(
      local,
      context,
      {
        ...call,
        tool: "read_file",
        input: { path: "pibot-image-result", limit: 1 },
      },
      signal,
    );
    const source = local.images.assertVisible(context, input.args);
    prepared.result.facts = source.attachments.map(({ metadata }) => ({
      kind: "read" as const,
      value: auditText(
        `${metadata.name} (${metadata.mimeType}, ${metadata.size} bytes)`,
        local.deps.redactor,
      ),
    }));
    prepared.result.canRemember = false;
    delete prepared.result.grantScope;
    recordPolicyStep(prepared.result, "grant", "managed_image_consent", "narrow");
    return { ...prepared, call };
  }
  const currentReadScope = () =>
    input.tool === "read_messages" ? messageScope(local, context, input.args) : undefined;
  const historyRead = input.tool === "read_messages";
  const readScope = currentReadScope();
  const authorization = authorizationSnapshot(local, context.botId, context);
  if (
    context.groupAuthorization !== undefined &&
    groupAuthorization(local, context) !== context.groupAuthorization
  )
    throw new Error("Group authorization changed");
  if (isCollaboration(input.tool)) {
    if (!local.collaboration) throw new Error("Collaboration unavailable");
    local.collaboration.validate(context, input);
  }
  if (input.tool === "apply_patch")
    return preparePatch(
      local,
      call,
      input.args.patch,
      (file) => prepareTool(local, context, file, signal),
      toolFingerprint,
    );
  signal.throwIfAborted();
  // Resolve exec's current aliases per decision. Omitting its Bot argument keeps this hard
  // deny limited to sensitive roots, separate from the app-data exceptions used by searches.
  const directAiConfigRead =
    !frozenRead && (input.tool === "read_file" || input.tool === "list_dir");
  // These roots are how *this* computer spells its credential and AI-config folders. A
  // remote workplace reads the execution device's disk, and the runner already derives that
  // boundary from its own platform, home and environment when it canonicalizes a path. Comparing
  // this desktop's macOS paths with a Windows target protected nothing, and made the desktop read
  // its own home for a decision that then applied to the other machine.
  const readBoundary =
    !frozenRead &&
    // The Bot browser always runs on this computer, so its local reads keep this computer's
    // boundary even in a remote workplace; the file tools of a remote workplace read the
    // execution device's disk, which the runner guards itself.
    (isBrowserTool(input.tool) ||
      (!remote &&
        [
          "read_file",
          "list_dir",
          "send_file",
          "reveal_in_folder",
          "find_files",
          "search_text",
          "office_read",
          "office_preview",
          "office_render",
          "office_inspect",
          "office_validate",
        ].includes(input.tool)))
      ? await abortable(
          sensitiveReadBoundary(
            local.deps.platform,
            [local.deps.userHome, workplace.home],
            local.deps.env,
          ),
          AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        )
      : undefined;
  const sensitiveReadRoots = directAiConfigRead
    ? readBoundary?.credentialReadRoots
    : readBoundary?.denyRead;
  const aiBoundary = directAiConfigRead ? readBoundary?.aiConfigReadBoundary : undefined;
  signal.throwIfAborted();
  const connector = prepareConnector(local, context, input);
  const capabilityTarget = capabilityAdapterTarget(local, context, input);
  const policy = await local.getPolicy(signal);
  context.permissionGroupId = runPermissionScope(local, context);
  const settings = local.tasks.settings(context, runPermissions(local, context));
  // Read per decision, so switching YOLO off asks again from the next one.
  const yolo = runYolo(local, context);
  const browserCall =
    (isBrowserTool(input.tool) && !capabilityTarget) || input.tool === "browser_login";
  if (
    browserCall &&
    settings.levels.web !== "never" &&
    !(input.tool === "browser_open" && options.deferBrowserLease)
  )
    await local.browser.forContext(context).acquireRun(context, signal);
  // Page actions are judged as visiting the Bot browser's current site.
  const pageAction =
    (isBrowserTool(input.tool) && !capabilityTarget && input.tool !== "browser_open") ||
    input.tool === "browser_login";
  const browserUrl =
    pageAction && settings.levels.web !== "never"
      ? await local.browser.forContext(context).resolvePage(context.botId, signal, context.runId)
      : undefined;
  // Only accounts saved for this page and granted to this Bot are ever offered.
  const login =
    input.tool === "browser_login" && browserUrl
      ? local.credentials.candidates(context.botId, browserUrl, input.args.site)
      : undefined;
  const refused = (reason: string): PolicyResult =>
    explainPolicyResult(
      {
        decision: "deny",
        reason,
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "boundary",
      reason,
    );
  const outsideProtection = protectedWriteRoots(
    local,
    workplace.boundary.location?.target,
    workplace.home,
  );
  const gitConfiguration =
    input.tool === "run_command"
      ? await prepareRunGitConfiguration(
          local,
          context,
          input.args,
          workplace,
          policy.analyzeCommand(input.args.command),
          signal,
          call.id,
        )
      : input.tool === "write_file"
        ? await prepareWriteGitConfiguration(local, context, input.args, workplace, call.id, signal)
        : undefined;
  const gitHook =
    input.tool === "run_command"
      ? await prepareRunGitHook(
          local,
          context,
          input.args,
          workplace,
          policy.analyzeCommand(input.args.command),
          signal,
        )
      : undefined;
  const hostSsh =
    input.tool === "run_command"
      ? await prepareRunHostSsh(
          local,
          context,
          input.args,
          workplace,
          policy.analyzeCommand(input.args.command),
          signal,
        )
      : undefined;
  // Fixed recipes run Git themselves under their own bindings; everything else is scanned.
  const gitEntries =
    input.tool === "run_command" && !gitConfiguration && !gitHook && !hostSsh
      ? await prepareRunGitEntries(
          local,
          context,
          input.args,
          workplace,
          policy.analyzeCommand(input.args.command),
          signal,
          call.id,
        )
      : undefined;
  const appSettings =
    input.tool === "run_command" ? new SettingsRepo(local.deps.db).get() : undefined;
  const automatic = automaticOutsidePatterns(
    appSettings?.sandboxAutoOutsideCommands ?? [],
    workplace.cwd,
  );
  const listedOutside = [
    ...(appSettings?.sandboxOutsideCommands ?? []),
    ...(context.routineSource || context.permissionGroupId ? automatic : []),
  ].slice(0, 32);
  // A fixed program (gh, aws, ssh, ...) and a recorded local-service block also need the
  // facts: without them policy can show neither their card nor the local-service card.
  const blockedService =
    input.tool === "run_command"
      ? context.sandboxBlocks?.localService({ command: input.args.command, cwd: input.args.cwd })
      : undefined;
  const fixedOutside =
    input.tool === "run_command" &&
    fixedOutsideCommand(policy.analyzeCommand(input.args.command), local.deps.platform);
  const outsideSandbox =
    input.tool === "run_command" &&
    (input.args.outsideSandbox ||
      listedOutside.length ||
      automatic.length ||
      blockedService ||
      context.sandboxBlocks?.systemService(input.args) ||
      fixedOutside)
      ? outsideSandboxFacts({
          platform: local.deps.platform,
          local: (workplace.boundary.location?.target ?? "local") === "local",
          args: input.args,
          recipe: !!(gitConfiguration || gitHook || hostSsh),
          readonlyRoots:
            !!workplace.boundary.denyWriteRoots?.length ||
            workplace.boundary.roots.some((root) => root.role === "readonly"),
          strict: appSettings?.strictSandbox === true,
          listed: listedOutside,
          automatic: context.routineSource || context.permissionGroupId ? [] : automatic,
          registry: context.sandboxBlocks,
          localService: blockedService,
          systemService: context.sandboxBlocks?.systemService(input.args),
        })
      : undefined;
  // A group run produces its files in the group's own output folder, so that folder stops
  // asking. Plan step folders sit inside it, so a reviewer's report needs no rule of its own; a
  // role default of "never" is not bypassed, it moved to "ask" for that role instead.
  const groupOutputRoots = context.permissionGroupId
    ? workflowOutputRoots().map((name) => join(workplace.cwd, ...name.split("/")))
    : undefined;
  // Another Bot's skills, memory or sessions must not be reachable through an approval card,
  // so policy is told which data roots are this run's own. A remote run reads the other device.
  const botData = remote
    ? undefined
    : {
        roots: [
          join(local.deps.dataDir, "bots"),
          join(local.deps.dataDir, "groups"),
          // Skill packages keep one shared copy each here, outside any Bot's folder; a Bot that
          // was not assigned the package must be refused rather than offered a remembered grant.
          join(local.deps.dataDir, "skill-packages"),
        ],
        allowed: [
          join(local.deps.dataDir, "bots", context.botId),
          ...(context.groupId
            ? [
                join(local.deps.dataDir, "groups", context.groupId, "home"),
                join(local.deps.dataDir, "groups", context.groupId, "bots", context.botId),
              ]
            : []),
          ...(local.skills?.roots?.(context.botId, runPermissionScope(local, context)) ?? []),
        ],
      };
  // The message names the file Pi Bot itself saved for this Bot, so reading it back needs
  // no card. A remote workplace reads another device's disk, where this desktop path means nothing.
  const attachmentsRoot = remote
    ? undefined
    : join(local.deps.dataDir, "bots", context.botId, "attachments");
  const commandEnvironment =
    !remote && input.tool === "run_command" && !input.args.docker
      ? await abortable(
          Promise.resolve(
            local.skills?.runtimeEnvironment?.(context.botId, runPermissionScope(local, context)),
          ),
          AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        )
      : undefined;
  signal.throwIfAborted();
  const policyInput = {
    ...(commandEnvironment
      ? {
          commandReadRoots: [
            commandEnvironment.dir,
            ...(commandEnvironment.python ? [commandEnvironment.python] : []),
            ...(commandEnvironment.node ? [commandEnvironment.node] : []),
          ],
        }
      : {}),
    ...(input.tool === "run_command" && !input.args.docker
      ? {
          commandIsolation: async (current: AbortSignal) => {
            try {
              return (await local.targetFor(workplace.boundary.location).isolationStatus(current))
                .available;
            } catch {
              current.throwIfAborted();
              // A failed target probe cannot certify isolation; policy keeps the danger card.
              return false;
            }
          },
        }
      : {}),
    ...(outsideSandbox ? { outsideSandbox } : {}),
    // Write paths the person approved before for this folder (brain facts, never model
    // input); none on a strict sandbox, a runner or for a routine / group run.
    ...(input.tool === "run_command" &&
    appSettings?.sandboxAutoWritePaths?.length &&
    appSettings.strictSandbox !== true &&
    !remote &&
    !context.routineSource &&
    !context.permissionGroupId
      ? { rememberedWritePaths: appSettings.sandboxAutoWritePaths }
      : {}),
    ...(groupOutputRoots ? { groupOutputRoots } : {}),
    ...(gitHook ? { gitHook: gitHook.facts } : {}),
    ...(gitEntries?.facts ? { gitEntries: gitEntries.facts } : {}),
    ...(hostSsh ? { hostSsh: hostSsh.facts } : {}),
    ...(gitConfiguration ? { gitConfiguration: gitConfiguration.facts } : {}),
    ...(gitConfiguration?.facts.operation === "known-file" && input.tool === "write_file"
      ? { gitConfigurationFile: gitKnownFileAdapter(gitConfiguration, call.id, input.args) }
      : {}),
    ...(gitConfiguration?.facts.operation === "hooks-path" && input.tool === "run_command"
      ? { gitHooksPath: gitHooksPathAdapter(gitConfiguration, call.id, input.args.command, signal) }
      : {}),
    ...(gitConfiguration?.managed
      ? {
          managedGitConfiguration: {
            binding: gitConfiguration.managed.binding,
            verifyCurrent: (
              requirement: import("@pibot/protocol-base").ManagedBranchConfigBinding,
            ) => {
              const handle = gitConfiguration.managed;
              if (!handle) return "changed" as const;
              handle.assertCurrent(requirement);
              return "current" as const;
            },
          },
        }
      : {}),
    ...(!context.groupId &&
    !context.routineRunId &&
    !context.routineWorkplace &&
    !context.executionTaskId &&
    context.conversationId
      ? { workplaceTopicId: context.conversationId }
      : {}),
    botId: context.botId,
    settings,
    permissionSources: runPermissionSources(local, context),
    sensitiveReadRoots,
    ...(botData ? { botData } : {}),
    ...(attachmentsRoot ? { attachmentsRoot } : {}),
    ...(aiBoundary ? { aiConfigReadBoundary: aiBoundary } : {}),
    grants: local.grants(context.botId, context),
    runGrants: context.runGrants,
    conversationWebDomains: local.approvals.webDomains(context),
    taskWebReadAllowed: local.approvals.taskWebAllowed(context),
    workplace: policyWorkplace,
    boundary: workplace.boundary,
    cwd: workplace.cwd,
    ...(workplace.boundary.location?.target !== "local"
      ? {
          realpath: (path: string, current: AbortSignal) =>
            local.targetFor(workplace.boundary.location).realpath(path, current),
          // One runner round trip per path instead of one per directory (relay latency).
          canonicalize: async (path: string, current: AbortSignal) => {
            const result = await local
              .targetFor(workplace.boundary.location)
              .canonicalizePath(path, path, current);
            return { path: result.path, exists: result.device !== null };
          },
          commandProtectionRoots: (current: AbortSignal) => {
            const target = local.targetFor(workplace.boundary.location);
            return target.commandProtectionRoots?.(current) ?? Promise.resolve([]);
          },
        }
      : {}),
    // A remote run reads the execution device's files, where this desktop's skills folder is not a
    // root; passing it would only make policy walk a meaningless path through the runner.
    skillsRoots: remote
      ? undefined
      : local.skills?.roots?.(context.botId, runPermissionScope(local, context)),
    skillsRoot: remote
      ? undefined
      : local.skills?.root(context.botId, runPermissionScope(local, context)),
    ...(outsideProtection ? { protectedWriteRoots: outsideProtection } : {}),
    yolo,
    signal,
  } as const;
  const memoryFacts = memoryWriteFacts(local, context, input);
  const connectorPolicy = capabilityTarget
    ? await policy.evaluate({
        ...policyInput,
        request: capabilityConnectorPolicy(local, capabilityTarget),
      })
    : undefined;
  let result: PolicyResult =
    browserCall && settings.levels.web === "never"
      ? refused("permission_never")
      : capabilityTarget?.capabilityId === "browser" && settings.levels.web === "never"
        ? refused("permission_never")
        : capabilityTarget && connectorPolicy && connectionRuled(capabilityTarget.capabilityId)
          ? connectorPolicy
          : pageAction && !browserUrl
            ? refused("browser_no_page")
            : input.tool === "browser_login" && !login
              ? refused("browser_login_no_account")
              : await policy.evaluate({
                  ...policyInput,
                  request: withPrivateNetwork(
                    local,
                    context,
                    input,
                    browserCall,
                    remote,
                    (projectPath
                      ? { category: "write_file" as const, path: projectPath, projectNotes: true }
                      : undefined) ??
                      (backgroundInput
                        ? {
                            category: "run_command" as const,
                            command: backgroundInput.command,
                            cwd: backgroundInput.cwd,
                            stdin: true as const,
                          }
                        : undefined) ??
                      connector?.request ??
                      (frozenRead
                        ? { category: "review" }
                        : input.tool === "read_messages"
                          ? {
                              category: "read_messages",
                              target:
                                input.args.mode === "search"
                                  ? CHAT_SEARCH_TARGET
                                  : input.args.mode === "messages"
                                    ? input.args.conversationId
                                    : "readable_conversations",
                              scopeValid: !!readScope,
                            }
                          : input.tool === "web_search" && local.deps.search
                            ? local.deps.search.policyRequest(searchRecipient)
                            : submit && input.tool === "browser_open"
                              ? {
                                  category: "web",
                                  url: input.args.url,
                                  submit: true,
                                  localPorts: local.background.ports(context.botId),
                                }
                              : withMainDirect(
                                  local,
                                  context,
                                  input.tool,
                                  policyRequest(
                                    input,
                                    local.deps.capabilityTools,
                                    browserUrl,
                                    login?.site,
                                    // Read at judging time, so a stopped command's port is refused.
                                    local.background.ports(context.botId),
                                    // Installed native converters change whether the call writes a file.
                                    { platform: local.deps.platform, env: local.deps.env },
                                  ),
                                )),
                  ),
                  ...(memoryFacts
                    ? {
                        request: {
                          category: "memory" as const,
                          operation:
                            input.tool === "memory_add"
                              ? ("add" as const)
                              : input.tool === "memory_update"
                                ? ("update" as const)
                                : ("remove" as const),
                          ...memoryFacts,
                        },
                      }
                    : {}),
                });
  if (
    browserCall &&
    !capabilityTarget &&
    result.decision !== "deny" &&
    localBrowserFileUnavailable(
      input.tool === "browser_open" ? input.args.url : browserUrl,
      result,
      workplace.boundary,
      local.deps.platform,
    )
  )
    result = refused("browser_local_file_unavailable");
  // the stricter of the capability's own rule and the connection's rule wins, so a
  // connection's "ask every time" is never skipped by an allowed built-in read.
  const strictness = { allow: 0, ask: 1, deny: 2 } as const;
  // A capability tool whose target is only known at call time (a knowledge search reaching
  // several connections) hands its requests over here. Each is judged as its own connection call,
  // so the connection's confirmation mode, audit and last-used record still apply; the strictest
  // decision covers the call.
  // A capability that judges per call may also return state for its own executor. It stays
  // on this call's prepared data so nothing else can read it and no global map is needed.
  const capability = local.toolPolicies(context, call, input.tool, input.args);
  const capabilityPolicies = (
    await Promise.all(
      capability.requests.map((request) => policy.evaluate({ ...policyInput, request })),
    )
  ).reduce<PolicyResult | undefined>(
    (strictest, next) =>
      !strictest || strictness[next.decision] > strictness[strictest.decision] ? next : strictest,
    undefined,
  );
  if (connectorPolicy && strictness[connectorPolicy.decision] > strictness[result.decision])
    result = connectorPolicy;
  if (capabilityPolicies && strictness[capabilityPolicies.decision] > strictness[result.decision])
    result = capabilityPolicies;
  result = explainRunScope(local, context, result);
  if (projectEdit && result.decision !== "deny") {
    if (result.path?.path !== projectPath || !result.path?.root)
      result = refused("outside_workplace_write_denied");
    else
      result.facts.push({
        kind: "write",
        value: boundFileDiff(local.deps.redactor.redact(projectEdit.diff)),
      });
  }
  if (
    !frozenRead &&
    (input.tool === "search_text" ||
      input.tool === "code_navigate" ||
      input.tool === "code_outline" ||
      input.tool === "code_symbols" ||
      input.tool === "code_map" ||
      input.tool === "review_start")
  )
    result = await searchRootPolicyResult(local, result, policyInput, signal);
  let docker: PreparedTool["docker"];
  if (input.tool === "run_command") {
    const requested = input.args.docker === true;
    const detected = result.analysis?.programs.some((program) =>
      /(?:^|[/\\])docker(?:-compose)?(?:\.exe)?$/i.test(program),
    );
    if (requested || detected) {
      const runtime = settings.dockerRuntime ?? "disabled";
      let reason: string | undefined;
      if (runtime === "disabled") reason = "docker_permission_required";
      else if (!requested) reason = "docker_explicit_required";
      else if (input.args.background || context.routineRunId) reason = "docker_unsupported";
      // An outside-write card opens one folder in Pi Bot's own sandbox; the Docker channel has
      // none to open.
      else if (result.outsideWriteRoots?.length) reason = "docker_unsupported";
      else if (!settings.network.allowAll) reason = "docker_network_unsupported";
      else if (
        local.deps.platform === "darwin" &&
        !(await local.target.isolationStatus(signal)).available
      )
        reason = "docker_unsupported";
      else if (result.decision !== "deny") {
        try {
          dockerArguments(input.args.command, local.deps.platform);
        } catch {
          reason = "docker_command_invalid";
        }
        if (!reason) {
          try {
            docker = await resolveDockerConnection(
              local.deps.platform,
              local.deps.userHome,
              runtime,
            );
          } catch (error) {
            reason =
              error instanceof ExecError && error.code === "docker_unsupported"
                ? "docker_unsupported"
                : "docker_endpoint_unavailable";
          }
        }
      }
      // Never weaken an existing hard deny (e.g. a never-level or invalid workspace).
      if (result.decision !== "deny") {
        // Explicit Docker selection does not make an opaque native Windows command safe
        // for automatic release. Keep the Docker consent and its dedicated dispatch checks.
        result.decision = reason ? "deny" : "ask";
        result.reason = reason ?? "docker_access";
        recordPolicyStep(result, "boundary", reason ?? "docker_access");
        result.canRemember = false;
        delete result.grantScope;
        if (docker) {
          result.risk = "danger";
          result.facts.push(
            { kind: "warning", value: "docker_access", risk: "danger" },
            { kind: "network", value: `${docker.runtime}: ${docker.endpoint}` },
            ...(local.deps.platform !== "darwin"
              ? [{ kind: "warning" as const, value: "docker_unisolated", risk: "danger" as const }]
              : []),
          );
        }
      }
    }
  }
  // A site the user already allowed in this run is not asked again for every page action.
  // A submission is its own question; an allowed visit does not answer it.
  if (isBrowserTool(input.tool) && !capabilityTarget && !submit)
    local.browser.forContext(context).allowApprovedSite(context, result);
  if (login) adjustLogin(local, context, { login, call }, result);
  // A background start that cannot happen is refused before anyone is asked to approve it.
  const backgroundRefusal =
    input.tool === "run_command" && input.args.background
      ? local.background.refusal(context)
      : undefined;
  if (backgroundRefusal && result.decision !== "deny") {
    result.decision = "deny";
    result.reason = backgroundRefusal;
    recordPolicyStep(result, "boundary", backgroundRefusal);
    result.canRemember = false;
    delete result.grantScope;
  }
  const sendPaths: string[] = [];
  if (input.tool === "send_file") {
    const results = [result];
    for (const path of input.args.paths.slice(1))
      results.push(
        await policy.evaluate({
          botId: context.botId,
          request: { category: "read_file", path },
          settings,
          permissionSources: runPermissionSources(local, context),
          sensitiveReadRoots,
          ...(botData ? { botData } : {}),
          grants: local.grants(context.botId, context),
          runGrants: context.runGrants,
          workplace: policyWorkplace,
          boundary: workplace.boundary,
          cwd: workplace.cwd,
          yolo,
          signal,
        }),
      );
    for (const item of results) {
      if (!item.path?.root || !item.path.exists || item.decision === "deny") {
        // The first item is result itself; capture its reason before changing the shared decision.
        const reason = item.decision === "deny" ? item.reason : "outside_workplace_send_denied";
        result.decision = "deny";
        result.reason = reason;
        recordPolicyStep(result, "boundary", reason);
      } else sendPaths.push(item.path.path);
    }
    if (result.decision !== "deny" && results.some((item) => item.decision === "ask"))
      result.decision = "ask";
    recordPolicyStep(result, "boundary", "batch_file_consent");
    result.facts = results.flatMap((item) => item.facts);
    // A single remembered folder grant must never cover a multi-root batch.
    result.canRemember = false;
    delete result.grantScope;
  }
  if (input.tool === "reveal_in_folder" && result.decision !== "deny") {
    // Unlike read_file, nothing outside the run's readable folders is offered for approval:
    // the host re-checks the canonical path against this root, so a link cannot lead it outside.
    // Without a desktop the call is refused here rather than after an approval card.
    const reason =
      (!local.deps.host.revealPath
        ? "reveal_unsupported"
        : !result.path?.root || !result.path.exists
          ? "outside_workplace_reveal_denied"
          : undefined) ?? revealIntentReason(local, context);
    if (reason) {
      result.decision = reason === REVEAL_CONFIRMATION_REASON ? "ask" : "deny";
      if (reason === REVEAL_CONFIRMATION_REASON) result.risk = "normal";
      result.reason = reason;
      recordPolicyStep(result, "boundary", reason);
      result.canRemember = false;
      delete result.grantScope;
    }
  }
  let cwd = backgroundInput?.cwd ?? result.cwd ?? workplace.cwd;
  const commandPlatform = workplace.boundary.location?.platform ?? local.deps.platform;
  if (input.tool === "run_command" && commandPlatform === "win32") {
    if (input.args.cwd) {
      const requested = expandHome(input.args.cwd, workplace.home);
      const cwdSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      // Windows skips shell path analysis; resolve its cwd on the execution device, not the host.
      cwd = await abortable(
        remote
          ? local
              .targetFor(workplace.boundary.location)
              .canonicalizePath(requested, workplace.cwd, cwdSignal)
              .then((path) => path.path)
          : canonicalPath(requested, workplace.cwd),
        cwdSignal,
      );
    }
    if (
      result.decision !== "deny" &&
      remote &&
      !workplace.boundary.writeRoots.some((root) => containsPath(root, cwd, commandPlatform))
    ) {
      result.decision = "deny";
      result.reason = "outside_workplace_write_denied";
      result.canRemember = false;
      delete result.grantScope;
      recordPolicyStep(result, "boundary", result.reason);
    }
    result.cwd = cwd;
    result.facts.push({ kind: "cwd", value: cwd });
  }
  signal.throwIfAborted();
  if (authorizationSnapshot(local, context.botId, context) !== authorization) {
    result.decision = "deny";
    result.reason = "changed";
    recordPolicyStep(result, "boundary", "changed");
    result.canRemember = false;
  }
  if (
    backgroundInput &&
    backgroundInput.scope !== backgroundInputScope({ settings, cwd, boundary: workplace.boundary })
  ) {
    result.decision = "deny";
    result.reason = "changed";
    recordPolicyStep(result, "boundary", "changed");
    result.canRemember = false;
  }
  if (historyRead && (!readScope || currentReadScope() !== readScope)) {
    result.decision = "deny";
    result.reason = "message_scope_unavailable";
    recordPolicyStep(result, "boundary", "message_scope_unavailable");
    result.canRemember = false;
  }
  // Derived gates (Docker, login and batch paths) must obey the same final policy transform.
  // Input ambiguities are denied below, so YOLO never chooses an identity on the user's behalf.
  const capabilityConnector =
    capabilityTarget && result.decision !== "deny"
      ? prepareCapabilityConnector(local, context, input, capabilityTarget, result)
      : undefined;
  const secretUses =
    input.tool === "run_command" && result.decision !== "deny"
      ? local.userSecrets.command(input.args.command, context.botId)
      : (capabilityConnector?.prepared.secretUses ?? connector?.prepared?.secretUses ?? []);
  if (docker && secretUses.length) result = refused("docker_secret_unsupported");
  const writeOut = secretWriteOutDenied(
    input.tool,
    local.deps.redactor.contains(toolSecretContent(input.tool, input.args, local.toolDefinitions)),
  );
  const browserSecretUses =
    result.decision === "deny"
      ? []
      : await prepareBrowserSecrets(
          local,
          context,
          input,
          signal,
          workplace.boundary.location?.target,
        );
  // Controlled recipes dispatch through their own adapters and cannot consume an arbitrary env.
  if (
    browserSecretUses.length &&
    input.tool === "run_command" &&
    (gitConfiguration || gitHook || gitEntries?.plan || hostSsh)
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "secret_handle_refused");
  const finalResult = browserSecretPolicy(
    writeOut
      ? explainPolicyResult(
          { ...writeOut, explanation: [...result.explanation, ...writeOut.explanation] },
          "secret",
          "secret_write_out",
        )
      : secretCommandPolicy(
          local,
          context,
          applyYolo(result, yolo),
          secretUses,
          yolo,
          input.tool === "run_command" ? "command" : "connector_config",
        ),
    browserSecretUses.length,
  );
  return {
    ...(projectChange ? { projectNotesWrite: { expectedHash: projectChange.expectedHash } } : {}),
    ...(browserSecretUses.length ? { browserSecretUses } : {}),
    ...(gitConfiguration ? { gitConfiguration } : {}),
    ...(gitHook ? { gitHook } : {}),
    ...(gitEntries ? { gitEntries } : {}),
    ...(hostSsh ? { hostSsh } : {}),
    ...(capability.prepared === undefined ? {} : { capabilityPolicyData: capability.prepared }),
    ...(memoryFacts ? { memorySafety: memorySafetySnapshot(memoryFacts) } : {}),
    ...(secretUses.length ? { secretUses } : {}),
    ...(connector?.prepared ? { connector: connector.prepared, connectorPolicy: result } : {}),
    ...(capabilityConnector
      ? {
          connector: capabilityConnector.prepared,
          capabilityConnector: {
            capabilityId: capabilityConnector.capabilityId,
            input: capabilityConnector.input,
          },
          ...(connectorPolicy ? { connectorPolicy } : {}),
        }
      : {}),
    ...(docker ? { docker } : {}),
    ...(login ? { login } : {}),
    ...(historyRead ? { messageScope: readScope } : {}),
    ...(input.tool === "web_search" ? { searchRecipient } : {}),
    ...(input.tool === "send_file" ? { sendPaths } : {}),
    ...(sensitiveReadRoots ? { sensitiveReadRoots } : {}),
    call,
    result: finalResult,
    settings,
    roots: workplace.roots,
    cwd,
    home: workplace.home,
    authorization,
    boundary: workplace.boundary,
  };
}

/**
 * Login card rules: several accounts on one site always need the user's pick (no remembered
 * grant or routine preauthorization can choose for them), and a site already allowed in this
 * run (two-step logins) is not asked again.
 */
function adjustLogin(
  local: LocalService,
  context: ToolRunContext,
  prepared: Pick<PreparedTool, "login" | "call">,
  result: PolicyResult,
) {
  const login = prepared.login as NonNullable<PreparedTool["login"]>;
  if (result.decision === "deny") return;
  if (local.credentials.approvedInRun(context.runId, login.site)) {
    result.decision = "allow";
    result.reason = "browser_login_run_approved";
    recordPolicyStep(result, "boundary", "browser_login_run_approved");
  } else if (loginNeedsChoice(prepared)) {
    result.decision = runYolo(local, context) ? "deny" : "ask";
    result.reason = "browser_login_choose";
    recordPolicyStep(result, "boundary", "browser_login_choose");
    result.canRemember = false;
    delete result.grantScope;
  }
}

export function groupAuthorization(local: LocalService, context: ToolRunContext): string {
  if (!context.groupId) return "";
  const group =
    local.collaboration?.workplaceGroup?.(context) ??
    new GroupsRepo(local.deps.db).get(context.groupId);
  const actual = context.conversationId
    ? new ConversationsRepo(local.deps.db).get(context.conversationId)
    : undefined;
  const task = context.threadId
    ? new GroupTasksRepo(local.deps.db, (t) => local.deps.redactor.redact(t)).forThread(
        context.threadId,
      )
    : undefined;
  // Plan runs retain their program-frozen folder selection; membership and permissions stay live.
  const owner = group?.coordinatorBotId;
  return JSON.stringify([
    context.botId,
    context.runId,
    context.messageId,
    context.conversationId,
    context.groupId,
    context.threadId,
    group
      ? {
          ...group,
          paused: undefined,
          updatedAt: undefined,
          topicTitle: undefined,
          memberWorkspaces: undefined,
          // Cosmetic settings (GroupService's COSMETIC_GROUP_FIELDS) change no authority; a
          // rename mid-step otherwise failed every later tool call and killed the running step.
          name: undefined,
          announcement: undefined,
          autoRoundLimit: undefined,
          externalAgentStepContext: undefined,
        }
      : null,
    actual?.kind,
    actual?.groupId,
    actual?.threadOf,
    task ? [task.id, task.assigneeBotId] : null,
    owner ? local.workplaces.repo.home(owner) : null,
  ]);
}
// Position of the Bot's remembered grants in `authorizationSnapshot` (see approvedUnchanged).
const GRANTS_AT = 6;

/**
 * Whether a tool re-prepared after its approval card is still the call the user approved. The
 * one authorization change the card itself makes is the grant "don't ask again" just stored, so
 * grants may only have been added; any other change (levels, workplaces, a revoked grant, a
 * different path or command) still counts as changed.
 */
export function approvedUnchanged(current: PreparedTool, original: PreparedTool, approved: string) {
  if (toolFingerprint(current) === approved) return true;
  if (toolFingerprint(current, original.authorization) !== approved) return false;
  return authorizationUnchanged(original.authorization, current.authorization);
}

/**
 * Two `authorizationSnapshot` values describe the same authorization except for grants added
 * since (the "don't ask again" a card just stored). Exported for gates that keep their own
 * snapshot, like image generation.
 */
export function authorizationUnchanged(original: string, current: string) {
  if (original === current) return true;
  const before = JSON.parse(original) as unknown[];
  const after = JSON.parse(current) as unknown[];
  if (before.length !== after.length) return false;
  return before.every((value, index) => {
    if (index !== GRANTS_AT) return JSON.stringify(value) === JSON.stringify(after[index]);
    const now = new Set((after[index] as unknown[]).map((grant) => JSON.stringify(grant)));
    return (value as unknown[]).every((grant) => now.has(JSON.stringify(grant)));
  });
}

export function authorizationSnapshot(
  local: LocalService,
  botId: string,
  context?: ToolRunContext,
  searchSnapshot = local.deps.search?.snapshot(),
): string {
  return JSON.stringify([
    context ? groupAuthorization(local, context) : "",
    new BotsRepo(local.deps.db).get(botId)?.archivedAt ?? null,
    new BotsRepo(local.deps.db).get(botId)?.memoryMode ?? "auto",
    searchSnapshot,
    withoutPiLevels(
      context
        ? local.tasks.settings(context, runPermissions(local, context))
        : local.permissions.effective(botId),
    ),
    workplaceAuthorization(local, botId, context),
    local.grants(botId, context),
    // Package assignment changes invalidate prepared local calls; roots never become grants.
    local.skills?.packageIds?.(botId, context ? runPermissionScope(local, context) : undefined) ??
      [],
    ...(context ? topicAuthorization(local, context) : []),
    // Scope liveness, not whether consent was just granted: the first allowed call stays valid.
    ...(context?.groupId || context?.executionTaskId
      ? [local.approvals.taskWebIdentity(context) ?? null]
      : []),
  ]);
}

/**
 * The folders this conversation works in. The Bot's whole registry is not part of it, so
 * another topic picking a new folder does not void this one's approvals. Folder IDs are enough:
 * a registered folder's path never changes, and the run snapshot rechecks the real directories.
 */
function workplaceAuthorization(local: LocalService, botId: string, context?: ToolRunContext) {
  // Group folders are part of groupAuthorization (the group record carries them).
  if (context?.groupId) return null;
  if (context && (context.routineRunId || context.routineWorkplace))
    return routineSelection(local, context).selection;
  const topic = context?.conversationId
    ? new ConversationsRepo(local.deps.db).get(context.conversationId)
    : undefined;
  return topic?.kind === "dm"
    ? local.workplaces.topic(topic.id)
    : { selection: local.workplaces.initial(botId) };
}

function topicAuthorization(local: LocalService, context: ToolRunContext) {
  const snapshot = topicWorkplaceSnapshot(local, context);
  // Leave untouched legacy topics compatible; a bind/unbind revision still invalidates old consent.
  return snapshot && (snapshot.folderId !== null || snapshot.revision > 0) ? [snapshot] : [];
}

/**
 * The default Pi's tools carry the kernel's own answer to "is this Pi's direct chat, typed by the
 * person here"; the capability's constant request cannot set it, so policy refuses without it.
 */
function withMainDirect(
  local: LocalService,
  context: ToolRunContext,
  tool: string,
  request: PolicyRequest,
): PolicyRequest {
  if (!local.deps.capabilityTools.specs[tool]?.mainBotOnly) return request;
  if (request.category !== "bot_management" && request.category !== "work_dispatch")
    throw new Error("Main-only tool without a Pi manager category");
  return { ...request, mainDirect: mainDirectRun(local, context) };
}

/**
 * The default Pi's two levels stay out of the "did authorization change while the card was open"
 * snapshot: the card's own "don't ask again" sets one of them, which must not void the very call
 * it approved. A level lowered to never is still caught: policy judges the call again on allow.
 */
function withoutPiLevels<T>(settings: T): T {
  if (!settings || typeof settings !== "object" || !("levels" in settings)) return settings;
  const {
    bot_management: _manage,
    work_dispatch: _dispatch,
    ...levels
  } = (settings as { levels: Record<string, unknown> }).levels;
  return { ...settings, levels } as T;
}
