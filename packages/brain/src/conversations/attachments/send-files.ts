// Tool and automatic delivery share identity checks, storage transactions and audit.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { canonicalPath, ExecError, sameFile } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import {
  type Attachment,
  attachmentContinuationOf,
  canPreviewSvg,
  FILE_LIMIT,
  MAX_REPLY_ATTACHMENTS,
  type Message,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { AttachmentsRepo, MessagesRepo, RunsRepo, transaction } from "@pibot/storage";
import { auditLeaf } from "../../core/audit-fields.ts";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { authorizationSnapshot } from "../../runtime/tools/local-prepare.ts";
import { AttachmentService } from "./attachments.ts";

/** What attaching needs from a prepared send_file call; an agent turn builds the same four. */
export type SendFilesInput = Pick<PreparedTool, "roots" | "cwd" | "sendPaths" | "authorization">;

/** Server-owned cursor for one automatic delivery pass. Never comes from a tool request. */
export interface OutputAttachmentPages {
  lastMessageId?: string;
}

async function readSource(
  local: LocalService,
  path: string,
  prepared: SendFilesInput,
  signal: AbortSignal,
) {
  const roots = await Promise.all(
    prepared.roots.map(async (root) => {
      if ((await realpath(root)) !== root) throw new ExecError("outside_workplace");
      return root;
    }),
  );
  if (
    (await canonicalPath(path, prepared.cwd)) !== path ||
    !roots.some((root) => containsPath(root, path, local.deps.platform))
  )
    throw new ExecError("outside_workplace");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Exact (bigint) identity: number stats round NTFS file IDs and can alias two files.
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile()) throw new ExecError("file_failed");
    if (Number(stat.size) > FILE_LIMIT)
      throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachment_too_large");
    const bytes = Buffer.alloc(Number(stat.size));
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const part = await file.read(bytes, length, Math.min(32768, bytes.length - length));
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1))).bytesRead)
      throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachment_too_large");
    const current = await lstat(path, { bigint: true });
    const after = await file.stat({ bigint: true });
    if (
      (await realpath(path)) !== path ||
      !sameFile(current, stat) ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs
    )
      throw new ExecError("outside_workplace");
    signal.throwIfAborted();
    return {
      name: auditLeaf(basename(path), local.deps.redactor),
      bytes: bytes.subarray(0, length),
    };
  } finally {
    await file.close();
  }
}

function deliveryText(items: Attachment[]): string {
  const lines: string[] = [];
  if (items.some((item) => item.kind === "image"))
    lines.push("Raster images are attached as inline pictures. / 位图已作为对话中的图片附上。");
  if (items.some(canPreviewSvg))
    lines.push(
      "SVG files are attached. Desktop chat shows them inline when the preview loads. Phones and failed previews show file cards. Describe them as attached. / SVG 已附上。桌面端预览成功后会内联显示，手机端和预览失败时显示文件卡片。请说明 SVG 已附上。",
    );
  if (items.some((item) => item.kind === "file" && !canPreviewSvg(item)))
    lines.push(
      "Other files are attached as file cards the user can click to open or preview. Do not say those files are embedded. / 其他文件以文件卡片附上，可点击打开或预览。不要说这些文件已内联显示。",
    );
  return lines.join("\n");
}

function outputAttachmentPage(
  messages: MessagesRepo,
  anchor: Message,
  incoming: number,
  pages: OutputAttachmentPages,
) {
  if (pages.lastMessageId) {
    const last = messages.get(pages.lastMessageId);
    if (
      !last ||
      attachmentContinuationOf(last) !== anchor.id ||
      last.runId !== anchor.runId ||
      last.botId !== anchor.botId ||
      last.conversationId !== anchor.conversationId
    )
      throw new ExecError("invalid_input");
    if ((last.attachments?.length ?? 0) + incoming <= MAX_REPLY_ATTACHMENTS) return last.id;
  }
  return messages.create({
    conversationId: anchor.conversationId,
    botId: anchor.botId,
    runId: anchor.runId,
    role: "assistant",
    content: "",
    status: "done",
    usage: { attachmentContinuationOf: anchor.id },
    markUnread: false,
  }).id;
}

