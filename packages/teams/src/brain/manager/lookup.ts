// Names the model gives are matched to the person's Bots and groups; ids win, then one exact name.
import type { DatabaseSync } from "node:sqlite";
import type { Bot, Group } from "@pibot/protocol";
import { BotsRepo, GroupsRepo } from "@pibot/storage";

export type Language = "zh" | "en";
export const say = (language: Language, zh: string, en: string) => (language === "zh" ? zh : en);

const key = (value: string) => value.trim().toLowerCase();

/** All Bots (active first) without the main Pi; bounded like the sidebar. */
export function allBots(db: DatabaseSync, includeArchived: boolean): Bot[] {
  return new BotsRepo(db).page({ limit: 200 }, includeArchived);
}

export function findBot(db: DatabaseSync, ref: string | undefined): Bot | undefined {
  if (!ref) return undefined;
  const repo = new BotsRepo(db);
  const byId = repo.get(ref.trim());
  if (byId) return byId;
  const named = allBots(db, true).filter((bot) => key(bot.name) === key(ref));
  // An active Bot wins over an archived one with the same name (names are unique among active).
  const active = named.filter((bot) => !bot.archivedAt);
  return active.length === 1 ? active[0] : named.length === 1 ? named[0] : undefined;
}

export function allGroups(db: DatabaseSync, includeArchived: boolean): Group[] {
  const repo = new GroupsRepo(db);
  return [
    ...repo.list({ limit: 100 }),
    ...(includeArchived ? repo.list({ limit: 100, archived: true }) : []),
  ];
}

export function findGroup(db: DatabaseSync, ref: string | undefined): Group | undefined {
  if (!ref) return undefined;
  const byId = new GroupsRepo(db).get(ref.trim());
  if (byId) return byId;
  const named = allGroups(db, true).filter((group) => key(group.name) === key(ref));
  const active = named.filter((group) => !group.archivedAt);
  return active.length === 1 ? active[0] : named.length === 1 ? named[0] : undefined;
}

export function botName(db: DatabaseSync, id: string): string {
  return new BotsRepo(db).get(id)?.name ?? id;
}

/** "provider/model-id" or "default"; anything else is not a model reference. */
export function parseModel(
  value: string | undefined,
): { provider: string; id: string } | null | undefined {
  if (value === undefined) return undefined;
  if (key(value) === "default") return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash).trim(), id: value.slice(slash + 1).trim() };
}

export function oneLine(value: string, limit = 160): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
