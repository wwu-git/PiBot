import { type SkillInventoryItem, skillFingerprint, textFingerprint } from "@pibot/brain/kit";
import {
  type Bot,
  type Category,
  CategorySchema,
  isPiManagerCategory,
  type Level,
  type ModelInfo,
  type PermissionLevels,
  tightenOverrides,
} from "@pibot/protocol";
import type { BuiltinChange } from "@pibot/teams-contract";
import type { BotBaseline, Stored } from "../../store/index.ts";
import type { TeamSkillPackage } from "../teams/team-archive.ts";
import type { BuiltinHistory, RoleFingerprint } from "./history.ts";
import type { BuiltinPack } from "./load.ts";
import { builtinPermission } from "./permissions.ts";
import { roleThinking } from "./thinking.ts";

type Language = "zh" | "en";
type Provenance = "recorded" | "history" | "none";

/** What the Bot's own role version held, per field; a value in a set means "not changed by the user". */
interface OldValues {
  provenance: Provenance;
  language?: Language;
  thinking: Set<string>;
  permissions(category: Category): Set<Level | undefined>;
  /** The old version had an opinion about this category (worth a "kept" line). */
  mentions(category: Category): boolean;
  norms: Set<string>;
  /** Package folder → fingerprints; `skillId` null = recorded as removed by the user. */
  skills: Map<string, { fingerprints: Set<string>; skillId?: string | null }>;
}

export type SkillStep =
  | { action: "add"; name: string; pkg: TeamSkillPackage }
  | { action: "update"; name: string; skillId: string; pkg: TeamSkillPackage }
  | { action: "remove"; name: string; skillId: string };

export interface BotPlan {
  provenance: Provenance;
  language: Language;
  fromVersion: number;
  toVersion: number;
  changes: BuiltinChange[];
  kept: BuiltinChange[];
  patch: { norms?: string; expectedNorms?: string; thinkingLevel?: Bot["thinkingLevel"] };
  permissions: Partial<Record<Category, Level | null>>;
  skills: SkillStep[];
  /** Each new-version folder's current skill row (null: none); `add` steps fill theirs in. */
  rowIds: Map<string, string | null>;
  /** Folders whose skill the user changed: their baseline stays the built-in value. */
  keptFolders: Set<string>;
  revision: string;
  /** The new version's values, for the baseline written after a complete apply. */
  target: {
    fingerprint: RoleFingerprint;
    /** The role's thinking level as creation would fit it to this Bot's model. */
    thinking: Bot["thinkingLevel"];
    norms: string;
    permissionOverrides: Partial<Record<Category, Level>>;
    folders: string[];
    skillFingerprints: Map<string, string>;
  };
}

export interface BotPlanInput {
  bot: Bot & { role: NonNullable<Bot["role"]> };
  pack: BuiltinPack;
  target: RoleFingerprint;
  history?: BuiltinHistory;
  stored?: Stored<BotBaseline>;
  inventory: SkillInventoryItem[];
  global: PermissionLevels;
  /** The Bot's current model when available: thinking is compared as creation fitted it. */
  model?: ModelInfo;
  language: Language;
  redact(text: string): string;
  /**
   * An automatic update replaces the fields the user changed too (the version it
   * replaces is kept as a recovery record first), instead of leaving them behind as「会保留」.
   * Keeps explicit command ask/never and unknown provenance when relaxing that default.
   */
  force?: boolean;
  /**
   * The skills this Bot should get from its source — the group template's subset for it
   * when it belongs to a built-in group, otherwise its role's full set. Never merged with both;
   * it is asked per language, because the pack it reads is the one the plan was made in.
   */
  packages?(language: Language): readonly TeamSkillPackage[] | undefined;
}

/** One category tightened against the current defaults, exactly like creation does. */
function tightened(global: PermissionLevels, category: Category, level: Level | undefined) {
  if (level === undefined) return undefined;
  return tightenOverrides(global, { [category]: level }).overrides[category] as Level | undefined;
}

