// The default Pi lists, creates, edits, archives and restores Bots and groups through the same
// services the person's own buttons use. Policy already decided the call (and showed the card);
// here every request is checked again against what Pi may never do.
import type { LocalToolResult } from "@pibot/agent";
import type { CapabilityContext, ToolRunContext } from "@pibot/brain/kit";
import type { Bot } from "@pibot/protocol";
import { piManagerTools } from "@pibot/teams-contract";
import { PiDispatchesRepo } from "../../store/pi-dispatches.ts";
import { managerFailure } from "./errors.ts";
import {
  allBots,
  allGroups,
  botName,
  findBot,
  findGroup,
  oneLine,
  parseModel,
  say,
} from "./lookup.ts";

/** The active Bot with exactly this name (names are unique among active Bots). */
function activeBotNamed(ctx: CapabilityContext, name: string): Bot | undefined {
  const wanted = name.trim().toLowerCase();
  return allBots(ctx.db, false).find((bot) => bot.name.trim().toLowerCase() === wanted);
}

const refusal = (text: string): LocalToolResult => ({ text, isError: true });
const done = (text: string, summary: string): LocalToolResult => ({
  text,
  summary: summary.slice(0, 200),
});

type ManagedCode =
  | "bot_created"
  | "bot_updated"
  | "bot_archived"
  | "bot_restored"
  | "group_created"
  | "group_members_added"
  | "group_members_removed"
  | "group_archived"
  | "group_restored";

