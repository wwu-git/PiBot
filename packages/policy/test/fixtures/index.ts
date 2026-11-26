import { pathToFileURL } from "node:url";
import type { PermissionsSettings, Workplaces } from "@pibot/protocol-base";
import type { FileSystem, Platform, Policy } from "../../src/core/types.ts";
import { createPolicy } from "../../src/index.ts";
import { boundaryFixtures } from "./boundary.ts";
import { commandFixtures } from "./command.ts";
import { reviewFixtures } from "./review.ts";
import { command, type Expected, type Fixture, unknown } from "./types.ts";
import { whitelistFixtures, whitelistGrantFixtures } from "./whitelist.ts";

export type { Fixture } from "./types.ts";
export const fixtures: readonly Fixture[] = [
  ...commandFixtures,
  ...reviewFixtures,
  ...whitelistFixtures,
  ...whitelistGrantFixtures,
  ...boundaryFixtures,
  ...["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd/1", "/dev/fd/2"].flatMap((target) => [
    command(`echo ok > ${target}`, ["echo"], { readonly: true }),
    unknown(`curl -sS -o ${target} https://example.com`, ["curl"], {
      domains: ["example.com"],
      network: true,
      readonly: false,
    }),
  ]),
  command("echo ok 2>/dev/null", ["echo"], { readonly: true }),
  command("echo ok &>/dev/null", ["echo"], { readonly: true }),
  command("echo ok >>/dev/null", ["echo"], { readonly: true }),
  command("echo ok >& /dev/stdout", ["echo"], { readonly: true }),
  command("echo ok > NUL", ["echo"], { writes: ["/work/NUL"], readonly: false }),
  ...["NUL", "nul"].map(
    (target): Fixture => ({
      ...command(`echo ok > ${target}`, [], { canRemember: false }),
      platform: "win32",
    }),
  ),
  ...["/dev/disk0", "/dev/zero", "/dev/fd/0", "/dev/fd/3", "/dev/null/file"].map((target) =>
    command(`echo ok > ${target}`, ["echo"], {
      writes: [target],
      decision: "deny",
      reason: "outside_workplace_write_denied",
      canRemember: false,
    }),
  ),
  unknown("curl -sS -o /dev/disk0 https://example.com", ["curl"], {
    writes: ["/dev/disk0"],
    domains: ["example.com"],
    network: true,
    decision: "deny",
    reason: "outside_workplace_write_denied",
  }),
  unknown("rm /dev/null", ["rm"], { writes: ["/dev/null"], decision: "deny" }),
  unknown("chmod 600 /dev/stdout", ["chmod"], { writes: ["/dev/stdout"], decision: "deny" }),
  ...[
    ["python3", "-c"],
    ["python", "-c"],
    ["node", "-e"],
    ["node", "--eval"],
    ["node", "-p"],
    ["ruby", "-e"],
    ["perl", "-e"],
    ["php", "-r"],
  ].map(([program, option]) =>
    unknown(`${program} ${option} "open('/outside/x','w')"`, [program as string], {
      reads: [],
      writes: [],
      readonly: false,
    }),
  ),
  unknown("node --eval=\"open('/outside/x','w')\"", ["node"]),
  unknown("python3 -c \"open('/outside/x','w')\" ./input.txt", ["python3"], {
    reads: ["/work/input.txt"],
  }),
  unknown("bash -c 'rm /outside/x'", ["bash", "rm"], {
    writes: ["/outside/x"],
    decision: "deny",
  }),
  ...["1", "0", "0.5", ".5", "1s", "2m", "1h", "1d", "1 0.5s", "--help", "--version"].map(
    (duration) => command(`sleep ${duration}`, ["sleep"], { readonly: true }),
  ),
  ...["", "-1", "infinity", "/outside/x", "foo", "--bogus", "1x"].map((duration) =>
    unknown(`sleep ${duration}`.trim(), ["sleep"], { readonly: false }),
  ),
  { ...command("sleep 1", ["sleep"], { decision: "allow" }), runLevel: "always" },
  { ...command("sleep 1", ["sleep"], { decision: "allow" }), withGrant: true },
  { ...unknown("sleep /outside/x", ["sleep"]), runLevel: "always" },
  { ...unknown("sleep --bogus 1", ["sleep"]), withGrant: true },
];
const settings: PermissionsSettings = {
  levels: {
    connector: "ask",
    agent_delegation: "ask",
    bot_management: "ask",
    work_dispatch: "ask",
    run_command: "ask",
    computer: "never",
    read_file: "always",
    list_dir: "always",
    write_file: "ask",
    read_ai_config: "never",
    read_messages: "never",
    send_out: "never",
    web: "ask",
  },
  network: { allowAll: true, domains: [] },
  pathEntries: [],
};
const workplace: Workplaces = { home: "/work", folders: [], currentId: "home" };
const fs: FileSystem = {
  async realpath(path, signal) {
    signal.throwIfAborted();
    return path
      .replace(/^\/work\/escape(?=\/|$)/, "/outside")
      .replace(/^\/work\/linked-other(?=\/|$)/, "/other");
  },
};
export async function printFixtures(resourcesDir?: string): Promise<number> {
  const policies = new Map<Platform, Policy>(
    await Promise.all(
      (["linux", "darwin", "win32"] as const).map(
        async (platform) =>
          [
            platform,
            await createPolicy({ platform, userHome: "/user", fs, resourcesDir }),
          ] as const,
      ),
    ),
  );
  let failed = 0;
  try {
    for (const fixture of fixtures) {
      const policy = policies.get(fixture.platform ?? "linux") as NonNullable<
        ReturnType<typeof policies.get>
      >;
      const result = await policy.evaluate({
        botId: "00000000-0000-4000-8000-000000000001",
        request: fixture.request,
        settings: fixture.runLevel
          ? { ...settings, levels: { ...settings.levels, run_command: fixture.runLevel } }
          : settings,
        workplace: fixture.workplace ?? workplace,
        grants: fixture.withGrant
          ? [
              {
                id: "00000000-0000-4000-8000-000000000002",
                botId: "00000000-0000-4000-8000-000000000001",
                category: "run_command",
                scope: {
                  kind: "programs",
                  programs: fixture.expected.programs.toSorted(),
                  root: fixture.grantRoot ?? "/work",
                },
                createdAt: "2026-10-09T00:00:00.000Z",
                revokedAt: null,
              },
            ]
          : [],
        signal: AbortSignal.timeout(2000),
      });
      const analysis = result.analysis;
      const actual: Expected = {
        programs: analysis?.programs ?? [],
        ...(fixture.expected.reason === undefined ? {} : { reason: result.reason }),
        ...(fixture.expected.grantScope === undefined
          ? {}
          : { grantScope: result.grantScope ?? null }),
        ...(fixture.expected.readonly === undefined
          ? {}
          : { readonly: analysis?.readonly ?? false }),
        ...(fixture.expected.unknownOptions === undefined
          ? {}
          : { unknownOptions: analysis?.unknownOptions ?? [] }),
        reads: analysis?.reads ?? [],
        writes: analysis?.writes ?? [],
        domains: analysis?.domains ?? [],
        network: analysis?.network ?? false,
        incomplete: analysis?.incomplete ?? false,
        risk: result.risk,
        decision: result.decision,
        canRemember: result.canRemember,
      };
      const mismatches = (Object.keys(actual) as (keyof Expected)[]).filter(
        (key) => JSON.stringify(actual[key]) !== JSON.stringify(fixture.expected[key]),
      );
      if (mismatches.length) failed++;
      console.log(
        `${mismatches.length ? "DIFF" : "OK"} ${fixture.name}${mismatches.length ? ` ${JSON.stringify({ expected: fixture.expected, actual, mismatches })}` : ""}`,
      );
    }
  } finally {
    for (const policy of policies.values()) policy.dispose();
  }
  console.log(`${fixtures.length} samples, ${failed} differences`);
  return failed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = (await printFixtures()) ? 1 : 0;
