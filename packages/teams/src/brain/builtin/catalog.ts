import type { BuiltinCatalog, BuiltinRoleView } from "@pibot/protocol";
import { type BuiltinContent, usesSkills } from "./load.ts";

/** The read-only catalog in the UI language, read from the role files. */
export function catalogView(
  content: BuiltinContent,
  language: "zh" | "en",
  models: { imageAvailable: boolean; vision: boolean },
): BuiltinCatalog {
  const roles: BuiltinRoleView[] = [];
  for (const [id, pack] of content.roles) {
    const team = pack[language];
    const bot = team.template.bots[0];
    if (!bot?.role?.name || !bot.role.category) continue;
    const { network: _network, confirmEverySend: _confirm, ...levels } = bot.permissionOverrides;
    const needs = bot.needs ?? { vision: false, imageGeneration: false };
    roles.push({
      id,
      version: bot.role.version,
      category: bot.role.category,
      name: bot.role.name,
      defaultBotName: bot.name,
      summary: bot.description.slice(0, 200),
      persona: bot.systemPrompt.slice(0, 4000),
      norms: (bot.norms ?? "").slice(0, 8000),
      avatar: { shape: bot.avatarShape, color: bot.avatarColor, eyes: bot.avatarEyes },
      botCategory: bot.category,
      ...(bot.imageMode ? { imageMode: bot.imageMode } : {}),
      // Only the command category may use the shipped sandboxed default.
      permissionOverrides: Object.fromEntries(
        Object.entries(levels).filter(
          ([category, level]) =>
            level === "ask" ||
            level === "never" ||
            (category === "run_command" && level === "always"),
        ),
      ),
      skills: usesSkills(bot)
        ? (team.skills[0] ?? []).map((skill) => ({
            id: skill.folder,
            name: skill.document.name,
            description: skill.document.description,
            files: skill.files.length,
            scripts: skill.files.filter((file) => file.script).length,
          }))
        : [],
      quickPrompts: bot.quickPrompts ?? [],
      quickPromptsByLanguage: {
        zh: pack.zh.template.bots[0]?.quickPrompts ?? [],
        en: pack.en.template.bots[0]?.quickPrompts ?? [],
      },
      needs,
      autoCheck: bot.autoCheck ?? false,
      ...(bot.category === "image" && !models.imageAvailable
        ? { unavailable: "no_image_model" as const }
        : {}),
      ...(needs.vision && !models.vision ? { visionWarning: true } : {}),
    });
  }
  return {
    language,
    roles,
    groups: [...content.groups].flatMap(([id, pack]) => {
      const group = pack[language].template.groups[0];
      if (!group?.template) return [];
      return [
        {
          id,
          version: group.template.version,
          name: group.name,
          summary: group.summary ?? "",
          coordinator: group.coordinator,
          members: group.members,
          announcement: group.announcement,
          welcome: group.welcome ?? "",
          quickStarts: group.quickStarts ?? [],
          autoRoundLimit: group.autoRoundLimit,
        },
      ];
    }),
    professions: content.professions.map((profession) => ({
      id: profession.id,
      name: profession.name[language],
      blurb: profession.blurb[language],
      icon: profession.icon,
      groups: profession.groups,
      roles: profession.roles,
      ...(profession.quickStart ? { quickStart: profession.quickStart[language] } : {}),
    })),
  };
}
