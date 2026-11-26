// Builds and applies the AGENTS.md change behind a project-memory proposal.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { RpcError } from "@pibot/protocol-base";

const OPEN = "<!-- pibot:notes -->";
const CLOSE = "<!-- /pibot:notes -->";
const TITLE = "## Pi Bot 记下的项目背景";
const MAX_BYTES = 256 * 1024;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function readAgents(path: string) {
  try {
    // A symlinked AGENTS.md could point outside the project folder; refuse rather than follow.
    if (lstatSync(path).isSymbolicLink())
      throw new RpcError(-32011, "memory_project_target_invalid");
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

/** The marked section Pi Bot owns, or none; a damaged pair of markers is never guessed at. */
function section(content: string) {
  const start = content.indexOf(OPEN);
  const end = content.indexOf(CLOSE);
  if (start < 0 && end < 0) return undefined;
  if (
    start < 0 ||
    end < start ||
    content.indexOf(OPEN, start + OPEN.length) >= 0 ||
    content.indexOf(CLOSE, end + CLOSE.length) >= 0
  )
    throw new RpcError(-32011, "memory_project_target_invalid");
  const inner = content.slice(start + OPEN.length, end).split(/\r?\n/);
  return {
    head: content.slice(0, start),
    tail: content.slice(end + CLOSE.length),
    title: inner.find((line) => line.startsWith("## ")) ?? TITLE,
    notes: inner.filter((line) => line.trim() && !line.startsWith("## ")),
  };
}

/**
 * The user's own part of the file. Pending cards are checked against it, so accepting one card
 * (which rewrites only the marked section) does not make the next card from the same topic stale,
 * while any edit the user made elsewhere still does.
 */
function ownContentHash(content: string) {
  const own = section(content);
  return sha256(own ? own.head + own.tail : content);
}

const noteLine = (text: string) => `- ${text.replace(/\s*\r?\n\s*/g, " ").trim()}`;

/** A reviewable diff that adds one note line to the marked section. */
export function projectFileProposal(path: string, text: string) {
  const before = readAgents(path);
  const own = section(before);
  const line = noteLine(text);
  const diff = [
    "--- AGENTS.md",
    "+++ AGENTS.md",
    ...(own
      ? [
          ` ${OPEN}`,
          ` ${own.title}`,
          ...own.notes.map((note) => ` ${note}`),
          `+${line}`,
          ` ${CLOSE}`,
        ]
      : [`+${OPEN}`, `+${TITLE}`, "+", `+${line}`, `+${CLOSE}`]),
  ].join("\n");
  return { path, diff, hash: ownContentHash(before) };
}

/**
 * Writes the confirmed note into the current marked section. The added lines come from the
 * reviewed diff; markers and headings in it are structure, never content.
 */
export function applyProjectFile(path: string, diff: string, expectedHash: string) {
  const current = readAgents(path);
  // Cards made before the section-only check stored the whole file's hash.
  if (expectedHash !== ownContentHash(current) && expectedHash !== sha256(current))
    throw new RpcError(-32011, "memory_project_file_changed");
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .filter((line) => line.trim() && line !== OPEN && line !== CLOSE && !line.startsWith("## "));
  const own = section(current);
  const notes = own?.notes ?? [];
  const merged = [...notes, ...added.filter((line) => !notes.includes(line))];
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const block = [OPEN, own?.title ?? TITLE, "", ...merged, CLOSE].join(eol);
  const next = own
    ? `${own.head}${block}${own.tail}`
    : `${current}${current && !current.endsWith("\n") ? eol : ""}${block}${eol}`;
  if (Buffer.byteLength(next) > MAX_BYTES)
    throw new RpcError(-32011, "memory_project_target_invalid");
  const temp = `${path}.${randomUUID()}.tmp`;
  // AGENTS.md is shared project text, not a secret: keep the user's own permissions.
  writeFileSync(temp, next, { mode: current ? statSync(path).mode & 0o777 : 0o644 });
  renameSync(temp, path);
}
