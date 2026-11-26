import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { abortable } from "../../core/abort.ts";
import type { WorkspaceFileAccess } from "../../resources/workplaces/workspace-files.ts";
import { migrateLegacyOutputs } from "./output-migration.ts";
import type { WorkflowRun } from "./workflow-prepare.ts";

/**
 * Every output lives under `<primary>/.pibot/out`, whatever the language;
 * the same root as a routine's default artifact folder, so both are found in one place.
 */
export const OUTPUT_ROOT_SEGMENTS = [".pibot", "out"] as const;
export const OUTPUT_ROOT = OUTPUT_ROOT_SEGMENTS.join("/");
/** Older output roots; still recognised in paths (older plans, model habits) and migrated. */
export const LEGACY_OUTPUT_ROOTS = ["Pi Bot 产出", "Pi Bot Output", "Pi Bot Outputs"] as const;
/** The output root and older spellings, as portable relative paths (`.pibot/out` first). */
export function workflowOutputRoots(): readonly string[] {
  return [OUTPUT_ROOT, ...LEGACY_OUTPUT_ROOTS];
}
/**
 * Index just after the last output root in `parts` (path segments), or -1 when the path is not in
 * an output tree. `.pibot/out` spans two segments; the older roots are one.
 */
export function outputRootEnd(parts: readonly string[]): number {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index] ?? "";
    if (part === OUTPUT_ROOT_SEGMENTS[1] && parts[index - 1] === OUTPUT_ROOT_SEGMENTS[0])
      return index + 1;
    if ((LEGACY_OUTPUT_ROOTS as readonly string[]).includes(part)) return index + 1;
  }
  return -1;
}
// A period key, plus `-n` for a later manual run on the same day (`2026-10-22-2`).
const PERIOD = /^(\d{4}-(?:\d{2}-\d{2}|W\d{2}|\d{2}))(?:-(\d{1,3}))?$/;
const SAME_DAY_RUNS = 99;
const LISTED_FILES = 20;
const FOLDER_MS = 5_000;

type FolderWorkflow = Pick<
  WorkflowRun,
  "name" | "contract" | "folder" | "previous" | "previousFromLedger"
> & {
  /** The folder segment under the output root when it is not `folderName(name)` (group plans). */
  root?: string;
};

export interface WorkflowFolder {
  folder: string;
  /** The latest earlier period of the same workflow, with up to 20 file names (manual runs). */
  previous?: { folder: string; files: string[] };
}

/** A folder name from a display name: no separators, reserved characters or trailing dots. */
export function folderName(name: string): string {
  const safe = Array.from(name.normalize("NFC"))
    .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? "-" : char))
    .join("")
    .trim()
    .replace(/[. ]+$/u, "")
    .slice(0, 60);
  return safe && safe !== "." && safe !== ".." ? safe : "workflow";
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const PLAN_FOLDER_CHARS = 48;

/**
 * A group plan's folder segment from the coordinator's free-form plan name: letters (CJK
 * included), digits, `_` and inner dots kept; whitespace becomes `-`; arrows, brackets, quotes and
 * every other symbol go; dashes collapse. Maintainers 2026-11-25: a plan named
 * "A → B（仅供评审）" made a folder with an arrow, full-width brackets and spaces, awkward in a
 * shell and on Windows. Saved workflows and routines keep `folderName`, which earlier periods
 * were written under.
 */
export function planFolderName(name: string): string {
  const slug = Array.from(name.normalize("NFKC"))
    .map((char) => (/[\p{L}\p{N}\p{M}_.]/u.test(char) ? char : /[\s\-‐-―]/u.test(char) ? "-" : ""))
    .join("")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  const capped = Array.from(slug)
    .slice(0, PLAN_FOLDER_CHARS)
    .join("")
    .replace(/[-.]+$/g, "");
  if (!capped) return "plan";
  return WINDOWS_RESERVED.test(capped.split(".")[0] ?? "") ? `${capped}-plan` : capped;
}

