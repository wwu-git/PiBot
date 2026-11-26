import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrainCapability,
  type RegisterRpc,
  resolvePersonaLanguage,
  type SkillsPort,
} from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { AuditRepo, BotsRepo, SettingsRepo } from "@pibot/storage";
import { BuiltinMethodTargetsRepo } from "../store/builtin-methods.ts";
import { packFromEntries } from "./builtin/load.ts";
import { builtinMethodSource } from "./builtin/method-source.ts";
import { provisionBuiltinMethods } from "./builtin/methods.ts";
import { BuiltinService, registerBuiltinRpc } from "./builtin/service.ts";
import { BuiltinUpdates, registerBuiltinUpdateRpc } from "./builtin/updates.ts";
import { RoleCatalogService, withoutAlwaysCommands } from "./cloud/role-catalog.ts";
import { registerPiManager } from "./manager/index.ts";
import { defaultBuiltinDir } from "./resources/builtin-dir.ts";
import { registerTeamRpc, TeamService } from "./teams/team-service.ts";

/** The version each shipped role and template declares, read from its team.json only. */
async function shippedVersions(dir: string) {
  const versions = new Map<string, number>();
  for (const [kind, folder] of [
    ["role", "roles"],
    ["group", "groups"],
  ] as const) {
    let names: string[] = [];
    try {
      names = (await readdir(join(dir, folder))).filter((name) => name.endsWith(".pibot"));
    } catch {
      // An installer without that folder ships none of them.
    }
    for (const name of names)
      try {
        const team = JSON.parse(await readFile(join(dir, folder, name, "team.json"), "utf8")) as {
          bots?: { role?: { version?: unknown } }[];
          groups?: { template?: { version?: unknown } }[];
        };
        const version =
          kind === "role" ? team.bots?.[0]?.role?.version : team.groups?.[0]?.template?.version;
        if (typeof version === "number") versions.set(`${kind}:${name.slice(0, -6)}`, version);
      } catch {
        // Unreadable: the catalog loader reports it; here it simply is not counted as shipped.
      }
  }
  return versions;
}

