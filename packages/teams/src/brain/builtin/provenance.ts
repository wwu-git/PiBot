import type { DatabaseSync } from "node:sqlite";
import { type SkillsPort, textFingerprint } from "@pibot/brain/kit";
import type { Level, TeamTemplate } from "@pibot/protocol";
import { BotsRepo, GroupsRepo } from "@pibot/storage";
import { BuiltinBaselinesRepo } from "../../store/index.ts";
import type { TeamSkillPackage } from "../teams/team-archive.ts";

export interface ProvenanceDeps {
  db: DatabaseSync;
  language: "zh" | "en";
  skills: Pick<SkillsPort, "inventory">;
  signal: AbortSignal;
  warn(message: string): void;
}

/**
 * Provenance for a later「采用新版」— the values each new Bot and group actually got
 * (after tightening and model fit) and the fingerprint of each skill as saved. Written right
 * after the skills are copied; a failure only means a later update falls back to the history.
 */
export async function recordBaselines(
  deps: ProvenanceDeps,
  template: TeamTemplate,
  skills: readonly TeamSkillPackage[][],
  result: { refs: Map<string, string>; created: string[]; groupIds: string[] },
  templateIds: readonly string[],
) {
  const repo = new BuiltinBaselinesRepo(deps.db);
  const bots = new BotsRepo(deps.db);
  for (const [index, entry] of template.bots.entries()) {
    const botId = result.refs.get(entry.ref);
    const bot = botId && result.created.includes(botId) ? bots.get(botId) : undefined;
    if (!bot?.role || !entry.role) continue;
    const packages = skills[index] ?? [];
    try {
      const saved = new Map(
        (packages.length ? await deps.skills.inventory(bot.id, deps.signal) : []).map((row) => [
          row.folder,
          row,
        ]),
      );
      const {
        network: _network,
        confirmEverySend: _confirm,
        ...levels
      } = bot.permissionOverrides ?? {};
      repo.setBot(bot.id, entry.role.id, entry.role.version, {
        language: deps.language,
        thinkingLevel: bot.thinkingLevel,
        permissionOverrides: Object.fromEntries(
          Object.entries(levels).filter((pair): pair is [string, Level] => !!pair[1]),
        ),
        norms: textFingerprint(bot.norms ?? ""),
        skills: packages.flatMap((pkg) => {
          const row = saved.get(pkg.folder);
          return row?.fingerprint
            ? [
                {
                  skillId: row.id,
                  folder: pkg.folder,
                  fingerprint: row.fingerprint,
                  ...(row.version ? { version: row.version } : {}),
                },
              ]
            : [];
        }),
      });
    } catch {
      deps.warn(JSON.stringify({ module: "builtin", event: "baseline_skipped", botId: bot.id }));
    }
  }
  const groups = new GroupsRepo(deps.db);
  result.groupIds.forEach((groupId, index) => {
    const entry = template.groups[index];
    const templateId = templateIds[index];
    const group = groups.get(groupId);
    if (!entry?.template || !templateId || !group) return;
    repo.setGroup(groupId, templateId, entry.template.version, {
      language: deps.language,
      coordinatorBotId: group.coordinatorBotId,
      announcement: textFingerprint(group.announcement),
      autoRoundLimit: group.autoRoundLimit,
      members: entry.members,
      // The template's own starters: a profession's extra starter is not part of the template.
      quickStarts: textFingerprint(JSON.stringify(entry.quickStarts ?? [])),
    });
  });
}