export function auditManaged(
  ctx: CapabilityContext,
  context: ToolRunContext,
  code: ManagedCode,
  target: string,
  extra: { fields?: string[]; groupId?: string; targetBotName?: string } = {},
) {
  // The change is already committed: a failed audit write is logged, never reported as a failed
  // change (owner report 2026-11-25: a created Bot was announced as "not created").
  try {
    appendManaged(ctx, context, code, target, extra);
  } catch (error) {
    ctx.logger.warn(
      JSON.stringify({
        module: "pi_manager",
        event: "audit_failed",
        code,
        reason: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

function appendManaged(
  ctx: CapabilityContext,
  context: ToolRunContext,
  code: ManagedCode,
  target: string,
  extra: { fields?: string[]; groupId?: string; targetBotName?: string },
) {
  ctx.local.approvals.audit.append({
    botId: context.botId,
    runId: context.runId,
    kind: "pi.managed",
    summary: `Pi ${code.replace("_", " ")} / Pi 管理 Bot 和群组`,
    detail: {
      // The person approved it (card or Pi's own "always"); Pi carried it out.
      actor: "automatic",
      reasonCode: code,
      target: ctx.redactor.redact(target).slice(0, 200),
      ...(extra.fields?.length ? { fields: extra.fields } : {}),
      ...(extra.groupId ? { groupId: extra.groupId } : {}),
      ...(extra.targetBotName
        ? { targetBotName: ctx.redactor.redact(extra.targetBotName).slice(0, 200) }
        : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    },
  });
}

export function teamList(ctx: CapabilityContext, context: ToolRunContext, input: unknown) {
  const args = piManagerTools.team_list.schema.parse(input);
  const busy = new PiDispatchesRepo(ctx.db).busy();
  const language = context.language;
  const bots = allBots(ctx.db, args.includeArchived === true).map((bot) => ({
    id: bot.id,
    name: bot.name,
    ...(bot.isMain ? { you: true } : {}),
    kind: bot.kind === "agent" ? "external_agent" : bot.category,
    role: oneLine(bot.description ?? "", 160),
    model: bot.modelProvider && bot.modelId ? `${bot.modelProvider}/${bot.modelId}` : "default",
    state: bot.archivedAt ? "archived" : busy.bots.has(bot.id) ? "busy" : "idle",
  }));
  const groups = allGroups(ctx.db, args.includeArchived === true).map((group) => ({
    id: group.id,
    name: group.name,
    coordinator: botName(ctx.db, group.coordinatorBotId),
    members: group.members.map((member) => botName(ctx.db, member.botId)),
    state: group.archivedAt
      ? "archived"
      : group.paused
        ? "paused"
        : busy.groups.has(group.id)
          ? "busy"
          : "idle",
  }));
  return {
    text: JSON.stringify({ bots, groups }),
    summary: say(
      language,
      `${bots.length} 个 Bot、${groups.length} 个群组`,
      `${bots.length} Bots, ${groups.length} groups`,
    ),
  };
}

export async function botManage(
  ctx: CapabilityContext,
  context: ToolRunContext,
  input: unknown,
): Promise<LocalToolResult> {
  const language = context.language;
  try {
    const a = piManagerTools.bot_manage.schema.parse(input);
    if (a.action === "create") {
      if (!a.name || !a.role)
        return refusal(say(language, "新建 Bot 需要 name 和 role", "create needs name and role"));
      const model = parseModel(a.model);
      if (a.model !== undefined && model === undefined)
        return refusal(
          say(
            language,
            "model 要写成「服务商/模型」或 default",
            'model must be "provider/model-id" or "default"',
          ),
        );
      // Idempotent: a retried or repeated request finds the Bot it already made, never a twin.
      const existing = activeBotNamed(ctx, a.name);
      if (existing?.isMain)
        return refusal(
          say(language, "这个名字和你自己重了，换一个名字", "That is your own name; pick another"),
        );
      if (existing)
        return done(
          say(
            language,
            `已经有一个叫「${existing.name}」的 Bot（id ${existing.id}），没有重复新建；要改它就用 update`,
            `A Bot named "${existing.name}" already exists (id ${existing.id}); nothing new was created. Use update to change it`,
          ),
          say(language, `${existing.name} 已存在`, `${existing.name} already exists`),
        );
      let bot: Bot;
      try {
        bot = await ctx.bots.create({
          name: a.name,
          description: a.role,
          category: "chat",
          ...(a.persona ? { systemPrompt: a.persona } : {}),
          ...(model ? { model } : {}),
          ...(a.color ? { avatarColor: a.color } : {}),
        });
      } catch (error) {
        // Honest outcome: a failure after the Bot was committed (a notice, a follow-up write)
        // still means the Bot exists, and Pi must say so.
        const created = activeBotNamed(ctx, a.name);
        if (!created || created.isMain) throw error;
        bot = created;
      }
      auditManaged(ctx, context, "bot_created", bot.name);
      return done(
        say(
          language,
          `已新建 Bot「${bot.name}」（id ${bot.id}）`,
          `Created the Bot "${bot.name}" (id ${bot.id})`,
        ),
        say(language, `新建了 ${bot.name}`, `Created ${bot.name}`),
      );
    }
    const bot = findBot(ctx.db, a.bot);
    if (!bot)
      return refusal(
        say(
          language,
          `找不到 Bot「${a.bot ?? ""}」；先用 team_list 看名字`,
          `No Bot "${a.bot ?? ""}"; use team_list for names`,
        ),
      );
    // Pi never changes itself: its permissions and persona are the person's own.
    if (bot.isMain)
      return refusal(
        say(language, "不能修改你自己（默认 Pi）", "You cannot change yourself (the default Pi)"),
      );
    if (a.action === "archive") {
      if (bot.archivedAt) return done(say(language, "它已经归档了", "Already archived"), bot.name);
      await ctx.bots.archive(bot.id);
      auditManaged(ctx, context, "bot_archived", bot.name);
      return done(
        say(
          language,
          `已归档「${bot.name}」，30 天内可以恢复`,
          `Archived "${bot.name}"; it can be restored within 30 days`,
        ),
        say(language, `归档了 ${bot.name}`, `Archived ${bot.name}`),
      );
    }
    if (a.action === "restore") {
      if (!bot.archivedAt) return done(say(language, "它没有归档", "It is not archived"), bot.name);
      await ctx.bots.restore(bot.id);
      auditManaged(ctx, context, "bot_restored", bot.name);
      return done(
        say(language, `已恢复「${bot.name}」`, `Restored "${bot.name}"`),
        say(language, `恢复了 ${bot.name}`, `Restored ${bot.name}`),
      );
    }
    if (bot.archivedAt)
      return refusal(say(language, "它已归档；先恢复再改", "It is archived; restore it first"));
    const model = parseModel(a.model);
    if (a.model !== undefined && model === undefined)
      return refusal(
        say(
          language,
          "model 要写成「服务商/模型」或 default",
          'model must be "provider/model-id" or "default"',
        ),
      );
    if (bot.kind === "agent" && (a.persona !== undefined || a.model !== undefined))
      return refusal(
        say(
          language,
          "外部 Agent 用自己的程序和模型，只能改名字和角色",
          "External agents use their own program and model; only name and role can change",
        ),
      );
    if (model) {
      const available = await ctx.agent.listModels({ availableOnly: true });
      if (!available.some((m) => m.provider === model.provider && m.id === model.id))
        return refusal(say(language, "这个模型现在不可用", "That model is not available"));
    }
    // Only these fields: permissions, policy levels and every other setting are not Pi's to change.
    const patch = {
      ...(a.name !== undefined ? { name: a.name } : {}),
      ...(a.role !== undefined ? { description: a.role } : {}),
      ...(a.persona !== undefined ? { systemPrompt: a.persona } : {}),
      ...(model !== undefined
        ? { modelProvider: model?.provider ?? null, modelId: model?.id ?? null }
        : {}),
      ...(a.color !== undefined ? { avatarColor: a.color } : {}),
    };
    const fields = Object.keys(patch);
    if (!fields.length) return refusal(say(language, "没有要改的内容", "Nothing to change"));
    const updated = await ctx.bots.update({ botId: bot.id, ...patch });
    auditManaged(ctx, context, "bot_updated", updated.name, { fields });
    return done(
      say(
        language,
        `已修改「${updated.name}」：${fields.join("、")}`,
        `Updated "${updated.name}": ${fields.join(", ")}`,
      ),
      say(language, `修改了 ${updated.name}`, `Edited ${updated.name}`),
    );
  } catch (error) {
    return managerFailure(ctx, language, error, "bot_manage");
  }
}

export async function groupManage(
  ctx: CapabilityContext,
  context: ToolRunContext,
  input: unknown,
): Promise<LocalToolResult> {
  const language = context.language;
  const parsed = piManagerTools.group_manage.schema.safeParse(input);
  if (!parsed.success) return managerFailure(ctx, language, parsed.error, "group_manage");
  const a = parsed.data;
  const members = (refs: readonly string[] | undefined) => {
    const found = (refs ?? []).map((ref) => ({ ref, bot: findBot(ctx.db, ref) }));
    const unknown = found.filter((entry) => !entry.bot || entry.bot.archivedAt);
    return { bots: found.flatMap((entry) => (entry.bot ? [entry.bot] : [])), unknown };
  };
  try {
    if (a.action === "create") {
      const { bots, unknown } = members(a.members);
      if (!a.name || bots.length < 2 || bots.length > 6)
        return refusal(
          say(language, "建群需要 name 和 2–6 个成员", "create needs a name and 2–6 members"),
        );
      if (unknown.length)
        return refusal(
          say(
            language,
            `找不到或已归档：${unknown.map((entry) => entry.ref).join("、")}`,
            `Not found or archived: ${unknown.map((entry) => entry.ref).join(", ")}`,
          ),
        );
      const coordinator = a.coordinator ? findBot(ctx.db, a.coordinator) : bots[0];
      if (!coordinator || !bots.some((bot) => bot.id === coordinator.id))
        return refusal(
          say(language, "协调者必须是成员之一", "The coordinator must be one of the members"),
        );
      const botIds = [...new Set(bots.map((bot) => bot.id))];
      const sameGroup = (group: { name: string; members: { botId: string }[] }) =>
        group.name.trim().toLowerCase() === a.name?.trim().toLowerCase() &&
        group.members.length === botIds.length &&
        group.members.every((member) => botIds.includes(member.botId));
      // Idempotent: the same group (name and members) asked for again is the one already made.
      const existing = allGroups(ctx.db, false).find(sameGroup);
      if (existing)
        return done(
          say(
            language,
            `已经有这个群「${existing.name}」（id ${existing.id}），成员相同，没有重复新建`,
            `The group "${existing.name}" (id ${existing.id}) already exists with these members; nothing new was created`,
          ),
          say(language, `${existing.name} 已存在`, `${existing.name} already exists`),
        );
      let group: { id: string; name: string };
      try {
        group = ctx.groups.create({
          name: a.name,
          botIds,
          coordinatorBotId: coordinator.id,
          ...(a.rules ? { announcement: a.rules } : {}),
        });
      } catch (error) {
        // A failure after the group was committed still means it exists; say so honestly.
        const created = allGroups(ctx.db, false).find(sameGroup);
        if (!created) throw error;
        group = created;
      }
      auditManaged(ctx, context, "group_created", group.name, { groupId: group.id });
      return done(
        say(
          language,
          `已建群「${group.name}」（id ${group.id}）`,
          `Created the group "${group.name}" (id ${group.id})`,
        ),
        say(language, `建了群 ${group.name}`, `Created ${group.name}`),
      );
    }
    const group = findGroup(ctx.db, a.group);
    if (!group)
      return refusal(
        say(
          language,
          `找不到群组「${a.group ?? ""}」；先用 team_list 看名字`,
          `No group "${a.group ?? ""}"; use team_list for names`,
        ),
      );
    if (a.action === "archive" || a.action === "restore") {
      const archive = a.action === "archive";
      if (!!group.archivedAt === archive)
        return done(say(language, "不需要改", "Nothing to change"), group.name);
      if (archive) await ctx.groups.archive(group.id);
      else await ctx.groups.restore(group.id);
      auditManaged(ctx, context, archive ? "group_archived" : "group_restored", group.name, {
        groupId: group.id,
      });
      return done(
        archive
          ? say(language, `已归档群组「${group.name}」`, `Archived the group "${group.name}"`)
          : say(language, `已恢复群组「${group.name}」`, `Restored the group "${group.name}"`),
        archive
          ? say(language, `归档了 ${group.name}`, `Archived ${group.name}`)
          : say(language, `恢复了 ${group.name}`, `Restored ${group.name}`),
      );
    }
    if (group.archivedAt)
      return refusal(
        say(language, "群组已归档；先恢复再改", "The group is archived; restore it first"),
      );
    const { bots, unknown } = members(a.members);
    if (!bots.length || unknown.length)
      return refusal(
        say(
          language,
          `找不到或已归档：${unknown.map((entry) => entry.ref).join("、") || "—"}`,
          `Not found or archived: ${unknown.map((entry) => entry.ref).join(", ") || "—"}`,
        ),
      );
    if (bots.some((bot) => bot.isMain))
      return refusal(
        say(
          language,
          "你自己的群成员身份由用户来改",
          "Only the person changes your own group membership",
        ),
      );
    const add = a.action === "add_members";
    const changed: string[] = [];
    for (const bot of bots) {
      const member = group.members.some((entry) => entry.botId === bot.id);
      if (add === member) continue;
      if (add) await ctx.groups.addMember(group.id, bot.id);
      else await ctx.groups.removeMember(group.id, bot.id);
      changed.push(bot.name);
    }
    if (changed.length)
      auditManaged(
        ctx,
        context,
        add ? "group_members_added" : "group_members_removed",
        group.name,
        {
          groupId: group.id,
          targetBotName: changed.join(", "),
        },
      );
    return done(
      changed.length
        ? say(
            language,
            `${add ? "已加入" : "已移出"}：${changed.join("、")}`,
            `${add ? "Added" : "Removed"}: ${changed.join(", ")}`,
          )
        : say(language, "成员没有变化", "Members unchanged"),
      say(language, `调整了 ${group.name} 的成员`, `Changed ${group.name}'s members`),
    );
  } catch (error) {
    return managerFailure(ctx, language, error, "group_manage");
  }
}
