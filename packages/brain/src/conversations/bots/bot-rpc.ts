import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { BotService } from "./bot-service.ts";

export function registerBotRpc(
  handle: KernelRegisterRpc,
  bots: BotService,
  waitForSessionRecovery: (signal: AbortSignal) => Promise<void>,
) {
  handle("bots.list", async (params) => bots.list(params));
  handle("bots.create", (params) => bots.create(params));
  handle("bots.update", (params) => bots.update(params));
  handle("bots.duplicate", ({ botId }) => bots.duplicate(botId));
  handle("bots.archived", async (params) => bots.archived(params));
  handle("bots.restore", ({ botId }) => bots.restore(botId));
  handle("bots.delete", async ({ botId }, { signal }) => {
    await waitForSessionRecovery(signal);
    return bots.remove(botId);
  });
  handle("bots.archive", ({ botId }) => bots.archive(botId));
  handle("bots.profile", async ({ botId }) => bots.profile(botId));
  handle("topics.metadata", (params) => bots.topicMetadata(params));
  handle("topics.list", async (params) => bots.topics(params));
  handle("topics.archive", (params) => bots.topicArchive.archive(params));
  handle("topics.restore", (params) => bots.topicArchive.restore(params));
  handle("topics.rename", (params) => bots.renameTopic(params));
  handle("topics.create", ({ botId }) => bots.newTopic(botId));
  handle("topics.switch", ({ botId, topicId }) => bots.switchTopic(botId, topicId));
  handle("topics.workplace.get", (params) => {
    bots.active(params.botId);
    return bots.topicWorkplace.get(params);
  });
  // The ACP host attaches a session to an existing topic; the service reports its own fixed
  // codes, so the generic "Unknown active Bot" check would only hide them.
  handle("topics.acp.attach", (params) => bots.topicWorkplace.attach(params));
  handle("topics.workplace.set", (params) => {
    bots.active(params.botId);
    return bots.topicWorkplace.set(params);
  });
  handle("topics.workplace.update", (params, { signal }) => {
    bots.active(params.botId);
    return bots.topicWorkplace.update(params, undefined, signal);
  });
  handle("topics.workplace.initial", (params) => {
    bots.active(params.botId);
    return bots.topicWorkplace.initial(params);
  });
}
