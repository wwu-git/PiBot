// The default Pi's management and dispatch tools: executors, card texts, receipts RPC.
import type { LocalToolResult } from "@pibot/agent";
import { type CapabilityContext, mainDirectRun, type RegisterRpc } from "@pibot/brain/kit";
import { PiDispatchesRepo } from "../../store/pi-dispatches.ts";
import { botCard, groupCard, sendCard } from "./cards.ts";
import { DispatchFollower, dispatchWork } from "./dispatch.ts";
import { say } from "./lookup.ts";
import { botManage, groupManage, teamList } from "./manage.ts";

export function registerPiManager(ctx: CapabilityContext, handle: RegisterRpc) {
  const follower = new DispatchFollower(ctx);
  // The kernel only offers and allows these in Pi's own direct chat; each executor checks it
  // again so a future routing change can never run them for anyone else.
  const onlyPi =
    (
      run: (
        context: Parameters<Parameters<CapabilityContext["tools"]["executor"]>[1]>[0],
        call: Parameters<Parameters<CapabilityContext["tools"]["executor"]>[1]>[1],
        signal: AbortSignal,
      ) => LocalToolResult | Promise<LocalToolResult>,
    ): Parameters<CapabilityContext["tools"]["executor"]>[1] =>
    async (context, call, signal) =>
      mainDirectRun(ctx.local, context)
        ? run(context, call, signal)
        : {
            text: say(
              context.language,
              "只有默认 Pi 在和用户的私聊里能用",
              "Only the default Pi can use this, in its own chat with the person",
            ),
            isError: true,
          };
  const releases = [
    ctx.tools.executor(
      "team_list",
      onlyPi((context, call) => teamList(ctx, context, call.input)),
    ),
    ctx.tools.executor(
      "bot_manage",
      onlyPi((context, call) => botManage(ctx, context, call.input)),
    ),
    ctx.tools.executor(
      "group_manage",
      onlyPi((context, call) => groupManage(ctx, context, call.input)),
    ),
    ctx.tools.executor(
      "send_to_bot",
      onlyPi((context, call, signal) => dispatchWork(ctx, follower, "bot", context, call, signal)),
    ),
    ctx.tools.executor(
      "send_to_group",
      onlyPi((context, call, signal) =>
        dispatchWork(ctx, follower, "group", context, call, signal),
      ),
    ),
    ctx.tools.card("bot_manage", botCard(ctx.db)),
    ctx.tools.card("group_manage", groupCard(ctx.db)),
    ctx.tools.card("send_to_bot", sendCard(ctx.db, "bot")),
    ctx.tools.card("send_to_group", sendCard(ctx.db, "group")),
  ];
  const repo = new PiDispatchesRepo(ctx.db);
  handle("teams.dispatches", ({ messageId }: { messageId: string }) => repo.forMessage(messageId));
  return {
    /** Receipts left open by a restart catch up with what happened meanwhile. */
    start() {
      repo.abandonUnsent();
      follower.start();
    },
    stop() {
      follower.stop();
      for (const release of releases) release();
    },
  };
}
