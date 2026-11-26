// Supplies the runtime ports and shared services used by brain capabilities.
import {
  type createPeer,
  type EventTable,
  type KernelEvents,
  type KernelMethods,
  type MethodTable,
  type Peer,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import type { InboxSource, SecretStore } from "@pibot/storage";
import { SettingsRepo } from "@pibot/storage";
import type { BotService } from "../../conversations/bots/bot-service.ts";
import type { ChatService } from "../../conversations/chat/chat.ts";
import type { ChatNoticeService } from "../../conversations/chat/chat-notices.ts";
import type { KernelRegisterRpc, RegisterRpc } from "../../core/business-rpc.ts";
import {
  type CapabilityHandle,
  CapabilityPorts,
  type SleepParticipant,
  startCapabilities,
  type ToolExecutor,
  type UnattendedRunOwner,
} from "../../core/capability.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import type { createBrainRedactor } from "../../core/privacy.ts";
import { runPermissionScope } from "../../core/run-permissions.ts";
import type { startBrain } from "../../index.ts";
import type { LocalService } from "../../local-service.ts";
import { computerRuntime } from "../computer/runtime.ts";
import type { ModelProvidersPort } from "../models/port.ts";
import type { BrainSleep } from "../queue/brain-sleep.ts";
import { isDelegatedKernelToolName, isKernelToolName } from "../tools/tools.ts";
import { workflowUserText } from "../workflows/workflow-text.ts";
import { createWorkspaceHost } from "../workspaces/host.ts";
import type { ManagedResourcesPort } from "../workspaces/port.ts";
import type { StartupTiming } from "./startup-timing.ts";

interface StartupContext {
  opts: Parameters<typeof startBrain>[0];
  network: { transport: { fetch: typeof fetch } };
  capabilities: LocalService;
  chat: ChatService;
  db: import("node:sqlite").DatabaseSync;
  dataDir: string;
  logger: import("@pibot/observability").Logger;
  redactor: ReturnType<typeof createBrainRedactor>;
  peer: ReturnType<typeof createPeer<typeof KernelMethods, typeof KernelEvents>>;
  agent: import("@pibot/agent").AgentRuntime;
  botBusiness: BotService;
  handle: KernelRegisterRpc;
  offlineAllowed: Set<string>;
  /** Kept after registration so the controller can reach capability ports. */
  ports?: CapabilityPorts;
  backgroundPrefixes: string[];
  claimUnattended: (owner: UnattendedRunOwner) => void;
  secrets: SecretStore;
  chatNotices: ChatNoticeService;
  resources: ManagedResourcesPort;
  groups: GroupOrchestrationPort;
  inboxSources: InboxSource[];
  sleepParticipants: SleepParticipant[];
  sleepService: BrainSleep;
  models: () => ModelProvidersPort;
  providerTests: AbortController;
  modelPort: ModelProvidersPort | undefined;
  capabilityHandles: CapabilityHandle[];
  timing: StartupTiming;
}
export async function registerCapabilities(ctx: StartupContext) {
  const ports = new CapabilityPorts();
  ctx.ports = ports;
  for (const capability of ctx.opts.capabilities ?? []) {
    const registerToolExecutor = (tool: string, run: ToolExecutor, kernelDelegate: boolean) => {
      if (kernelDelegate) {
        if (capability.id !== "memory" || !isDelegatedKernelToolName(tool))
          throw new Error(`Capability ${capability.id} cannot delegate kernel tool: ${tool}`);
      } else if (isKernelToolName(tool)) {
        throw new Error(`Capability ${capability.id} cannot register kernel tool: ${tool}`);
      }
      if (ctx.capabilities.toolExecutors.has(tool)) throw new Error(`Tool executor taken: ${tool}`);
      ctx.capabilities.toolExecutors.set(tool, run);
      return () => {
        if (ctx.capabilities.toolExecutors.get(tool) === run)
          ctx.capabilities.toolExecutors.delete(tool);
      };
    };
    const registered = await capability.register({
      computer: {
        runtime: computerRuntime(ctx.capabilities, (id) => ctx.chat.abort(id)),
        handoffWaitMs: ctx.capabilities.deps.computerHandoffWaitMs,
        provide(port) {
          if (ctx.capabilities.computerUse) throw new Error("Computer use port already provided");
          ctx.capabilities.computerUse = port;
        },
      },
      db: ctx.db,
      dataDir: ctx.dataDir,
      fetch: ctx.network.transport.fetch,
      version: ctx.opts.version,
      dev: ctx.opts.dev ?? false,
      logger: ctx.logger,
      redactor: ctx.redactor,
      peer: ctx.peer as Peer<MethodTable, EventTable>,
      agent: ctx.agent,
      local: ctx.capabilities,
      chat: ctx.chat,
      host: ctx.opts.host,
      bots: {
        introduce: (botId) => ctx.botBusiness.introduce(botId),
        update: (params) => ctx.botBusiness.update(params),
        create: (params) => ctx.botBusiness.create(params),
        archive: (botId) => ctx.botBusiness.archive(botId),
        restore: (botId) => ctx.botBusiness.restore(botId),
        newTopic: (botId) => ctx.botBusiness.newTopic(botId),
        updateTopicWorkplace: (params, signal) => {
          ctx.botBusiness.active(params.botId);
          return ctx.botBusiness.topicWorkplace.update(params, undefined, signal);
        },
      },
      groups: {
        confirmNotice: (groupId, conversationId, botId, text, confirmation, display) =>
          ctx.groups.confirmNotice(groupId, conversationId, botId, text, confirmation, display),
        update: (params) => ctx.groups.update(params),
        addMember: (groupId, botId) => ctx.groups.addMember(groupId, botId),
        create: (params) => ctx.groups.create(params),
        removeMember: (groupId, botId) => ctx.groups.removeMember(groupId, botId),
        archive: (groupId) => ctx.groups.archive(groupId),
        restore: (groupId) => ctx.groups.restore(groupId),
        send: (groupId, conversationId, text, display) =>
          ctx.groups.send(
            { groupId, topicId: conversationId, text },
            undefined,
            undefined,
            display,
          ),
        newTopic: (groupId) => ctx.groups.topics.create({ groupId, inheritWorkspace: true }),
        sendWorkflow: (groupId, botId, workflow, conversationId) =>
          workflow.contract.planTemplate
            ? ctx.groups.startPlanTemplate(
                groupId,
                workflow,
                workflowUserText(workflow, ctx.chat.currentLanguage()),
                conversationId,
              )
            : workflow.contract.steps?.length
              ? ctx.groups.startWorkflow(groupId, botId, workflow, conversationId)
              : ctx.groups.send(
                  {
                    groupId,
                    ...(conversationId ? { topicId: conversationId } : {}),
                    text: workflowUserText(workflow, ctx.chat.currentLanguage()),
                    mentions: [botId],
                  },
                  undefined,
                  { botId, run: workflow },
                ),
      },
      rpc: {
        handle: ctx.handle as RegisterRpc,
        allowOffline: (method) => ctx.offlineAllowed.add(method),
        background: (prefix) => ctx.backgroundPrefixes.push(prefix),
      },
      unattended: { claim: ctx.claimUnattended },
      secrets: ctx.secrets,
      office: {
        provide: (port) => {
          if (ctx.capabilities.officeProvider)
            throw new Error("Office provider already registered");
          ctx.capabilities.officeProvider = port;
        },
      },
      images: {
        provide: (port) => {
          if (ctx.capabilities.imageProvider) throw new Error("Image provider already registered");
          ctx.capabilities.imageProvider = port;
        },
      },
      externalAgents: {
        provide: (port) => {
          if (ctx.capabilities.externalAgentProvider)
            throw new Error("External agents already registered");
          ctx.capabilities.externalAgentProvider = port;
        },
      },
      memory: { provide: (port) => ctx.capabilities.provideMemory(port) },
      browser: {
        environment: {
          deps: { host: ctx.opts.host, logger: ctx.logger, proxy: ctx.capabilities.deps.proxy },
          shutdown: ctx.capabilities.shutdown,
          scope: (context) => runPermissionScope(ctx.capabilities, context),
          grants: (id, context) => ctx.capabilities.grants(id, context),
          permissions: ctx.capabilities.permissions,
          background: ctx.capabilities.background,
          googleCompat: { enabled: (scope) => ctx.capabilities.googleCompat.enabled(scope) },
          userBrowser: {
            preferred: () => new SettingsRepo(ctx.db).get().browserExtensionPreference === "user",
          },
          privateNetwork: ctx.capabilities.privateNetwork,
        },
        notices: ctx.chatNotices,
        beginTakeover: (id) => ctx.resources.beginBrowserTakeover(id),
        members: (id) => ctx.groups.active(id).members.map((m) => m.botId),
        afterHandBack: (id) => ctx.capabilities.credentials.afterHandBack(id),
        provide: (port, view) => {
          if (ctx.capabilities.browserProvider) throw new Error("Browser already provided");
          ctx.capabilities.browserProvider = port;
          ctx.capabilities.browserView = view;
        },
      },
      credentialServices: { provide: (port) => ctx.capabilities.provideCredentials(port) },
      skills: {
        provide: (port) => ctx.capabilities.provideSkills(port),
        takeover: (botId, on) => {
          if (!ctx.capabilities.browserView)
            return Promise.reject(new RpcError(RpcErrorCodes.unsupported, "browser_unavailable"));
          return ctx.capabilities.browserView.takeover(botId, on);
        },
      },
      connectors: {
        provide: (port) => {
          if (ctx.capabilities.connectors) throw new Error("Connectors already provided");
          ctx.capabilities.connectors = port;
        },
      },
      inbox: { source: (source) => ctx.inboxSources.push(source) },
      workspaces: {
        host: createWorkspaceHost(
          ctx.capabilities,
          ctx.chat,
          ctx.groups,
          ctx.botBusiness.topicWorkplace,
        ),
        provide(port) {
          if (ctx.capabilities.workspaceServices) throw new Error("Workspaces already provided");
          ctx.capabilities.workspaceServices = port;
        },
      },
      tools: {
        executor: (tool, run) => registerToolExecutor(tool, run, false),
        delegateKernel: (tool, run) => registerToolExecutor(tool, run, true),
        card: (tool, describe) => {
          if (isKernelToolName(tool))
            throw new Error(`Capability ${capability.id} cannot describe kernel tool: ${tool}`);
          if (ctx.capabilities.toolCards.has(tool)) throw new Error(`Tool card taken: ${tool}`);
          ctx.capabilities.toolCards.set(tool, describe);
          return () => {
            if (ctx.capabilities.toolCards.get(tool) === describe)
              ctx.capabilities.toolCards.delete(tool);
          };
        },
      },
      sleep: {
        participate: (participant) => ctx.sleepParticipants.push(participant),
        wakeSource: (source) => ctx.sleepService.useWakeSource(source),
        interrupt: () => ctx.sleepService.interrupt(),
      },
      credentials: (id) => ctx.models().credentials(id),
      models: {
        signal: () => ctx.providerTests.signal,
        provide(port) {
          if (ctx.modelPort) throw new Error("Model providers port already provided");
          ctx.modelPort = port;
          ctx.capabilities.models = port;
        },
      },
      ports,
    });
    ctx.capabilityHandles.push(registered);
    ctx.timing.mark(`register.${capability.id}`);
  }
  const ids = (ctx.opts.capabilities ?? []).map((capability) => capability.id);
  await startCapabilities(ctx.capabilityHandles, (index) =>
    ctx.timing.mark(`start.${ids[index] ?? "unknown"}`),
  );
}
