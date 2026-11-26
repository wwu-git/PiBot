import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type PackagePlatform = "mac" | "win" | "linux";
export type PackageArch = "x64" | "arm64";
export type PackageMode = "test" | "release";
export function packageOptions(args: string[], host = process.platform, hostArch = process.arch) {
  const allowed = new Set([
    "--mac",
    "--win",
    "--linux",
    "--all",
    "--x64",
    "--arm64",
    "--dir",
    "--dmg",
    "--help",
    "--plan",
    "--release",
    "--test",
    "--",
  ]);
  for (const arg of args)
    if (!allowed.has(arg)) throw new Error(`Unknown package argument: ${arg}`);
  if (args.includes("--release") && args.includes("--test"))
    throw new Error("Choose --release or --test");
  const mode: PackageMode = args.includes("--release") ? "release" : "test";
  let platforms: PackagePlatform[] = ["mac", "win", "linux"].filter((p) =>
    args.includes(`--${p}`),
  ) as PackagePlatform[];
  if (args.includes("--all")) platforms = ["mac", "win", "linux"];
  if (!platforms.length) {
    const platform =
      host === "darwin" ? "mac" : host === "win32" ? "win" : host === "linux" ? "linux" : undefined;
    if (!platform)
      throw new Error("Unsupported packaging host; select a target platform explicitly");
    platforms = [platform];
  }
  let architectures: PackageArch[] = ["x64", "arm64"].filter((a) =>
    args.includes(`--${a}`),
  ) as PackageArch[];
  if (!architectures.length) {
    if (args.includes("--all")) architectures = ["x64", "arm64"];
    else if (hostArch === "x64" || hostArch === "arm64") architectures = [hostArch];
    else throw new Error("Select --x64 or --arm64");
  }
  if (args.includes("--dir") && args.includes("--dmg")) throw new Error("Choose --dir or --dmg");
  const dirOnly = args.includes("--dir");
  return platforms.flatMap((platform) =>
    architectures.map((arch) => ({
      platform,
      arch,
      mode,
      targets: dirOnly
        ? ["dir"]
        : platform === "mac"
          ? args.includes("--dmg")
            ? // The zip is what an installed copy downloads to update itself (latest-mac.yml).
              ["dir", "dmg", "zip"]
            : ["dir"]
          : platform === "win"
            ? ["nsis"]
            : // The .deb carries the AppArmor profile Ubuntu 24.04+ needs (electron-builder.yml).
              ["AppImage", "tar.gz", "deb"],
    })),
  );
}

/**
 * Everything the app ships from apps/desktop; the rest of the project (src, caches, dist, dev restart
 * backups) stays out. Production node_modules are collected from package.json dependencies.
 * Mirrors `files` in electron-builder.yml, but must be complete here: an exclusion-only `files`
 * list makes electron-builder include the whole project directory (2026-10-21: a 12 GB app.asar
 * full of .cache backups).
 */
export const APP_FILES = [
  // Named outputs only: a stale folder left in out/ by an older build must not ship.
  "out/main/**",
  "out/preload/**",
  "out/renderer/**",
  "out/builtin/**",
  "out/migrations/**",
  "out/third-party-dependencies.json",
  "resources/tray*.png",
  "package.json",
] as const;

/** The full file list for one target: the app's files minus other targets' native prebuilds. */
export function packageFiles(platform: PackagePlatform, arch: PackageArch) {
  return [...APP_FILES, ...foreignNativeFiles(platform, arch)];
}

/**
 * Rejects an archive that holds anything outside APP_FILES (plus the production node_modules
 * electron-builder collects), so a wrong file list fails before an installer is produced.
 * Ported from the profile-app-menu worktree fix.
 */