/** Local calendar day, the period of a manual run (a routine's period comes from its trigger). */
function today(now: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * This run's artifact folder. A routine passes its period folder; a manual run writes to
 * `<primary>/.pibot/out/<workflow>/<day>[-n]/` under the same rule as routines: inside the primary
 * folder and never through a symbolic link. Nothing is created here (writes create parents).
 */
export async function resolveWorkflowFolder(
  primary: string,
  workflow: FolderWorkflow,
  parent: AbortSignal,
  now = new Date(),
  files?: WorkspaceFileAccess,
): Promise<WorkflowFolder> {
  if (workflow.folder)
    return {
      folder: workflow.folder,
      ...(workflow.previous ? { previous: workflow.previous } : {}),
    };
  const signal = AbortSignal.any([parent, AbortSignal.timeout(FOLDER_MS)]);
  if (files?.remote) return remoteWorkflowFolder(primary, workflow, signal, now, files);
  // A group workflow can start before any run used this folder; its earlier periods must be
  // in `.pibot/out` before the previous period is looked up. Idempotent; a failure leaves them.
  await migrateLegacyOutputs(primary, signal).catch(() => parent.throwIfAborted());
  const workflowRoot = workflow.root ?? folderName(workflow.name);
  const period = await freePeriod(
    join(primary, ...OUTPUT_ROOT_SEGMENTS, workflowRoot),
    today(now),
    signal,
  );
  const names = [...OUTPUT_ROOT_SEGMENTS, workflowRoot, period];
  let current = primary;
  for (const name of names) {
    current = join(current, name);
    const info = await abortable(lstat(current), signal).catch((error: unknown) => {
      parent.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RpcError(RpcErrorCodes.unsupported, "workflow_folder_unavailable");
    });
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new RpcError(RpcErrorCodes.unsupported, "workflow_folder_unavailable");
  }
  const folder = join(primary, ...names);
  const wantsPrevious =
    workflow.contract.state?.readPrevious ||
    workflow.contract.inputs.some((input) => input.kind === "previous");
  if (!wantsPrevious || workflow.previousFromLedger) return { folder };
  // Top-level deliverables only: the period folder listing below is one level deep.
  const deliverables = workflow.contract.deliverables
    .map((item) => item.path)
    .filter((path) => !path.includes("/"));
  const previous = await previousPeriod(
    join(primary, ...OUTPUT_ROOT_SEGMENTS, workflowRoot),
    period,
    deliverables,
    signal,
  ).catch(() => {
    parent.throwIfAborted();
    // No readable earlier period is the normal first run.
    return undefined;
  });
  return previous ? { folder, previous } : { folder };
}

/** Orders period keys by day, then by same-day run number (plain string order puts -10 before -2). */
function periodOrder(a: string, b: string) {
  const [, dayA = a, runA = "1"] = PERIOD.exec(a) ?? [];
  const [, dayB = b, runB = "1"] = PERIOD.exec(b) ?? [];
  return dayA === dayB ? Number(runA) - Number(runB) : dayA < dayB ? -1 : 1;
}

/**
 * A manual run on a day that already has results gets `<day>-2`, `-3`, …, so a second period run
 * the same day neither overwrites the first nor loses it as its previous period.
 * An empty folder (an earlier run that wrote nothing) is reused.
 */
async function freePeriod(root: string, day: string, signal: AbortSignal) {
  for (let run = 1; run <= SAME_DAY_RUNS; run++) {
    const key = run === 1 ? day : `${day}-${run}`;
    const entries = await abortable(readdir(join(root, key)), signal).catch((error: unknown) => {
      signal.throwIfAborted();
      // Missing is the normal case; anything else is checked again by the caller's lstat walk.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
    });
    if (entries && !entries.some((name) => !name.startsWith("."))) return key;
  }
  throw new RpcError(RpcErrorCodes.unsupported, "workflow_folder_unavailable");
}

/**
 * The latest earlier period that finished: it holds at least one of the workflow's deliverables
 * (an interrupted run once left a folder with only data.md, which must not become "last
 * period"). A workflow without deliverables takes the latest earlier folder that has any file.
 */
async function previousPeriod(
  root: string,
  current: string,
  deliverables: readonly string[],
  signal: AbortSignal,
) {
  const entries = await abortable(readdir(root, { withFileTypes: true }), signal);
  const keys = entries
    .filter(
      (entry) =>
        entry.isDirectory() && PERIOD.test(entry.name) && periodOrder(entry.name, current) < 0,
    )
    .map((entry) => entry.name)
    .sort(periodOrder)
    .reverse();
  for (const key of keys) {
    const folder = join(root, key);
    const files = (await abortable(readdir(folder, { withFileTypes: true }), signal))
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    const finished = deliverables.length
      ? deliverables.some((path) => files.includes(path))
      : files.length > 0;
    if (finished) return { folder, files: files.slice(0, LISTED_FILES) };
  }
  return undefined;
}

async function remoteWorkflowFolder(
  primary: string,
  workflow: FolderWorkflow,
  signal: AbortSignal,
  now: Date,
  files: WorkspaceFileAccess,
): Promise<WorkflowFolder> {
  const { join } = files.paths;
  const segment = workflow.root ?? folderName(workflow.name);
  const root = join(primary, ...OUTPUT_ROOT_SEGMENTS, segment);
  let period: string | undefined;
  for (let run = 1; run <= SAME_DAY_RUNS; run++) {
    const key = run === 1 ? today(now) : `${today(now)}-${run}`;
    const info = await files.inspect(join(root, key), signal);
    if (!info) {
      period = key;
      break;
    }
    if (info.kind !== "directory")
      throw new RpcError(RpcErrorCodes.unsupported, "workflow_folder_unavailable");
    if (!(await files.entries(join(root, key), signal)).some((e) => !e.name.startsWith("."))) {
      period = key;
      break;
    }
  }
  if (!period) throw new RpcError(RpcErrorCodes.unsupported, "workflow_folder_unavailable");
  let current = primary;
  for (const part of [...OUTPUT_ROOT_SEGMENTS, segment, period]) {
    current = join(current, part);
    const info = await files.inspect(current, signal);
    if (!info) break;
    if (info.kind !== "directory")
      throw new RpcError(RpcErrorCodes.unsupported, "workflow_folder_unavailable");
  }
  const folder = join(root, period);
  if (
    workflow.previousFromLedger ||
    !(
      workflow.contract.state?.readPrevious ||
      workflow.contract.inputs.some((i) => i.kind === "previous")
    )
  )
    return { folder };
  if (!(await files.inspect(root, signal))) return { folder };
  const selectedPeriod = period;
  const keys = (await files.entries(root, signal))
    .filter(
      (e) =>
        e.kind === "directory" && PERIOD.test(e.name) && periodOrder(e.name, selectedPeriod) < 0,
    )
    .map((e) => e.name)
    .sort(periodOrder)
    .reverse();
  const deliverables = workflow.contract.deliverables
    .map((d) => d.path)
    .filter((p) => !p.includes("/"));
  for (const key of keys) {
    const previous = join(root, key);
    const names = (await files.entries(previous, signal))
      .filter((e) => e.kind === "file" && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    if (deliverables.length ? deliverables.some((p) => names.includes(p)) : names.length)
      return { folder, previous: { folder: previous, files: names.slice(0, LISTED_FILES) } };
  }
  return { folder };
}