function oldValues(input: BotPlanInput): OldValues {
  const { bot, stored, history, global } = input;
  const recorded = stored?.version === bot.role.version ? stored.baseline : undefined;
  if (recorded)
    return {
      provenance: "recorded",
      language: recorded.language,
      thinking: new Set([recorded.thinkingLevel]),
      permissions: (category) => new Set([recorded.permissionOverrides[category]]),
      mentions: (category) => recorded.permissionOverrides[category] !== undefined,
      norms: new Set([recorded.norms]),
      skills: new Map(
        recorded.skills.map((skill) => [
          skill.folder,
          { fingerprints: new Set([skill.fingerprint]), skillId: skill.skillId },
        ]),
      ),
    };
  const variants = history?.roles[bot.role.id]?.[String(bot.role.version)] ?? [];
  if (!variants.length)
    return {
      provenance: "none",
      thinking: new Set(),
      permissions: () => new Set(),
      mentions: () => false,
      norms: new Set(),
      skills: new Map(),
    };
  const norms = textFingerprint(bot.norms ?? "");
  const skills: OldValues["skills"] = new Map();
  for (const variant of variants)
    for (const [folder, pair] of Object.entries(variant.skills)) {
      const entry = skills.get(folder) ?? { fingerprints: new Set<string>() };
      entry.fingerprints.add(pair.zh).add(pair.en);
      skills.set(folder, entry);
    }
  const raw = (category: Category) =>
    variants.map((variant) => variant.permissionOverrides[category] as Level | undefined);
  return {
    provenance: "history",
    // The language the Bot was made in: the one its norms still match, when they do.
    ...(variants.some((v) => v.norms.zh === norms)
      ? { language: "zh" as const }
      : variants.some((v) => v.norms.en === norms)
        ? { language: "en" as const }
        : {}),
    thinking: new Set(
      variants.flatMap((variant) => [
        variant.thinkingLevel,
        ...(input.model ? [roleThinking(variant.thinkingLevel, input.model)] : []),
      ]),
    ),
    // Creation stored either the file's value or, when it was not stricter, nothing.
    permissions: (category) =>
      new Set(raw(category).flatMap((level) => [level, tightened(global, category, level)])),
    mentions: (category) => raw(category).some((level) => level !== undefined),
    norms: new Set(variants.flatMap((variant) => [variant.norms.zh, variant.norms.en])),
    skills,
  };
}

const keepReason = (old: OldValues) => (old.provenance === "none" ? "unknown" : "changed");

function planSkills(
  input: BotPlanInput,
  old: OldValues,
  packages: readonly TeamSkillPackage[],
  force: boolean,
) {
  const changes: BuiltinChange[] = [];
  const kept: BuiltinChange[] = [];
  const steps: SkillStep[] = [];
  const rowIds = new Map<string, string | null>();
  const keptFolders = new Set<string>();
  const rows = input.inventory;
  const claimed = new Set<string>();
  // A recorded skill is followed by id (a rename keeps it); otherwise by folder and team source.
  const rowFor = (folder: string) => {
    const known = old.skills.get(folder);
    if (old.provenance === "recorded" && known) {
      if (!known.skillId) return undefined;
      return rows.find((row) => row.id === known.skillId);
    }
    return rows.find((row) => row.folder === folder && (!known || row.source === "team"));
  };
  for (const pkg of packages) {
    const next = skillFingerprint(pkg.document, pkg.files);
    const known = old.skills.get(pkg.folder);
    const row = rowFor(pkg.folder);
    rowIds.set(pkg.folder, row?.id ?? null);
    if (row) claimed.add(row.id);
    if (row?.fingerprint === next) continue;
    if (row) {
      const unchanged = !!known && !!row.fingerprint && known.fingerprints.has(row.fingerprint);
      // A skill of the user's own that happens to share the folder is never written over.
      if (force ? row.source === "team" : unchanged) {
        changes.push({ item: "skill", action: "update", name: pkg.document.name });
        steps.push({ action: "update", name: pkg.document.name, skillId: row.id, pkg });
      } else {
        kept.push({ item: "skill", action: "keep", name: row.name, reason: "changed" });
        keptFolders.add(pkg.folder);
      }
      continue;
    }
    if (!force && known) {
      kept.push({ item: "skill", action: "keep", name: pkg.document.name, reason: "removed" });
    } else if (!force && old.provenance === "none") {
      kept.push({ item: "skill", action: "keep", name: pkg.document.name, reason: "unknown" });
    } else {
      changes.push({ item: "skill", action: "add", name: pkg.document.name });
      steps.push({ action: "add", name: pkg.document.name, pkg });
    }
  }
  const current = new Set(packages.map((pkg) => pkg.folder));
  for (const [folder, known] of old.skills) {
    if (current.has(folder)) continue;
    const row = rowFor(folder);
    if (!row || claimed.has(row.id)) continue;
    if (
      (row.fingerprint && known.fingerprints.has(row.fingerprint)) ||
      (force && row.source === "team")
    ) {
      changes.push({ item: "skill", action: "remove", name: row.name });
      steps.push({ action: "remove", name: row.name, skillId: row.id });
    } else kept.push({ item: "skill", action: "keep", name: row.name, reason: "dropped" });
  }
  return { changes, kept, steps, rowIds, keptFolders };
}

/**
 * What「采用新版」does for one Bot, computed locally from stored hashes and files on disk
 * (no model call). Norms, thinking, each permission category and each skill are updated only
 * while the Bot still holds its version's built-in value; persona, name, avatar and model are
 * never touched. The same input always gives the same plan and revision.
 */
