import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, opendir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PortablePiBotApplicationSchema,
  parseClaudePluginManifest,
  pluginText,
} from "@pibot/plugin-sdk";
import {
  hardenPluginConfigField,
  hasPluginCommandSubstitution,
  looksLikeCredentialValue,
  unsupportedClaudePluginComponents,
} from "@pibot/plugins-contract";
import type {
  ClaudePluginComponent,
  ClaudePluginConfigField,
  ClaudePluginSkill,
  ConnectorCommandConfirmation,
  ConnectorImportHost,
} from "@pibot/plugins-contract/full";
import {
  ClaudePluginBundleSchema,
  IdSchema,
  progressDeadline,
  RpcError,
  RpcErrorCodes,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  withProgressDeadline,
} from "@pibot/plugins-contract/full";
import { commandConfirmationDialog } from "./command-confirmation.ts";
import { importFileChanges } from "./import-file-changes.ts";
import {
  type ImportContent,
  type ImportParentCache,
  importChunks,
  importResource,
} from "./import-resource.ts";
import { extractPluginZip } from "./zip-import.ts";

const TTL = 5 * 60_000;
const MAX_CONFIG = 1024 * 1024;
const MAX_FILES = SKILL_IMPORT_MAX_FILES;
const MAX_BYTES = SKILL_IMPORT_MAX_BYTES;
// Claude Code reads these names at the plugin root only. Excluding them at every depth silently
// dropped a skill's own `workflows/`, `bin/` or `agents/` folder, which is ordinary package
// content (ppt-master lost 23 files that way).
const excludedAtRoot = new Set([
  ...unsupportedClaudePluginComponents.map((item) => item.path.toLowerCase()),
  "extensions",
]);
const neverCopied = new Set([".git", ".env", ".ds_store"]);
const isEnvFile = (name: string) =>
  name.toLowerCase() !== ".env.example" && /^\.env(?:\.|$)/i.test(name);
/** Version-control data and real environment files never leave the source, at any depth. */
const isNeverCopied = (name: string) => neverCopied.has(name.toLowerCase()) || isEnvFile(name);
const isExcluded = (name: string, rootLevel: boolean) =>
  isNeverCopied(name) || (rootLevel && excludedAtRoot.has(name.toLowerCase()));
/** A configured path's first segment is a plugin-root name; deeper ones only carry file rules. */
const referencesExcludedPath = (path: string) => {
  const values = [path];
  const equals = path.indexOf("=");
  if (equals >= 0) values.push(path.slice(equals + 1));
  return values.some((value) => {
    const segments = value.split(/[\\/]/).filter((segment) => segment && segment !== ".");
    return segments.some((segment, index) => isExcluded(segment, index === 0));
  });
};
type Entry = {
  path: string;
  kind: "file" | "directory";
  sourceKind: "json" | "plugin";
  expires: number;
  installationId?: string;
  digest?: string;
  cleanupPath?: string;
  fallbackName?: string;
  abort?: AbortController;
  pending?: Set<Promise<unknown>>;
  work?: ReturnType<typeof progressDeadline>;
};
type Snapshot = {
  text: string;
  digest: string;
  files: Map<string, ImportContent>;
  configNames: Set<string>;
};
function failure(reason = "layout_unsupported"): never {
  throw new RpcError(RpcErrorCodes.pluginImportInvalid, `connector_import_${reason}`);
}
function rejectSymlink(): never {
  throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_import_symlink");
}
function rejectCommandSubstitution(): never {
  throw new RpcError(
    RpcErrorCodes.pluginImportInvalid,
    "connector_command_substitution_unsupported",
  );
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
async function readSafe(root: string, path: string, max: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!inside(root, path)) failure("path_outside_plugin");
  let ancestor = path;
  while (ancestor !== root) {
    if ((await lstat(ancestor)).isSymbolicLink()) rejectSymlink();
    ancestor = dirname(ancestor);
  }
  // Bigint stats keep NTFS-sized inodes exact (see execution core/file-identity.ts; the host entry
  // cannot import execution, so the comparison stays inline).
  const stat = await lstat(path, { bigint: true });
  if (Number(stat.size) > max) failure("file_too_large");
  if (!stat.isFile() || stat.isSymbolicLink()) failure();
  if (!inside(root, await realpath(path))) failure("path_outside_plugin");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
  );
  try {
    const current = await file.stat({ bigint: true });
    if (
      !current.isFile() ||
      Number(current.size) > max ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    )
      failure();
    const bytes = await file.readFile({ signal });
    if (bytes.length > max) failure("file_too_large");
    const latest = await lstat(path, { bigint: true });
    if (
      !inside(root, await realpath(path)) ||
      latest.dev !== current.dev ||
      latest.ino !== current.ino
    )
      failure();
    return bytes;
  } finally {
    await file.close();
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure();
  return value as Record<string, unknown>;
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function scalar(value: string | undefined) {
  const text = value?.trim() ?? "";
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  )
    return text.slice(1, -1);
  return text.replace(/\s+#.*$/, "").trim();
}

function skillMetadata(text: string, fallback: string) {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
  const header = end >= 0 ? normalized.slice(4, end) : "";
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], scalar(match[2]));
  }
  const body = end >= 0 ? normalized.slice(end + 4).trim() : normalized;
  const description =
    fields.get("description") || body.split("\n").find((line) => line.trim()) || fallback;
  return {
    name: (fields.get("name") || fallback)
      .replace(/[\p{Cc}]/gu, " ")
      .trim()
      .slice(0, 80),
    description: description
      .replace(/[\p{Cc}]/gu, " ")
      .trim()
      .slice(0, 1024),
  };
}

