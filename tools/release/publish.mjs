#!/usr/bin/env node
// Publish a packaged release: installers (and the macOS update zips) go to the R2 bucket
// `pibot-releases` under `<version>/`, served by the website Worker at
// https://pibot.space/downloads/<version>/<file>. The website's download buttons
// (public/releases.json), the brain's fallback manifest (public/updates/stable.json, read by
// AppUpdates) and electron-updater's feed (public/updates/latest*.yml, read by the desktop app's
// in-app updater) are rewritten to match. Deploying the website stays a separate, explicit step
// (`pnpm deploy` in the website repo).
//
//   node tools/release/publish.mjs --web ../PiBot_web [--dry-run] [--launch] [--desktop-only] [--reuse-large-uploads]
//
// Without --launch only the in-app update feeds (updates/latest*.yml, updates/stable.json) move
// to this version; the website's download buttons (releases.json) stay as they are, so testers
// get updates while the site still says 即将发布. --launch also publishes the download links.
//
// Uses the caller's own Wrangler login; Wrangler telemetry is forced off.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { assertReleaseArtifact } from "../../apps/desktop/scripts/package/release-record.ts";
import {
  absoluteFeed,
  DOWNLOAD_ORIGIN,
  feedValue,
  formatFeed,
  parseFeed,
} from "../../apps/desktop/scripts/package/update-feed.ts";

import { androidFeed } from "./android-feed.mjs";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const web = resolve(root, option("--web") ?? "../PiBot_web");
const dryRun = args.includes("--dry-run");
const launch = args.includes("--launch");
const reuseLargeUploads = args.includes("--reuse-large-uploads");
// A desktop hotfix must not relabel an older phone or runner build as the new version.
const desktopOnly = args.includes("--desktop-only");
// --update-only: an urgent fix ships only as an in-app update. The macOS disk images (download
// only) are not uploaded, and stable.json and the website's buttons keep the published version;
// the electron-updater feeds and the files they name (mac zips, the Windows installer, the
// AppImage and the .deb latest-linux.yml also lists, blockmaps) are what installed apps fetch.
const updateOnly = args.includes("--update-only");
if (updateOnly && launch) throw new Error("--update-only cannot be combined with --launch");
const version = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected version ${version}`);
// Maintainers 2026-11-13: every published version says what it changes. The app reads the feed's
// releaseNotes as JSON ({ zh: string[], en: string[] }, plain text lines; app-updater.ts).
const notesPath = join(root, "apps/desktop/release-notes", `${version}.json`);
if (!existsSync(notesPath)) throw new Error(`Missing release notes ${notesPath}`);
const notes = JSON.parse(readFileSync(notesPath, "utf8"));
for (const language of ["zh", "en"]) {
  const lines = notes[language];
  if (
    !Array.isArray(lines) ||
    !lines.length ||
    lines.length > 20 ||
    lines.some((line) => typeof line !== "string" || !line.trim() || line.length > 300)
  )
    throw new Error(`Release notes ${language}: 1–20 non-empty lines of at most 300 characters`);
}
// YAML single-quoted scalar on one line: the only escape is a doubled quote.
const releaseNotesYaml = `'${JSON.stringify({ zh: notes.zh, en: notes.en }).replaceAll("'", "''")}'`;
if (!existsSync(join(web, "public/releases.json"))) throw new Error(`No website at ${web}`);

const dist = join(root, "apps/desktop/dist/release");
// Only explicit --release builds enter this tree; never fall back to legacy/test dist/ files.
const locate = (folder, name) => [join(dist, folder, name)].find((path) => existsSync(path));
// Manifest key (AppReleaseSchema) → website button key → packaging folder → installer name.
const artifacts = [
  ["darwin-arm64", "mac-arm64", "mac-arm64", `PiBot-${version}-mac-arm64.dmg`],
  ["darwin-x64", "mac-x64", "mac-x64", `PiBot-${version}-mac-x64.dmg`],
  ["win32-x64", "windows", "win-x64", `PiBot-${version}-win-x64.exe`],
  ["linux-x64", "linux", "linux-x64", `PiBot-${version}-linux-x86_64.AppImage`],
  // Ubuntu 24.04+ needs the .deb's AppArmor profile. It is a download button only: installed apps
  // parse the manifest's downloads strictly, and its single linux-x64 entry stays the AppImage.
  [undefined, "linux-deb", "linux-x64", `PiBot-${version}-linux-amd64.deb`, "Linux · .deb"],
]
  .map(([platform, button, folder, name, label]) => ({ platform, button, folder, name, label }))
  .map((artifact) => ({ ...artifact, path: locate(artifact.folder, artifact.name) }))
  .filter((artifact) => artifact.path);