export async function sendFiles(
  local: LocalService,
  context: ToolRunContext,
  prepared: SendFilesInput,
  parent: AbortSignal,
  /** Audit source: the send_file tool, or an external agent turn's created files. */
  toolName = "send_file",
  pages?: OutputAttachmentPages,
) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
  const repo = new AttachmentsRepo(local.deps.db);
  const paths = prepared.sendPaths;
  if (
    !paths?.length ||
    paths.length > MAX_REPLY_ATTACHMENTS ||
    (!pages &&
      (repo.forMessages([context.messageId]).get(context.messageId)?.length ?? 0) + paths.length >
        MAX_REPLY_ATTACHMENTS)
  )
    throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachments_already_sent");
  const sources = [];
  for (const path of paths) sources.push(await readSource(local, path, prepared, signal));
  const attachments = new AttachmentService(
    local.deps.db,
    local.deps.dataDir,
    local.deps.host.attachments,
  );
  const batch = await attachments.prepareOutput(context.botId, sources, signal);
  const messages = new MessagesRepo(local.deps.db);
  let messageId: string;
  try {
    signal.throwIfAborted();
    if (authorizationSnapshot(local, context.botId, context) !== prepared.authorization)
      throw new ExecError("outside_workplace");
    messageId = transaction(local.deps.db, () => {
      const run = new RunsRepo(local.deps.db).get(context.runId);
      const message = messages.get(context.messageId);
      if (
        run?.status !== "running" ||
        run.botId !== context.botId ||
        run.messageId !== context.messageId ||
        message?.role !== "assistant" ||
        message.status !== "streaming"
      )
        throw new ExecError("invalid_input");
      let targetId = message.id;
      if ((message.attachments?.length ?? 0) + batch.items.length > MAX_REPLY_ATTACHMENTS) {
        if (!pages) throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachments_already_sent");
        // The current reply remains the authorization and receipt anchor. The additional
        // message only owns this attachment batch, and rolls back with it if persistence fails.
        if (
          toolName !== "automatic_delivery" ||
          run.kind !== "chat" ||
          run.groupId ||
          run.taskId ||
          context.executionTaskId ||
          run.conversationId !== context.conversationId ||
          message.conversationId !== run.conversationId ||
          message.runId !== run.id ||
          message.botId !== run.botId
        )
          throw new ExecError("invalid_input");
        targetId = outputAttachmentPage(messages, message, batch.items.length, pages);
      }
      attachments.persist(targetId, batch, context.botId);
      for (const item of batch.items)
        local.approvals.audit.append({
          botId: context.botId,
          runId: context.runId,
          kind: "file.sent",
          summary: "Attached a file / 发了文件",
          detail: {
            toolName,
            target: auditLeaf(item.metadata.name, local.deps.redactor),
            bytes: item.metadata.size,
          },
        });
      return targetId;
    });
  } catch (error) {
    await batch.discard();
    throw error;
  }
  context.sentFilePaths ??= new Set();
  for (const path of paths) context.sentFilePaths.add(path);
  if (pages && messageId !== context.messageId) pages.lastMessageId = messageId;
  try {
    if (messageId !== context.messageId) {
      const message = messages.get(messageId);
      if (!message) throw new Error("Attachment continuation missing after delivery");
      local.deps.peer.emit("chat.message", {
        botId: context.botId,
        conversationId: message.conversationId,
        runId: context.runId,
        messageId,
        message,
      });
    } else {
      local.deps.peer.emit("chat.attachments", {
        botId: context.botId,
        conversationId: context.conversationId,
        ...(context.groupId ? { groupId: context.groupId } : {}),
        ...(context.threadId ? { threadId: context.threadId } : {}),
        runId: context.runId,
        messageId,
        attachments: repo.forMessages([messageId]).get(messageId) ?? [],
      });
    }
  } catch {
    local.deps.logger.warn("Attachment notification deferred; history retains committed metadata");
  }
  return {
    text: deliveryText(batch.items.map((item) => item.metadata)),
    summary: "send_file",
  };
}
