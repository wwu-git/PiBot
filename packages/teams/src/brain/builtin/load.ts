import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RawEntry } from "@pibot/brain/kit";
import { avatarColors, avatarEyes, avatarShapes } from "@pibot/brain/kit";
import {
  type BuiltinProfessionFile,
  BuiltinProfessionsFileSchema,
  CategorySchema,
  type TeamTemplate,
} from "@pibot/protocol";
import { folderEntries, type ResolvedTeam, resolveTeam, teamJson } from "../teams/team-archive.ts";
import { builtinCache } from "./cache.ts";
import {
  type BuiltinHistory,
  BuiltinHistorySchema,
  groupFingerprint,
  HISTORY_FILE,
  HISTORY_MAX_BYTES,
  roleFingerprint,
  roleSkillVersions,
  type SkillVersion,
} from "./history.ts";
import { contentIssues, packIssues } from "./quality.ts";

export { contentWarnings } from "./quality.ts";

/**
 * One built-in `.pibot` folder: `roles/<roleId>.pibot/` holds exactly one Bot and no
 * group, `groups/<groupId>.pibot/` one group with its member Bots inline. Each Bot's ref is its
 * role id, so the same role in several folders is the same Bot when they are combined.
 */
export interface BuiltinPack {
  id: string;
  entries: RawEntry[];
  zh: ResolvedTeam;
  en: ResolvedTeam;
  /** Downloaded from the signed catalog rather than shipped in this installer. */
  source?: "cloud";
}
export interface BuiltinContent {
  cacheStats?: { hits: number; misses: number };
  roles: Map<string, BuiltinPack>;
  groups: Map<string, BuiltinPack>;
  professions: BuiltinProfessionFile[];
  /** Fingerprints of every released version; absent means no update offers. */
  history?: BuiltinHistory;
  /** File-level problems, by folder and reason only (never content). */
  issues: string[];
}

const SUFFIX = ".pibot";
const MAX_PACKS = 200;