if (!artifacts.length) throw new Error(`No installers for ${version} in ${dist}`);
for (const artifact of artifacts)
  await assertReleaseArtifact(artifact.path, join(dist, artifact.folder), version);

async function sha512(body) {
  const hash = createHash("sha512");
  for await (const chunk of body) hash.update(chunk);
  return hash.digest("base64");
}

// electron-updater feeds, one per update channel file; macOS merges both architectures (the
// updater picks the zip whose URL contains arm64 on Apple silicon, the other one on Intel).
const feedSources = {
  "latest.yml": ["win-x64"],
  "latest-mac.yml": ["mac-arm64", "mac-x64"],
  "latest-linux.yml": ["linux-x64"],
};
const uploads = new Map(
  artifacts
    .filter((artifact) => !(updateOnly && artifact.name.endsWith(".dmg")))
    .map((artifact) => [artifact.name, artifact.path]),
);
// An APK is advertised only when this release uploads it.
const apk = join(root, "apps/mobile/android/app/build/outputs/apk/release/app-release.apk");
const apkName = `PiBot-${version}-android.apk`;
let android;
if (!desktopOnly && !updateOnly && existsSync(apk)) {
  android = await androidFeed(
    apk,
    version,
    `${DOWNLOAD_ORIGIN}/${version}/${apkName}`,
    process.env.AAPT,
  );
  uploads.set(apkName, apk);
}
const feeds = {};
for (const [name, folders] of Object.entries(feedSources)) {
  const parts = [];
  for (const folder of folders) {
    const path = locate(folder, name);
    if (!path) continue;
    const feed = absoluteFeed(parseFeed(readFileSync(path, "utf8")), version);
    // dist/ may still hold another build's manifest; only this version's belongs here.
    if (feedValue(feed.top, "version") !== version) continue;
    // Both folders can fall back to the same dist/ manifest; the merge drops duplicate files.
    parts.push(feed);
  }
  if (!parts.length) continue;
  const [first, ...rest] = parts;
  const merged = { top: first.top, files: [...first.files] };
  for (const part of rest)
    for (const file of part.files)
      if (!merged.files.some((known) => feedValue(known, "url") === feedValue(file, "url")))
        merged.files.push(file);
  // An update-only release names no disk image: macOS updates install from the zip.
  if (updateOnly)
    merged.files = merged.files.filter((file) => !(feedValue(file, "url") ?? "").endsWith(".dmg"));
  // Every referenced file must be this release's, present locally and match its checksum.
  for (const file of merged.files) {
    const url = feedValue(file, "url") ?? "";
    const prefix = `${DOWNLOAD_ORIGIN}/${version}/`;
    if (!url.startsWith(prefix)) throw new Error(`${name} points outside ${prefix}: ${url}`);
    const fileName = url.slice(prefix.length);
    const local = folders.map((folder) => locate(folder, fileName)).find(Boolean);
    if (!local) throw new Error(`${name} lists ${fileName}, which is not in ${dist}`);
    if (String(statSync(local).size) !== feedValue(file, "size"))
      throw new Error(`${fileName} size differs from ${name}`);
    if ((await sha512(createReadStream(local))) !== feedValue(file, "sha512"))
      throw new Error(`${fileName} checksum differs from ${name}`);
    await assertReleaseArtifact(local, resolve(local, ".."), version);
    uploads.set(fileName, local);
  }
  merged.top = [
    ...merged.top.filter(([key]) => key !== "releaseNotes"),
    ["releaseNotes", releaseNotesYaml],
  ];
  feeds[name] = formatFeed(merged);
}

// electron-updater fetches `<file>.blockmap` of both the installed and the new version to
// download only the changed blocks; without them every update is the full installer.
for (const [name, path] of [...uploads])
  if ((name.endsWith(".exe") || name.endsWith(".zip")) && existsSync(`${path}.blockmap`)) {
    await assertReleaseArtifact(`${path}.blockmap`, resolve(path, ".."), version);
    uploads.set(`${name}.blockmap`, `${path}.blockmap`);
  }

