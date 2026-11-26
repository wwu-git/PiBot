/*
 * The Bot side of the built-in update flow: which roles have a newer version, what the plan looks
 * like, the steps that write it back, and the automatic pass that runs them.
 */
import type { SkillInventoryItem } from "@pibot/brain/kit";
import { type Bot, type Level, RpcError } from "@pibot/protocol";
import {
  BackgroundTaskHealthRepo,
  BotsRepo,
  GroupsRepo,
  PermissionsRepo,
  transaction,
} from "@pibot/storage";
import type { BuiltinChange } from "@pibot/teams-contract";
import {
  type BotRecovery,
  BuiltinBaselinesRepo,
  BuiltinRecoveriesRepo,
} from "../../../store/index.ts";
import type { TeamSkillPackage } from "../../teams/team-archive.ts";
import { type BotPlan, baselineAfter, planBotUpdate } from "../bot-update.ts";
import { groupOrigin } from "../group-update.ts";
import { roleFingerprint } from "../history.ts";
import type { BuiltinContent } from "../load.ts";
import {
  type Apply,
  audit,
  type BuiltinUpdateDeps,
  changed,
  counts,
  type Language,
  unavailable,
} from "./common.ts";

/**
 * The skills this Bot takes from its source. A Bot in a built-in group takes that
 * template's list for its role (a group may carry only some of a role's skills, and
 * nothing is filled back in from the role); otherwise it takes its role's own set.
 */
export function skillSource(
  deps: BuiltinUpdateDeps,
  bot: Bot & { role: NonNullable<Bot["role"]> },
  content: BuiltinContent,
  language: Language,
): TeamSkillPackage[] | undefined {
  if (bot.category === "image") return undefined;
  const groups = new GroupsRepo(deps.db);
  const bots = new BotsRepo(deps.db);
  const baselines = new BuiltinBaselinesRepo(deps.db);
  const found: TeamSkillPackage[] = [];
  const seen = new Set<string>();
  for (const groupId of groups.idsForBot(bot.id)) {
    const group = groups.get(groupId);
    if (!group) continue;
    const coordinator = bots.get(group.coordinatorBotId);
    const origin = groupOrigin(group, coordinator?.role?.id, content, baselines.group(groupId));
    const pack = origin && content.groups.get(origin.templateId);
    if (!pack) continue;
    const team = pack[language];
    const index = team.template.bots.findIndex((entry) => entry.role?.id === bot.role.id);
    if (index < 0) continue;
    for (const pkg of team.skills[index] ?? []) {
      if (seen.has(pkg.folder)) continue;
      seen.add(pkg.folder);
      found.push(pkg);
    }
  }
  return found.length ? found : undefined;
}

export async function botPlan(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  botId: string,
  force = false,
) {
  const bot = new BotsRepo(deps.db).get(botId);
  if (!bot || bot.archivedAt || bot.isMain || !bot.role) return undefined;
  const role = bot.role;
  const content = await deps.builtin.content();
  const pack = content.roles.get(role.id);
  const version = pack?.zh.template.bots[0]?.role?.version ?? 0;
  if (!pack || version <= role.version) return undefined;
  const stored = new BuiltinBaselinesRepo(deps.db).bot(botId);
  // Each port call gets its own budget: a slow step must not spend the next step's timeout.
  // Shared imports cannot be shipped role copies. Keep their rows for collisions without
  // rehashing unrelated packages on every preview, apply, and baseline calculation.
  const inventory =
    bot.category === "image"
      ? []
      : await deps.skills().inventory(botId, signal(), { skipSharedContent: true });
  const model =
    bot.modelProvider && bot.modelId ? await deps.model(bot.modelProvider, bot.modelId) : undefined;
  const plan = planBotUpdate({
    bot: { ...bot, role },
    ...(model ? { model } : {}),
    pack,
    target: roleFingerprint(pack),
    ...(content.history ? { history: content.history } : {}),
    ...(stored ? { stored } : {}),
    inventory,
    global: new PermissionsRepo(deps.db).get().levels,
    language: deps.language(),
    redact: (text) => deps.redactor.redact(text),
    ...(force ? { force } : {}),
    packages: (language) => skillSource(deps, { ...bot, role }, content, language),
  });
  const name = pack[deps.language()].template.bots[0]?.role?.name ?? role.id;
  return { bot, role, plan, stored, name, inventory };
}

/** Builds what「恢复上一版」would write back for one Bot: its own values, now. */
export async function snapshotBot(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  bot: Bot,
  language: Language,
  inventory: readonly SkillInventoryItem[],
): Promise<BotRecovery> {
  const team = new Set(inventory.filter((row) => row.source === "team").map((row) => row.folder));
  const packages = team.size
    ? (await deps.skills().exportPackages(bot.id, signal(), undefined, { source: "team" })).filter(
        (pkg) => team.has(pkg.folder),
      )
    : [];
  return {
    kind: "bot",
    language,
    norms: bot.norms ?? "",
    thinkingLevel: bot.thinkingLevel,
    permissionOverrides: Object.fromEntries(
      Object.entries(bot.permissionOverrides ?? {}).filter(
        (pair): pair is [string, Level] => pair[0] !== "confirmEverySend" && !!pair[1],
      ),
    ),
    skills: packages.map((pkg) => ({
      folder: pkg.folder,
      enabled: pkg.enabled,
      document: pkg.document,
      files: pkg.files.map((file) => ({
        path: file.path,
        data: file.data.toString("base64"),
        text: file.text,
        script: file.script,
      })),
    })),
  };
}

