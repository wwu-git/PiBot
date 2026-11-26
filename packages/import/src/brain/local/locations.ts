// Keeps desktop-selected imports within the documented local source layouts.
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { ImportSource } from "@pibot/import-contract";
import { containsPath, type Platform } from "@pibot/policy";
import { ImportFailure } from "../adapter.ts";

export type LocalSource = "claude-code" | "codex" | "cursor";
export type LocalSelection = { kind: "history" | "projectNote"; configRoot?: string };

export function isLocalSource(source: ImportSource): source is LocalSource {
  return source === "claude-code" || source === "codex" || source === "cursor";
}

export function supportsLocalSources(platform: NodeJS.Platform): platform is Platform {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

function pathApi(platform: Platform) {
  return platform === "win32" ? win32 : posix;
}

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const jsonl = /^([\da-f-]+)\.jsonl$/i;

function claudeSelection(parts: string[], configRoot: string): LocalSelection | undefined {
  if (parts[0] !== "projects" || !parts[1]) return;
  if (parts.length === 3 && uuid.test(jsonl.exec(parts[2] ?? "")?.[1] ?? ""))
    return { kind: "history", configRoot };
  if (parts.length === 4 && parts[2] === "memory" && /^[\w.-][\w.-]*\.md$/i.test(parts[3] ?? ""))
    return { kind: "projectNote", configRoot };
}

function cursorTranscript(parts: string[]) {
  if (parts[0] !== "projects" || !parts[1] || parts[2] !== "agent-transcripts") return false;
  const id = jsonl.exec(parts.at(-1) ?? "")?.[1];
  return !!id && uuid.test(id) && (parts.length === 4 || (parts.length === 5 && parts[3] === id));
}

export function configRootFor(source: LocalSource, platform: Platform, home: string) {
  const api = pathApi(platform);
  const name = source === "claude-code" ? ".claude" : `.${source}`;
  return api.join(home, name);
}

export function sameLocalPath(
  platform: Platform,
  home: string,
  canonicalHome: string,
  file: string,
  canonicalFile: string,
) {
  const api = pathApi(platform);
  const physical = containsPath(home, file, platform)
    ? api.join(canonicalHome, api.relative(home, file))
    : file;
  return api.relative(physical, canonicalFile) === "";
}

export function localSelection(
  source: LocalSource,
  platform: Platform,
  home: string,
  file: string,
): LocalSelection {
  const api = pathApi(platform);
  const configRoot = configRootFor(source, platform, home);
  const parts = api.relative(configRoot, file).split(api.sep);
  if (source === "cursor" && /\.vscdb(?:-wal|-shm)?$/i.test(api.basename(file)))
    throw new ImportFailure("unsupported");
  if (containsPath(configRoot, file, platform)) {
    let selection: LocalSelection | undefined;
    if (source === "claude-code") selection = claudeSelection(parts, configRoot);
    if (
      source === "codex" &&
      parts.length === 5 &&
      parts[0] === "sessions" &&
      /^\d{4}$/.test(parts[1] ?? "") &&
      /^\d{2}$/.test(parts[2] ?? "") &&
      /^\d{2}$/.test(parts[3] ?? "") &&
      /^rollout-[\w-]+\.jsonl$/i.test(parts[4] ?? "")
    )
      selection = { kind: "history", configRoot };
    if (source === "cursor" && cursorTranscript(parts)) selection = { kind: "history", configRoot };
    if (selection) return selection;
    throw new ImportFailure("source_changed");
  }

  const name = api.basename(file);
  const parent = api.dirname(file);
  const isProject = api.relative(home, parent) !== "" && api.parse(parent).root !== parent;
  if (source === "claude-code" && name === "CLAUDE.md" && isProject) return { kind: "projectNote" };
  if (source === "codex" && name === "AGENTS.md" && isProject) return { kind: "projectNote" };
  if (source === "cursor" && isProject && isCursorRule(api, file)) return { kind: "projectNote" };
  throw new ImportFailure("source_changed");
}

function isCursorRule(api: ReturnType<typeof pathApi>, file: string) {
  const name = api.basename(file);
  if (name === ".cursorrules") return true;
  if (!name.endsWith(".mdc")) return false;
  const parts = api.dirname(file).split(api.sep);
  return parts.some((part, index) => part === ".cursor" && parts[index + 1] === "rules");
}

/**
 * A selected CLAUDE.md / AGENTS.md / Cursor rule is one project: the folder it lives in (above
 * `.cursor`). A Claude Code memory note only names its encoded project folder, never a path.
 */
export function noteSummary(platform: NodeJS.Platform, file: string) {
  const api = pathApi(platform === "win32" ? "win32" : "darwin");
  const parts = api.dirname(file).split(api.sep);
  const cursor = parts.lastIndexOf(".cursor");
  const memory = parts.at(-1) === "memory" && parts.at(-3) === "projects";
  const folder = memory
    ? undefined
    : cursor > 0
      ? parts.slice(0, cursor).join(api.sep) || api.sep
      : api.dirname(file);
  const name = (folder ? api.basename(folder) : (parts.at(-2) ?? "").replace(/^-+/u, "")) || "";
  const key = `note:${createHash("sha256")
    .update(folder ?? file)
    .digest("hex")
    .slice(0, 32)}`;
  return {
    summary: {
      topics: 0,
      messages: 0,
      from: null,
      through: null,
      projectNotes: 1,
      projects: [{ key, name: name.slice(0, 200), topics: 0, messages: 0, knowledge: 1 }],
    },
    paths: new Map<string, string>(folder ? [[key, folder]] : []),
  };
}