// Maintainers 2026-11-13: the runner ships next to the desktop and phone builds. `pnpm runner:package`
// writes the Windows installer and Linux packages to dist/runner/installer and the macOS tray
// app to dist/runner/darwin-<arch>; they upload under release names, and --launch fills the
// website's runner download links (status stays as the release test plan set it).
const runnerDist = join(root, "dist/runner");
const runnerFiles = desktopOnly
  ? []
  : [
      [
        "runner-windows",
        join(runnerDist, "installer", `Pi Bot Runner Setup ${version}.exe`),
        `PiBot-Runner-${version}-win-x64.exe`,
      ],
      [
        "runner-linux",
        join(runnerDist, "installer", `pibot-runner_${version}_amd64.deb`),
        `PiBot-Runner-${version}-linux-x64.deb`,
      ],
    ];
const runnerApp = join(runnerDist, "darwin-x64", "Pi Bot Runner.app");
// v0.0.3 dry run: the tray app left from the 0.0.1 build was zipped and labelled 0.0.3. Only a
// bundle whose own version is this release is published; otherwise its download stays.
const runnerAppVersion = () => {
  const plist = join(runnerApp, "Contents", "Info.plist");
  if (!existsSync(plist)) return undefined;
  const read = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", plist],
    {
      encoding: "utf8",
    },
  );
  return read.status === 0 ? read.stdout.trim() : undefined;
};
const runnerAppCurrent = !desktopOnly && existsSync(runnerApp) && runnerAppVersion() === version;
if (!desktopOnly && existsSync(runnerApp) && !runnerAppCurrent)
  console.warn(
    `The runner-mac build is ${runnerAppVersion() ?? "of unknown version"}, not ${version}; its download stays as it is.`,
  );
if (runnerAppCurrent) {
  const zip = join(runnerDist, `PiBot-Runner-${version}-mac-x64.zip`);
  if (!dryRun || !existsSync(zip)) {
    // ditto keeps the bundle's symlinks and signature; a plain zip would break the app.
    const result = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", runnerApp, zip], {
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`zipping ${runnerApp} failed`);
  }
  runnerFiles.push(["runner-mac", zip, `PiBot-Runner-${version}-mac-x64.zip`]);
}
const runners = [];
for (const [button, path, name] of runnerFiles) {
  if (!existsSync(path)) {
    console.warn(`No ${button} build for ${version} (${path}); its download stays as it is.`);
    continue;
  }
  uploads.set(name, path);
  runners.push({ button, name });
}

