import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch, build, type Configuration, Platform } from "electron-builder";
import { runAsNodeProblems } from "../../../../tools/dev/run-as-node-check.ts";
import installLinuxLauncher from "./linux-launcher.mjs";
import { configurePackageFuses, packagedElectron, verifyPackageFuses } from "./package-fuses.ts";
import {
  BASE_ASAR_UNPACK,
  childNodeUnpack,
  packageFiles,
  packageOptions,
} from "./package-options.ts";
import prepareResources from "./prepare-resources.mjs";
import { writeReleaseRecord } from "./release-record.ts";
import { signNodeHelper, verifyNodeHelper } from "./sign-node-helper.ts";
import { readUpdateFeeds, restoreUpdateFeeds, rewriteUpdateFeeds } from "./update-feed.ts";
import { verifyMacPackage } from "./verify-mac-package.ts";
import { verifyTargetPackage } from "./verify-target-package.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.info(
    "pnpm package [--mac|--win|--linux|--all] [--x64] [--arm64] [--dir|--dmg] [--release|--test] [--plan]\n--all selects all three platforms and both architectures. Default: test, host platform/architecture. Release output: dist/release/<platform>-<arch>. No publishing or app restart.\nSet PIBOT_DEVTOOLS=1 before pnpm package to include Development > Developer Tools in the packaged app. Set PIBOT_LOCAL_GMAIL=1 only for a private local build that includes the unshipped Gmail code. This does not open a remote debugging port.",
  );
} else {
  const jobs = packageOptions(args);
  if (args.includes("--plan")) console.info(JSON.stringify(jobs, null, 2));
  else await packageTargets(jobs);
}
async function packageTargets(jobs: ReturnType<typeof packageOptions>) {
  // Option a: refuse to package while any code path still runs Pi Bot as Node.
  const runAsNode = runAsNodeProblems();
  if (runAsNode.length)
    throw new Error(`ELECTRON_RUN_AS_NODE is still set:\n${runAsNode.join("\n")}`);
  if (jobs.some((job) => job.platform === "mac") && process.platform !== "darwin")
    throw new Error(
      "macOS signing/DMG needs a Mac. Run the mac targets on macOS; Windows/Linux targets can be cross-built with their required toolchain.",
    );
  const projectDir = fileURLToPath(new URL("../../", import.meta.url));
  const workspace = JSON.parse(
    await readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as { packageManager?: unknown };
  if (
    typeof workspace.packageManager !== "string" ||
    !/^pnpm@\d+\.\d+\.\d+$/u.test(workspace.packageManager)
  )
    throw new Error("The packaging workspace must pin its pnpm version");
  // Builder probes the app directory, which has no lockfile; plain Node must not select npm.
  process.env.npm_config_user_agent = workspace.packageManager.replace("@", "/");
  process.env.ELECTRON_BUILDER_CACHE = join(projectDir, ".cache", "electron-builder");
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  for (const key of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "CSC_NAME",
    "CSC_KEYCHAIN",
    "CSC_INSTALLER_LINK",
    "CSC_INSTALLER_KEY_PASSWORD",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
  ])
    delete process.env[key];
  const { version } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const execute = promisify(execFile);
  let identity: string | undefined;
  let identityName: string | undefined;
  if (
    process.platform === "darwin" &&
    jobs.some((job) => job.platform === "mac") &&
    process.env.PIBOT_SIGN_IDENTITY !== "adhoc"
  ) {
    const { stdout } = await execute("/usr/bin/security", ["find-identity", "-p", "codesigning"], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    // An Apple Development certificate (free Personal Team in Xcode) carries a Team ID, so the
    // keychain recognises every rebuild and stops asking for the login password; the self-signed
    // "Pi Bot Dev" has none, so macOS partitions keychain access per build hash.
    const valid = (name: string) =>
      new RegExp(`^\\s*\\d+\\)\\s+([\\dA-Fa-f]{40})\\s+"(${name})"(?:\\s|$)`, "m").exec(stdout);
    const apple = valid('Apple Development: [^"]+');
    const local = valid("Pi Bot Dev");
    identity = (apple ?? local)?.[1];
    identityName = (apple ?? local)?.[2];
  }
  for (const job of jobs) {
    const platform =
      job.platform === "mac"
        ? Platform.MAC
        : job.platform === "win"
          ? Platform.WINDOWS
          : Platform.LINUX;
    const targetArch = job.arch === "x64" ? Arch.x64 : Arch.arm64;
    const native = platform.nodeName === process.platform && job.arch === process.arch;
    const electronDist = join(projectDir, "node_modules", "electron", "dist");
    const binary =
      process.platform === "darwin"
        ? join(electronDist, "Electron.app", "Contents", "MacOS", "Electron")
        : join(electronDist, process.platform === "win32" ? "electron.exe" : "electron");
    const release = job.mode === "release";
    const output = release
      ? join(projectDir, "dist", "release", `${job.platform}-${job.arch}`)
      : native
        ? join(projectDir, "dist")
        : join(projectDir, "dist", `${job.platform}-${job.arch}`);
    // A failed rebuild must not leave a previous build's publication approval behind.
    if (release) await rm(join(output, "release-package.json"), { force: true });
    let application: string | undefined;
    let unpacked: string | undefined;
    console.info(`Packaging ${job.mode} ${job.platform}-${job.arch}: ${job.targets.join(", ")}`);
    // Builder archives the tar.gz in the background while the .deb target writes its package-type
    // marker and AppArmor profile into the same unpacked folder, so one run could ship them in the
    // tarball. The .deb is made in a second run from the folder the first run verified.
    const later = job.targets.filter((target) => target === "deb");
    const first = job.targets.filter((target) => target !== "deb");
    // Let builder download the target Electron. A host Electron is never relabelled as foreign.
    const config: Configuration = {
      extends: join(projectDir, "electron-builder.yml"),
      beforePack: prepareResources,
      files: packageFiles(job.platform, job.arch),
      // Child entries and their dependencies run on the helper Node.
      asarUnpack: [...BASE_ASAR_UNPACK, ...childNodeUnpack(projectDir)],
      artifactName: `PiBot-\${version}-\${os}-\${arch}${release ? "" : "-test"}.\${ext}`,
      extraMetadata: {
        ...(job.platform === "win" ? { name: "pi-bot" } : {}),
        pibotBuildMode: job.mode,
      },
      mac: { extendInfo: { PiBotBuildMode: job.mode } },
      // Builder embeds the ASAR header hash in macOS Info.plist / Windows PE resources.
      disableAsarIntegrity: false,
      ...(native && existsSync(binary) ? { electronDist } : {}),
      // Keep the legacy host package location used by app:run. Foreign targets have their own root.
      directories: { output },
      afterPack: async (context) => {
        await installLinuxLauncher(context);
        const { appOutDir } = context;
        unpacked = appOutDir;
        application = packagedElectron(appOutDir, platform.nodeName);
        await configurePackageFuses(application, job.mode);
        if (job.platform !== "mac")
          await verifyTargetPackage(appOutDir, platform.nodeName, job.arch, job.mode);
      },
      afterSign: async ({ appOutDir }) => {
        if (job.platform === "mac") {
          const app = join(appOutDir, "Pi Bot.app");
          // Its own identifier and entitlements; then the bundle seal below covers it again.
          await signNodeHelper(app, identity ?? "-", projectDir);
          if (!identity)
            await execute(
              "/usr/bin/codesign",
              [
                "--force",
                "--sign",
                "-",
                "--preserve-metadata=identifier,entitlements,flags,runtime",
                app,
              ],
              { timeout: 120_000, killSignal: "SIGKILL" },
            );
          if (identity) {
            // Resources is not a standard nested-code directory; sign it explicitly first.
            for (const target of [join(app, "Contents", "Resources", "cua-driver"), app])
              await execute(
                "/usr/bin/codesign",
                [
                  "--force",
                  "--deep",
                  "--sign",
                  identity,
                  "--timestamp=none",
                  "--preserve-metadata=identifier,entitlements,flags,runtime",
                  target,
                ],
                { timeout: 120_000, killSignal: "SIGKILL" },
              );
            console.info(`Signed ${app} with ${identityName}.`);
          }
          await verifyMacPackage(app, undefined, job.arch, job.mode);
          console.info(
            JSON.stringify({
              event: "package.node_helper.verified",
              version: await verifyNodeHelper(app, native),
              launched: native,
            }),
          );
        } else {
          await verifyPackageFuses(packagedElectron(appOutDir, platform.nodeName), job.mode);
        }
      },
    };
    const artifacts = await build({
      projectDir,
      targets: platform.createTarget(first, targetArch),
      publish: "never",
      config,
    });
    // Unsigned targets skip afterSign; always re-read the final binary after build as well.
    if (!application) throw new Error("Packager did not produce an application");
    await verifyPackageFuses(application, job.mode);
    if (later.length) {
      if (!unpacked) throw new Error("Packager did not report the unpacked application");
      const feeds = await readUpdateFeeds(output, version);
      // Prepackaged: builder skips packing, hooks and signing and only wraps the folder.
      artifacts.push(
        ...(await build({
          projectDir,
          prepackaged: unpacked,
          targets: platform.createTarget(later, targetArch),
          publish: "never",
          config,
        })),
      );
      await restoreUpdateFeeds(output, version, feeds);
      await verifyPackageFuses(application, job.mode);
    }
    if (release) {
      for (const feed of await rewriteUpdateFeeds(output, version))
        console.info(`Update manifest ${feed} now points at the release download folder.`);
      await writeReleaseRecord(
        output,
        { version, platform: job.platform, arch: job.arch },
        artifacts,
      );
    }
  }
}
