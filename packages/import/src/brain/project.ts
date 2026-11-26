// A reviewed diff grants one conditional write to a project folder's AGENTS.md.
import { createHash, randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { type CapabilityContext, writeReviewedProjectNotes } from "@pibot/brain/kit";
import { createFileTools, directoryIdentity, sensitiveReadBoundary } from "@pibot/execution";
import type { ImportFolderTarget, ImportPreview } from "@pibot/import-contract";
import { nodeFileSystem, protectedPaths } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import type { ImportProjects, ProjectReceipt, StoredReceipt } from "../store/projects.ts";
import type { ImportInput } from "./adapter.ts";
import { exportItems } from "./exports/index.ts";
import { displayPath, type ResolvedFolder, removeFolder, resolveFolder } from "./folders.ts";
import { readProjectNote } from "./local/text.ts";
import { redactImportText } from "./records.ts";

const file = "AGENTS.md";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unavailable = () => new RpcError(-32602, "import_project_unavailable");
type Identity = Pick<ProjectReceipt, "root" | "device" | "inode">;

/** What the brain knows about a source project besides its preview counts. */
export type ProjectInfo = { key: string; name: string; newName: string; source?: string };

export type ProjectReview = {
  reviewId: string;
  key: string;
  target: ImportFolderTarget;
  folder: ResolvedFolder;
  /** The folder's identity when it already existed at review time. */
  identity?: Identity;
  /** null: AGENTS.md does not exist yet and the write creates it. */
  before: string | null;
  content: string;
  diff: string;
  lines: number;
  assertSource(signal: AbortSignal): Promise<void>;
};

export function sameTarget(left: ImportFolderTarget, right: ImportFolderTarget) {
  return (
    left.kind === right.kind &&
    (left.kind !== "folder" || (right.kind === "folder" && left.folderId === right.folderId))
  );
}

export class ProjectImport {
  private readonly files = createFileTools();
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportProjects,
  ) {}

  async review(
    preview: ImportPreview,
    input: ImportInput,
    project: ProjectInfo,
    target: ImportFolderTarget,
    signal: AbortSignal,
  ): Promise<ProjectReview> {
    const notes = await this.notes(preview, input, project.key, signal);
    const folder = await resolveFolder(this.ctx, target, project, signal);
    let identity: Identity | undefined;
    let before: string | null = null;
    if (folder.exists) {
      const { canonicalPath: root, device, inode } = await directoryIdentity(folder.path);
      identity = { root, device, inode };
      before = await this.read(identity, signal);
      if (before !== null && redactImportText(this.ctx.redactor, before) !== before)
        throw unavailable();
    }
    const eol = before?.includes("\r\n") ? "\r\n" : "\n";
    const section = [
      "## Imported project notes / 导入的项目笔记",
      "",
      ...notes
        .join("\n\n")
        .split(/\r?\n/u)
        .map((line) => `> ${line}`),
      "",
    ];
    // A new file opens with the project's name so it reads as that project's notes.
    const added =
      before === null
        ? [`# ${project.name.replace(/[\r\n]+/gu, " ") || project.newName}`, "", ...section]
        : ["", ...section];
    const content = (before === null ? "" : before + eol) + added.join(eol);
    if (Buffer.byteLength(content) > 128 * 1024 || content.split("\n").length > 2000)
      throw unavailable();
    const diff = ["--- AGENTS.md", "+++ AGENTS.md", ...added.map((line) => `+${line}`)].join("\n");
    return {
      reviewId: randomUUID(),
      key: project.key,
      target,
      folder,
      ...(identity ? { identity } : {}),
      before,
      content,
      diff,
      lines: added.length,
      async assertSource(current: AbortSignal) {
        if (input.file) {
          // The native source iterator rechecks permission and identity at both ends, even without reading its body.
          for await (const _file of input.file(current)) current.throwIfAborted();
        } else if (input.projectNote) {
          await readProjectNote(input, current);
        }
      },
    };
  }

  /** How the review names the folder and file; shown paths still pass through the redactor. */
  display(review: ProjectReview) {
    const shown = (path: string) =>
      redactImportText(this.ctx.redactor, displayPath(this.ctx.local.deps, path)).slice(0, 4096);
    const api = this.ctx.local.deps.platform === "win32" ? win32 : posix;
    return {
      folder: shown(review.folder.path),
      path: shown(api.join(review.folder.path, file)),
    };
  }

  private async notes(
    preview: ImportPreview,
    input: ImportInput,
    key: string,
    signal: AbortSignal,
  ) {
    const notes: string[] = [];
    let size = 0;
    const items = input.projectNote
      ? [{ kind: "projects" as const, text: await readProjectNote(input, signal), key }]
      : preview.source === "claude"
        ? exportItems("claude", input, signal)
        : [];
    for await (const item of items) {
      if (item.kind !== "projects") continue;
      if (("key" in item ? item.key : item.project?.key) !== key) continue;
      const text = redactImportText(this.ctx.redactor, item.text).replaceAll("\0", "").trim();
      size += Buffer.byteLength(text);
      if (size > 8000 || notes.length >= 100) throw unavailable();
      if (text) notes.push(text);
    }
    if (!notes.length) throw unavailable();
    return notes;
  }

  /** `root` is the folder as it exists now; a folder created by this batch has a new identity. */
  async apply(
    importId: string,
    botId: string,
    position: number,
    review: ProjectReview,
    root: string,
    signal: AbortSignal,
  ) {
    const { content, diff, before } = review;
    if (redactImportText(this.ctx.redactor, content) !== content) throw unavailable();
    const current = await directoryIdentity(root);
    const identity = { root: current.canonicalPath, device: current.device, inode: current.inode };
    if (
      review.identity &&
      (review.identity.root !== identity.root ||
        review.identity.device !== identity.device ||
        review.identity.inode !== identity.inode)
    )
      throw unavailable();
    await this.context(identity, signal);
    signal.throwIfAborted();
    const receipt = {
      ...identity,
      before: before ?? "",
      created: before === null,
      hash: hash(content),
    };
    this.store.remember(importId, botId, position, receipt);
    await writeReviewedProjectNotes(
      this.ctx.local,
      {
        botId,
        ...identity,
        content,
        expectedHash: before === null ? null : hash(before),
        diff,
        assertSource: review.assertSource,
        assertCurrent: () => this.store.assertCurrent(importId, position, receipt, "apply"),
      },
      signal,
    );
  }

  assertUndoable(importId: string) {
    if (this.store.hasDependents(importId)) throw unavailable();
  }

  /**
   * Puts every project file back, then removes the folders the batch created while they are
   * still empty. A hand-edited file or a folder with new content is kept and counted.
   */
  async restore(importId: string, batchBot: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(90_000)]);
    this.assertUndoable(importId);
    for (const receipt of this.store.pending(importId)) {
      await this.restoreFile(importId, receipt.botId ?? batchBot, receipt, signal);
    }
    for (const folder of this.store.folders(importId)) {
      const state = await removeFolder(this.ctx.local.deps, folder, signal);
      this.store.settleFolder(importId, folder.path, state);
    }
  }

  private async restoreFile(
    importId: string,
    botId: string,
    receipt: StoredReceipt,
    signal: AbortSignal,
  ) {
    const { position } = receipt;
    let currentText: string | null;
    try {
      currentText = await this.read(receipt, signal);
    } catch (error) {
      signal.throwIfAborted();
      // The folder was moved, replaced or made unreadable: what is there now is the user's.
      if (error instanceof RpcError || (error as { code?: unknown })?.code) {
        this.store.settle(importId, position, "kept");
        return;
      }
      throw error;
    }
    const current = currentText === null ? null : hash(currentText);
    if (receipt.created ? current === null : current === hash(receipt.before)) {
      this.store.assertCurrent(importId, position, receipt, "restore");
      this.store.settle(importId, position, "restored");
      return;
    }
    if (current !== receipt.hash) {
      this.store.settle(importId, position, "kept");
      return;
    }
    this.store.assertCurrent(importId, position, receipt, "restore");
    if (receipt.created) {
      // The file is exactly what the batch wrote, inside a checked folder: removing it is the
      // compensation of a create, not a new change the user has to approve.
      await this.context(receipt, signal);
      await unlink(join(receipt.root, file));
      this.store.settle(importId, position, "restored");
      return;
    }
    // A blocked or refused compensation keeps the durable receipt and cleanup phase for retry.
    await writeReviewedProjectNotes(
      this.ctx.local,
      {
        botId,
        root: receipt.root,
        device: receipt.device,
        inode: receipt.inode,
        content: receipt.before,
        expectedHash: receipt.hash,
        assertCurrent: () => this.store.assertCurrent(importId, position, receipt, "restore"),
        diff: [
          "--- AGENTS.md",
          "+++ AGENTS.md",
          ...(currentText ?? "").split(/\r?\n/u).map((line) => `-${line}`),
          ...receipt.before.split(/\r?\n/u).map((line) => `+${line}`),
        ].join("\n"),
      },
      signal,
    );
    this.store.settle(importId, position, "restored");
  }

  /** The current AGENTS.md text, or null when the folder has none. */
  private async read(identity: Identity, signal: AbortSignal) {
    const context = await this.context(identity, signal);
    const missing = await lstat(context.path).then(
      () => false,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return true;
        throw error;
      },
    );
    if (missing) return null;
    const value = await this.files.readFile(context);
    if (value.type !== "text" || value.truncated || value.size > 128 * 1024) throw unavailable();
    return value.text;
  }

  private async context({ root, device, inode }: Identity, signal: AbortSignal) {
    const { platform, userHome, env, dataDir } = this.ctx.local.deps;
    const path = join(root, file);
    const assertPolicy = async () => {
      signal.throwIfAborted();
      const sensitive = await sensitiveReadBoundary(platform, [userHome], env);
      const policy = await protectedPaths(
        {
          platform,
          home: userHome,
          cwd: root,
          roots: [root],
          fs: nodeFileSystem,
          signal,
        },
        [...sensitive.denyRead, dataDir],
      );
      if (policy.covers(root) || policy.covers(path)) throw unavailable();
    };
    await assertPolicy();
    return {
      path,
      signal,
      expectedPath: path,
      cwd: root,
      writeRoots: [root],
      rootIdentities: [{ canonicalPath: root, device, inode }],
      confirmDispatch: assertPolicy,
    };
  }
}