export async function applyBot(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  botId: string,
  params: Apply,
) {
  const found = await botPlan(deps, signal, botId);
  if (!found) throw unavailable();
  const { plan, role } = found;
  if (plan.toVersion !== params.toVersion || plan.revision !== params.revision) throw changed();
  const failed = await runBot(deps, signal, botId, role, plan, false);
  return { ok: true as const, failed };
}

export async function runBot(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  botId: string,
  role: NonNullable<Bot["role"]>,
  plan: BotPlan,
  automatic: boolean,
) {
  const failed: BuiltinChange[] = [];
  const lines = (item: BuiltinChange["item"]) => plan.changes.filter((c) => c.item === item);
  const step = async (what: BuiltinChange[], action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      if (error instanceof RpcError && error.message === "bot_norms_changed") throw changed();
      deps.logger.warn(
        JSON.stringify({
          module: "builtin",
          event: "update_step_failed",
          botId,
          items: what.map((c) => c.item),
        }),
      );
      failed.push(...what);
    }
  };
  const { norms, expectedNorms, thinkingLevel } = plan.patch;
  if (norms !== undefined && expectedNorms !== undefined)
    await step(lines("norms"), () => deps.bots.update({ botId, norms, expectedNorms }));
  // Separate from norms: a model that is unavailable right now must not block the norms.
  if (thinkingLevel)
    await step(lines("thinking"), () => deps.bots.update({ botId, thinkingLevel }));
  if (Object.keys(plan.permissions).length)
    await step(lines("permission"), () =>
      deps.permissions.set({ botId, levels: plan.permissions }),
    );
  const added = new Map<string, string>();
  for (const skill of plan.skills) {
    const line = plan.changes.filter((c) => c.item === "skill" && c.name === skill.name);
    await step(line, async () => {
      const skills = deps.skills();
      if (skill.action === "add") {
        const saved = await skills.create(botId, skill.pkg.document, "team", {
          enabled: skill.pkg.enabled,
          files: skill.pkg.files,
          folder: skill.pkg.folder,
        });
        added.set(skill.pkg.folder, saved.id);
      } else if (skill.action === "update")
        await skills.replace(botId, skill.skillId, skill.pkg.document, skill.pkg.files);
      else await skills.remove(botId, skill.skillId);
    });
  }
  if (!failed.length) await finishBot(deps, signal, botId, role, plan, added, automatic);
  else
    audit(
      deps,
      botId,
      {
        reasonCode: "partial",
        target: `${role.id}@${plan.fromVersion}->${plan.toVersion}`,
        reason: counts(failed, []),
      },
      "Built-in role update incomplete / 内置角色更新未完成",
    );
  // A role whose steps keep failing (a rejected write, a broken package) used to be
  // visible only in the audit log; this streak is what the inbox card reports.
  const health = new BackgroundTaskHealthRepo(deps.db, () => deps.peer.emit("inbox.changed", {}));
  if (failed.length) health.fail("builtin_update", botId, "update_step_failed");
  else health.recover("builtin_update", botId);
  deps.peer.emit("bots.changed", { botId, reason: "updated" });
  return failed;
}

export async function finishBot(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  botId: string,
  role: NonNullable<Bot["role"]>,
  plan: BotPlan,
  added: Map<string, string>,
  automatic: boolean,
) {
  const inventory = plan.target.folders.length
    ? await deps.skills().inventory(botId, signal(), { skipSharedContent: true })
    : [];
  transaction(deps.db, () => {
    const bots = new BotsRepo(deps.db);
    const bot = bots.get(botId);
    if (!bot || bot.archivedAt) throw unavailable();
    bots.update(botId, { role: { id: role.id, version: plan.toVersion } });
    new BuiltinBaselinesRepo(deps.db).setBot(
      botId,
      role.id,
      plan.toVersion,
      baselineAfter(plan, bot, added, inventory),
    );
    const target = `${role.id}@${plan.fromVersion}->${plan.toVersion}`;
    audit(
      deps,
      botId,
      {
        reasonCode: automatic ? "auto" : "adopted",
        target,
        reason: counts(plan.changes, plan.kept),
      },
      automatic
        ? "Built-in role updated automatically / 内置角色已自动更新"
        : "Built-in role updated / 内置角色已更新",
    );
    for (const line of plan.changes)
      if (line.item === "permission" && line.category)
        audit(
          deps,
          botId,
          {
            reasonCode: "permission",
            target,
            category: line.category,
            reason: `${line.from}->${line.to}`,
          },
          "Built-in permission updated / 内置权限已更新",
        );
  });
}

export async function autoBot(deps: BuiltinUpdateDeps, signal: () => AbortSignal, botId: string) {
  const found = await botPlan(deps, signal, botId, true);
  if (!found) return;
  const { bot, role, plan, stored, inventory } = found;
  if ((stored?.dismissedVersion ?? 0) >= plan.toVersion) return;
  if (plan.changes.length)
    new BuiltinRecoveriesRepo(deps.db).setBot(
      botId,
      role.id,
      plan.fromVersion,
      plan.toVersion,
      await snapshotBot(deps, signal, bot, plan.language, inventory),
    );
  await runBot(deps, signal, botId, role, plan, true);
}
