import type { DatabaseSync } from "node:sqlite";
import {
  type BotPermissionOverrides,
  BotPermissionOverridesSchema,
  type PermissionsPatch,
  PermissionsPatchSchema,
  type PermissionsSettings,
  PermissionsSettingsSchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { defined } from "../database/paging.ts";

export const DEFAULT_PERMISSIONS = Object.freeze({
  levels: Object.freeze({
    connector: "ask",
    run_command: "ask",
    // Opens the category; "ask" is the global default ("always allow" needs an explicit list).
    computer: "ask",
    read_file: "always",
    list_dir: "always",
    // Owner decision 2026-10-23: writes inside the workplace are checkpointed and can be undone,
    // so they no longer ask by default; outside writes stay refused (OUTSIDE_WORKPLACE_LEVELS).
    // Stored settings are full snapshots and cannot tell an explicit "ask" from the old default,
    // so only installs that never saved permissions pick this up (no migration).
    write_file: "always",
    read_ai_config: "ask",
    // Migrates the old global "never" once; Bot/group overrides stay independent.
    read_messages: "always",
    send_out: "ask",
    // Maintainers 2026-11-19: visiting and reading websites no longer asks. The first automatic login
    // and the first form submission per site, paid image generation and a search service's
    // first use still ask at this level; like write_file above, only installs that never saved
    // permissions pick it up.
    web: "always",
    // Each hand-off to an external agent asks until the user allows it for good.
    agent_delegation: "ask",
    // Only the default Pi's own override is ever changed; the default asks every time.
    bot_management: "ask",
    work_dispatch: "ask",
  }),
  network: Object.freeze({ allowAll: true, domains: Object.freeze([] as string[]) }),
  pathEntries: Object.freeze([] as string[]),
});
export const OUTSIDE_WORKPLACE_LEVELS = Object.freeze({
  read_file: "ask",
  list_dir: "ask",
  write_file: "never",
  run_command: "ask",
} as const);

export class PermissionsRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(): PermissionsSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'permissions'").get();
    // Parsing returns fresh objects, so callers cannot mutate the shared defaults.
    return PermissionsSettingsSchema.parse(
      row ? JSON.parse(String(row.value)) : DEFAULT_PERMISSIONS,
    );
  }

  /**
   * Forget aliases the user's ~/.ssh/config no longer defines. Kept separate from `set`
   * because a patch merges by alias and therefore cannot express a removal.
   */
  pruneSshHosts(keep: ReadonlySet<string>): number {
    const current = this.get();
    if (!current.sshHosts) return 0;
    const next = Object.fromEntries(
      Object.entries(current.sshHosts).filter(([alias]) => keep.has(alias)),
    );
    const removed = Object.keys(current.sshHosts).length - Object.keys(next).length;
    if (!removed) return 0;
    this.db
      .prepare(`INSERT INTO settings(key, value) VALUES ('permissions', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(PermissionsSettingsSchema.parse({ ...current, sshHosts: next })));
    return removed;
  }

  set(patch: PermissionsPatch): PermissionsSettings {
    const parsed = PermissionsPatchSchema.parse(patch);
    return transaction(this.db, () => {
      const current = this.get();
      const next = PermissionsSettingsSchema.parse({
        ...current,
        ...defined(parsed),
        levels: { ...current.levels, ...defined(parsed.levels ?? {}) },
        network: { ...current.network, ...defined(parsed.network ?? {}) },
        // The settings panel writes one row at a time. Merging by alias keeps a quick second
        // toggle from replacing an alias written by the first, which was still in flight.
        ...(parsed.sshHosts ? { sshHosts: { ...current.sshHosts, ...parsed.sshHosts } } : {}),
      });
      this.db
        .prepare(`INSERT INTO settings(key, value) VALUES ('permissions', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(JSON.stringify(next));
      return next;
    });
  }

  getBotOverrides(botId: string): BotPermissionOverrides | undefined {
    const row = this.db.prepare("SELECT permission_overrides FROM bots WHERE id = ?").get(botId);
    return row
      ? BotPermissionOverridesSchema.parse(JSON.parse(String(row.permission_overrides)))
      : undefined;
  }

  getGroupOverrides(groupId: string): BotPermissionOverrides | undefined {
    const row = this.db
      .prepare(`SELECT p.overrides FROM groups g
      LEFT JOIN group_permissions p ON p.group_id=g.id WHERE g.id=?`)
      .get(groupId);
    return row
      ? BotPermissionOverridesSchema.parse(
          row.overrides === null ? {} : JSON.parse(String(row.overrides)),
        )
      : undefined;
  }

  setGroupOverrides(groupId: string, overrides: BotPermissionOverrides): void {
    const value = BotPermissionOverridesSchema.parse(overrides);
    this.db
      .prepare(`INSERT INTO group_permissions(group_id,overrides) VALUES (?,?)
      ON CONFLICT(group_id) DO UPDATE SET overrides=excluded.overrides`)
      .run(groupId, JSON.stringify(value));
  }

  setBotOverrides(
    botId: string,
    overrides: BotPermissionOverrides,
  ): BotPermissionOverrides | undefined {
    const value = BotPermissionOverridesSchema.parse(overrides);
    const result = this.db
      .prepare(`UPDATE bots SET permission_overrides = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(value), new Date().toISOString(), botId);
    return result.changes ? value : undefined;
  }
}
