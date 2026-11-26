// What the default Pi's approval cards list: exactly what changes, field by field.
import type { DatabaseSync } from "node:sqlite";
import type { ToolCardDescriber } from "@pibot/brain/kit";
import type { ApprovalFact } from "@pibot/protocol";
import { BotsRepo } from "@pibot/storage";
import { piManagerTools } from "@pibot/teams-contract";
import { botName, findBot, findGroup, type Language, oneLine, parseModel, say } from "./lookup.ts";

type BotArgs = ReturnType<typeof piManagerTools.bot_manage.schema.parse>;
type GroupArgs = ReturnType<typeof piManagerTools.group_manage.schema.parse>;
type SendArgs = ReturnType<typeof piManagerTools.send_to_bot.schema.parse>;

const row = (label: string, value: string): ApprovalFact => ({
  kind: "write",
  label,
  value: value.trim() || "—",
});

function piName(db: DatabaseSync) {
  return new BotsRepo(db).getMain()?.name ?? "Pi";
}

function modelText(language: Language, value: string | undefined) {
  const model = parseModel(value);
  if (model === null || value === undefined) return say(language, "跟随默认模型", "Default model");
  return model ? `${model.provider} / ${model.id}` : value;
}

function missing(language: Language, ref: string | undefined, group = false): ApprovalFact {
  return {
    kind: "warning",
    value: say(
      language,
      `找不到${group ? "群组" : " Bot "}「${ref ?? ""}」，允许后这一步会被拒绝`,
      `No ${group ? "group" : "Bot"} named "${ref ?? ""}"; this step will be refused`,
    ),
  };
}

/** A step that cannot succeed as written: no card, the model hears exactly why. */
function invalid(language: Language, code: string, zh: string, en: string) {
  return {
    code,
    text: `${language === "zh" ? "没有完成" : "Not done"} [${code}]: ${say(language, zh, en)}`,
  };
}

/** Members that are not an active Bot of this person, by the name the model used. */
function unknownMembers(db: DatabaseSync, refs: readonly string[] | undefined) {
  return (refs ?? []).filter((ref) => {
    const bot = findBot(db, ref);
    return !bot || !!bot.archivedAt;
  });
}

export function botCard(db: DatabaseSync): ToolCardDescriber {
  return (_context, input, language) => {
    const args = piManagerTools.bot_manage.schema.safeParse(input);
    const pi = piName(db);
    if (!args.success)
      return {
        title: say(language, `${pi} 想管理一个 Bot`, `${pi} wants to manage a Bot`),
        facts: [],
      };
    const a: BotArgs = args.data;
    const label = (zh: string, en: string) => say(language, zh, en);
    if (a.action === "create")
      return {
        title: label(`${pi} 想新建一个 Bot`, `${pi} wants to create a Bot`),
        lead: label(
          "新建后可以随时在 Bot 资料里改，或者归档。",
          "You can edit it in its profile or archive it any time.",
        ),
        facts: [
          row(label("名字", "Name"), a.name ?? label("由模型起名", "Named by the model")),
          row(label("角色", "Role"), oneLine(a.role ?? "", 300)),
          ...(a.persona ? [row(label("人设", "Persona"), oneLine(a.persona, 200))] : []),
          row(label("模型", "Model"), modelText(language, a.model)),
          row(
            label("权限", "Permissions"),
            label(
              `跟随全局设置（${pi} 不能改任何 Bot 的权限）`,
              `Global defaults (${pi} cannot change any Bot's permissions)`,
            ),
          ),
        ],
      };
    const bot = findBot(db, a.bot);
    const name = bot?.name ?? a.bot ?? "";
    if (!bot || bot.isMain)
      return {
        title: label(`${pi} 想修改 Bot「${name}」`, `${pi} wants to change the Bot "${name}"`),
        facts: [missing(language, a.bot)],
        invalid: bot
          ? invalid(
              language,
              "pi_self",
              "不能修改你自己（默认 Pi）",
              "You cannot change yourself (the default Pi)",
            )
          : invalid(
              language,
              "pi_bot_unknown",
              `没有叫「${a.bot ?? ""}」的 Bot；先用 team_list 看名字，或问用户是不是要先新建`,
              `No Bot named "${a.bot ?? ""}"; check team_list, or ask the person whether to create it first`,
            ),
      };
    if (a.action === "update") {
      const changes: ApprovalFact[] = [];
      if (a.name !== undefined && a.name !== bot.name)
        changes.push(row(label("名字", "Name"), `${bot.name} → ${a.name}`));
      if (a.role !== undefined)
        changes.push(
          row(
            label("角色", "Role"),
            `${oneLine(bot.description ?? "", 120) || "—"} → ${oneLine(a.role, 200)}`,
          ),
        );
      if (a.persona !== undefined)
        changes.push(
          row(
            label("人设", "Persona"),
            label(
              `换成新的人设（${a.persona.length} 字）：${oneLine(a.persona, 120)}`,
              `New persona (${a.persona.length} characters): ${oneLine(a.persona, 120)}`,
            ),
          ),
        );
      if (a.model !== undefined) {
        const before =
          bot.modelProvider && bot.modelId
            ? `${bot.modelProvider} / ${bot.modelId}`
            : label("跟随默认模型", "Default model");
        changes.push(row(label("模型", "Model"), `${before} → ${modelText(language, a.model)}`));
      }
      return {
        title: label(
          `${pi} 想修改 Bot「${bot.name}」`,
          `${pi} wants to edit the Bot "${bot.name}"`,
        ),
        lead: label(
          "只改下面这些；权限和其他设置不变。",
          "Only what is listed changes; permissions and other settings stay.",
        ),
        facts: changes.length
          ? changes
          : [{ kind: "warning", value: label("没有要改的内容", "Nothing to change") }],
      };
    }
    const archive = a.action === "archive";
    return {
      title: archive
        ? label(`${pi} 想归档 Bot「${bot.name}」`, `${pi} wants to archive the Bot "${bot.name}"`)
        : label(`${pi} 想恢复 Bot「${bot.name}」`, `${pi} wants to restore the Bot "${bot.name}"`),
      lead: archive
        ? label(
            "归档后它不在列表里出现，聊天和资料都保留，30 天内可以恢复。",
            "It leaves the list; its chats and profile are kept and it can be restored within 30 days.",
          )
        : label("恢复后它回到列表里，可以继续聊。", "It returns to the list and can chat again."),
      facts: [
        row("Bot", bot.name),
        ...(bot.description ? [row(label("角色", "Role"), oneLine(bot.description, 200))] : []),
      ],
    };
  };
}