async function names(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
const reason = (error: unknown) =>
  error instanceof Error ? error.message.split("\n")[0]?.slice(0, 300) : "unreadable";

/** Rules a built-in Bot must meet beyond the team file schema (spec sections 2 and 10). */
function botIssues(template: TeamTemplate): string[] {
  const issues: string[] = [];
  for (const bot of template.bots) {
    if (!bot.role) issues.push(`${bot.ref}: role is required`);
    else if (bot.role.id !== bot.ref) issues.push(`${bot.ref}: ref must equal role.id`);
    if (!bot.role?.name || !bot.role.category) issues.push(`${bot.ref}: role name/category`);
    if (bot.model) issues.push(`${bot.ref}: built-ins use the default model (model: null)`);
    const { network, confirmEverySend: _confirm, ...levels } = bot.permissionOverrides;
    if (network) issues.push(`${bot.ref}: no network override`);
    for (const [category, level] of Object.entries(levels))
      if (
        !CategorySchema.safeParse(category).success ||
        (level !== "ask" &&
          level !== "never" &&
          !(category === "run_command" && level === "always"))
      )
        issues.push(
          `${bot.ref}: permission ${category} may only be ask or never (run_command: always allowed)`,
        );
    if (
      !avatarShapes.includes(bot.avatarShape) ||
      !avatarColors.includes(bot.avatarColor) ||
      !avatarEyes.includes(bot.avatarEyes)
    )
      issues.push(`${bot.ref}: avatar not in the avatar lists`);
  }
  return issues;
}

function packProblems(
  id: string,
  kind: "role" | "group",
  zh: ResolvedTeam,
  en: ResolvedTeam,
): string[] {
  const problems = [...botIssues(zh.template), ...botIssues(en.template), ...packIssues(zh, en)];
  const { template } = zh;
  if (kind === "role" && (template.bots.length !== 1 || template.groups.length))
    problems.push("a role file has exactly one Bot and no group");
  if (kind === "role" && template.bots[0]?.role?.id !== id)
    problems.push("folder name must be <roleId>.pibot");
  if (kind === "group") {
    const group = template.groups[0];
    if (template.groups.length !== 1 || !group) problems.push("a group file has exactly one group");
    else {
      if (group.template?.id !== id) problems.push("folder name must be <groupId>.pibot");
      if (!group.welcome) problems.push("group welcome is required");
      if (template.bots.length !== group.members.length)
        problems.push("every Bot of a group file is a member");
    }
  }
  if (zh.skipped || en.skipped) problems.push("files outside any skill folder");
  return problems;
}

async function readPack(
  dir: string,
  id: string,
  kind: "role" | "group",
  cache?: Awaited<ReturnType<typeof builtinCache>>,
): Promise<BuiltinPack> {
  return packFromEntries(await folderEntries(dir), id, kind, cache);
}

/** Reads one pack from its files (a built-in folder or a downloaded archive); throws on problems. */
export function packFromEntries(
  entries: RawEntry[],
  id: string,
  kind: "role" | "group",
  cache?: Awaited<ReturnType<typeof builtinCache>>,
): BuiltinPack {
  // Both languages must read cleanly, so a missing translation fails here, not at creation.
  const hash = cache?.hash(entries);
  const parse = (useCache: boolean) => {
    let fromCache = false;
    const localized = (language: "zh" | "en") => {
      const cached = useCache && hash ? cache?.get(hash, language) : undefined;
      if (cached) {
        fromCache = true;
        return cached;
      }
      const result = resolveTeam(entries, language);
      if (hash) cache?.put(hash, language, result);
      return result;
    };
    const zh = localized("zh");
    const en = localized("en");
    return { zh, en, problems: packProblems(id, kind, zh, en), fromCache };
  };
  let parsed = parse(true);
  // A cached parse that passes the schema but fails these checks is a damaged cache, not a broken
  // pack: re-read the folder (which also rewrites the cache) instead of dropping the role.
  if (parsed.problems.length && parsed.fromCache) parsed = parse(false);
  const { zh, en, problems } = parsed;
  if (problems.length) throw new Error(problems.join("; "));
  return { id, entries, zh, en };
}

/** Downloaded packs and catalog history, read on every catalog load. */
export interface CloudPacks {
  packs(): Promise<{ kind: "role" | "group"; id: string; entries: RawEntry[] }[]>;
  history(): Promise<unknown>;
}

/** The released version a pack declares: the role's, or the group template's. */
export function packVersion(pack: BuiltinPack, kind: "role" | "group"): number {
  const template = pack.zh.template;
  return (
    (kind === "role" ? template.bots[0]?.role?.version : template.groups[0]?.template?.version) ?? 0
  );
}

/**
 * Loads `roles/*.pibot/`, `groups/*.pibot/` and `professions.json` with the same reader as a
 * user's `.pibot` import. A broken folder is left out with an issue line; professions drop
 * references to anything missing. `pnpm builtin:check` prints the issues and also compares
 * every copy of a role across folders.
 */
export async function loadBuiltin(
  dir: string,
  dataDir?: string,
  cloud?: CloudPacks,
  // Runtime recommendations may name uninstalled cloud content; source checks stay strict.
  options: { strictRecommendations?: boolean } = {},
): Promise<BuiltinContent> {
  const cache = await builtinCache(dir, dataDir);
  const issues: string[] = [];
  const load = async (kind: "role" | "group") => {
    const map = new Map<string, BuiltinPack>();
    const folder = join(dir, `${kind}s`);
    const selected = (await names(folder))
      .slice(0, MAX_PACKS)
      .filter((name) => name.endsWith(SUFFIX));
    // A synthetic cold startup spent ~824 ms in the catalog. Overlap bounded resource I/O,
    // retaining name order and the complete bilingual parse before publishing the method port.
    for (let offset = 0; offset < selected.length; offset += 4) {
      const batch = selected.slice(offset, offset + 4);
      const loaded = await Promise.allSettled(
        batch.map((name) =>
          readPack(join(folder, name), name.slice(0, -SUFFIX.length), kind, cache),
        ),
      );
      for (const [index, result] of loaded.entries()) {
        const name = batch[index] as string;
        if (result.status === "fulfilled") map.set(result.value.id, result.value);
        else issues.push(`${kind}s/${name}: ${reason(result.reason)}`);
      }
    }
    return map;
  };
  const [roles, groups] = await Promise.all([load("role"), load("group")]);
  // A downloaded version replaces the shipped one only when it is newer.
  if (cloud)
    for (const { kind, id, entries } of await cloud.packs()) {
      try {
        const pack = { ...packFromEntries(entries, id, kind), source: "cloud" as const };
        const map = kind === "role" ? roles : groups;
        const shipped = map.get(id);
        if (!shipped || packVersion(pack, kind) > packVersion(shipped, kind)) map.set(id, pack);
      } catch (error) {
        issues.push(`cloud ${kind}s/${id}: ${reason(error)}`);
      }
    }
  let professions: BuiltinProfessionFile[] = [];
  try {
    const path = join(dir, "professions.json");
    const info = await stat(path);
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("not a file or too large");
    professions = BuiltinProfessionsFileSchema.parse(JSON.parse(await readFile(path, "utf8")))
      .map((profession) => {
        const unknown = [
          ...profession.groups.filter((id) => !groups.has(id)),
          ...profession.roles.filter((id) => !roles.has(id)),
        ];
        if (options.strictRecommendations && unknown.length)
          issues.push(`professions.json ${profession.id}: unknown ${unknown.join(", ")}`);
        return {
          ...profession,
          groups: profession.groups.filter((id) => groups.has(id)),
          roles: profession.roles.filter((id) => roles.has(id)),
        };
      })
      .filter((p) => p.groups.length || p.roles.length);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      issues.push(`professions.json: ${reason(error)}`);
  }
  let history: BuiltinHistory | undefined;
  try {
    const path = join(dir, HISTORY_FILE);
    const info = await stat(path);
    if (!info.isFile() || info.size > HISTORY_MAX_BYTES) throw new Error("not a file or too large");
    history = BuiltinHistorySchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      issues.push(`${HISTORY_FILE}: ${reason(error)}`);
  }
  // The catalog carries the full release history, so a downloaded version can be adopted too.
  const cloudHistory = await cloud?.history();
  if (cloudHistory) {
    const parsed = BuiltinHistorySchema.safeParse(cloudHistory);
    if (parsed.success) history = parsed.data;
    else issues.push("cloud history: invalid");
  }
  await cache?.save();
  return {
    roles,
    groups,
    professions,
    issues,
    ...(history ? { history } : {}),
    ...(cache ? { cacheStats: cache.stats } : {}),
  };
}

/**
 * Every copy of one role (its own folder and each group folder that has it) must be the same
 * Bot: identical team.json entry (apart from nothing) and byte-identical skill folders.
 */
interface Copy {
  where: string;
  /** The Bot entry without its skill list: a group may carry fewer skills, nothing else varies. */
  bot: string;
  /** Self-contained (inline) skills, which cannot be left out of a copy. */
  inline: string;
  folders: Map<string, { ref: string; files: string }>;
}

export function consistencyIssues(content: BuiltinContent): string[] {
  const issues: string[] = [...contentIssues(content), ...historyIssues(content)];
  const copies = new Map<string, Copy[]>();
  const add = (where: string, pack: BuiltinPack) => {
    const json = teamJson(pack.entries) as {
      bots: { ref: string; skills?: { folder?: string; enabled?: boolean; name?: string }[] }[];
    };
    for (const bot of json.bots) {
      const folders = new Map<string, { ref: string; files: string }>();
      for (const skill of bot.skills ?? []) {
        if (!skill.folder) continue;
        const prefix = `skills/${bot.ref}/${skill.folder}/`;
        const files = pack.entries
          .filter((e) => e.path.startsWith(prefix))
          .map((e) => `${e.path.slice(prefix.length)}:${e.data.toString("base64")}`)
          .sort()
          .join("|");
        folders.set(skill.folder, { ref: JSON.stringify(skill), files });
      }
      // A group may carry only part of its role's skills (the study group's researcher keeps the
      // two study-facing ones), so the skill list is compared as a subset, folder by folder.
      const { skills, ...rest } = bot;
      const inline = (skills ?? []).filter((skill) => !skill.folder);
      const list = copies.get(bot.ref) ?? [];
      list.push({ where, bot: JSON.stringify(rest), inline: JSON.stringify(inline), folders });
      copies.set(bot.ref, list);
    }
  };
  for (const [id, pack] of content.roles) add(`roles/${id}.pibot`, pack);
  for (const [id, pack] of content.groups) add(`groups/${id}.pibot`, pack);
  for (const [ref, list] of copies) {
    const first = list[0];
    if (!content.roles.has(ref)) issues.push(`${ref}: no roles/${ref}.pibot`);
    for (const copy of list.slice(1)) {
      if (!first) break;
      const pair = `${first.where} and ${copy.where}`;
      if (copy.bot !== first.bot || copy.inline !== first.inline)
        issues.push(`${ref}: team.json entry differs between ${pair}`);
      for (const [folder, skill] of copy.folders) {
        const canonical = first.folders.get(folder);
        if (!canonical)
          issues.push(`${ref}: skill ${folder} is not in ${first.where} (${copy.where})`);
        else if (canonical.ref !== skill.ref)
          issues.push(`${ref}: skill ${folder} differs between ${pair}`);
        else if (canonical.files !== skill.files)
          issues.push(`${ref}: skill files differ between ${pair}`);
      }
    }
  }
  return issues;
}

/**
 * The current content of every role and template must be one of its version's recorded
 * variants; otherwise Bots made from it could never be recognised as unchanged later.
 */
function historyIssues(content: BuiltinContent): string[] {
  const { history } = content;
  if (!history) return [`${HISTORY_FILE}: missing (pnpm builtin:pack sync)`];
  const issues: string[] = [];
  const recorded = (variants: unknown[] | undefined, value: unknown) =>
    !!variants?.some((item) => JSON.stringify(item) === JSON.stringify(value));
  for (const [id, pack] of content.roles) {
    const version = pack.zh.template.bots[0]?.role?.version ?? 0;
    if (!recorded(history.roles[id]?.[String(version)], roleFingerprint(pack)))
      issues.push(`roles/${id}.pibot: v${version} not in ${HISTORY_FILE} (pnpm builtin:pack sync)`);
  }
  for (const [id, pack] of content.groups) {
    const version = pack.zh.template.groups[0]?.template?.version ?? 0;
    if (!recorded(history.groups[id]?.[String(version)], groupFingerprint(pack)))
      issues.push(
        `groups/${id}.pibot: v${version} not in ${HISTORY_FILE} (pnpm builtin:pack sync)`,
      );
  }
  for (const [folder, skill] of builtinSkillVersions(content)) {
    const where = `skills/${folder}`;
    if (skill.version !== skill.enVersion)
      issues.push(
        `${where}: zh and en pibot-version differ (${skill.version} / ${skill.enVersion})`,
      );
    const variants = history.skills?.[folder]?.[String(skill.version)];
    if (recorded(variants, skill.value)) continue;
    issues.push(
      variants?.length
        ? `${where}: content changed but pibot-version is still ${skill.version}; bump pibot-version, then role.version of ${skill.roles.join(", ")}, and run pnpm builtin:pack sync`
        : `${where}: pibot-version ${skill.version} not in ${HISTORY_FILE} (pnpm builtin:pack sync)`,
    );
  }
  return issues;
}

/** Each built-in skill folder once (shared folders are identical, see contentIssues). */
export function builtinSkillVersions(
  content: BuiltinContent,
): Map<string, SkillVersion & { roles: string[] }> {
  const skills = new Map<string, SkillVersion & { roles: string[] }>();
  for (const [id, pack] of content.roles)
    for (const [folder, skill] of roleSkillVersions(pack)) {
      const known = skills.get(folder);
      if (known) known.roles.push(id);
      else skills.set(folder, { ...skill, roles: [id] });
    }
  return skills;
}

/**
 * Skills a Bot made from a built-in receives. An image Bot's chat goes straight to image
 * generation with no system prompt or read_file (chat-run), so it could never use one; its
 * skills stay in the content and are not copied.
 */
export function usesSkills(bot: TeamTemplate["bots"][number]): boolean {
  return bot.category !== "image";
}
