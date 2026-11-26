// Expose local operations through the validated brain RPC dispatcher.
import { join } from "node:path";
import { discoverCommandPaths, listHostSshAliases } from "@pibot/execution";
import { PI_MANAGER_CATEGORIES, RpcError } from "@pibot/protocol-base";
import { BotsRepo, transaction } from "@pibot/storage";
import { registerDraftRpc } from "../../conversations/drafts/drafts.ts";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { LocalService } from "../../local-service.ts";
import { grantList } from "../../resources/workplaces/grant-list.ts";
import { revealWorkingFolder } from "../../resources/workplaces/reveal-folder.ts";
import { browseRunner } from "../../resources/workplaces/runner-browse.ts";
import { registerSandboxWebsiteRpc } from "./sandbox-website-rpc.ts";

export function registerLocalRpc(handle: KernelRegisterRpc, local: LocalService) {
  const { approvals, workplaces, permissions } = local;
  registerDraftRpc(handle, local.drafts);
  const savePermissions: typeof permissions.set = async (params) => {
    const result = await permissions.set(params);
    try {
      await local.browserProvider?.refreshPermissions(
        result.botId,
        result.groupId,
        AbortSignal.any([local.shutdown.signal, AbortSignal.timeout(15000)]),
      );
    } catch {
      local.deps.logger.warn("Browser permission refresh unavailable; next action will recheck");
    }
    return result;
  };
  registerSandboxWebsiteRpc(handle, local, savePermissions);
  handle("chat.externalImageStatus", (params) => local.externalImages.status(params));
  handle("chat.loadExternalImage", (params) => local.externalImages.load(params));
  handle("chat.cancelExternalImage", async ({ requestId }) =>
    local.externalImages.cancel(requestId),
  );
  handle("workplaces.list", ({ botId }) => workplaces.list(botId));
  /**
   * The code map is derived, so a failed cleanup must never fail "remove folder"; the
   * next use of the folder simply rebuilds what was dropped.
   */
  const dropCodeMap = (path: string | undefined) => {
    if (path) local.codeMap.forgetPaths([path]);
  };
  // The Bot's current topic may now resolve to another folder; the sidebar's watch follows it.
  const folderChanged = <T>(botId: string, result: T) => {
    local.deps.peer.emit("changes.changed", { conversationKey: `dm:${botId}`, reason: "folder" });
    return result;
  };
  // Registering or hiding a "used folder" changes no conversation's folders, so only the
  // Bot's lists refresh (bots.changed is what the folder lists already listen to).
  const usedChanged = <T>(botId: string, result: T) => {
    local.deps.peer.emit("bots.changed", { botId, reason: "updated" });
    return result;
  };
  handle("workplaces.add", async ({ botId }) => usedChanged(botId, await workplaces.add(botId)));
  handle("workplaces.remove", async ({ botId, folderId }) => {
    // The folder path is read before the record disappears, so the code index of a
    // removed last record can still be dropped afterwards.
    const path = local.codeMap.folderPath(folderId);
    const result = usedChanged(botId, await workplaces.remove(botId, folderId));
    await dropCodeMap(path);
    return result;
  });
  handle("workplaces.pick", async ({ botId, create, location, path, association }, { signal }) =>
    association === "session"
      ? workplaces.pick(botId, create, { location, path }, signal, undefined, association)
      : usedChanged(
          botId,
          await workplaces.pick(botId, create, { location, path }, signal, undefined, association),
        ),
  );
  handle("workplaces.browse", ({ location, path }, { signal }) =>
    browseRunner(local.executionTargets, location, path, signal),
  );
  handle("workplaces.used", ({ botId }) => workplaces.used(botId));
  handle("workplaces.reveal", (params, { signal }) => revealWorkingFolder(local, params, signal));
  handle("workplaces.forget", async ({ botId, folderId }) => {
    const path = local.codeMap.folderPath(folderId);
    const result = usedChanged(botId, await workplaces.forget(botId, folderId));
    await dropCodeMap(path);
    return result;
  });
  handle("workplaces.setCurrent", async ({ botId, folderId }) =>
    folderChanged(botId, await workplaces.setCurrent(botId, folderId)),
  );
  handle("files.open", ({ botId, path }) => workplaces.open(botId, path));
  handle("runs.readLog", (params, { signal }) => local.logs.read(params, signal));
  handle("runs.revealLog", ({ runId, toolCallId }, { signal }) =>
    local.logs.reveal(runId, toolCallId, signal),
  );
  handle("runs.openLog", ({ runId, toolCallId }, { signal }) =>
    local.openLog(runId, toolCallId, signal),
  );
  handle("conversations.yolo.get", ({ conversationId }) => local.yolo.get(conversationId));
  handle("conversations.yolo.enableOnWindows", ({ conversationId, acknowledged }, { signal }) =>
    local.yolo.enableOnWindows(conversationId, acknowledged === true, signal),
  );
  handle("conversations.yolo.set", ({ conversationId, enabled }) =>
    local.yolo.set(conversationId, enabled),
  );
  handle("autoCheck.get", async ({ botId }) => local.autoCheck.get(botId));
  handle("autoCheck.set", async ({ botId, enabled, rounds }) =>
    local.autoCheck.set(botId, { enabled, rounds }),
  );
  handle("autoCheck.folder.get", ({ botId, conversationId }) =>
    local.autoCheck.folderGet(botId, conversationId),
  );
  handle("autoCheck.folder.set", ({ botId, conversationId, commands }) =>
    local.autoCheck.folderSet(botId, conversationId, commands),
  );
  handle("autoCheck.conversation.set", async ({ conversationId, enabled }) =>
    local.autoCheck.conversationSet(conversationId, enabled),
  );
  handle("autoCheck.proposal.resolve", async ({ noticeId, accept, commands }) =>
    local.autoCheck.resolveProposal(noticeId, accept, commands),
  );
  let discoveringCommandPaths = false;
  handle("permissions.paths.discover", async ({ source }) => {
    if (discoveringCommandPaths) throw new RpcError(-32001, "command_path_discovery_in_progress");
    discoveringCommandPaths = true;
    try {
      return await discoverCommandPaths({
        platform: local.deps.platform,
        env: local.deps.env,
        home: local.deps.userHome,
        source,
        signal: local.shutdown.signal,
      });
    } catch {
      throw new RpcError(-32001, "command_path_discovery_failed");
    } finally {
      discoveringCommandPaths = false;
    }
  });
  handle("permissions.get", (params) => permissions.get(params?.botId, params?.groupId));
  handle("permissions.sshHosts.list", async (_params, { signal }) => {
    const { configured, complete, ...result } = await listHostSshAliases(
      {
        userHome: local.deps.userHome,
        platform: local.deps.platform,
        hosts: permissions.repo.get().sshHosts ?? {},
        // An Include inside a workspace or Bot home is Bot-writable, so the panel reports it
        // as unsupported instead of trusting it. ~/.ssh itself stays outside these roots.
        forbiddenRoots: [
          join(local.deps.dataDir, "bots"),
          join(local.deps.dataDir, "groups"),
          ...workplaces.workplaceRoots(),
        ],
      },
      // A slow network home must not hold the settings panel open indefinitely.
      AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    );
    // Only a complete read proves an alias is gone: a missing or rejected Include would otherwise
    // make its hosts look removed and silently drop the permissions the person enabled for them.
    if (configured && complete && !result.unavailable) {
      const removed = transaction(local.deps.db, () => {
        const removed = permissions.repo.pruneSshHosts(
          new Set(result.hosts.map((host) => host.alias)),
        );
        if (removed)
          approvals.audit.append({
            botId: new BotsRepo(local.deps.db).getMain()?.id ?? "",
            kind: "permissions.changed",
            summary: "Permissions updated / 权限已修改",
            detail: {
              reasonCode: "ssh_hosts_removed_from_config",
              removedCount: removed,
            },
          });
        return removed;
      });
      if (removed) local.deps.peer.emit("permissions.changed", await permissions.get());
    }
    return result;
  });
  handle("permissions.set", (params, { source }) => {
    // Pi's management and dispatch levels are the person's own switch (this computer or the
    // paired phone); an ACP editor cannot widen them.
    if (
      source === "acp" &&
      PI_MANAGER_CATEGORIES.some((category) => params.levels?.[category] !== undefined)
    )
      throw new RpcError(-32602, "pi_manager_no_acp");
    return savePermissions(params);
  });
  handle("approvals.pending", async (params) => approvals.repo.pending(params));
  handle("approvals.addWritableFolder", ({ id }, { signal }) =>
    approvals.addWritableFolder(id, signal),
  );
  handle(
    "approvals.resolve",
    (
      {
        id,
        decision,
        remember,
        preauthorize,
        rememberSecrets,
        connectorConsent,
        allowConversation,
        allowTaskWeb,
        allowSession,
        conversationId,
      },
      { source },
    ) => {
      const approval = approvals.repo.get(id);
      if (conversationId && approval?.conversationId !== conversationId)
        throw new RpcError(-32602, "Approval conversation changed");
      // "Don't ask again" on Pi's cards changes Pi's own level: the person's switch, on this
      // computer or the paired phone, never an ACP editor's.
      if (
        remember &&
        source === "acp" &&
        approval &&
        PI_MANAGER_CATEGORIES.some((category) => category === approval.category)
      )
        throw new RpcError(-32602, "pi_manager_no_acp");
      if (approval?.draft) throw new RpcError(-32602, "Use drafts.resolve for send drafts");
      return approvals.resolve(
        id,
        decision,
        remember,
        preauthorize,
        source === "acp" ? "acp" : "user",
        rememberSecrets,
        connectorConsent,
        allowConversation,
        allowTaskWeb,
        allowSession,
      );
    },
  );
  handle("grants.list", (params, { signal }) => grantList(local, params, signal));
  handle("grants.revoke", async ({ id }) => {
    const grant = transaction(local.deps.db, () => {
      const grant = approvals.grants.get(id);
      if (!grant || grant.revokedAt) throw new RpcError(-32602, "Grant is unavailable");
      approvals.grants.revoke(id);
      approvals.audit.append({
        botId: grant.botId,
        kind: "grant.revoked",
        summary: "Permission revoked / 已撤销授权",
        detail: { grantId: id, category: grant.category },
      });
      return grant;
    });
    // Revoking has no event of its own; open grant lists (desktop, or a phone that revoked it)
    // refresh on their scope's permissions event.
    const groupId = grant.groupId ?? undefined;
    local.deps.peer.emit(
      "permissions.changed",
      await permissions.get(groupId ? undefined : grant.botId, groupId),
    );
    return { ok: true };
  });
  handle("audit.list", async (params) => approvals.audit.list(params));
  handle("audit.counts", async (params) => approvals.audit.counts(params));
}
