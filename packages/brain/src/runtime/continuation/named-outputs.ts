// A reply's actual changed files must reach the user without another model request.
import { stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { FILE_LIMIT, MAX_REPLY_ATTACHMENTS } from "@pibot/protocol-base";
import { AttachmentsRepo, RunFileChangesRepo } from "@pibot/storage";
import { isOutputDeliverable } from "../../conversations/attachments/output-path.ts";
import {
  type OutputAttachmentPages,
  sendFiles,
} from "../../conversations/attachments/send-files.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { authorizationSnapshot } from "../tools/local-prepare.ts";

/** Paths explicitly named in a reply; they are references, never authority to read. */
export function namedPaths(reply: string): string[] {
  return [...reply.matchAll(/`([^`\n]{1,1000})`/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

const SOURCE = new Set(
  ".py .js .mjs .cjs .ts .tsx .jsx .sh .bash .zsh .ps1 .bat .cmd .rb .go .rs .java .c .h .cpp .hpp .cs .swift .kt .php .lua .pl .lock .css .scss .vue .svelte".split(
    " ",
  ),
);
/** The file's name stands as a word in the reply (`report.md`, report.md.), not inside another. */
function namedIn(reply: string, path: string) {
  const name = basename(path);
  const at = reply.indexOf(name);
  if (at < 0) return false;
  const before = reply[at - 1] ?? " ";
  const after = reply[at + name.length] ?? " ";
  return !/[\w.-]/u.test(before) && !/[\w-]/u.test(after);
}

/**
 * Maintainers 2026-11-20 (no file may go missing): a document, picture, sheet, deck, page, recording or
 * archive this run newly created is a result even when the reply never names it. Files that
 * already existed and source code still need the output folder or a mention: a Bot editing a
 * project would otherwise post every file it touched, and the changes pane shows those.
 */
const NEW_RESULT = new Set(
  ".txt .md .markdown .rtf .pdf .doc .docx .odt .csv .tsv .xls .xlsx .ods .ppt .pptx .odp .png .jpg .jpeg .gif .webp .svg .bmp .tif .tiff .html .htm .mp3 .mp4 .wav .webm .ogg .m4a .mov .zip".split(
    " ",
  ),
);
/** A command's file changes reach the run's record up to about a second after it returns. */
const COMMAND_SETTLE_MS = 1_200;

type Skip = { reason: "too_large" | "outside_workspace" | "missing" | "limit" };
/** Files left out only by the per-reply limit: shown under the reply with their folder. */
export type AttachmentOverflow = {
  count: number;
  /** Folder of the first file left out, relative to the run's working folder (for display). */
  folder: string;
  /** The same folder, absolute; the brain re-checks it before revealing it. */
  path: string;
};

export async function attachNamedOutputs(input: {
  local: LocalService;
  context: ToolRunContext;
  reply: string;
  signal: AbortSignal;
  declared?: readonly string[];
}): Promise<{ attached: number; overflow?: AttachmentOverflow }> {
  const { local, context, signal } = input;
  if (local.changes.turn.watching(context.runId))
    await new Promise<void>((done) => {
      const timer = setTimeout(done, COMMAND_SETTLE_MS);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true },
      );
    });
  signal.throwIfAborted();
  const touched = await local.changes.turn.touched(context.runId);
  // Written by a write tool over an existing file: not new, whatever its timestamps say.
  const recorded = new Map(
    new RunFileChangesRepo(local.deps.db)
      .summarize(context.runId)
      .map((item) => [item.path, item.kind]),
  );
  const startedRow = local.deps.db
    .prepare("SELECT created_at AS createdAt FROM runs WHERE id=?")
    .get(context.runId) as { createdAt?: string } | undefined;
  const started = startedRow?.createdAt ? Date.parse(startedRow.createdAt) : Number.NaN;
  const place = context.runWorkplace;
  const sent = context.sentFilePaths ?? new Set<string>();
  // Counted now: sendFiles below adds the automatic ones to the same set.
  const sentByModel = sent.size;
  const skipped: Skip[] = [];
  let attached = 0;
  // Group results and task notices still project one reply. A direct chat already renders
  // multiple assistant messages of one run.
  const pages: OutputAttachmentPages | undefined =
    !context.groupId && !context.threadId && !context.executionTaskId && !context.routineRunId
      ? {}
      : undefined;
  const count = pages
    ? 0
    : (new AttachmentsRepo(local.deps.db).forMessages([context.messageId]).get(context.messageId)
        ?.length ?? 0);
  const roots = place?.boundary.writeRoots ?? [];
  const output = (path: string) => isOutputDeliverable(path, roots);
  const named = (path: string) =>
    !SOURCE.has(extname(path).toLowerCase()) && namedIn(input.reply, path);
  // Only new files qualify this way; checked against the file itself below.
  const unnamedNew = (path: string) =>
    !output(path) && !named(path) && NEW_RESULT.has(extname(path).toLowerCase());
  // Declared deliverables and the output folder first, so the limit leaves out the least wanted.
  const candidates = new Set([
    ...(input.declared ?? []),
    ...touched.filter(output),
    ...touched.filter(named),
    ...touched.filter(unnamedNew),
  ]);
  // One file can arrive under two spellings (Windows case, separators); it is attached once.
  const same = (path: string) =>
    local.deps.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const declared = new Set(
    (input.declared ?? []).map((path) => same(resolve(place?.cwd ?? "", path))),
  );
  const sentPaths = new Set(Array.from(sent, same));
  let overflow: AttachmentOverflow | undefined;
  for (const candidate of candidates) {
    signal.throwIfAborted();
    const path = resolve(place?.cwd ?? "", candidate);
    const key = same(path);
    if (sentPaths.has(key)) continue;
    const root = place?.boundary.writeRoots.find((entry) => {
      const part = relative(entry, path);
      return part && !part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part);
    });
    if (
      !place ||
      !root ||
      (place?.boundary.location?.target && place.boundary.location.target !== "local") ||
      relative(root, path)
        .split(sep)
        .some(
          (part, index, parts) =>
            part === ".cache" || (part === ".pibot" && parts[index + 1] !== "out"),
        )
    ) {
      skipped.push({ reason: "outside_workspace" });
      continue;
    }
    const info = await stat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isFile()) {
      skipped.push({ reason: "missing" });
      continue;
    }
    if (
      unnamedNew(candidate) &&
      !declared.has(same(path)) &&
      (recorded.get(path) === "modify" ||
        recorded.get(path) === "delete" ||
        (recorded.get(path) !== "add" &&
          !(info.birthtimeMs > 0 && info.birthtimeMs >= started - 2_000)))
    )
      continue;
    if (info.size > FILE_LIMIT) {
      skipped.push({ reason: "too_large" });
      continue;
    }
    if (!pages && count + attached >= MAX_REPLY_ATTACHMENTS) {
      skipped.push({ reason: "limit" });
      const folder = dirname(path);
      overflow = overflow
        ? { ...overflow, count: overflow.count + 1 }
        : // The working folder itself has no relative name; show its own (Linux acceptance).
          { count: 1, path: folder, folder: relative(place.cwd, folder) || basename(folder) };
      continue;
    }
    try {
      await sendFiles(
        local,
        context,
        {
          roots: [...place.boundary.writeRoots],
          cwd: place.cwd,
          sendPaths: [path],
          authorization: authorizationSnapshot(local, context.botId, context),
        },
        signal,
        "automatic_delivery",
        pages,
      );
      sentPaths.add(key);
      attached++;
    } catch {
      signal.throwIfAborted();
      local.deps.logger.warn(
        JSON.stringify({
          module: "attachments",
          event: "delivery_failed",
          runId: context.runId,
          botId: context.botId,
          code: "attachment_failed",
        }),
      );
    }
  }
  local.deps.logger.info(
    JSON.stringify({
      module: "attachments",
      event: "delivery",
      runId: context.runId,
      botId: context.botId,
      produced: touched.length,
      // Files the model sent itself this run (they can sit on earlier bubbles of the reply).
      sent: sentByModel,
      autoAttached: attached,
      skipped,
    }),
  );
  return { attached, ...(overflow ? { overflow } : {}) };
}
