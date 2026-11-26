import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractAll, extractFile, listPackage, statFile } from "@electron/asar";
import ts from "typescript-runtime";
import { verifyPackageFuses } from "./package-fuses.ts";
import type { PackageMode } from "./package-options.ts";
import { assertApplicationFiles, assertTargetNativeFiles } from "./package-options.ts";
import { verifyChildNode } from "./verify-child-node.ts";
import { verifyNativePrebuilds } from "./verify-native-prebuilds.ts";
import { verifyCodeMapGrammars, verifySemanticLibraries } from "./verify-semantic-libraries.ts";
import { verifyTargetBinary } from "./verify-target-binary.ts";

const desktop = fileURLToPath(new URL("../../", import.meta.url));

async function verifySignature(application: string, signal?: AbortSignal): Promise<string> {
  // Certificate authorities are only included at verbosity level two.
  const { stderr } = await promisify(execFile)("/usr/bin/codesign", ["-dvv", application], {
    encoding: "utf8",
    signal,
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (/^Signature=adhoc\r?$/m.test(stderr)) return "ad-hoc";
  const authority = /^Authority=(Apple Development: .+|Pi Bot Dev)\r?$/m.exec(stderr)?.[1];
  assert.ok(authority, "Expected ad-hoc, Apple Development or Pi Bot Dev signature");
  const { stdout: requirement } = await promisify(execFile)(
    "/usr/bin/codesign",
    ["-d", "-r-", application],
    { encoding: "utf8", signal, timeout: 30_000, killSignal: "SIGKILL" },
  );
  assert.match(
    requirement,
    /^designated => .*\bidentifier "app\.pibot\.desktop"/m,
    "The designated requirement must contain the application ID",
  );
  return authority;
}

export async function verifyMacPackage(
  application: string,
  signal?: AbortSignal,
  arch: "x64" | "arm64" = process.arch as "x64" | "arm64",
  mode: PackageMode = "test",
): Promise<void> {
  const signature = await verifySignature(application, signal);
  await verifyPackageFuses(application, mode);
  verifyTargetBinary(join(application, "Contents", "MacOS", "Pi Bot"), "darwin", arch);
  const resources = join(application, "Contents", "Resources");
  const daemon = join(resources, "cua-driver");
  accessSync(daemon, constants.X_OK);
  verifyTargetBinary(daemon, "darwin", arch);
  const { stderr: daemonSignature } = await promisify(execFile)(
    "/usr/bin/codesign",
    ["-dvv", daemon],
    { encoding: "utf8", signal, timeout: 30_000, killSignal: "SIGKILL" },
  );
  assert(
    signature === "ad-hoc"
      ? /^Signature=adhoc$/m.test(daemonSignature)
      : daemonSignature.split(/\r?\n/).includes(`Authority=${signature}`),
    "Cua daemon must be signed with the application's identity",
  );
  // The daemon is nested code: verify it explicitly as well as the enclosing sealed bundle.
  for (const target of [daemon, application])
    await promisify(execFile)("/usr/bin/codesign", ["--verify", "--deep", "--strict", target], {
      signal,
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
  verifyTargetBinary(join(resources, "bin", "rg"), "darwin", arch);
  verifyChildNode(resources, "darwin", arch);
  const archive = join(resources, "app.asar");
  for (const plugin of ["calendar", "contacts"])
    assert(
      existsSync(join(resources, "plugins", plugin, "pibot.json")),
      `Missing declarative plugin: ${plugin}`,
    );
  const files = listPackage(archive, { isPack: false }).map((file) => file.replaceAll("\\", "/"));
  assertApplicationFiles(files);
  assertTargetNativeFiles(files, "mac", arch);
  verifyNativePrebuilds(archive, "darwin", arch);
  const required = [
    "out/main/index.js",
    "out/main/brain.js",
    // exec spawns it per background command; without it isolated background commands fail.
    "out/main/sandbox-host.js",
    // Supervises the Seatbelt `log stream`; without it blocks go unreported.
    "out/main/violation-log.js",
    "out/main/plugin-calendar-server.js",
    "out/main/plugin-contacts-server.js",
    // The `pibot` MCP relay external agents start.
    "out/main/pibot-mcp-bridge.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
  ];
  for (const file of required) assert(files.includes(`/${file}`), `Missing entry: ${file}`);
  assert(
    files.some((file) => /^\/out\/renderer\/assets\/.+\.js$/.test(file)),
    "Missing renderer JS",
  );
  assert(
    files.some((file) => /^\/out\/renderer\/assets\/.+\.css$/.test(file)),
    "Missing renderer CSS",
  );
  verifySemanticLibraries(archive, files);
  const manifest = JSON.parse(extractFile(archive, "package.json").toString());
  assert.equal(manifest.pibotBuildMode, mode, "Wrong package mode");
  assert.equal(manifest.main, "./out/main/index.js");

  const migrations = readdirSync(join(desktop, "../../packages/storage/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.deepEqual(
    files
      .filter((file) => file.startsWith("/out/migrations/") && file.endsWith(".sql"))
      .map((file) => file.slice("/out/migrations/".length))
      .sort(),
    migrations,
    "Packaged migrations must exactly match the source checkout",
  );
  for (const file of migrations) {
    assert.deepEqual(
      extractFile(archive, `out/migrations/${file}`),
      readFileSync(join(desktop, "../../packages/storage/migrations", file)),
      `Migration changed or missing: ${file}`,
    );
  }
  for (const file of readdirSync(join(desktop, "resources"))) {
    if (!/^tray.*\.png$/.test(file)) continue;
    assert.deepEqual(
      extractFile(archive, `resources/${file}`),
      readFileSync(join(desktop, "resources", file)),
    );
  }
  const plist = readFileSync(join(application, "Contents", "Info.plist"), "utf8");
  assert(plist.includes("app.pibot.desktop"), "Wrong application ID");
  assert(plist.includes("Pi Bot"), "Wrong product name");
  assert.match(plist, new RegExp(`<key>PiBotBuildMode</key>\\s*<string>${mode}</string>`));
  if (mode === "release")
    assert(plist.includes("<key>ElectronAsarIntegrity</key>"), "Missing ASAR integrity metadata");
  assert.deepEqual(
    readFileSync(join(resources, "icon.icns")),
    readFileSync(join(desktop, "build/icon.icns")),
  );
  accessSync(join(resources, "bin", "rg"), constants.X_OK);
  verifyCodeMapGrammars(join(resources, "wasm", "codemap"));
  for (const name of ["web-tree-sitter.wasm", "tree-sitter-bash.wasm"])
    assert(
      WebAssembly.validate(readFileSync(join(resources, "wasm", name))),
      `Invalid parser WASM: ${name}`,
    );

  const imports = new Set<string>();
  let lazyPiSdkImport = false;
  let staticPiSdkImport = false;
  for (const file of files.filter((file) => /^\/out\/main\/.+\.js$/.test(file))) {
    const code = extractFile(archive, file.slice(1)).toString();
    assert(!code.includes("node_modules/.pnpm/"), "Bundle refers to pnpm's worktree store");
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const fileImports = new Set<string>();
    const visit = (node: ts.Node) => {
      const literal = (value: ts.Expression | undefined) =>
        value && ts.isStringLiteralLike(value) ? value.text : undefined;
      if (ts.isImportDeclaration(node)) {
        const specifier = literal(node.moduleSpecifier);
        if (
          specifier === "@earendil-works/pi-coding-agent" ||
          specifier === "@earendil-works/pi-coding-agent/sdk"
        )
          staticPiSdkImport = true;
        if (specifier) fileImports.add(specifier);
      } else if (ts.isExportDeclaration(node)) {
        const specifier = literal(node.moduleSpecifier);
        if (
          specifier === "@earendil-works/pi-coding-agent" ||
          specifier === "@earendil-works/pi-coding-agent/sdk"
        )
          staticPiSdkImport = true;
        if (specifier) fileImports.add(specifier);
      } else if (ts.isImportEqualsDeclaration(node)) {
        const reference = node.moduleReference;
        const specifier = ts.isExternalModuleReference(reference) && literal(reference.expression);
        if (
          specifier === "@earendil-works/pi-coding-agent" ||
          specifier === "@earendil-works/pi-coding-agent/sdk"
        )
          staticPiSdkImport = true;
        if (specifier) fileImports.add(specifier);
      } else if (ts.isCallExpression(node)) {
        const specifier = literal(node.arguments[0]);
        const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const commonjs = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if (specifier?.startsWith("@earendil-works/pi-coding-agent")) {
          if (dynamic && specifier === "@earendil-works/pi-coding-agent/sdk")
            lazyPiSdkImport = true;
          if (
            (commonjs || !dynamic) &&
            (specifier === "@earendil-works/pi-coding-agent" ||
              specifier === "@earendil-works/pi-coding-agent/sdk")
          )
            staticPiSdkImport = true;
        }
        if (specifier && (dynamic || commonjs)) fileImports.add(specifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    /* Keep the existing relative-entry and package import collection semantics below. */
    for (const specifier of fileImports) {
      if (!specifier || specifier.startsWith("node:") || specifier === "electron") continue;
      if (/^\.\.?\//.test(specifier) && file.endsWith(".js")) {
        const target = join(file.slice(1), "..", specifier).replaceAll("\\", "/");
        assert(files.includes(`/${target}`), `Missing bundle import: ${specifier}`);
      } else if (/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/.*)?$/i.test(specifier)) {
        // Only npm-style package names enter dependency recursion; builtins and bundle paths do not.
        imports.add(specifier);
      }
    }
  }
  // The pi patch moved the lazy load behind pi's headless subpath. Keep this exact allow-list narrow:
  // accepting the package root would let a stale/static full SDK import satisfy the check, while
  // accepting arbitrary subpaths would make a typo or an unrelated string look like the loader.
  assert(
    lazyPiSdkImport,
    "Missing dynamic lazy pi SDK import (@earendil-works/pi-coding-agent/sdk)",
  );
  assert(!staticPiSdkImport, "Pi SDK must not be statically imported in the startup bundle");

  // Extract without loading application code: inspect Node's dependency search
  // paths in an isolated tree so missing files cannot be masked by the worktree.
  const temporary = mkdtempSync(join(tmpdir(), "pibot-package-check-"));
  let packageCount = 0;
  try {
    extractAll(archive, temporary);
    const visited = new Set<string>();
    const inspect = (name: string, parent: string): void => {
      const require = createRequire(parent);
      const packageJson = require.resolve
        // A dependency named string_decoder is an npm package, even though
        // the bare name also denotes a builtin and has no Node search paths.
        .paths(`${name}/`)
        ?.map((directory) => join(directory, name, "package.json"))
        .find((path) => !relative(temporary, path).startsWith("..") && existsSync(path));
      assert(packageJson, `Missing runtime dependency: ${name}`);
      if (visited.has(packageJson)) return;
      visited.add(packageJson);
      const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
      if (name === "@earendil-works/pi-coding-agent") piPackageJson = packageJson;
      if (name === "@earendil-works/pi-ai" || name === "@earendil-works/pi-coding-agent")
        assert.equal(pkg.version, "1.6.0");
      for (const dependency of Object.keys(pkg.dependencies ?? {}))
        inspect(dependency, packageJson);
    };
    const parent = join(temporary, "out/main/brain.js");
    let piPackageJson: string | undefined;
    for (const specifier of imports) {
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      assert(name);
      inspect(name, parent);
    }
    assert(piPackageJson, "Missing resolved pi-coding-agent package.json");
    const piPackage = JSON.parse(readFileSync(piPackageJson, "utf8"));
    const sdkExport = piPackage.exports?.["./sdk"];
    const sdkTarget =
      typeof sdkExport === "string" ? sdkExport : (sdkExport?.import ?? sdkExport?.default);
    assert(typeof sdkTarget === "string", "Pi SDK export ./sdk is missing");
    const sdkPath = resolve(dirname(piPackageJson), sdkTarget);
    assert(
      !relative(dirname(piPackageJson), sdkPath).startsWith(".."),
      "Pi SDK export ./sdk escapes its package",
    );
    assert(existsSync(sdkPath), "Pi SDK export ./sdk target is missing from ASAR");
    // Injected services and asset-only packages may not appear in bundle imports yet.
    for (const name of [
      "@anthropic-ai/sandbox-runtime",
      "web-tree-sitter",
      "tree-sitter-bash",
      "@vscode/ripgrep",
      "linkedom",
      "@mozilla/readability",
      "pdfjs-dist",
      "mammoth",
      // Imported by computed path from app.asar.unpacked (packages/computer/src/cua/loader.ts).
      "@trycua/cua-driver",
    ])
      inspect(name, parent);
    packageCount = visited.size;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  for (const file of files.filter((file) => file.endsWith(".node"))) {
    assert(statFile(archive, file.slice(1)).unpacked, `Native file must be unpacked: ${file}`);
    assert(
      existsSync(join(`${archive}.unpacked`, file.slice(1))),
      `Missing unpacked native file: ${file}`,
    );
  }
  // Cua: the SDK, its runtime and this architecture's native library live outside the
  // archive, and the MIT / MPL-2.0 notices ship with them.
  const cua = join(`${archive}.unpacked`, "node_modules", "@trycua");
  for (const file of [
    join(cua, "cua-driver", "dist", "index.js"),
    join(cua, `cua-driver-darwin-${arch}`, "libcua_driver_sdk.dylib"),
    join(cua, `cua-driver-darwin-${arch}`, "cua_driver_node_runtime.node"),
    join(`${archive}.unpacked`, "node_modules", "@ubjs", "node", "lib.js"),
    join(resources, "licenses", "cua-driver.md"),
    join(resources, "licenses", "MPL-2.0.txt"),
  ])
    assert(existsSync(file), `Missing Cua Driver file: ${relative(resources, file)}`);
  console.info(
    `Verified ${application}: ${signature} signature, entries, migrations, TypeScript libraries, tray, app icon, rg, parser WASM, Cua Driver, ${packageCount} runtime packages and native files.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const application = process.argv[2];
  if (!application) throw new Error("Usage: node scripts/verify-mac-package.ts <Pi Bot.app>");
  await verifyMacPackage(
    resolve(application),
    undefined,
    undefined,
    process.argv.includes("--release") ? "release" : "test",
  );
}
