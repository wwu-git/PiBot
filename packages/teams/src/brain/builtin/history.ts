import { skillFingerprint, textFingerprint } from "@pibot/brain/kit";
import { LevelSchema, ThinkingLevelSchema } from "@pibot/protocol";
import { z } from "zod";
import type { ResolvedTeam } from "../teams/team-archive.ts";

/**
 * What each released version of a built-in role / group template contained, as short
 * hashes (never the text itself). A Bot or group made from version N is "unchanged" in a field
 * while it still holds one of version N's values, so「采用新版」can update exactly those fields
 * and keep everything the user changed. `history.json` sits next to the `.pibot` folders and is
 * kept by `pnpm builtin:pack sync` (bootstrapped from git with `pnpm builtin:pack history`).
 */
const hash = z.string().regex(/^[a-f0-9]{16}$/);
const pair = z.strictObject({ zh: hash, en: hash });
const id = z.string().regex(/^[a-z0-9-]{1,64}$/);
export const RoleFingerprintSchema = z.strictObject({
  thinkingLevel: ThinkingLevelSchema,
  permissionOverrides: z.record(z.string().max(40), LevelSchema),
  norms: pair,
  skills: z.record(z.string().max(64), pair),
});
export const GroupFingerprintSchema = z.strictObject({
  name: z.strictObject({ zh: z.string().max(200), en: z.string().max(200) }),
  coordinator: id,
  members: z.array(id).max(6),
  announcement: pair,
  quickStarts: pair,
  autoRoundLimit: z.number().int().min(1).max(10),
});
// Several variants per version: content that changed before anyone bumped the version.
const versions = <T extends z.ZodType>(item: T) =>
  z.record(z.string().regex(/^\d{1,5}$/), z.array(item).min(1).max(20));
export const BuiltinHistorySchema = z.strictObject({
  format: z.literal(1),
  roles: z.record(id, versions(RoleFingerprintSchema)),
  groups: z.record(id, versions(GroupFingerprintSchema)),
  /**
   * Each built-in skill folder by `pibot-version` (0 = none). A recorded version never
   * gets a new variant through `sync`: changing a skill's content requires a version bump.
   */
  skills: z.record(z.string().max(64), versions(pair)).optional(),
});
export type RoleFingerprint = z.infer<typeof RoleFingerprintSchema>;
export type GroupFingerprint = z.infer<typeof GroupFingerprintSchema>;
export type BuiltinHistory = z.infer<typeof BuiltinHistorySchema>;
export const HISTORY_FILE = "history.json";
export const HISTORY_MAX_BYTES = 2 * 1048576;

type Languages = { zh: ResolvedTeam; en: ResolvedTeam };

/** Each skill's fingerprint per language, keyed by package folder (the Bot's skill folder). */
export function packageSkills(team: ResolvedTeam, index = 0): Map<string, string> {
  return new Map(
    (team.skills[index] ?? []).map((skill) => [
      skill.folder,
      skillFingerprint(skill.document, skill.files),
    ]),
  );
}

export interface SkillVersion {
  version: number;
  enVersion: number;
  value: { zh: string; en: string };
}
/**
 * Every skill a role ships, by folder, with its `pibot-version` (0 when it has none) and
 * per-language fingerprint. A role's zh and en copies must carry the same version.
 */
export function roleSkillVersions(pack: Languages): Map<string, SkillVersion> {
  const en = new Map((pack.en.skills[0] ?? []).map((skill) => [skill.folder, skill]));
  const result = new Map<string, SkillVersion>();
  for (const skill of pack.zh.skills[0] ?? []) {
    const other = en.get(skill.folder) ?? skill;
    const zh = skillFingerprint(skill.document, skill.files);
    result.set(skill.folder, {
      version: skill.document.version ?? 0,
      enVersion: other.document.version ?? 0,
      value: { zh, en: other === skill ? zh : skillFingerprint(other.document, other.files) },
    });
  }
  return result;
}

export function roleFingerprint(pack: Languages): RoleFingerprint {
  const zh = pack.zh.template.bots[0];
  const en = pack.en.template.bots[0];
  if (!zh || !en) throw new TypeError("role without a Bot");
  const zhSkills = packageSkills(pack.zh);
  const enSkills = packageSkills(pack.en);
  const { network: _network, confirmEverySend: _confirm, ...levels } = zh.permissionOverrides;
  return {
    thinkingLevel: zh.thinkingLevel,
    permissionOverrides: Object.fromEntries(
      Object.entries(levels)
        .filter((entry): entry is [string, z.infer<typeof LevelSchema>] => !!entry[1])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    norms: { zh: textFingerprint(zh.norms ?? ""), en: textFingerprint(en.norms ?? "") },
    skills: Object.fromEntries(
      [...zhSkills].map(([folder, value]) => [
        folder,
        { zh: value, en: enSkills.get(folder) ?? value },
      ]),
    ),
  };
}

export function groupFingerprint(pack: Languages): GroupFingerprint {
  const zh = pack.zh.template.groups[0];
  const en = pack.en.template.groups[0];
  if (!zh || !en) throw new TypeError("template without a group");
  return {
    name: { zh: zh.name, en: en.name },
    coordinator: zh.coordinator,
    members: zh.members,
    announcement: { zh: textFingerprint(zh.announcement), en: textFingerprint(en.announcement) },
    quickStarts: {
      zh: textFingerprint(JSON.stringify(zh.quickStarts ?? [])),
      en: textFingerprint(JSON.stringify(en.quickStarts ?? [])),
    },
    autoRoundLimit: zh.autoRoundLimit,
  };
}

/** Adds a variant unless an equal one is recorded; true when the history changed. */
export function recordVariant<T>(
  table: Record<string, Record<string, T[]>>,
  key: string,
  version: number,
  value: T,
): boolean {
  const versions = table[key] ?? {};
  table[key] = versions;
  const list = versions[String(version)] ?? [];
  versions[String(version)] = list;
  const text = JSON.stringify(value);
  if (list.some((item) => JSON.stringify(item) === text)) return false;
  list.push(value);
  return true;
}
