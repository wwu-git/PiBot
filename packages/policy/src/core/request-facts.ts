import { deny } from "./deny.ts";

export { deny } from "./deny.ts";

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  type ApprovalFact,
  DomainSchema,
  type GrantScope,
  localServiceTarget,
  type PermissionsSettings,
} from "@pibot/protocol-base";
import { dangerousReasons } from "../commands/dangerous.ts";
import { curlFollowsRedirects } from "../commands/options/curl-options.ts";
import type { ScriptInputs, ScriptSource } from "../commands/scripts.ts";
import { isAiConfigPath } from "../paths/ai-config-paths.ts";
import { canonicalPath, containsPath, expandHome, pathApi, resolvePath } from "../paths/paths.ts";
import { privateNetworkOrigin } from "../targets/private-network.ts";
import { website } from "../targets/web.ts";
import { commandPathScope, isWritableCommandPath } from "./command-path-risk.ts";
import {
  WINDOWS_ORDINARY_COMMAND,
  WINDOWS_READ_ONLY,
  WINDOWS_REQUIRES_APPROVAL,
} from "./confirmation-reasons.ts";
import { createPolicyTrace, type PolicyTrace } from "./explain.ts";
import { finish } from "./finish.ts";
import {
  prepareGitConfigurationFacts,
  selectedGitConfiguration,
  unsupportedGitConfigurationTarget,
} from "./git-configuration-policy.ts";
import { prepareGitHookFacts } from "./git-hook-policy.ts";
import { prepareGitHooksPathFacts } from "./git-hooks-path-policy.ts";
import { gitInlineExecutableUse } from "./git-inline-execution.ts";
import { prepareGitKnownFileFacts } from "./git-known-file-policy.ts";
import { prepareHostSshPolicy } from "./host-ssh-policy.ts";
import { judgeOutsideWrites } from "./outside-write.ts";
import { scriptPreauthScope } from "./script-consent.ts";
import type { CommandAnalysis, EvaluationInput, PathContext, PolicyResult } from "./types.ts";
import { proveWindowsReadOnly } from "./windows-command-approval.ts";
import { prepareWindowsCommandScan } from "./windows-command-scan.ts";

