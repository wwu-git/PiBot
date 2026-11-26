import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import { build, normalizePath } from "vite";
import { STANDARD_LIBRARIES } from "../../packages/execution/src/semantic/libraries.ts";
import { copyMinimalBuiltin } from "../../tools/dev/builtin-minimal.ts";
import {
  desktopMainInputs,
  isThirdPartyRuntimeDependency,
  thirdPartyDependencies,
} from "./scripts/package/third-party-dependencies.ts";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const workspacePackages = Object.keys(
  (
    JSON.parse(readFileSync(source("package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    }
  ).dependencies,
).filter((name) => name.startsWith("@pibot/"));
const ooxmlAssets = dirname(createRequire(import.meta.url).resolve("@silurus/ooxml/docx"));
const pdfAssets = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

// Keep electron-vite 5's shim intact, but let Rollup place it at a syntax-safe
// chunk boundary. Its regex otherwise treats a string ending in `import` as a
// static import and can insert the shim inside a following string literal.
/** Entries started as child processes on the helper Node, never inside Electron. */
const includeLocalGmail = process.env.PIBOT_LOCAL_GMAIL === "1";
const CHILD_NODE_ENTRIES = [
  "sandbox-doctor",
  "sandbox-host",
  "violation-log",
  "plugin-calendar-server",
  "plugin-contacts-server",
  ...(includeLocalGmail ? ["plugin-gmail-server"] : []),
  "linux-sandbox-check",
  "pibot-mcp-bridge",
];

const mainCjsShim = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`;

function buildCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source("."),
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Source archives have no Git metadata; never guess a revision from the installed directory.
    return null;
  }
}

export default defineConfig(({ command }) => ({
  main: {
    define: {
      __PIBOT_DEV_BUILD__: JSON.stringify(command === "serve"),
      __PIBOT_DEVTOOLS_BUILD__: JSON.stringify(process.env.PIBOT_DEVTOOLS === "1"),
      __PIBOT_COMMIT__: JSON.stringify(buildCommit()),
    },
    plugins: [
      {
        name: "pibot-startup-fingerprint",
        generateBundle(_options, bundle) {
          const hash = createHash("sha256");
          for (const name of Object.keys(bundle).sort()) {
            const chunk = bundle[name];
            if (chunk?.type !== "chunk") continue;
            hash.update(name);
            hash.update(chunk.code);
          }
          this.emitFile({
            type: "asset",
            fileName: "startup-bundle.sha256",
            source: hash.digest("hex"),
          });
        },
      },
      {
        // Option a: these entries run on the bundled helper Node, which cannot read
        // app.asar. Record each one's chunk and third-party closure so packaging can unpack
        // exactly that (package-options.ts childNodeUnpack), plus the ESM marker plain Node needs.
        name: "pibot-child-node-entries",
        generateBundle(_options, bundle) {
          const files = new Set<string>();
          const packages = new Set<string>();
          const visit = (fileName: string) => {
            const chunk = bundle[fileName];
            if (chunk?.type !== "chunk" || files.has(fileName)) return;
            files.add(fileName);
            for (const id of [...chunk.imports, ...chunk.dynamicImports])
              if (bundle[id]) visit(id);
              else if (isThirdPartyRuntimeDependency(id))
                packages.add(
                  id.startsWith("@")
                    ? id.split("/").slice(0, 2).join("/")
                    : (id.split("/")[0] ?? id),
                );
          };
          for (const [fileName, chunk] of Object.entries(bundle))
            if (chunk.type === "chunk" && chunk.isEntry && CHILD_NODE_ENTRIES.includes(chunk.name))
              visit(fileName);
          this.emitFile({
            type: "asset",
            fileName: "child-node-entries.json",
            source: `${JSON.stringify({ files: [...files].sort(), packages: [...packages].sort() }, null, 2)}\n`,
          });
          this.emitFile({
            type: "asset",
            fileName: "package.json",
            source: '{ "type": "module" }\n',
          });
        },
      },
      {
        name: "pibot-third-party",
        closeBundle() {
          mkdirSync(source("out"), { recursive: true });
          writeFileSync(
            source("out/third-party-dependencies.json"),
            JSON.stringify(thirdPartyDependencies(source("package.json"))),
          );
        },
      },
      {
        name: "pibot-plugins",
        closeBundle() {
          const target = source("out/plugins");
          const root = source("../plugins");
          rmSync(target, { recursive: true, force: true });
          cpSync(root, target, {
            recursive: true,
            filter(path) {
              const relative = normalizePath(path.slice(root.length)).replace(/^\//, "");
              if (!relative) return true;
              const parts = relative.split("/");
              if (!includeLocalGmail && parts[0] === "gmail") return false;
              if (parts.length === 1) return true;
              return (
                parts[1] === "pibot.json" ||
                (includeLocalGmail && parts[0] === "gmail" && parts[1] === "pibot.local.json") ||
                parts[1] === ".mcp.json" ||
                parts[1] === ".claude-plugin" ||
                parts[1] === "skills"
              );
            },
          });
        },
      },
      {
        name: "pibot-node-dependencies",
        enforce: "pre",
        async resolveId(id, importer) {
          if (!importer || !isThirdPartyRuntimeDependency(id)) return null;
          const resolved = await this.resolve(id, importer, { skipSelf: true });
          // Bundled workspace code resolves externals from out/main, so desktop's
          // manifest must declare their runtime dependencies. Keep package names
          // for both pnpm development and packaging, never worktree store paths.
          if (resolved && normalizePath(resolved.id).includes("/node_modules/"))
            return { id, external: true };
          return null;
        },
      },
      {
        // electron-builder drops *.d.ts from node_modules, so the semantic worker's TypeScript
        // standard library (read by hash in packages/execution/src/semantic/service.ts) ships
        // beside the bundle instead; packaged apps had none and every query failed (ENOENT).
        name: "pibot-typescript-lib",
        closeBundle() {
          const lib = join(
            dirname(
              createRequire(source("../../packages/execution/package.json")).resolve(
                "typescript-runtime/package.json",
              ),
            ),
            "lib",
          );
          rmSync(source("out/main/typescript-lib"), { recursive: true, force: true });
          mkdirSync(source("out/main/typescript-lib"), { recursive: true });
          // `.txt`: electron-builder drops every `*.d.ts`, not only those in node_modules.
          for (const name of Object.keys(STANDARD_LIBRARIES))
            cpSync(join(lib, name), source(`out/main/typescript-lib/${name}.txt`));
        },
      },
      {
        name: "pibot-migrations",
        closeBundle() {
          // A previous branch may have copied migrations absent from this checkout.
          rmSync(source("out/migrations"), { recursive: true, force: true });
          mkdirSync(source("out/migrations"), { recursive: true });
          cpSync(source("../../packages/storage/migrations"), source("out/migrations"), {
            recursive: true,
          });
        },
      },
      {
        // Read-only roles, group templates, professions and skills; brain resolves
        // `../builtin/` from its bundle in out/main, as the store does for migrations.
        name: "pibot-builtin",
        closeBundle() {
          copyMinimalBuiltin(source("../../packages/teams/builtin"), source("out/builtin"));
        },
      },
    ],
    build: {
      // Every workspace package is TypeScript source: bundle all of them into main. An external
      // @pibot/* import is loaded by Node at runtime and fails in strip-only mode (2026-10-21:
      // @pibot/plugins/host crashed the background owner while renderer smoke stayed green).
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        input: desktopMainInputs(source("."), includeLocalGmail),
        output: {
          format: "es",
          banner: mainCjsShim,
          entryFileNames: "[name].js",
          chunkFileNames: "[name]-[hash].js",
        },
      },
    },
  },
  preload: {
    plugins: [
      {
        name: "pibot-isolated-preloads",
        buildStart() {
          for (const entry of [
            "attachments",
            "computer-guard",
            "live-island",
            "browser-takeover",
            "link-bridge",
            "office-render",
          ])
            this.addWatchFile(source(`src/preload/${entry}.ts`));
        },
        async closeBundle() {
          // Electron sandbox require() cannot load local shared chunks. Build every entry alone.
          for (const entry of [
            "attachments",
            "computer-guard",
            "live-island",
            "browser-takeover",
            "link-bridge",
            "office-render",
          ])
            await build({
              configFile: false,
              publicDir: false,
              logLevel: "warn",
              build: {
                outDir: source("out/preload"),
                emptyOutDir: false,
                target: "es2023",
                minify: false,
                lib: {
                  entry: source(`src/preload/${entry}.ts`),
                  formats: ["cjs"],
                  fileName: () => `${entry}.cjs`,
                },
                rollupOptions: { external: ["electron"], output: { inlineDynamicImports: true } },
              },
            });
        },
      },
    ],
    build: {
      // Sandboxed preload can require Electron only; bundle workspace schemas and their parser.
      externalizeDeps: { exclude: [...workspacePackages, "zod"] },
      rollupOptions: {
        input: {
          index: source("src/preload/index.ts"),
        },
        // Sandboxed preload scripts cannot load ESM or split chunks.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    define: { __PIBOT_COMMIT__: JSON.stringify(buildCommit()) },
    optimizeDeps: { exclude: ["@silurus/ooxml"] },
    plugins: [
      {
        name: "pibot-ooxml-assets",
        configureServer(server) {
          server.middlewares.use("/ooxml", (request, response, next) => {
            const path = request.url?.split("?")[0] ?? "";
            if (!/^\/(?:assets\/)?[a-zA-Z0-9_.-]+\.(?:mjs|js|wasm)$/.test(path)) return next();
            void readFile(join(ooxmlAssets, path.slice(1)))
              .then((data) => {
                response.setHeader(
                  "Content-Type",
                  path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
                );
                response.end(data);
              })
              .catch(() => next());
          });
        },
        closeBundle() {
          cpSync(ooxmlAssets, source("out/renderer/ooxml"), {
            recursive: true,
            filter: (path) => !path.includes("/types"),
          });
        },
      },
      {
        name: "pibot-pdf-assets",
        configureServer(server) {
          server.middlewares.use("/pdf/assets", (request, response, next) => {
            const path = request.url?.split("?")[0] ?? "";
            if (!/^\/(?:cmaps|standard_fonts|wasm)\/[a-zA-Z0-9_.-]+$/.test(path)) return next();
            void readFile(join(pdfAssets, path.slice(1)))
              .then((data) => {
                response.setHeader(
                  "Content-Type",
                  path.endsWith(".js") ? "text/javascript" : "application/octet-stream",
                );
                response.end(data);
              })
              .catch(() => next());
          });
        },
        closeBundle() {
          for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
            cpSync(join(pdfAssets, folder), source(`out/renderer/pdf/assets/${folder}`), {
              recursive: true,
            });
          }
        },
      },
    ],
    root: source("src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: source("src/renderer/index.html"),
          pdf: source("src/renderer/pdf/index.html"),
          "office-render": source("src/renderer/office-render/index.html"),
          "link-bridge": source("src/renderer/link-bridge/index.html"),
        },
      },
    },
  },
}));
