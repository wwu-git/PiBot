import { BotsRepo, ConversationsRepo, MessagesRepo, RunsRepo } from "@pibot/storage";
import type { LocalService } from "../local-service.ts";
import type { ToolRunContext } from "./local-types.ts";

/**
 * Owner decision 2026-11-24: the default Pi's management and dispatch tools are hard-wired to
 * one place, Pi's own direct chat with a message the person typed on this computer. The kernel
 * answers this from its own records, so no capability, model text or other Bot can claim it:
 * - only the main Bot (never an agent Bot, never any other Bot);
 * - only a visible DM topic of that Bot (no group, task thread, routine, sub-task, review,
 *   external-agent hand-off or internal task session);
 * - only a turn whose user message the person wrote in the desktop app ("user") or on the paired
 *   phone through this computer ("phone", owner decision 2026-11-25); an ACP editor message, a
 *   forwarded or dispatched message and any message the brain wrote itself are out. The phone's
 *   own offline model never gets these tools (its fixed tool list and portable policy).
 * A dispatched run therefore can never dispatch again (the loop guard's first half).
 */
export function mainDirectRun(local: LocalService, context: ToolRunContext): boolean {
  if (!mainDirectTopic(local, context)) return false;
  const { db } = local.deps;
  const run = new RunsRepo(db).get(context.runId);
  if (
    !run ||
    run.botId !== context.botId ||
    run.groupId ||
    run.kind !== "chat" ||
    !run.userMessageId
  )
    return false;
  const message = new MessagesRepo(db).get(run.userMessageId);
  const usage = message?.usage;
  return (
    message?.role === "user" &&
    !!usage &&
    typeof usage === "object" &&
    !Array.isArray(usage) &&
    ["user", "phone"].includes(String((usage as Record<string, unknown>).inputOrigin)) &&
    !("forward" in usage) &&
    !("dispatch" in usage) &&
    !("systemEvent" in usage)
  );
}

/**
 * Where the tools are offered: the default Pi's own visible DM topic, never one an ACP editor
 * has written into. It does not look at the turn's message, so the catalog of a topic stays the
 * same from turn to turn: a routine notice or a card answer between two typed turns used to drop
 * and re-add the tools, which changed the session's tool set, forced a context checkpoint (extra
 * model calls) and broke the prompt cache. Policy and the executors still require `mainDirectRun`.
 */
export function mainDirectTopic(local: LocalService, context: ToolRunContext): boolean {
  if (
    context.groupId ||
    context.threadId ||
    context.executionTaskId ||
    context.permissionGroupId ||
    context.routineRunId ||
    context.routineSource ||
    context.routineWorkplace ||
    context.auditSource ||
    context.delegatedHome ||
    !context.conversationId
  )
    return false;
  const { db } = local.deps;
  const bot = new BotsRepo(db).get(context.botId);
  if (!bot?.isMain || bot.kind === "agent" || bot.archivedAt) return false;
  if (local.reviews.profile(context)) return false;
  const conversations = new ConversationsRepo(db);
  const topic = conversations.get(context.conversationId);
  if (topic?.kind !== "dm" || topic.botId !== bot.id || conversations.isInternal(topic.id))
    return false;
  // A topic an ACP editor drives keeps these tools out of its catalog for good.
  return !db
    .prepare(
      "SELECT 1 FROM messages WHERE conversation_id=? AND json_extract(usage,'$.inputOrigin')='acp' LIMIT 1",
    )
    .get(topic.id);
}