export interface RequestFacts {
  gitHook?: true;
  hostSsh?: true;
  gitConfiguration?: "project" | "global" | "hooks-path" | "sensitive-project";
  result: PolicyResult;
  scope?: GrantScope;
  incomplete: boolean;
  outside?: boolean;
  /** A read or listing inside the Bot's own skills folder (`EvaluationInput.skillsRoot`). */
  skill?: boolean;
  /** A read inside the Bot's own attachments folder (`EvaluationInput.attachmentsRoot`). */
  attachment?: boolean;
  /** A loopback URL on a port the Bot's own background command listens on. */
  localService?: boolean;
  /** A Bot-browser request to a local-network origin; `approved` when this run's user allowed it. */
  privateNetwork?: { approved: boolean };
  /** The exact read script a routine may pre-authorize although its analysis is incomplete. */
  scriptScope?: GrantScope;
}
export async function prepareRequestFacts(
  input: EvaluationInput,
  context: PathContext,
  analyze: (command: string, inputs?: ScriptInputs) => CommandAnalysis,
  trace: PolicyTrace,
): Promise<RequestFacts> {
  const result: PolicyResult = {
    decision: "ask",
    reason: "permission_ask",
    risk: "normal",
    facts: [],
    canRemember: false,
    explanation: trace.steps,
  };
  const request = input.request;
  if (
    input.gitHook &&
    (input.gitHook.status === "unsupported" ||
      (context.platform !== "darwin" && context.platform !== "linux") ||
      input.boundary?.location?.target !== "local")
  ) {
    const hook = await prepareGitHookFacts(input, context, result, analyze, trace);
    if (hook) return hook;
  }
  if (
    input.hostSsh &&
    (context.platform !== "darwin" || input.boundary?.location?.target !== "local")
  ) {
    const controlled = prepareHostSshPolicy(input, context, result, analyze, trace);
    if (controlled) return controlled;
  }
  if (selectedGitConfiguration(input) && unsupportedGitConfigurationTarget(input, context)) {
    const controlled = await prepareGitConfigurationFacts(input, context, result, analyze, trace);
    if (controlled) return controlled;
  }
  if (request.category === "run_command" && !selectedGitConfiguration(input)) {
    const external = input.boundary?.location && input.boundary.location.target !== "local";
    const usesHome =
      /(?:^|[\s"'=<>;|&(])~|\$(?:HOME\b|\{HOME\}|env:(?:HOME|USERPROFILE)\b)|%USERPROFILE%/i.test(
        request.command,
      );
    // Runner overrides HOME and editor terminals own their environment. A project root is not
    // evidence of either value, so do not issue a card claiming that it is their command home.
    if (
      external &&
      (usesHome ||
        request.cwd?.startsWith("~") ||
        request.writePaths?.some((p) => p.startsWith("~")))
    )
      return { result: deny(result, "command_home_unavailable", trace), incomplete: true };
    if (!external) result.commandHome = context.home;
    if (usesHome) result.facts.push({ kind: "warning", value: `command_home:${context.home}` });
  }
  if (request.category === "send_out") {
    result.facts = [{ kind: "write", value: request.target }];
    return {
      result,
      incomplete: false,
      ...(request.identity === "bot" && request.rememberable
        ? {
            scope: {
              kind: "send_target" as const,
              connectorId: request.connectorId,
              tool: request.tool,
              target: request.target,
              definitionDigest: request.definitionDigest,
              targetDigest: request.targetDigest,
            },
          }
        : {}),
    };
  }
  if (request.category === "connector") {
    if (!request.visible)
      return {
        result: deny(result, "connector_unavailable", trace, "connector"),
        incomplete: false,
      };
    if (request.operation === "call" && (!request.connectorId || !request.tool))
      return {
        result: deny(result, "connector_tool_denied", trace, "connector"),
        incomplete: false,
      };
    if (request.operation === "call" && request.connectorId)
      result.facts.push({ kind: "read", value: request.connectorId });
    if (request.operation === "call" && request.tool)
      result.facts.push({ kind: "read", value: request.tool });
    return {
      result,
      incomplete: false,
      ...(request.operation === "call" && request.connectorId
        ? { scope: { kind: "connector" as const, connectorId: request.connectorId } }
        : {}),
    };
  }
  if (request.category === "read_messages") {
    if (!request.scopeValid)
      return { result: deny(result, "message_scope_unavailable", trace), incomplete: false };
    result.facts.push({ kind: "read", value: request.target });
    return { result, incomplete: false };
  }
  if (request.category === "image_generation")
    return imageRecipientFacts(request.recipient, input.settings, result, trace);
  if (request.category === "web") {
    const local = localServiceTarget(request.url);
    if (local && !request.search && request.localPorts?.includes(local.port)) {
      result.url = new URL(request.url).href;
      result.facts.push({ kind: "network", value: result.url });
      return { result, incomplete: false, localService: true };
    }
    // Maintainers 2026-11-14: the Bot browser may open the user's own network (a router page) once the
    // user allows that origin for this task; web_fetch and search keep the plain local ban.
    const origin =
      request.privateNetwork && !request.search && !request.fetch
        ? privateNetworkOrigin(request.url)
        : undefined;
    if (origin) {
      result.url = new URL(request.url).href;
      result.facts.push({ kind: "network", value: origin });
      result.privateTargets = [origin];
      trace.step("boundary", "private_network_address", "info");
      return {
        result,
        incomplete: false,
        privateNetwork: { approved: request.privateNetwork?.approved.includes(origin) === true },
      };
    }
    return websiteFacts(request.url, input.settings, result, trace, request.search);
  }
  if (request.category === "run_command" && context.platform === "win32") {
    context.signal.throwIfAborted();
    const runner = input.boundary?.location?.target.startsWith("runner:") === true;
    let extra: readonly string[] | undefined;
    if (runner) {
      try {
        extra = await input.commandProtectionRoots?.(context.signal);
      } catch {
        // Missing/older/offline runner metadata must never turn an unknown risk into normal.
        context.signal.throwIfAborted();
      }
    } else {
      extra = await input.protectedWriteRoots?.(context.signal);
    }
    context.signal.throwIfAborted();
    const scope = commandPathScope(input);
    const cwd =
      request.cwd ??
      input.cwd ??
      (input.workplace.currentId === "home"
        ? input.workplace.home
        : input.workplace.folders.find((folder) => folder.id === input.workplace.currentId)?.path);
    const protectedRoots = [...(extra ?? []), ...(input.sensitiveReadRoots ?? [])];
    // The Bot's own folder on this computer is its normal workspace even though it sits in the
    // data directory; a runner or editor terminal keeps the whole protection.
    const ownRoots =
      !runner &&
      !input.boundary?.location?.target.startsWith("acp:") &&
      scope.writeRoots.some((root) => containsPath(root, input.workplace.home, "win32"))
        ? await ownWorkRoots(input.workplace.home, context)
        : [];
    const scan = await prepareWindowsCommandScan(request.command, {
      protectedRoots,
      ownRoots,
      scope,
      cwd,
      writePaths: request.writePaths,
      context: runner && !extra?.length ? undefined : context,
    });
    result.command = request.command;
    result.facts.push({ kind: "warning", value: "windows_unisolated" });
    if (scan.fragments.length) {
      result.risk = "danger";
      result.facts.push(
        ...scan.fragments.map(
          (value): ApprovalFact => ({ kind: "warning", value, risk: "danger" }),
        ),
      );
      trace.step("danger", "windows_command_scan", "info");
    }
    if (scan.privilegeEscalation)
      return { result: deny(result, "privilege_escalation_denied", trace), incomplete: true };
    if (runner && !extra?.length)
      return {
        result: deny(result, "runner_command_protection_unavailable", trace),
        incomplete: true,
      };
    const readOnly = scan.fragments.length
      ? undefined
      : await proveWindowsReadOnly(
          { ...input, request },
          context,
          cwd,
          { roots: protectedRoots, own: ownRoots },
          async (file) => {
            const fileTrace = createPolicyTrace();
            const fileInput = { ...input, request: file };
            const facts = await prepareRequestFacts(fileInput, { ...context }, analyze, fileTrace);
            finish(
              fileInput,
              { platform: "win32", userHome: context.protectionHome ?? context.home },
              facts,
              fileTrace,
            );
            return facts;
          },
        );
    if (readOnly) {
      result.reason = WINDOWS_READ_ONLY;
      result.facts.push(...readOnly);
      return { result, incomplete: false };
    }
    const ordinary =
      !scan.needsConfirmation &&
      !scan.fragments.length &&
      !request.stdin &&
      !request.outsideSandbox &&
      !input.boundary?.location?.target.startsWith("acp:");
    result.reason = ordinary ? WINDOWS_ORDINARY_COMMAND : WINDOWS_REQUIRES_APPROVAL;
    if (ordinary) result.facts.push(...scan.facts);
    return { result, incomplete: true };
  }
  if (!("path" in request) && request.category !== "run_command")
    return { result: deny(result, "category_unavailable", trace, "category"), incomplete: false };
  const workplace = input.workplace;
  context.roots = await Promise.all(
    [workplace.home, ...workplace.folders.map((folder) => folder.path)].map(
      async (root) => (await canonicalPath(root, context)).path,
    ),
  );
  if (input.boundary) context.roots = input.boundary.readRoots;
  trace.step("boundary", input.boundary ? "workspace_snapshot" : "workplace_roots", "info");
  const current =
    workplace.currentId === "home"
      ? workplace.home
      : workplace.folders.find((folder) => folder.id === workplace.currentId)?.path;
  if (!current) return { result: deny(result, "invalid_workplace", trace), incomplete: false };
  context.cwd = (await canonicalPath(current, context)).path;
  if (input.cwd) context.cwd = (await canonicalPath(input.cwd, context)).path;
  if (request.category === "write_file" && selectedGitConfiguration(input))
    return prepareGitKnownFileFacts(input, context, result, trace);
  if (request.category === "run_command") {
    if (request.cwd) context.cwd = (await canonicalPath(request.cwd, context)).path;
    const hook = await prepareGitHookFacts(input, context, result, analyze, trace);
    if (hook) return hook;
    const ssh = prepareHostSshPolicy(input, context, result, analyze, trace);
    if (ssh) return ssh;
    if (input.gitConfiguration?.operation === "hooks-path")
      return prepareGitHooksPathFacts(input, context, result, analyze, trace);
    const controlled = await prepareGitConfigurationFacts(input, context, result, analyze, trace);
    if (controlled) return controlled;
    const facts = await commandFacts(request, input, context, result, analyze, trace);
    // An earlier refusal (protected path, privilege escalation) keeps its own reason.
    if (input.boundary && result.decision !== "deny") {
      const boundary = input.boundary;
      const outside = new Set(result.outsideWrites);
      const blocked = (path: string) =>
        boundary.denyWriteRoots.some(
          (r) => containsPath(r, path, context.platform) || containsPath(path, r, context.platform),
        ) ||
        (!outside.has(path) &&
          !boundary.writeRoots.some((r) => containsPath(r, path, context.platform)));
      if (result.analysis?.writes.some(blocked) || boundary.writeRoots.length === 0)
        deny(result, "readonly_workplace", trace);
    }
    return facts;
  }
  const path = await resolvePath(request.path, context);
  result.path = path;
  trace.step("boundary", path.root ? "inside_workplace" : "outside_workplace", "info");
  if (request.category !== "write_file") {
    const lexical = pathApi(context.platform).resolve(
      context.cwd,
      expandHome(request.path, context.home),
    );
    // This Bot's own attachments folder is app-written data the message itself names. The
    // read is the request being carried out, so it is checked before the data-directory boundary
    // that keeps other Bots' folders closed (and before office tools, which have no read_file
    // exemption there); it can never write, because the branch excludes write_file.
    if (input.attachmentsRoot) {
      const attachments = (await canonicalPath(input.attachmentsRoot, context)).path;
      if (
        containsPath(attachments, path.path, context.platform) ||
        containsPath(attachments, lexical, context.platform)
      ) {
        result.facts.push({ kind: "read", value: path.path });
        return { result, incomplete: false, attachment: true };
      }
    }
    if (
      input.aiConfigReadBoundary &&
      (request.category === "read_file" || request.category === "list_dir") &&
      (isAiConfigPath(path.path, input.aiConfigReadBoundary, context) ||
        isAiConfigPath(lexical, input.aiConfigReadBoundary, context))
    ) {
      result.category = "read_ai_config";
      trace.step("category", "read_ai_config", "info");
    }
    const sensitive = input.sensitiveReadRoots?.find(
      (root) =>
        containsPath(root, path.path, context.platform) ||
        containsPath(root, lexical, context.platform),
    );
    if (sensitive)
      // ~/.ssh stays closed, but the model is told the safe way in: the host SSH recipe.
      return {
        result: deny(
          result,
          /[\\/]\.ssh$/.test(sensitive) ? "ssh_config_private" : "sensitive_path",
          trace,
        ),
        incomplete: false,
      };
    const botData = input.botData;
    if (botData) {
      const within = (root: string) =>
        containsPath(root, path.path, context.platform) ||
        containsPath(root, lexical, context.platform);
      const roots = (
        await Promise.all(
          botData.roots.map(async (root) => (await canonicalPath(root, context)).path),
        )
      ).filter((root) => root);
      const allowed = (
        await Promise.all(
          botData.allowed.map(async (root) => (await canonicalPath(root, context)).path),
        )
      ).filter((root) => root);
      // The current Bot's own folder and its group stay readable; everything else in the data
      // directory belongs to other Bots and is refused without offering a remembered grant.
      if (roots.some(within) && !allowed.some(within))
        return { result: deny(result, "sensitive_path", trace), incomplete: false };
    }
  }
  result.facts.push({
    kind: request.category === "write_file" ? "write" : "read",
    value: path.path,
  });
  if (result.category === "read_ai_config") return { result, incomplete: false };
  if (request.category !== "write_file") {
    for (const root of input.skillsRoots ?? (input.skillsRoot ? [input.skillsRoot] : [])) {
      const skills = (await canonicalPath(root, context)).path;
      if (containsPath(skills, path.path, context.platform))
        return { result, incomplete: false, skill: true };
    }
  }
  if (request.category === "write_file" && !path.root) {
    const refused = await judgeOutsideWrites([path], "file", input, context, result);
    if (refused) deny(result, refused, trace);
  }
  if (
    request.category === "write_file" &&
    input.boundary &&
    result.decision !== "deny" &&
    ((path.root &&
      !input.boundary.writeRoots.some((r) => containsPath(r, path.path, context.platform))) ||
      input.boundary.denyWriteRoots.some((r) => containsPath(r, path.path, context.platform)))
  )
    deny(result, "readonly_workplace", trace);
  // An outside write is allowed once and never becomes a reusable folder grant.
  if (request.category === "write_file" && !path.root)
    return { result, incomplete: false, outside: true };
  const scope: GrantScope =
    request.category === "write_file" && path.root
      ? {
          kind: "workplace",
          root: path.root,
          ...(input.workplaceTopicId ? { topicId: input.workplaceTopicId } : {}),
        }
      : {
          kind: "folder",
          path:
            request.category === "list_dir"
              ? path.path
              : pathApi(context.platform).dirname(path.path),
        };
  return { result, scope, incomplete: false, outside: !path.root };
}
function imageRecipientFacts(
  recipient: string,
  settings: PermissionsSettings,
  result: PolicyResult,
  trace: PolicyTrace,
): RequestFacts {
  // This is the model's configured service host, not model output or a URL to fetch.
  // Explicitly configured local gateways are valid; ordinary web's LAN prohibition
  // does not apply, but the same effective network allowlist and web ceiling do.
  const page = website(`https://${recipient}/`, trace);
  if (page.host !== recipient.toLowerCase().replace(/^\[|\]$/g, ""))
    return { result: deny(result, "invalid_image_recipient", trace), incomplete: false };
  const parsed = new URL(page.url);
  if (parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash)
    return { result: deny(result, "invalid_image_recipient", trace), incomplete: false };
  trace.step("boundary", "configured_image_service", "info");
  const domain = DomainSchema.safeParse(page.host);
  if (domain.success) result.domain = domain.data;
  result.facts.push({ kind: "network", value: page.host });
  if (!settings.network.allowAll && !settings.network.domains.includes(page.host))
    deny(result, "domain_not_allowed", trace);
  // No grant scope: a paid request never inherits a remembered general web grant for the same
  // service, and `finish` asks before every generation.
  return { result, incomplete: false };
}
// An allow-list entry also covers its subdomains, the same rule the Bot browser host
// applies; other sites a page pulls in (CDNs) still need their own entry.
function allowedDomain(domain: string, settings: PermissionsSettings) {
  return settings.network.domains.some(
    (entry) => domain === entry || (isIP(entry) === 0 && domain.endsWith(`.${entry}`)),
  );
}
function websiteFacts(
  url: string,
  settings: PermissionsSettings,
  result: PolicyResult,
  trace: PolicyTrace,
  search?: { disclosed: boolean; configuredEndpoint?: string },
): RequestFacts {
  const page = website(url, trace);
  const selectedSearch =
    search?.configuredEndpoint !== undefined &&
    new URL(search.configuredEndpoint).href === page.url;
  if (selectedSearch) trace.step("boundary", "configured_search_endpoint", "info");
  const domain = selectedSearch ? page.host : page.domain;
  result.url = page.url;
  if (page.domain) result.domain = page.domain;
  result.facts.push({ kind: "network", value: page.url });
  if (page.denied && !selectedSearch) deny(result, "local_network_denied", trace);
  else if (!settings.network.allowAll && (!domain || !allowedDomain(domain, settings)))
    deny(result, "domain_not_allowed", trace);
  return {
    result,
    incomplete: false,
    ...(page.domain ? { scope: { kind: "domain", domain: page.domain } as const } : {}),
  };
}
async function commandFacts(
  request: Extract<EvaluationInput["request"], { category: "run_command" }>,
  input: EvaluationInput,
  context: PathContext,
  result: PolicyResult,
  analyze: (command: string, inputs?: ScriptInputs) => CommandAnalysis,
  trace: PolicyTrace,
): Promise<RequestFacts> {
  const { command } = request;
  const settings = input.settings;
  result.cwd = context.cwd;
  result.command = command;
  let analysis = analyze(command);
  // A script run is judged by its text, read here (inside the workplace roots, bounded)
  // and analysed again; without it the interpreter stays an unknown program and the run asks.
  if (
    (analysis.scriptFiles?.length && context.fs.readScript) ||
    (analysis.moduleSearchCwd && context.fs.listNames)
  ) {
    const files = await readScripts(analysis.scriptFiles ?? [], context);
    // A script may itself run `python3 -c`, which the first pass could not see: list the cwd
    // whenever a second pass happens, so that one pass has everything.
    const cwdNames = await context.fs.listNames?.(context.cwd, context.signal);
    if (files.size || cwdNames)
      analysis = analyze(command, { files, ...(cwdNames ? { cwdNames } : {}) });
  }
  // Writes the analysis cannot see (a package manager's cache) are declared by the
  // model and judged exactly like analysed ones; declaring one means the command is not read-only.
  if (request.writePaths?.length) {
    analysis.writes = [...new Set([...analysis.writes, ...request.writePaths])];
    analysis.readonly = false;
  }
  result.analysis = analysis;
  const facts = result.facts;
  facts.push(
    { kind: "cwd", value: context.cwd },
    ...analysis.programs.map((value): ApprovalFact => ({ kind: "program", value })),
  );
  if (
    analysis.programs.some((program) =>
      ["sudo", "su", "doas"].includes(program.split("/").at(-1) ?? program),
    )
  )
    return {
      result: deny(result, "privilege_escalation_denied", trace),
      incomplete: analysis.incomplete,
    };
  if (gitInlineExecutableUse(analysis)) {
    result.risk = "danger";
    return {
      result: deny(result, "git_inline_execution_unsupported", trace),
      incomplete: analysis.incomplete,
    };
  }
  const reads = await resolveCommandPaths(analysis.reads, context, facts, "read");
  const writes = await resolveCommandPaths(analysis.writes, context, facts, "write");
  analysis.reads = reads.map((path) => path.path);
  analysis.writes = [...new Set(writes.map((path) => path.path))];
  const refused = await judgeOutsideWrites(
    writes.filter((path) => !path.root),
    "command",
    input,
    context,
    result,
    input.rememberedWritePaths,
  );
  if (refused) return { result: deny(result, refused, trace), incomplete: analysis.incomplete };
  const root = context.roots
    .filter((entry) => containsPath(entry, context.cwd, context.platform))
    .sort((a, b) => b.length - a.length)[0];
  // `curl -L` is read-only only because the sandbox proxy keeps every redirect on the
  // allowed hosts; without a confirmed sandbox for this run the response could lead anywhere.
  if (
    analysis.readonly &&
    analysis.network &&
    analysis.commands.some(
      ({ program, args }) => program === "curl" && curlFollowsRedirects(args),
    ) &&
    !(
      context.platform !== "win32" &&
      request.outsideSandbox !== true &&
      (await input.commandIsolation?.(context.signal)) === true
    )
  ) {
    analysis.readonly = false;
    analysis.incomplete = true;
    analysis.warnings.push("redirect_unbounded");
  }
  const incomplete = analysis.incomplete || reads.some((path) => !path.root) || !root;
  if (incomplete) analysis.readonly = false;
  if (analysis.network) {
    facts.push(
      ...(analysis.domains.length ? analysis.domains : ["network_target_unknown"]).map(
        (value): ApprovalFact => ({ kind: "network", value }),
      ),
    );
    if (
      !settings.network.allowAll &&
      analysis.domains.some((domain) => !settings.network.domains.includes(domain))
    )
      deny(result, "domain_not_allowed", trace);
  }
  const dangers = dangerousReasons(analysis, context.roots, context.platform);
  if (analysis.warnings.includes("unknown_directory_write")) {
    // Only a current target probe can justify relying on the sandbox. No concrete path means
    // this remains incomplete/nonrememberable even when YOLO may release the ordinary ask.
    const isolated =
      context.platform !== "win32" &&
      request.outsideSandbox !== true &&
      (await input.commandIsolation?.(context.signal)) === true;
    if (isolated) facts.push({ kind: "warning", value: "unknown_command_directory_sandboxed" });
    else dangers.push("unknown_command_directory");
  }
  const scopeForRisk = commandPathScope(input);
  const commandReadRoots = await Promise.all(
    [
      ...(input.skillsRoots ?? (input.skillsRoot ? [input.skillsRoot] : [])),
      ...(input.commandReadRoots ?? []),
    ].map(async (root) => (await canonicalPath(root, context)).path),
  );
  const writtenPaths = new Set(analysis.writes);
  const outsideRiskPaths = [...analysis.reads, ...analysis.writes].filter(
    (path) =>
      !isWritableCommandPath(path, context.platform, scopeForRisk) &&
      (writtenPaths.has(path) ||
        !commandReadRoots.some((root) => containsPath(root, path, context.platform))),
  );
  const protectedRoots = outsideRiskPaths.length
    ? await input.protectedWriteRoots?.(context.signal)
    : undefined;
  if (
    outsideRiskPaths.some((path) =>
      protectedRoots?.some((root) => containsPath(root, path, context.platform)),
    )
  )
    dangers.push("protected_command_path");
  if (dangers.length) {
    result.risk = "danger";
    for (const code of dangers) trace.step("danger", code, "info");
    facts.push(
      ...dangers.map((value): ApprovalFact => ({ kind: "warning", value, risk: "danger" })),
    );
  }
  if (analysis.readonly) facts.push({ kind: "warning", value: "readonly" });
  // A topic-bound promise covers its current write roots; other scopes retain one-root meaning.
  const withinGrantRoot =
    root &&
    [...reads, ...writes].every(
      (path) =>
        containsPath(root, path.path, context.platform) ||
        (input.workplaceTopicId &&
          input.boundary?.writeRoots.includes(root) &&
          input.boundary.writeRoots.some((writeRoot) =>
            containsPath(writeRoot, path.path, context.platform),
          )),
    );
  const scope: GrantScope | undefined =
    !incomplete && root && withinGrantRoot && analysis.programs.length
      ? {
          kind: "programs",
          programs: analysis.programs.toSorted(),
          root,
          ...(input.workplaceTopicId && input.boundary?.writeRoots.includes(root)
            ? { topicId: input.workplaceTopicId }
            : {}),
        }
      : undefined;
  const scriptScope =
    incomplete && root && reads.every((path) => path.root)
      ? scriptPreauthScope(analysis, context.cwd)
      : undefined;
  return { result, scope, incomplete, ...(scriptScope ? { scriptScope } : {}) };
}
async function readScripts(paths: readonly string[], context: PathContext) {
  const scripts = new Map<string, ScriptSource>();
  if (!context.fs.readScript) return scripts;
  const api = pathApi(context.platform);
  for (const path of paths.slice(0, 4)) {
    const absolute = api.isAbsolute(path) ? path : api.join(context.cwd, path);
    // The resolved file (links followed) must stay inside a root the Bot may work in.
    const real = await context.fs.realpath(absolute, context.signal).catch(() => undefined);
    if (!real || !context.roots.some((root) => containsPath(root, real, context.platform)))
      continue;
    const text = await context.fs.readScript(real, context.signal);
    if (text === undefined) continue;
    // Python searches the script's directory first: as written and with links resolved.
    const directories = [...new Set([api.dirname(absolute), api.dirname(real)])];
    const listed = await Promise.all(
      directories.map((directory) => context.fs.listNames?.(directory, context.signal)),
    );
    const neighbours = listed.every((names) => names !== undefined)
      ? listed.flatMap((names) => names ?? [])
      : undefined;
    scripts.set(path, {
      text,
      // readScript decodes strictly (BOM kept), so these bytes are exactly the file's.
      path: absolute,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      ...(neighbours ? { neighbours } : {}),
    });
  }
  return scripts;
}
async function resolveCommandPaths(
  paths: string[],
  context: PathContext,
  facts: ApprovalFact[],
  kind: "read" | "write",
) {
  const result = [];
  for (const value of paths) {
    const path = await resolvePath(value, context);
    result.push(path);
    facts.push({ kind, value: path.path });
  }
  return result;
}

/** The lexical and the canonical spelling, so a drive-letter case or 8.3 alias still matches. */
async function ownWorkRoots(home: string, context: PathContext) {
  try {
    const canonical = await canonicalPath(home, context);
    return canonical.exists ? [...new Set([home, canonical.path])] : [];
  } catch {
    // An unresolvable own folder keeps the data-directory protection.
    context.signal.throwIfAborted();
    return [];
  }
}