export function teamsCapability(
  options: {
    builtinDir?: string;
    /** Tests and probes: another catalog address and trust list. */
    roleCatalog?: { baseUrl?: string; publicKeys?: readonly string[] };
  } = {},
): BrainCapability {
  return {
    id: "teams",
    async register(ctx) {
      const skills = () => {
        if (!ctx.local.skills) throw new RpcError(RpcErrorCodes.unsupported, "skills_unavailable");
        return ctx.local.skills;
      };
      const common = {
        db: ctx.db,
        agent: ctx.agent,
        peer: ctx.peer,
        logger: ctx.logger,
        redactor: ctx.redactor,
        bots: ctx.bots,
        language: () =>
          resolvePersonaLanguage(
            new SettingsRepo(ctx.db).get().language,
            Intl.DateTimeFormat().resolvedOptions().locale,
          ),
        skills: {
          previewLink: (...args: Parameters<NonNullable<SkillsPort["previewLink"]>>) => {
            const port = skills();
            if (!port.previewLink)
              throw new RpcError(RpcErrorCodes.unsupported, "skill_link_import_unavailable");
            return port.previewLink(...args);
          },
          create: (...args: Parameters<ReturnType<typeof skills>["create"]>) =>
            skills().create(...args),
          exportDocuments: (...args: Parameters<ReturnType<typeof skills>["exportDocuments"]>) =>
            skills().exportDocuments(...args),
          exportPackages: (...args: Parameters<ReturnType<typeof skills>["exportPackages"]>) =>
            skills().exportPackages(...args),
          inventory: (...args: Parameters<ReturnType<typeof skills>["inventory"]>) =>
            skills().inventory(...args),
        },
      };
      const teams = new TeamService({ ...common, host: ctx.host });
      const methodsAbort = new AbortController();
      const methodsSignal = AbortSignal.any([methodsAbort.signal, ctx.local.shutdown.signal]);
      let methodsWork: Promise<void> | undefined;
      let methodsAgain = false;
      const scheduleMethods = (): void => {
        if (methodsSignal.aborted) return;
        methodsAgain = true;
        methodsWork ??= new Promise<void>((resolve) => setTimeout(resolve, 0))
          .then(async () => {
            while (methodsAgain && !methodsSignal.aborted) {
              methodsAgain = false;
              await provisionBuiltinMethods(
                ctx,
                builtin,
                skills(),
                common.language(),
                methodsSignal,
              );
            }
          })
          .catch(() => {
            if (!methodsSignal.aborted)
              ctx.logger.warn(
                JSON.stringify({ module: "builtin", event: "method_backfill_failed" }),
              );
          })
          .finally(() => {
            methodsWork = undefined;
            // A creation can request another pass while the completed promise is settling.
            if (methodsAgain && !methodsSignal.aborted) scheduleMethods();
          });
      };
      const builtinDir = options.builtinDir ?? defaultBuiltinDir();
      const cloud = new RoleCatalogService({
        dataDir: ctx.dataDir,
        appVersion: ctx.version.split(":")[0] ?? ctx.version,
        fetch: ctx.fetch,
        validate: (entries, kind, id) => packFromEntries(withoutAlwaysCommands(entries), id, kind),
        bundled: () => shippedVersions(builtinDir),
        audit: (reasonCode, target) =>
          new AuditRepo(ctx.db, ctx.redactor).append({
            botId: new BotsRepo(ctx.db).getMain()?.id ?? "",
            kind: "builtin.catalog",
            summary: "Role library / 角色库",
            detail: { actor: "user", reasonCode, ...(target ? { target } : {}) },
          }),
        ...(options.roleCatalog ?? {}),
        signal: ctx.local.shutdown.signal,
      });
      teams.setArchiveVerifier((data) => cloud.verifyArchive(data));
      const builtin = new BuiltinService({
        ...common,
        dir: builtinDir,
        dataDir: ctx.dataDir,
        ensureMethods: scheduleMethods,
        cloud,
      });
      const catalogStarted = performance.now();
      const content = await builtin.content();
      ctx.logger.info(
        JSON.stringify({
          module: "startup",
          event: "builtin_catalog_ready",
          durationMs: Math.round(performance.now() - catalogStarted),
          cache: content.cacheStats ? "enabled" : "disabled",
          ...content.cacheStats,
        }),
      );
      ctx.ports.provide(
        "builtin-methods",
        builtinMethodSource(new BuiltinMethodTargetsRepo(ctx.db), content, common.language),
      );
      const updates = new BuiltinUpdates({
        db: ctx.db,
        peer: ctx.peer,
        redactor: ctx.redactor,
        logger: ctx.logger,
        builtin,
        skills,
        bots: ctx.bots,
        groups: ctx.groups,
        permissions: ctx.local.permissions,
        model: async (provider, id) =>
          (await ctx.agent.listModels({ availableOnly: true })).find(
            (model) => model.provider === provider && model.id === id,
          ),
        language: common.language,
      });
      const pending = new Set<Promise<unknown>>();
      let closed = false;
      const handle: RegisterRpc = (method, action) =>
        ctx.rpc.handle(method, (params, context) => {
          if (closed) return Promise.reject(new RpcError(RpcErrorCodes.closed, "teams_stopped"));
          const work = Promise.resolve().then(() => {
            if (closed) throw new RpcError(RpcErrorCodes.closed, "teams_stopped");
            return action(params, context);
          });
          pending.add(work);
          void work
            .finally(() => pending.delete(work))
            .catch(() => {
              // The RPC caller observes the rejection; tracking never creates a detached one.
            });
          return work;
        });
      registerTeamRpc(handle, teams);
      const piManager = registerPiManager(ctx, handle);
      registerBuiltinRpc(handle, builtin);
      registerBuiltinUpdateRpc(handle, updates);
      handle("roleCatalog.get", () => cloud.state());
      handle("roleCatalog.check", () => cloud.check());
      handle("roleCatalog.install", async ({ kind, id }) => {
        const version = await cloud.install(kind, id);
        // The next read merges the new archive; Bots on that role take it like a shipped update.
        builtin.reload();
        return { ok: true as const, version };
      });
      // The newest built-in roles and templates apply themselves on start, including to
      // the Bots and groups the user changed. A failure is logged and retried on the next start;
      // it never keeps the app from opening.
      // The gate is background work, so large package verification does not delay
      // capability registration or the existing manual update RPCs.
      let autoWork: Promise<void> | undefined = Promise.resolve()
        .then(async () => {
          await ctx.local.skills?.waitForPackageMaintenance?.(methodsSignal);
          if (!methodsSignal.aborted) await updates.autoApply();
        })
        .catch((error) => {
          if (!methodsSignal.aborted)
            ctx.logger.warn(
              JSON.stringify({
                module: "builtin",
                event: "auto_apply_failed",
                // A class name, not the message: messages can carry ids and paths.
                reason: error instanceof Error ? error.name : typeof error,
              }),
            );
        })
        .finally(() => {
          autoWork = undefined;
        });
      ctx.sleep.participate({
        idle: () =>
          !methodsWork &&
          !autoWork &&
          pending.size === 0 &&
          teams.idle &&
          builtin.idle &&
          updates.idle,
      });
      return {
        start() {
          piManager.start();
          scheduleMethods();
        },
        afterReady: (signal) => builtin.checkConsistency(signal),
        async stop() {
          closed = true;
          piManager.stop();
          methodsAbort.abort();
          await updates.stop();
          await Promise.all([methodsWork, autoWork]);
          await Promise.all([builtin.stop(), teams.stop(), Promise.allSettled([...pending])]);
        },
      };
    },
  };
}