export function assertApplicationFiles(files: readonly string[]) {
  const outputs = /^out\/(main|preload|renderer|builtin|migrations)(\/|$)/;
  for (const raw of files) {
    const file = raw.replaceAll("\\", "/").replace(/^\//, "");
    if (
      file === "out" ||
      outputs.test(file) ||
      file === "out/third-party-dependencies.json" ||
      file === "node_modules" ||
      file.startsWith("node_modules/") ||
      file === "resources" ||
      /^resources\/tray[^/]*\.png$/.test(file) ||
      file === "package.json"
    )
      continue;
    throw new Error("Packaged files exceed the application allowlist");
  }
}

/** Installed cross-build prebuilds must not inflate each individual target's application. */
export function foreignNativeFiles(platform: PackagePlatform, arch: PackageArch) {
  const patterns = ["!node_modules/@ubjs/node-linux-*-musl/**/*"];
  for (const other of ["mac", "win", "linux"] as const)
    for (const cpu of ["x64", "arm64"] as const) {
      if (other === platform && cpu === arch) continue;
      const os = other === "mac" ? "darwin" : other === "win" ? "win32" : "linux";
      const suffix = other === "mac" ? "" : other === "win" ? "-msvc" : "-gnu";
      patterns.push(
        `!node_modules/@trycua/cua-driver-${os}-${cpu}${suffix}/**/*`,
        `!node_modules/@ubjs/node-${os}-${cpu}${suffix}/**/*`,
        `!node_modules/@vscode/ripgrep-${os}-${cpu}/**/*`,
        `!node_modules/@esbuild/${os}-${cpu}/**/*`,
        `!node_modules/tree-sitter-bash/prebuilds/${os}-${cpu}/**/*`,
        `!node_modules/@earendil-works/pi-tui/native/${os}/prebuilds/${os}-${cpu}/**/*`,
      );
      if (other !== platform)
        patterns.push(`!node_modules/@earendil-works/pi-tui/native/${os}/**/*`);
      if (other === "win")
        patterns.push(`!node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/${cpu}/**/*`);
    }
  for (const cpu of ["x64", "arm64"] as const)
    if (platform !== "linux" || cpu !== arch)
      patterns.push(`!node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/${cpu}/**/*`);
  return patterns;
}

/** Verify exclusions against the actual archive on every platform, including macOS. */
export function assertTargetNativeFiles(
  files: readonly string[],
  platform: PackagePlatform,
  arch: PackageArch,
) {
  const prefixes = foreignNativeFiles(platform, arch)
    .map((pattern) => pattern.slice(1, -5))
    .filter((prefix) => !prefix.includes("*"));
  for (const raw of files) {
    const file = raw.replaceAll("\\", "/").replace(/^\//, "");
    if (prefixes.some((prefix) => file.startsWith(`${prefix}/`)))
      throw new Error(`Foreign native file: ${file}`);
  }
}

/** electron-builder.yml's own asarUnpack list; a `config.asarUnpack` replaces it, not appends. */
export const BASE_ASAR_UNPACK = [
  "node_modules/@anthropic-ai/sandbox-runtime/vendor/**",
  "node_modules/@trycua/**",
  "node_modules/@ubjs/**",
] as const;

/**
 * Child entries run on the helper Node, which cannot read app.asar. The build
 * records each entry's chunk closure and third-party imports (out/main/child-node-entries.json);
 * those files, the ESM marker and every installed dependency of those packages are unpacked.
 */
export function childNodeUnpack(desktop: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(desktop, "out", "main", "child-node-entries.json"), "utf8"),
  ) as { files: string[]; packages: string[] };
  const require = createRequire(join(desktop, "package.json"));
  const names = new Set<string>();
  const queue = manifest.packages.map((name) => ({ name, from: require }));
  while (queue.length) {
    const { name, from } = queue.shift() as (typeof queue)[number];
    if (names.has(name)) continue;
    let file: string;
    try {
      file = from.resolve(`${name}/package.json`);
    } catch {
      // Packages that hide package.json behind exports: walk up from the main entry.
      let dir = dirname(from.resolve(name));
      while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
      file = join(dir, "package.json");
    }
    names.add(name);
    const pkg = JSON.parse(readFileSync(file, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const next = createRequire(file);
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      try {
        next.resolve(`${dependency}/package.json`);
      } catch {
        // An optional dependency for another platform is not installed; nothing to unpack.
        if (pkg.optionalDependencies?.[dependency]) continue;
      }
      queue.push({ name: dependency, from: next });
    }
  }
  return [
    "out/main/package.json",
    ...manifest.files.map((file) => `out/main/${file}`),
    ...[...names].sort().map((name) => `**/node_modules/${name}/**`),
  ];
}