export function groupCard(db: DatabaseSync): ToolCardDescriber {
  return (_context, input, language) => {
    const args = piManagerTools.group_manage.schema.safeParse(input);
    const pi = piName(db);
    const label = (zh: string, en: string) => say(language, zh, en);
    if (!args.success)
      return { title: label(`${pi} 想管理一个群组`, `${pi} wants to manage a group`), facts: [] };
    const a: GroupArgs = args.data;
    const names = (refs: readonly string[] | undefined) =>
      (refs ?? [])
        .map((ref) => findBot(db, ref)?.name ?? `${ref}${label("（找不到）", " (not found)")}`)
        .join(label("、", ", "));
    const unknown = unknownMembers(db, a.members);
    // Never ask the person to approve a group with someone who is not there (owner 2026-11-25).
    const memberProblem = unknown.length
      ? invalid(
          language,
          "pi_member_unknown",
          `这些还没有（或已归档）：${unknown.join("、")}。问用户：先用 bot_manage 新建它们，还是不带它们`,
          `Not an active Bot: ${unknown.join(", ")}. Ask the person: create them first with bot_manage, or leave them out`,
        )
      : undefined;
    if (a.action === "create") {
      const coordinator = a.coordinator ? findBot(db, a.coordinator) : findBot(db, a.members?.[0]);
      const count = new Set((a.members ?? []).map((ref) => findBot(db, ref)?.id ?? ref)).size;
      const createProblem =
        memberProblem ??
        (!a.name || count < 2 || count > 6
          ? invalid(
              language,
              "pi_group_shape",
              "建群需要群名和 2–6 个成员",
              "A group needs a name and 2–6 members",
            )
          : a.coordinator &&
              (!coordinator ||
                !(a.members ?? []).some((ref) => findBot(db, ref)?.id === coordinator.id))
            ? invalid(
                language,
                "pi_coordinator_not_member",
                "协调者必须是成员之一",
                "The coordinator must be one of the members",
              )
            : undefined);
      const members = (a.members ?? []).map((ref) => {
        const bot = findBot(db, ref);
        const name = bot?.name ?? `${ref}${label("（找不到）", " (not found)")}`;
        return bot && coordinator?.id === bot.id
          ? `${name}${label("（协调）", " (coordinator)")}`
          : name;
      });
      return {
        title: label(`${pi} 想建一个群组`, `${pi} wants to create a group`),
        lead: label(
          "建好后你也可以自己加人、改名或归档。",
          "You can add people, rename or archive it yourself later.",
        ),
        ...(createProblem ? { invalid: createProblem } : {}),
        facts: [
          row(label("群名", "Name"), a.name ?? ""),
          row(label("成员", "Members"), members.join(label("、", ", "))),
          ...(a.rules ? [row(label("群规", "Rules"), oneLine(a.rules, 200))] : []),
          row(
            label("工作位置", "Work folder"),
            label(
              "群组自己的文件夹（之后可以在群设置里改）",
              "The group's own folder (change it in group settings)",
            ),
          ),
        ],
      };
    }
    const group = findGroup(db, a.group);
    if (!group)
      return {
        title: label(
          `${pi} 想修改群组「${a.group ?? ""}」`,
          `${pi} wants to change the group "${a.group ?? ""}"`,
        ),
        facts: [missing(language, a.group, true)],
        invalid: invalid(
          language,
          "pi_group_unknown",
          `没有叫「${a.group ?? ""}」的群组；先用 team_list 看名字`,
          `No group named "${a.group ?? ""}"; check team_list for names`,
        ),
      };
    if (a.action === "add_members" || a.action === "remove_members") {
      const add = a.action === "add_members";
      return {
        ...(memberProblem ? { invalid: memberProblem } : {}),
        title: add
          ? label(
              `${pi} 想给群组「${group.name}」加成员`,
              `${pi} wants to add members to "${group.name}"`,
            )
          : label(
              `${pi} 想从群组「${group.name}」移出成员`,
              `${pi} wants to remove members from "${group.name}"`,
            ),
        lead: add
          ? label("新成员从下一条消息开始参与。", "New members join from the next message.")
          : label(
              "移出的 Bot 本身不受影响，只是不再参与这个群。",
              "The removed Bots themselves are unchanged; they just leave this group.",
            ),
        facts: [
          row(label("群组", "Group"), group.name),
          row(
            label("现在的成员", "Members now"),
            group.members.map((member) => botName(db, member.botId)).join(label("、", ", ")),
          ),
          row(add ? label("加入", "Add") : label("移出", "Remove"), names(a.members)),
        ],
      };
    }
    const archive = a.action === "archive";
    return {
      title: archive
        ? label(
            `${pi} 想归档群组「${group.name}」`,
            `${pi} wants to archive the group "${group.name}"`,
          )
        : label(
            `${pi} 想恢复群组「${group.name}」`,
            `${pi} wants to restore the group "${group.name}"`,
          ),
      lead: archive
        ? label(
            "归档会停下群里进行中的工作；聊天记录保留，随时可以恢复。",
            "Archiving stops the group's ongoing work; its chats are kept and it can be restored any time.",
          )
        : label("恢复后群组回到列表里。", "The group returns to the list."),
      facts: [
        row(label("群组", "Group"), group.name),
        row(
          label("成员", "Members"),
          group.members.map((member) => botName(db, member.botId)).join(label("、", ", ")),
        ),
      ],
    };
  };
}