export function planBotUpdate(input: BotPlanInput): BotPlan {
  const { bot, pack, target, global } = input;
  const old = oldValues(input);
  const force = input.force === true;
  const language = old.language ?? input.language;
  const team = pack[language];
  const roleBot = team.template.bots[0];
  if (!roleBot?.role) throw new TypeError("role without a Bot");
  const changes: BuiltinChange[] = [];
  const kept: BuiltinChange[] = [];
  const patch: BotPlan["patch"] = {};
  const nextNorms = input.redact(roleBot.norms ?? "");
  const currentNorms = textFingerprint(bot.norms ?? "");
  if (currentNorms !== textFingerprint(nextNorms)) {
    if (force || old.norms.has(currentNorms)) {
      changes.push({ item: "norms", action: "update" });
      patch.norms = nextNorms;
      patch.expectedNorms = bot.norms ?? "";
    } else kept.push({ item: "norms", action: "keep", reason: keepReason(old) });
  }
  // Creation fits the role's level to the model (off without reasoning); compare the same way.
  const thinkingTarget = input.model
    ? roleThinking(target.thinkingLevel, input.model)
    : target.thinkingLevel;
  if (bot.category !== "image" && bot.thinkingLevel !== thinkingTarget) {
    const line = { item: "thinking", from: bot.thinkingLevel, to: thinkingTarget } as const;
    if (force || old.thinking.has(bot.thinkingLevel)) {
      changes.push({ ...line, action: "update" });
      patch.thinkingLevel = target.thinkingLevel;
    } else kept.push({ ...line, action: "keep", reason: keepReason(old) });
  }
  const permissions: BotPlan["permissions"] = {};
  const permissionOverrides: BotPlan["target"]["permissionOverrides"] = {};
  for (const category of CategorySchema.options) {
    // The default Pi's own management levels are the person's switch; roles never carry them.
    if (isPiManagerCategory(category)) continue;
    const next = builtinPermission(global, category, target.permissionOverrides[category]);
    if (next) permissionOverrides[category] = next;
    const current = bot.permissionOverrides?.[category];
    if (current === next) continue;
    const line = {
      item: "permission",
      category,
      from: current ?? "default",
      to: next ?? "default",
    } as const;
    // Old role defaults and an explicit user choice can have the same value. Never guess that an
    // explicit ask/never is disposable when the new built-in default would relax command access.
    const preserveCommand =
      category === "run_command" &&
      target.permissionOverrides.run_command === "always" &&
      (current === "ask" || current === "never" || !old.permissions(category).has(current));
    if (!preserveCommand && (force || old.permissions(category).has(current))) {
      changes.push({ ...line, action: "update" });
      permissions[category] = next ?? null;
    } else if (old.mentions(category) || target.permissionOverrides[category] !== undefined)
      kept.push({ ...line, action: "keep", reason: keepReason(old) });
  }
  const packages =
    bot.category === "image" ? [] : (input.packages?.(language) ?? team.skills[0] ?? []);
  const skills = planSkills(input, old, packages, force);
  changes.push(...skills.changes);
  kept.push(...skills.kept);
  const revision = textFingerprint(
    JSON.stringify({
      to: roleBot.role.version,
      changes,
      kept,
      norms: currentNorms,
      thinking: bot.thinkingLevel,
      permissions: bot.permissionOverrides ?? {},
      skills: input.inventory.map((row) => [row.id, row.name, row.fingerprint]),
    }),
  );
  return {
    provenance: old.provenance,
    language,
    fromVersion: bot.role.version,
    toVersion: roleBot.role.version,
    changes,
    kept,
    patch,
    permissions,
    skills: skills.steps,
    rowIds: skills.rowIds,
    keptFolders: skills.keptFolders,
    revision,
    target: {
      fingerprint: target,
      thinking: thinkingTarget,
      norms: nextNorms,
      permissionOverrides,
      folders: packages.map((pkg) => pkg.folder),
      // The source's own fingerprints: a group subset that leaves a skill out must not look
      // like an unchanged role skill in the baseline written afterwards.
      skillFingerprints: new Map(
        packages.map((pkg) => [pkg.folder, skillFingerprint(pkg.document, pkg.files)]),
      ),
    },
  };
}

/**
 * The baseline after a complete apply: the new version's values as this Bot would have received
 * them. Kept fields therefore still differ from it next time; skills the user removed are
 * remembered (skillId null) so a later version does not bring them back.
 */
export function baselineAfter(
  plan: BotPlan,
  bot: Bot,
  added: ReadonlyMap<string, string>,
  inventory: readonly SkillInventoryItem[],
): BotBaseline {
  return {
    language: plan.language,
    // Applied: what the model fit gave; otherwise the fitted target (a kept value still differs).
    thinkingLevel: plan.patch.thinkingLevel ? bot.thinkingLevel : plan.target.thinking,
    permissionOverrides: plan.target.permissionOverrides,
    norms: textFingerprint(plan.target.norms),
    skills: plan.target.folders.flatMap((folder) => {
      const builtin = plan.target.skillFingerprints.get(folder);
      if (!builtin) return [];
      const skillId = added.get(folder) ?? plan.rowIds.get(folder) ?? null;
      // What is on disk now is the reference for "unchanged", unless the user's edit was kept.
      const row = plan.keptFolders.has(folder)
        ? undefined
        : inventory.find((item) => item.id === skillId);
      const version = row?.fingerprint ? row.version : null;
      return [
        {
          skillId,
          folder,
          fingerprint: row?.fingerprint ?? builtin,
          ...(version ? { version } : {}),
        },
      ];
    }),
  };
}