function skillId(value: string) {
  let id = value
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!/^[a-z]/.test(id)) id = `command-${id}`.slice(0, 64);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) failure();
  return id;
}

/** Only selected paths become short-lived capabilities. Renderer never receives a filesystem path. */
/** The two Electron dialog calls this host makes; the desktop passes Electron's `dialog`. */
export interface ImportDialogs {
  showOpenDialog(options: {
    properties: ("openFile" | "openDirectory")[];
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  showMessageBox(
    options: {
      type: "warning";
      buttons: string[];
      defaultId: number;
      cancelId: number;
      noLink: boolean;
      title: string;
      message: string;
      detail: string;
    },
    signal?: AbortSignal,
  ): Promise<{ response: number }>;
}

export function createConnectorImportHost(options: {
  dataDir: string;
  dialog: ImportDialogs;
  locale?: "zh" | "en" | (() => "zh" | "en");
  /** Wording of the run-as-me confirmation (Keychain or keyring); defaults to this process. */
  platform?: NodeJS.Platform;
}): ConnectorImportHost & {
  confirm(
    input: ConnectorCommandConfirmation,
    signal?: AbortSignal,
  ): Promise<{ approved: boolean }>;
  dispose(): Promise<void>;
} {
  const selections = new Map<string, Entry>();
  const stopped = new AbortController();
  const signal = (entry?: Entry) => {
    if (entry) entry.abort ??= new AbortController();
    if (entry?.work) return entry.work.signal;
    return AbortSignal.any([stopped.signal, ...(entry?.abort ? [entry.abort.signal] : [])]);
  };
  let confirming = false;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(selectionId: string, action: () => Promise<T>): Promise<T> => {
    stopped.signal.throwIfAborted();
    const entry = selections.get(selectionId);
    if (entry?.work)
      return Promise.reject(new RpcError(RpcErrorCodes.busy, "connector_import_busy"));
    if (entry) entry.work = progressDeadline(signal(entry));
    const work = Promise.resolve().then(action);
    pending.add(work);
    if (entry) {
      entry.pending ??= new Set();
      entry.pending.add(work);
    }
    return work.finally(() => {
      entry?.work?.dispose();
      if (entry) {
        entry.work = undefined;
        entry.expires = Date.now() + TTL;
      }
      pending.delete(work);
      entry?.pending?.delete(work);
    });
  };
  const privateRoot = join(options.dataDir, "plugins");
  const importRoot = join(options.dataDir, "plugin-imports");
  const cleanupReady = rm(importRoot, { recursive: true, force: true });
  const cleanup = async (entry: Entry | undefined) => {
    entry?.abort?.abort();
    await Promise.allSettled([...(entry?.pending ?? [])]);
    if (entry?.cleanupPath) await rm(entry.cleanupPath, { recursive: true, force: true });
  };
  const get = async (id: string) => {
    const parsed = IdSchema.parse(id);
    const entry = selections.get(parsed);
    if (!entry) failure();
    if (entry.expires < Date.now()) {
      // Keep the expired entry until release/picker cleanup/dispose can drain other readers.
      entry.abort?.abort();
      failure();
    }
    return entry;
  };
  async function connectorSnapshot(
    input: Record<string, unknown>,
    root: string,
    installationId: string,
    files: Map<string, ImportContent>,
    configNames: Set<string>,
    includeDigest = true,
    requestSignal = signal(),
    activity?: () => void,
  ): Promise<Snapshot> {
    const source = record(JSON.parse(JSON.stringify(input)));
    const serverObjects =
      source.schemaVersion === 1
        ? Array.isArray(source.servers)
          ? source.servers.map(record)
          : failure()
        : source.mcpServers
          ? Object.values(record(source.mcpServers)).map(record)
          : [source];
    const required = new Set<string>();
    const ownedRoot = join(privateRoot, IdSchema.parse(installationId));
    const ownedData = join(options.dataDir, "plugin-data", IdSchema.parse(installationId));
    const special = (value: string) =>
      value
        .replaceAll(`\${CLAUDE_PLUGIN_DATA}`, ownedData)
        .replaceAll(`\${CLAUDE_PLUGIN_ROOT}`, ownedRoot)
        .replaceAll(`\${PLUGIN_ROOT}`, ownedRoot);
    const pathCandidate = (value: string) => {
      const equals = value.indexOf("=");
      return equals >= 0
        ? { prefix: value.slice(0, equals + 1), value: value.slice(equals + 1) }
        : { prefix: "", value };
    };
    async function relocate(value: unknown): Promise<unknown> {
      if (typeof value !== "string") return value;
      const sourceCandidate = value
        .replaceAll(`\${CLAUDE_PLUGIN_ROOT}`, root)
        .replaceAll(`\${PLUGIN_ROOT}`, root);
      const mapped = special(value);
      if (
        sourceCandidate.includes(`\${CLAUDE_PLUGIN_ROOT}`) ||
        sourceCandidate.includes(`\${PLUGIN_ROOT}`)
      )
        failure();
      if (value.includes(`\${CLAUDE_PLUGIN_DATA}`)) return mapped;
      const absolute = isAbsolute(sourceCandidate)
        ? sourceCandidate
        : resolve(root, sourceCandidate);
      const sourceInsideRoot = inside(root, absolute);
      if (
        (sourceInsideRoot || !isAbsolute(sourceCandidate)) &&
        referencesExcludedPath(sourceInsideRoot ? relative(root, absolute) : sourceCandidate)
      )
        failure();
      const pathExists = await exists(absolute);
      if (!pathExists) {
        if (
          value.startsWith("./") ||
          value.startsWith("../") ||
          value.includes(`\${CLAUDE_PLUGIN_ROOT}`) ||
          value.includes(`\${PLUGIN_ROOT}`)
        )
          failure();
        return mapped;
      }
      if (isAbsolute(sourceCandidate) && !inside(root, absolute)) {
        if (!isAbsolute(value)) failure();
        return value;
      }
      if (!inside(root, absolute) || absolute === root) failure("path_outside_plugin");
      const rel = relative(root, absolute);
      if (rel.split(sep).some((segment, index) => isExcluded(segment, index === 0))) failure();
      required.add(rel);
      return join(ownedRoot, rel);
    }
    async function relocateArgument(value: unknown): Promise<unknown> {
      if (typeof value !== "string") return value;
      const candidate = pathCandidate(value);
      const relocated = await relocate(candidate.value);
      return typeof relocated === "string" ? `${candidate.prefix}${relocated}` : relocated;
    }
    for (const server of serverObjects) {
      if (server.command !== undefined) {
        if (
          typeof server.command === "string" &&
          hasPluginCommandSubstitution(server.command, true)
        )
          rejectCommandSubstitution();
        server.command = await relocate(server.command);
      }
      if (Array.isArray(server.args))
        server.args = await Promise.all(server.args.map(relocateArgument));
      for (const field of ["env", "headers"])
        if (server[field]) {
          const values = record(server[field]);
          for (const [name, value] of Object.entries(values))
            if (typeof value === "string")
              values[name] = /\$\{(?:CLAUDE_)?PLUGIN_(?:ROOT|DATA)\}/.test(value)
                ? await relocate(value)
                : special(value);
        }
    }
    const parentCache: ImportParentCache = new Map();
    let entries = files.size;
    let bytes = [...files.values()].reduce((sum, item) => sum + item.byteLength, 0);
    if (files.size > MAX_FILES || bytes > MAX_BYTES) failure();
    async function collect(path: string) {
      requestSignal.throwIfAborted();
      if (++entries > 100_000) failure();
      const stat = await lstat(path);
      activity?.();
      if (stat.isSymbolicLink()) rejectSymlink();
      if (stat.isDirectory()) {
        for await (const child of await opendir(path)) {
          if (isExcluded(child.name, path === root)) continue;
          await collect(join(path, child.name));
        }
        return;
      }
      const rel = relative(root, path);
      if (files.has(rel)) return;
      const content = await importResource(root, path, MAX_BYTES - bytes, parentCache);
      bytes += content.byteLength;
      if (bytes > MAX_BYTES) failure("file_too_large");
      files.set(rel, content);
      if (files.size > MAX_FILES) failure();
    }
    for (const rel of required) {
      const path = join(root, rel);
      const stat = await lstat(path);
      activity?.();
      await collect(stat.isDirectory() || dirname(rel) === "." ? path : dirname(path));
    }
    const text = JSON.stringify(source);
    if (Buffer.byteLength(text) > MAX_CONFIG) failure("file_too_large");
    const hash = createHash("sha256").update(text);
    if (includeDigest)
      for (const [name, content] of [...files].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        hash.update(name).update("\0");
        for await (const chunk of importChunks(content, requestSignal, activity))
          hash.update(chunk);
        hash.update("\0");
      }
    return { text, digest: hash.digest("hex"), files, configNames };
  }
  async function snapshot(
    entry: Entry,
    installationId: string,
    requestSignal = signal(entry),
  ): Promise<Snapshot> {
    const activity = () => {
      entry.work?.touch();
      entry.expires = Date.now() + TTL;
    };
    requestSignal.throwIfAborted();
    if ((await lstat(entry.path)).isSymbolicLink()) failure();
    const root =
      entry.kind === "directory" ? await realpath(entry.path) : await realpath(dirname(entry.path));
    const files = new Map<string, ImportContent>();
    const configNames = new Set<string>();
    if (entry.sourceKind === "json") {
      const bytes = await readSafe(root, entry.path, MAX_CONFIG, requestSignal);
      const text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
      try {
        record(JSON.parse(text));
      } catch {
        failure();
      }
      return {
        text,
        digest: createHash("sha256").update(text).digest("hex"),
        files,
        configNames,
      };
    }
    const config = async (path: string) => {
      const rel = relative(root, path);
      if (
        !inside(root, path) ||
        rel.split(sep).some((segment, index) => isExcluded(segment, index === 0))
      )
        failure();
      if (!(await exists(path))) failure("manifest_not_found");
      const bytes = await readSafe(root, path, MAX_CONFIG, requestSignal);
      files.set(rel, bytes);
      configNames.add(rel);
      try {
        return record(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")));
      } catch {
        failure();
      }
    };
    let manifest: Record<string, unknown> = {};
    let manifestPath: string | undefined;
    if (entry.kind === "file" && extname(entry.path).toLowerCase() === ".json")
      manifestPath = entry.path;
    else {
      for (const candidate of [
        join(root, ".codex-plugin", "plugin.json"),
        join(root, ".claude-plugin", "plugin.json"),
        join(root, "plugin.json"),
      ])
        if (await exists(candidate)) {
          manifestPath = candidate;
          break;
        }
    }
    if (manifestPath) {
      const raw = await config(manifestPath);
      try {
        manifest = record(parseClaudePluginManifest(raw));
      } catch {
        failure();
      }
    }
    // Installed applications use the same card metadata as shipped apps, with only a portable
    // server entry: declarations cannot grant fixed system services or trusted sandbox escapes.
    const applicationPath = join(root, "pibot.json");
    const applicationSource = (await exists(applicationPath))
      ? record(
          JSON.parse(
            (await readSafe(root, applicationPath, MAX_CONFIG, requestSignal)).toString("utf8"),
          ),
        )
      : undefined;
    const application =
      applicationSource?.format === "pibot-application"
        ? PortablePiBotApplicationSchema.parse(applicationSource)
        : undefined;
    if (application) {
      files.set("pibot.json", Buffer.from(JSON.stringify(application)));
      manifest = {
        ...manifest,
        name: application.id,
        pibotApp: true,
        description: application.card.description.zh,
      };
    }

    const components: ClaudePluginComponent[] = [];
    const skills: ClaudePluginSkill[] = [];
    const usedSkillIds = new Set<string>();
    const parentCache: ImportParentCache = new Map();
    let entries = files.size;
    let bytes = [...files.values()].reduce((sum, item) => sum + item.byteLength, 0);
    if (files.size > MAX_FILES || bytes > MAX_BYTES) failure();
    async function collect(path: string) {
      requestSignal.throwIfAborted();
      if (++entries > 100_000) failure();
      const stat = await lstat(path);
      activity?.();
      if (stat.isSymbolicLink()) rejectSymlink();
      if (stat.isDirectory()) {
        for await (const child of await opendir(path)) {
          if (isExcluded(child.name, path === root)) continue;
          await collect(join(path, child.name));
        }
        return;
      }
      const rel = relative(root, path);
      if (files.has(rel)) return;
      const content = await importResource(root, path, MAX_BYTES - bytes, parentCache);
      bytes += content.byteLength;
      if (bytes > MAX_BYTES) failure("file_too_large");
      files.set(rel, content);
      if (files.size > MAX_FILES) failure();
    }
    async function addSkill(path: string, kind: "skill" | "command", fallback: string) {
      const content = await readSafe(root, path, MAX_CONFIG, requestSignal);
      const rel = relative(root, path).split(sep).join("/");
      // A suspected credential refuses only this skill. Failing the whole plugin
      // threw away every other skill because one file mentioned something key-shaped.
      if (looksLikeCredentialValue(content.toString("utf8"))) {
        components.push({
          kind,
          name: fallback,
          path: rel,
          status: "unsupported",
          reason: "secret",
        });
        return;
      }
      const id = skillId(fallback);
      if (usedSkillIds.has(id)) failure();
      usedSkillIds.add(id);
      const metadata = skillMetadata(content.toString("utf8"), fallback);
      skills.push({ id, kind, path: rel, ...metadata });
      components.push({ kind, name: metadata.name, path: rel, status: "import" });
      if (kind === "skill") await collect(dirname(path));
      else {
        files.set(relative(root, path), content);
        entries++;
        bytes += content.byteLength;
      }
      if (files.size > MAX_FILES || bytes > MAX_BYTES) failure();
    }

    const skillsRoot = join(root, "skills");
    if (await exists(skillsRoot)) {
      if ((await lstat(skillsRoot)).isSymbolicLink()) failure();
      for await (const child of await opendir(skillsRoot)) {
        if (child.isSymbolicLink()) failure();
        if (!child.isDirectory() || isNeverCopied(child.name)) continue;
        const path = join(skillsRoot, child.name, "SKILL.md");
        if (await exists(path)) await addSkill(path, "skill", child.name);
      }
    }
    // A package whose SKILL.md sits at its root is one skill. Reading only skills/*/SKILL.md
    // reported "0 skills" for it, so the import button imported nothing.
    if (!skills.some((skill) => skill.kind === "skill")) {
      const rootSkill = join(root, "SKILL.md");
      if (await exists(rootSkill)) await addSkill(rootSkill, "skill", basename(root));
    }
    const commandsRoot = join(root, "commands");
    if (await exists(commandsRoot)) {
      if ((await lstat(commandsRoot)).isSymbolicLink()) failure();
      for await (const child of await opendir(commandsRoot)) {
        if (child.isSymbolicLink()) failure();
        if (child.isFile() && child.name.toLowerCase().endsWith(".md"))
          await addSkill(
            join(commandsRoot, child.name),
            "command",
            basename(child.name, extname(child.name)),
          );
      }
    }

    const mcpServers: Record<string, unknown> = {};
    const mergeMcp = (value: unknown) => {
      const source = record(value);
      for (const [name, server] of Object.entries(source)) {
        if (Object.hasOwn(mcpServers, name)) failure("mcp_duplicate");
        mcpServers[name] = server;
      }
    };
    const mcpPath = join(root, ".mcp.json");
    if (application)
      mcpServers[application.id] = {
        command: "node",
        args: [`\${CLAUDE_PLUGIN_ROOT}/${application.server.entry}`],
        env: application.server.env,
        networkDomains: application.server.networkDomains,
      };
    const rootMcp = await exists(mcpPath);
    if (rootMcp && !application) {
      const source = await config(mcpPath);
      mergeMcp(source.mcpServers ?? source);
      components.push({ kind: "mcp", name: ".mcp.json", path: ".mcp.json", status: "import" });
    }
    if (manifest.mcpServers !== undefined && !application) {
      if (typeof manifest.mcpServers === "string") {
        const declared = manifest.mcpServers;
        if (isAbsolute(declared) || declared.includes("${")) failure();
        const declaredPath = resolve(root, declared);
        if (!inside(root, declaredPath)) failure("path_outside_plugin");
        // Codex plugins (figma, data-analytics…) declare "./.mcp.json", the default file read
        // above; reading it twice made every server a duplicate and failed the whole import.
        if (!(rootMcp && declaredPath === resolve(mcpPath))) {
          const source = await config(declaredPath);
          mergeMcp(source.mcpServers ?? source);
          components.push({ kind: "mcp", name: declared, path: declared, status: "import" });
        }
      } else {
        mergeMcp(manifest.mcpServers);
        components.push({ kind: "mcp", name: "plugin.json mcpServers", status: "import" });
      }
    }

    const configFields: ClaudePluginConfigField[] = [];
    if (manifest.userConfig !== undefined) {
      for (const [key, raw] of Object.entries(record(manifest.userConfig))) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) failure();
        const field = record(raw);
        const type = field.type === undefined ? "string" : String(field.type);
        if (!["string", "number", "boolean", "directory", "file"].includes(type)) failure();
        const value = hardenPluginConfigField({
          key,
          type: type as ClaudePluginConfigField["type"],
          // `{ zh, en }` is accepted beside plain strings (see the SDK's PluginTextSchema).
          title: pluginText(field.title) ?? key,
          description: pluginText(field.description) ?? key,
          sensitive: field.sensitive === true,
          required: field.required === true,
          ...(field.default !== undefined
            ? { default: field.default as string | number | boolean }
            : {}),
          ...(Array.isArray(field.options)
            ? {
                options: field.options
                  .filter(
                    (option): option is Record<string, unknown> =>
                      !!option && typeof option === "object" && !Array.isArray(option),
                  )
                  .filter(
                    (option) =>
                      ["string", "number", "boolean"].includes(typeof option.value) &&
                      pluginText(option.label) !== undefined,
                  )
                  .map((option) => ({
                    value: option.value as string | number | boolean,
                    label: pluginText(option.label) as string,
                  })),
              }
            : Array.isArray(field.enum)
              ? {
                  options: field.enum
                    .filter((option): option is string | number | boolean =>
                      ["string", "number", "boolean"].includes(typeof option),
                    )
                    .map((option) => ({ value: option, label: String(option) })),
                }
              : {}),
          ...(field.visibleWhen &&
          typeof field.visibleWhen === "object" &&
          !Array.isArray(field.visibleWhen) &&
          typeof (field.visibleWhen as Record<string, unknown>).key === "string" &&
          ["string", "number", "boolean"].includes(
            typeof (field.visibleWhen as Record<string, unknown>).equals,
          )
            ? {
                visibleWhen: {
                  key: String((field.visibleWhen as Record<string, unknown>).key),
                  equals: (field.visibleWhen as Record<string, unknown>).equals as
                    | string
                    | number
                    | boolean,
                },
              }
            : {}),
        });
        configFields.push(value);
        components.push({ kind: "setting", name: value.title, status: "import" });
      }
    }
    const declared = new Set(configFields.map((field) => field.key));
    const serializedMcp = JSON.stringify(mcpServers);
    for (const match of serializedMcp.matchAll(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g)) {
      const key = match[1];
      if (!key || key === "CLAUDE_PLUGIN_ROOT" || key === "CLAUDE_PLUGIN_DATA" || declared.has(key))
        continue;
      declared.add(key);
      configFields.push({
        key,
        type: "string",
        title: key,
        description: "",
        sensitive: true,
        required: true,
      });
      components.push({ kind: "setting", name: key, status: "import" });
    }

    const experimental =
      manifest.experimental &&
      typeof manifest.experimental === "object" &&
      !Array.isArray(manifest.experimental)
        ? (manifest.experimental as Record<string, unknown>)
        : undefined;
    for (const {
      path,
      kind,
      reason,
      manifestFields,
      experimentalFields,
    } of unsupportedClaudePluginComponents) {
      if (
        (path !== "pibot.json" || !application) &&
        ((await exists(join(root, path))) ||
          manifestFields.some((field) => manifest[field] !== undefined) ||
          experimentalFields.some((field) => experimental?.[field] !== undefined))
      )
        components.push({ kind, name: path, path, status: "unsupported", reason });
    }
    for (const [field, kind, name] of [
      ["skills", "skill", "plugin.json skills"],
      ["commands", "command", "plugin.json commands"],
    ] as const)
      if (manifest[field] !== undefined)
        components.push({
          kind,
          name,
          status: "unsupported",
          reason: "not-supported",
        });
    if (!manifestPath && !rootMcp && !skills.length && !components.length)
      failure("manifest_not_found");
    const bundle = ClaudePluginBundleSchema.parse({
      pibotClaudePlugin: 1,
      name: String(manifest.name ?? entry.fallbackName ?? basename(root)),
      version: String(manifest.version ?? "0.0.0"),
      versionDeclared: manifest.version !== undefined,
      description: String(manifest.description ?? "Imported Claude Code plugin"),
      application: manifest.pibotApp === true,
      ...(application ? { applicationId: application.id } : {}),
      ...(application ? { applicationCard: application.card } : {}),
      mcpServers,
      skills,
      config: configFields,
      components,
    });
    files.set(
      ".pibot-plugin.json",
      Buffer.from(JSON.stringify({ schemaVersion: 1, name: bundle.name, skills: bundle.skills })),
    );
    const relocated = await connectorSnapshot(
      { mcpServers: bundle.mcpServers },
      root,
      installationId,
      files,
      configNames,
      false,
      requestSignal,
      activity,
    );
    const text = JSON.stringify({
      ...bundle,
      mcpServers: record(JSON.parse(relocated.text)).mcpServers,
    });
    if (Buffer.byteLength(text) > MAX_CONFIG) failure("file_too_large");
    const hash = createHash("sha256").update(text);
    for (const [name, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
      hash.update(name).update("\0");
      for await (const chunk of importChunks(content, requestSignal, activity)) hash.update(chunk);
      hash.update("\0");
    }
    return { text, digest: hash.digest("hex"), files, configNames };
  }
  const host: ConnectorImportHost & {
    confirm(
      input: ConnectorCommandConfirmation,
      signal?: AbortSignal,
    ): Promise<{ approved: boolean }>;
    dispose(): Promise<void>;
    replaceMaterialize(input: {
      selectionId: string;
      installationId: string;
      expectedDigest: string;
    }): Promise<{ ok: true }>;
  } = {
    async pick({ kind }) {
      await cleanupReady;
      for (const [id, entry] of selections)
        if (entry.expires < Date.now()) {
          selections.delete(id);
          await cleanup(entry);
        }
      if (selections.size >= 16) failure();
      const result = await options.dialog.showOpenDialog({
        properties: kind === "directory" ? ["openDirectory"] : ["openFile"],
        ...(kind === "file"
          ? { filters: [{ name: "Plugin or JSON", extensions: ["zip", "json"] }] }
          : {}),
      });
      stopped.signal.throwIfAborted();
      const path = result.filePaths[0];
      // Dismissing the dialog is a normal outcome; say so instead of an empty selection
      // that callers had to guess at.
      if (result.canceled || !path) return { selectionId: null, canceled: true };
      // Reject the selected alias explicitly; do not weaken descendant no-follow checks.
      if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== resolve(path))
        throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_import_symlink");
      const selectionId = randomUUID();
      if (kind === "file" && extname(path).toLowerCase() === ".zip") {
        await mkdir(importRoot, { recursive: true, mode: 0o700 });
        if ((await lstat(importRoot)).isSymbolicLink()) failure();
        const cleanupPath = join(importRoot, selectionId);
        const extracted = await withProgressDeadline(signal(), (signal, touch) =>
          extractPluginZip(path, cleanupPath, signal, touch),
        );
        selections.set(selectionId, {
          path: extracted,
          kind: "directory",
          sourceKind: "plugin",
          expires: Date.now() + TTL,
          cleanupPath,
          fallbackName: basename(path, extname(path)),
        });
      } else
        selections.set(selectionId, {
          path,
          kind,
          sourceKind: kind === "directory" ? "plugin" : "json",
          expires: Date.now() + TTL,
          fallbackName: kind === "directory" ? basename(path) : basename(path, extname(path)),
        });
      return { selectionId, canceled: false };
    },
    async adopt({ path, temporary }) {
      await cleanupReady;
      stopped.signal.throwIfAborted();
      for (const [id, entry] of selections)
        if (entry.expires < Date.now()) {
          selections.delete(id);
          await cleanup(entry);
        }
      if (selections.size >= 16) failure();
      // The brain names this folder from its own scan; the same alias rules as a picked folder
      // apply, and nothing outside it is read (snapshot keeps every file inside the root).
      if (!isAbsolute(path)) failure();
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (await realpath(path)) !== resolve(path))
        throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_import_symlink");
      if (!stat.isDirectory()) failure();
      stopped.signal.throwIfAborted();
      const selectionId = randomUUID();
      let cleanupPath: string | undefined;
      if (temporary) {
        // This flag only transfers the brain-owned, validated download tree, never arbitrary picks.
        const downloads = await realpath(join(options.dataDir, "skill-downloads"));
        const rel = relative(downloads, path);
        if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) failure();
        await mkdir(importRoot, { recursive: true, mode: 0o700 });
        if ((await lstat(importRoot)).isSymbolicLink()) failure();
        cleanupPath = join(importRoot, selectionId);
        try {
          await withProgressDeadline(stopped.signal, async (copySignal, touch) =>
            cp(path, cleanupPath as string, {
              recursive: true,
              dereference: false,
              errorOnExist: true,
              force: false,
              filter: () => {
                copySignal.throwIfAborted();
                touch();
                return true;
              },
            }),
          );
          path = cleanupPath;
        } catch (error) {
          await rm(cleanupPath, { recursive: true, force: true });
          throw error;
        }
      }
      selections.set(selectionId, {
        path,
        ...(cleanupPath ? { cleanupPath } : {}),
        kind: "directory",
        sourceKind: "plugin",
        expires: Date.now() + TTL,
        fallbackName: basename(path),
      });
      return { selectionId };
    },
    async read({ selectionId, installationId }) {
      const entry = await get(selectionId);
      if (entry.installationId && entry.installationId !== installationId) failure();
      const result = await snapshot(entry, installationId);
      entry.installationId = installationId;
      entry.digest = result.digest;
      return {
        text: result.text,
        sourceDigest: result.digest,
        sourceKind: entry.sourceKind,
        ...(entry.sourceKind === "plugin"
          ? {
              fileChanges: await importFileChanges(
                join(privateRoot, installationId),
                result.files.keys(),
                signal(entry),
              ),
            }
          : {}),
      };
    },
    async materialize({ selectionId, installationId, expectedDigest }) {
      const entry = await get(selectionId);
      const requestSignal = signal(entry);
      const activity = () => {
        entry.work?.touch();
        entry.expires = Date.now() + TTL;
      };
      if (entry.installationId !== installationId || entry.digest !== expectedDigest) failure();
      if (entry.sourceKind !== "plugin") failure();
      const result = await snapshot(entry, installationId, requestSignal);
      if (result.digest !== expectedDigest) failure();
      await mkdir(privateRoot, { recursive: true, mode: 0o700 });
      if ((await lstat(privateRoot)).isSymbolicLink()) failure();
      const destination = join(privateRoot, IdSchema.parse(installationId));
      try {
        await lstat(destination);
        failure();
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          throw error;
      }
      const stage = join(privateRoot, `.stage-${randomUUID()}`);
      const pluginDataRoot = join(options.dataDir, "plugin-data");
      const pluginData = join(pluginDataRoot, IdSchema.parse(installationId));
      await mkdir(stage, { mode: 0o700 });
      let dataCreated = false;
      let renamed = false;
      try {
        for (const [name, content] of result.files) {
          // The sanitized DB manifest is authoritative; imported source JSON may contain plaintext tokens.
          if (result.configNames.has(name)) continue;
          const path = join(stage, name);
          if (!inside(stage, path)) failure();
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const file = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o700,
          );
          try {
            for await (const chunk of importChunks(content, requestSignal, activity))
              await file.writeFile(chunk);
          } finally {
            await file.close();
          }
        }
        await mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
        if ((await lstat(pluginDataRoot)).isSymbolicLink()) failure();
        if (await exists(pluginData)) failure();
        await mkdir(pluginData, { mode: 0o700 });
        dataCreated = true;
        requestSignal.throwIfAborted();
        await rename(stage, destination);
        renamed = true;
      } catch (error) {
        await Promise.all([
          rm(stage, { recursive: true, force: true }),
          ...(renamed ? [rm(destination, { recursive: true, force: true })] : []),
          ...(dataCreated ? [rm(pluginData, { recursive: true, force: true })] : []),
        ]);
        throw error;
      }
      return { ok: true };
    },
    async replaceMaterialize({ selectionId, installationId, expectedDigest }) {
      const id = IdSchema.parse(installationId);
      const destination = join(privateRoot, id);
      const pluginData = join(options.dataDir, "plugin-data", id);
      const backup = `${destination}.backup-${randomUUID()}`;
      const dataBackup = `${pluginData}.backup-${randomUUID()}`;
      await rename(destination, backup);
      let dataMoved = false;
      try {
        // A plugin that never wrote data has no folder; that is not a failed update.
        dataMoved = await rename(pluginData, dataBackup).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        await host.materialize({ selectionId, installationId: id, expectedDigest });
        await Promise.all([
          rm(backup, { recursive: true, force: true }),
          rm(dataBackup, { recursive: true, force: true }),
        ]);
        return { ok: true };
      } catch (error) {
        await Promise.all([
          rm(destination, { recursive: true, force: true }),
          rm(pluginData, { recursive: true, force: true }),
          rename(backup, destination),
          ...(dataMoved ? [rename(dataBackup, pluginData)] : []),
        ]);
        throw error;
      }
    },
    async release({ selectionId }) {
      const id = IdSchema.parse(selectionId);
      const entry = selections.get(id);
      entry?.abort?.abort();
      selections.delete(id);
      await Promise.allSettled([...(entry?.pending ?? [])]);
      await cleanup(entry);
      return { ok: true };
    },
    async remove({ installationId }) {
      const id = IdSchema.parse(installationId);
      await Promise.all([
        rm(join(privateRoot, id), { recursive: true, force: true }),
        rm(join(options.dataDir, "plugin-data", id), { recursive: true, force: true }),
      ]);
      return { ok: true };
    },
    async confirm(input, parent) {
      if (confirming) throw new RpcError(RpcErrorCodes.busy, "gui_dialog_busy");
      const waiting = AbortSignal.any([
        stopped.signal,
        ...(parent ? [parent] : []),
        AbortSignal.timeout(300_000),
      ]);
      waiting.throwIfAborted();
      const zh =
        (typeof options.locale === "function" ? options.locale() : options.locale) === "zh";
      confirming = true;
      try {
        const answer = await options.dialog.showMessageBox(
          {
            type: "warning",
            ...commandConfirmationDialog(input, zh, options.platform ?? process.platform),
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          },
          waiting,
        );
        waiting.throwIfAborted();
        return { approved: answer.response === 1 };
      } catch (error) {
        if (waiting.aborted)
          throw new RpcError(
            waiting.reason instanceof DOMException && waiting.reason.name === "TimeoutError"
              ? RpcErrorCodes.timeout
              : RpcErrorCodes.closed,
            "connector_confirmation_ended",
          );
        throw error;
      } finally {
        confirming = false;
      }
    },
    async dispose() {
      stopped.abort();
      await Promise.allSettled([...pending]);
      try {
        await Promise.all([...selections.values()].map(cleanup));
      } finally {
        selections.clear();
      }
    },
  };
  // Optional on the interface; this host always has it, but keep the type honest.
  const adopt = host.adopt;
  return {
    ...host,
    confirm: (input, parent) => {
      const work = host.confirm(input, parent);
      pending.add(work);
      return work.finally(() => pending.delete(work));
    },
    ...(adopt
      ? { adopt: (input: { path: string; temporary?: boolean }) => track("", () => adopt(input)) }
      : {}),
    read: (input) => track(input.selectionId, () => host.read(input)),
    materialize: (input) => track(input.selectionId, () => host.materialize(input)),
  };
}