export function sendCard(db: DatabaseSync, kind: "bot" | "group"): ToolCardDescriber {
  return (_context, input, language) => {
    const label = (zh: string, en: string) => say(language, zh, en);
    const pi = piName(db);
    const schema =
      kind === "bot" ? piManagerTools.send_to_bot.schema : piManagerTools.send_to_group.schema;
    const args = schema.safeParse(input);
    if (!args.success)
      return { title: label(`${pi} 想派一项工作`, `${pi} wants to assign a task`), facts: [] };
    const a = args.data as SendArgs & { group?: string };
    const ref = kind === "bot" ? a.bot : (a as unknown as { group: string }).group;
    const target = kind === "bot" ? findBot(db, ref) : findGroup(db, ref);
    const name = target?.name ?? ref;
    return {
      ...(!target || target.archivedAt
        ? {
            invalid: invalid(
              language,
              kind === "bot" ? "pi_bot_unknown" : "pi_group_unknown",
              `没有叫「${ref}」的${kind === "bot" ? " Bot" : "群组"}（或已归档）；先用 team_list 看名字`,
              `No active ${kind === "bot" ? "Bot" : "group"} named "${ref}"; check team_list for names`,
            ),
          }
        : {}),
      title: label(`${pi} 想给 ${name} 派一个任务`, `${pi} wants to send ${name} a task`),
      lead:
        kind === "bot"
          ? label(
              `${name} 会开一个标着「来自 ${pi}」的新话题，按它自己的权限做，做完 ${pi} 把结果带回这里。`,
              `${name} opens a new topic marked "from ${pi}", works under its own permissions, and ${pi} brings the result back here.`,
            )
          : label(
              `群里会开一个标着「来自 ${pi}」的新话题，协调者按群的正常流程安排，成员按各自的权限做，做完 ${pi} 把结果带回这里。`,
              `The group opens a new topic marked "from ${pi}"; its coordinator plans as usual, members work under their own permissions, and ${pi} brings the result back here.`,
            ),
      facts: [
        ...(target ? [] : [missing(language, ref, kind === "group")]),
        row(label("发给", "To"), `${name} · ${label("新话题", "new topic")}`),
        row(label("标题", "Title"), a.title),
        row(label("任务", "Task"), oneLine(a.task, 400)),
        row(
          label("回来", "Back"),
          label(
            "完成、失败、停止或等你确认时都会告诉你",
            "You'll hear when it finishes, fails, stops or needs you",
          ),
        ),
      ],
    };
  };
}