const origin = DOWNLOAD_ORIGIN;
const wrangler = (command) => {
  console.log(`$ wrangler ${command.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync("npx", ["wrangler", ...command], {
    cwd: web,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.status !== 0) throw new Error(`wrangler failed (${result.status})`);
};

async function uploadedBytesMatch(path, url, size) {
  const signal = AbortSignal.timeout(300_000);
  // R2 returns the MD5 of a single upload or the MD5 of the concatenated part MD5s.
  // A staged artifact's original local bytes already passed the SHA-256 release receipt.
  const head = await fetch(url, { method: "HEAD", redirect: "error", signal });
  if (!head.ok || head.headers.get("content-length") !== String(size)) return false;
  const etag = head.headers.get("etag")?.replace(/^"|"$/gu, "");
  if (/^[a-f0-9]{32}$/u.test(etag ?? "")) {
    const md5 = createHash("md5");
    for await (const chunk of createReadStream(path)) md5.update(chunk);
    return md5.digest("hex") === etag;
  }
  const multipart = /^[a-f0-9]{32}-(\d+)$/u.exec(etag ?? "");
  if (multipart) {
    for (const partMiB of [5, 8, 16]) {
      const partSize = partMiB * 1024 * 1024;
      const partCount = Math.ceil(size / partSize);
      if (Number(multipart[1]) !== partCount) continue;
      const md5 = createHash("md5");
      let actualParts = 0;
      for await (const part of createReadStream(path, { highWaterMark: partSize })) {
        md5.update(createHash("md5").update(part).digest());
        actualParts++;
      }
      if (actualParts === partCount && `${md5.digest("hex")}-${actualParts}` === etag) return true;
    }
  }
  // Other upload clients may choose a different part size.
  const response = await fetch(url, { redirect: "error", signal });
  return (
    response.ok &&
    response.body !== null &&
    (await sha512(response.body)) === (await sha512(createReadStream(path)))
  );
}

for (const [name, path] of uploads) {
  const size = statSync(path).size;
  const oversized = size > 300 * 1024 * 1024;
  const url = `${origin}/${version}/${name}`;
  if (oversized && !reuseLargeUploads)
    throw new Error(
      `${name} exceeds the Wrangler upload limit; upload by S3 or R2 multipart and pass --reuse-large-uploads`,
    );
  if (reuseLargeUploads && !dryRun) {
    if (await uploadedBytesMatch(path, url, size).catch(() => false)) {
      console.log(`Verified staged upload: ${url}`);
      continue;
    }
    if (oversized) throw new Error(`The staged R2 object does not match ${name}`);
  } else if (oversized) {
    console.log(`Verify multipart upload: ${url}`);
    continue;
  }
  const type = name.endsWith(".apk")
    ? "application/vnd.android.package-archive"
    : name.endsWith(".exe")
      ? "application/vnd.microsoft.portable-executable"
      : name.endsWith(".dmg")
        ? "application/x-apple-diskimage"
        : name.endsWith(".zip")
          ? "application/zip"
          : name.endsWith(".deb")
            ? "application/vnd.debian.binary-package"
            : "application/octet-stream";
  wrangler([
    "r2",
    "object",
    "put",
    `pibot-releases/${version}/${name}`,
    "--file",
    path,
    "--content-type",
    type,
    "--remote",
  ]);
}

const downloads = {};
for (const artifact of artifacts)
  if (artifact.platform) downloads[artifact.platform] = `${origin}/${version}/${artifact.name}`;
const releases = JSON.parse(readFileSync(join(web, "public/releases.json"), "utf8"));
releases.status = "available";
releases.version = version;
if (android)
  releases.platforms.android = {
    ...releases.platforms.android,
    url: android.url,
    label: "Android",
    detail: `v${version}`,
    version,
    ...(releases.platforms.android?.version !== version ? { status: "testing" } : {}),
  };
for (const artifact of artifacts) {
  releases.platforms[artifact.button] = {
    ...(artifact.label ? { label: artifact.label } : {}),
    ...releases.platforms[artifact.button],
    url: `${origin}/${version}/${artifact.name}`,
    detail: `v${version}`,
    version,
    ...(releases.platforms[artifact.button]?.version !== version ? { status: "testing" } : {}),
  };
}
for (const runner of runners)
  releases.platforms[runner.button] = {
    ...releases.platforms[runner.button],
    url: `${origin}/${version}/${runner.name}`,
    detail: `v${version}`,
    version,
    ...(releases.platforms[runner.button]?.version !== version ? { status: "testing" } : {}),
  };
// Release notes stay in the electron-updater feeds.
const manifest = { version, downloads };
const androidManifest = android ? JSON.stringify(android, null, 2) : undefined;
console.log(JSON.stringify(manifest, null, 2));
if (androidManifest) console.log(`--- updates/android.json\n${androidManifest}`);
for (const [name, text] of Object.entries(feeds)) console.log(`--- updates/${name}\n${text}`);
if (!Object.keys(feeds).length)
  console.warn("No update feeds for this version; in-app updates will not see it.");
if (!dryRun) {
  if (launch)
    writeFileSync(join(web, "public/releases.json"), `${JSON.stringify(releases, null, 2)}\n`);
  mkdirSync(join(web, "public/updates"), { recursive: true });
  if (!updateOnly)
    writeFileSync(
      join(web, "public/updates/stable.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  for (const [name, text] of Object.entries(feeds))
    writeFileSync(join(web, "public/updates", name), text);
  if (androidManifest) {
    writeFileSync(join(web, "public/updates/android.json"), `${androidManifest}\n`);
    console.log("Wrote updates/android.json");
  }
  console.log(
    `Wrote ${launch ? "releases.json, " : ""}${updateOnly ? "" : "updates/stable.json and "}${Object.keys(feeds).join(", ") || "no update feeds"} in ${web}; deploy the website next.`,
  );
}
