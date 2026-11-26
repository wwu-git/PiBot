import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { effectiveLevel } from "@pibot/policy";
import {
  type BotPermissionOverrides,
  type Category,
  CategorySchema,
  type KernelMethodParams,
  type Permissions,
  PermissionsPatchSchema,
  type PermissionsSettings,
  PI_MANAGER_CATEGORIES,
  type PolicyStep,
  RpcError,
} from "@pibot/protocol-base";
import { BotsRepo, PermissionsRepo, transaction } from "@pibot/storage";

export class PermissionService {
  readonly repo: PermissionsRepo;
  constructor(
    private readonly db: DatabaseSync,
    private readonly isolation: () => Promise<Permissions["isolation"]>,
    private readonly changed: (value: Permissions) => void,
    private readonly auditChange?: (
      fields: string[],
      scope?: { botId?: string; groupId?: string },
    ) => void,
  ) {
    this.repo = new PermissionsRepo(db);
  }
  overrides(botId: string): BotPermissionOverrides {
    const value = this.repo.getBotOverrides(botId);
    if (!value) throw new RpcError(-32602, "Unknown Bot");
    return value;
  }
  sources(botId: string, groupId?: string) {
    const overrides = groupId ? this.groupOverrides(groupId) : this.overrides(botId);
    return Object.fromEntries(
      CategorySchema.options.map((category) => [
        category,
        overrides[category] === undefined ? "default" : groupId ? "group" : "bot",
      ]),
    ) as Record<Category, PolicyStep["source"]>;
  }
  effective(botId: string): PermissionsSettings {
    return this.merge(this.overrides(botId));
  }
  groupOverrides(groupId: string): BotPermissionOverrides {
    const value = this.repo.getGroupOverrides(groupId);
    if (!value) throw new RpcError(-32602, "Unknown group");
    return value;
  }
  effectiveGroup(groupId: string): PermissionsSettings {
    return this.merge(this.groupOverrides(groupId));
  }
  private merge(overrides: BotPermissionOverrides): PermissionsSettings {
    const global = this.repo.get();
    return {
      ...global,
      levels: Object.fromEntries(
        CategorySchema.options.map((category) => [
          category,
          effectiveLevel(global.levels[category], overrides[category]),
        ]),
      ) as PermissionsSettings["levels"],
      network: overrides.network ?? global.network,
    };
  }
  async get(botId?: string, groupId?: string): Promise<Permissions> {
    const isolation = await this.status();
    if (groupId)
      return {
        ...this.effectiveGroup(groupId),
        isolation,
        groupId,
        overrides: this.groupOverrides(groupId),
        effective: this.effectiveGroup(groupId),
      };
    if (!botId) return { ...this.repo.get(), isolation };
    const effective = this.effective(botId);
    return { ...effective, isolation, botId, overrides: this.overrides(botId), effective };
  }
  /** A self-check that did not finish (timeout under load) is reported as such, never thrown. */
  private async status(): Promise<Permissions["isolation"]> {
    try {
      return await this.isolation();
    } catch {
      return { available: false, reason: "isolation_check_unfinished" };
    }
  }
  async set(params: KernelMethodParams["permissions.set"]): Promise<Permissions> {
    const { botId, groupId, levels, network, pathEntries, dockerRuntime, sshHosts } = params;
    // Owner decision 2026-11-24: these levels exist only on the default Pi's own page.
    if (
      PI_MANAGER_CATEGORIES.some((category) => levels?.[category] !== undefined) &&
      (!botId || groupId || !new BotsRepo(this.db).get(botId)?.isMain)
    )
      throw new RpcError(-32602, "pi_manager_main_only");
    if (!botId && !groupId) {
      if (network === null || Object.values(levels ?? {}).some((value) => value === null))
        throw new RpcError(-32602, "Only Bot overrides can follow global");
      if (pathEntries?.some((path) => !isAbsolute(path) || /[\p{Cc}\p{Cf}]/u.test(path)))
        throw new RpcError(-32602, "PATH entries must be absolute directories");
      transaction(this.db, () => {
        const before = this.repo.get();
        const next = this.repo.set(
          PermissionsPatchSchema.parse({ levels, network, pathEntries, dockerRuntime, sshHosts }),
        );
        const fields = Object.keys(next).filter(
          (key) =>
            !isDeepStrictEqual(
              before[key as keyof PermissionsSettings],
              next[key as keyof PermissionsSettings],
            ),
        );
        if (fields.length) this.auditChange?.(fields);
      });
    } else {
      if (dockerRuntime !== undefined) throw new RpcError(-32602, "Docker is a global setting");
      if (pathEntries !== undefined) throw new RpcError(-32602, "PATH is a global setting");
      if (sshHosts !== undefined) throw new RpcError(-32602, "SSH hosts are a global setting");
      const global = this.repo.get();
      const next = {
        ...(groupId ? this.groupOverrides(groupId) : this.overrides(botId as string)),
      };
      for (const category of CategorySchema.options) {
        const value = levels?.[category];
        if (value === null) delete next[category];
        else if (value !== undefined) {
          next[category] = value;
        }
      }
      if (network === null) delete next.network;
      else if (network !== undefined) {
        const value = { ...(next.network ?? global.network), ...network };
        value.domains = [...new Set(value.domains)];
        next.network = value;
      }
      transaction(this.db, () => {
        const before = groupId ? this.groupOverrides(groupId) : this.overrides(botId as string);
        if (groupId) this.repo.setGroupOverrides(groupId, next);
        else this.repo.setBotOverrides(botId as string, next);
        const fields = [...new Set([...Object.keys(before), ...Object.keys(next)])].filter(
          (key) =>
            !isDeepStrictEqual(
              before[key as keyof BotPermissionOverrides],
              next[key as keyof BotPermissionOverrides],
            ),
        );
        if (fields.length) this.auditChange?.(fields, { botId, groupId });
      });
    }
    // F-B1 (round B 2026-11-11): the change is saved before the sandbox self-check, which only
    // describes the machine; a busy machine must not turn a saved change into a failed request.
    const isolation = await this.status();
    const effective = groupId
      ? this.effectiveGroup(groupId)
      : botId
        ? this.effective(botId)
        : this.repo.get();
    const result = {
      ...effective,
      isolation,
      ...(botId ? { botId, overrides: this.overrides(botId), effective } : {}),
      ...(groupId ? { groupId, overrides: this.groupOverrides(groupId), effective } : {}),
    };
    this.changed(result);
    return result;
  }
}
