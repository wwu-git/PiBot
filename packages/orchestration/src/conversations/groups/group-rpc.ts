import type { KernelRegisterRpc } from "@pibot/brain/orchestration-kit";
import { inspectChatRecovery, resumeRun, retryRun } from "@pibot/brain/orchestration-kit";
import { RpcError } from "@pibot/protocol-base";
import { GroupTaskExecutionRepo, GroupTaskHistoryRepo, type RunsRepo } from "@pibot/storage";
import { GroupAcpRuntime } from "./group-acp-runtime.ts";
import { choosePlan, planProgress, stopPlan } from "./group-plan-progress.ts";
import { planTemplateDocument } from "./group-plan-template.ts";
import type { GroupService } from "./group-service.ts";
import { taskBrief } from "./group-task-brief.ts";

export function registerGroupRpc(handle: KernelRegisterRpc, groups: GroupService, runs: RunsRepo) {
  const acp = new GroupAcpRuntime(groups);
  const requireAcp = (source?: "acp") => {
    if (source !== "acp") throw new RpcError(-32601, "acp_method_unavailable");
  };
  handle("groups.acp.list", async (_params, { source }) => {
    requireAcp(source);
    return acp.list();
  });
  handle("groups.acp.get", async ({ groupId }, { source }) => {
    requireAcp(source);
    return acp.metadata(groupId);
  });
  handle("groups.acp.topics.create", (params, { source, signal }) => {
    requireAcp(source);
    return acp.topics.create(params, signal);
  });
  handle("groups.acp.topics.attach", (params, { source, signal }) => {
    requireAcp(source);
    return acp.topics.attach(params, signal);
  });
  handle("groups.acp.topics.rebind", (params, { source, signal }) => {
    requireAcp(source);
    return acp.topics.rebind(params, signal);
  });
  handle("groups.acp.topics.archive", (params, { source, signal }) => {
    requireAcp(source);
    return acp.topics.archive(params, signal);
  });
  handle("groups.acp.send", (params, { source, signal }) => {
    requireAcp(source);
    return acp.send(params, signal);
  });
  handle("groups.acp.snapshot", async (params, { source }) => {
    requireAcp(source);
    return acp.snapshot(params);
  });
  handle("groups.acp.cancel", (params, { source }) => {
    requireAcp(source);
    return acp.cancel(params);
  });
  handle("groups.plan.current", async ({ groupId }) => {
    const group = groups.active(groupId),
      cycle = groups.cycles.get(groupId).cycleId;
    const entry = cycle ? groups.plans.repo.forCycle(group.conversationId, cycle) : undefined;
    return entry ? { messageId: entry.message.id, card: entry.card } : null;
  });
  handle("groups.plan.resolve", (params, { signal }) => groups.plans.resolve(params, signal));
  handle("groups.plan.template", async (params) => planTemplateDocument(groups, params));
  handle("groups.plan.progress", async (params) => planProgress(groups, params));
  handle("groups.plan.stop", async (params) => stopPlan(groups, params));
  handle("groups.plan.choose", async (params) => choosePlan(groups, params));
  const get = (id: string) => {
    const group = groups.groups.get(id);
    if (!group) throw new RpcError(-32602, "Unknown group");
    return groups.folders.present(group);
  };
  handle("groups.create", async (params) => groups.folders.present(groups.create(params)));
  handle("groups.list", async (params) =>
    groups.groups.list(params).map((g) => groups.folders.present(g)),
  );
  handle("groups.topics.list", async (params) => groups.topics.list(params));
  handle("groups.topics.history", async (params) => groups.topics.history(params));
  handle("groups.topics.create", async (params, { signal }) =>
    groups.topics.create(params, signal),
  );
  handle("groups.topics.rename", async (params) => groups.topics.rename(params));
  handle("groups.topics.restore", async (params) => groups.topics.restore(params));
  handle("groups.topics.switch", async (params, { signal }) =>
    groups.topics.switch(params, signal),
  );
  handle("groups.topics.pickFolder", async (params, { signal }) =>
    groups.topics.pickFolder(params, signal),
  );
  handle("groups.topics.archive", async (params) => groups.topics.archive(params));
  handle("groups.get", async ({ groupId }) => get(groupId));
  handle("groups.folders.used", async ({ groupId }) => ({
    folders: (get(groupId).folders ?? []).map(({ id, name }) => ({ id, name })),
  }));
  handle("groups.folders.reveal", ({ groupId, folderId }, { signal }) =>
    groups.files.reveal(groupId, signal, folderId),
  );
  handle("groups.folders.add", ({ groupId, create, location, path }, { signal }) =>
    groups.folders.add(groupId, create, { location, path }, signal),
  );
  handle("groups.folders.setPrimary", ({ groupId, folderId }) =>
    groups.folders.setPrimary(groupId, folderId),
  );
  handle("groups.folders.remove", async ({ groupId, folderId }) =>
    groups.folders.remove(groupId, folderId),
  );
  handle("groups.files.list", (params) => groups.files.list(params));
  handle("groups.files.preview", (params) => groups.files.preview(params));
  handle("groups.files.open", (params) => groups.files.open(params));
  handle("groups.files.cancel", async ({ groupId, requestId }) =>
    groups.files.cancel(groupId, requestId),
  );
  handle("groups.state", async ({ groupId }) => {
    get(groupId);
    return groups.cycles.get(groupId);
  });
  handle("groups.update", async (params) => groups.folders.present(await groups.update(params)));
  handle("groups.addMember", async ({ groupId, botId }) =>
    groups.folders.present(await groups.addMember(groupId, botId)),
  );
  handle("groups.removeMember", async ({ groupId, botId }) =>
    groups.folders.present(await groups.removeMember(groupId, botId)),
  );
  handle("groups.archive", async ({ groupId }) =>
    groups.folders.present((await groups.archive(groupId)) as import("@pibot/protocol-base").Group),
  );
  handle("groups.restore", async ({ groupId }) =>
    groups.folders.present((await groups.restore(groupId)) as import("@pibot/protocol-base").Group),
  );
  handle("groups.delete", ({ groupId }) => groups.remove(groupId));
  handle("groups.tasks", async ({ groupId, status, before, limit, origin, section }) => {
    get(groupId);
    return groups.tasks.list(groupId, { before, limit }, status, { origin, section });
  });
  handle("groups.execution.tasks", async (params) => {
    get(params.groupId);
    return new GroupTaskExecutionRepo(groups.deps.db).groupPage(params);
  });
  handle("groups.tasks.history", async (params) => {
    get(params.groupId);
    return new GroupTaskHistoryRepo(groups.deps.db).page(params);
  });
  handle("groups.tasks.execution", async (params) => {
    get(params.groupId);
    return new GroupTaskExecutionRepo(groups.deps.db).page(params);
  });
  handle("groups.tasks.brief", (params, { signal }) =>
    taskBrief(groups, get(params.groupId), params, signal),
  );
  handle("groups.tasks.summary", async (params) => {
    get(params.groupId);
    return groups.tasks.summary(params);
  });
  handle("groups.tasks.resolve", (params) => groups.completion.resolve(params));
  handle("groups.workflow.resolve", async (params) => groups.workflows.resolve(params));
  handle("chat.recovery", (params) => inspectChatRecovery(groups, params));
  handle("runs.retry", (params) => retryRun(groups, params));
  handle("runs.resume", (params) => resumeRun(groups, params));
  handle("chat.runs", async ({ botId, groupId, before, limit }) =>
    runs
      .list({ botId, groupId }, { before, limit })
      .map(({ sessionFile: _file, triggerKey: _key, ancestry: _ancestry, ...run }) => run),
  );
}
