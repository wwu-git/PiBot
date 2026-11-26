import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import {
  businessConfirmation,
  type LocalService,
  memoryProjectPath,
  redactValue,
  runPermissionScope,
  type ToolExecutor,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { memoryWritePolicy, mustAskNow } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import { parseMemoryInput, parseMemoryReadInput } from "./memory-input.ts";
import type { MemoryService } from "./memory-service.ts";

function json(local: LocalService, value: unknown) {
  return JSON.stringify(redactValue(value, local.deps.redactor));
}

/** The snippet stays short because memory_search answers list questions, not full text. */
const SNIPPET_CHARS = 160;

export async function executeMemoryReadTool(
  memory: MemoryService,
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
): Promise<LocalToolResult> {
  signal.throwIfAborted();
  const input = parseMemoryReadInput(call.tool, call.input);
  const groupId = runPermissionScope(local, context);
  const project = memoryProjectPath(context);
  const zh = context.language === "zh";
  if (input.tool === "memory_read") {
    const note = memory.read(context.botId, input.args.id, input.args.scope, groupId, project);
    if (!note)
      return {
        text: zh
          ? "本轮可见范围里没有这条记忆：id 可能已删除，或属于别的 Bot/群/项目范围。可用 memory_search 重新找。"
          : "No such memory in this run's visible scopes: the id may be deleted or belong to another Bot, group or project. Use memory_search to look again.",
        isError: true,
      };
    return {
      text: json(local, {
        id: note.id,
        scope: note.scope,
        category: note.category,
        text: note.text,
        why: note.why ?? null,
        how: note.how ?? null,
        archived: note.archivedAt != null,
        updatedAt: note.updatedAt,
      }),
      summary: zh ? "已读取一条记忆" : "Read one memory note",
    };
  }
  const notes = memory.search(
    context.botId,
    input.args.query,
    input.args.scope,
    groupId,
    project,
    input.args.limit,
    signal,
  );
  return {
    text: notes.length
      ? json(local, {
          query: input.args.query,
          matches: notes.map((note) => ({
            id: note.id,
            scope: note.scope,
            category: note.category,
            snippet: Array.from(note.text).slice(0, SNIPPET_CHARS).join(""),
            archived: note.archivedAt != null,
          })),
        })
      : zh
        ? "没有匹配的记忆。可换关键词再试；记忆目录里的 id 也可以直接用 memory_read 打开。"
        : "No matching memory notes. Try other keywords, or open an id from the memory catalog with memory_read.",
    summary: zh ? `搜索记忆：${notes.length} 条` : `Memory search: ${notes.length} hit(s)`,
  };
}

/**
 * What the model reads back: a plain conclusion and the ids it may need later. Returning the raw
 * proposal let replies quote internal values ("已保存（accept）", second-Mac test).
 */
function outcomeText(
  local: LocalService,
  result: { proposal: { id: string; status: string }; memory: { id: string } | null },
  zh: boolean,
) {
  const pending = result.proposal.status === "pending";
  return json(local, {
    result: pending
      ? zh
        ? "已提出，用户确认后才会记住"
        : "Proposed; remembered only after the user confirms"
      : zh
        ? "已记住"
        : "Remembered",
    ...(result.memory ? { memoryId: result.memory.id } : {}),
    ...(pending ? { proposalId: result.proposal.id } : {}),
  });
}

export async function executeMemoryTool(
  memory: MemoryService,
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  authorization?: Parameters<ToolExecutor>[3],
): Promise<LocalToolResult> {
  signal.throwIfAborted();
  const input = parseMemoryInput(call.tool, call.input);
  const groupId = runPermissionScope(local, context);
  const project = memoryProjectPath(context);
  const scope = memory.toolScope(
    context.botId,
    input,
    groupId,
    // Only an explicit or prior project target creates the project row.
    memory.projectId(project, input.args.scope === "project"),
  );
  const projectId = scope === "project" ? memory.projectId(project, true) : undefined;
  const facts = () => ({
    text:
      input.tool === "memory_add"
        ? input.args.text
        : input.tool === "memory_update" && input.args.text !== undefined
          ? input.args.text
          : memory.writeTarget(context.botId, input.args.id, input.args.scope, groupId, project)
              ?.text,
    afterUntrusted: context.untrustedContent?.seen === true,
    scope,
  });
  const assertCurrent = () => {
    signal.throwIfAborted();
    authorization?.assertCurrent();
    if (mustAskNow(memoryWritePolicy(facts())) && !authorization?.confirmedNow)
      throw new RpcError(-32602, "memory_confirmation_required");
  };
  assertCurrent();
  if (input.tool === "memory_add") {
    const existing = memory.similar(context.botId, input.args.text, scope, groupId, projectId);
    if (existing)
      return {
        text:
          context.language === "zh"
            ? `已有相似条目 ${existing.id}：${local.deps.redactor.redact(existing.text)}，请用 memory_update${existing.archivedAt ? "（该条目已归档）" : ""}`
            : `Similar memory already exists ${existing.id}: ${local.deps.redactor.redact(existing.text)}. Use memory_update${existing.archivedAt ? " (archived entry)" : ""}.`,
        summary:
          context.language === "zh"
            ? "已有相似记忆，未新增"
            : "Similar memory exists; nothing added",
      };
  }
  const yolo = businessConfirmation(local, context, call);
  // The policy card already audited this human answer; it is not another YOLO grant.
  const automatic = authorization?.confirmedNow
    ? {
        assertCurrent,
        // ApprovalService already recorded the answer before this synchronous transaction.
        audit: () => signal.throwIfAborted(),
      }
    : yolo && {
        assertCurrent() {
          assertCurrent();
          yolo.assertCurrent();
        },
        audit() {
          yolo.audit();
        },
      };
  if (scope === "group") {
    if (!groupId) throw new RpcError(-32602, "group_resource_unavailable");
    // The group's own context is saved like a DM in auto mode; a
    // proposal per note piled up unanswered. The mandatory cases (untrusted input this round,
    // secret-like text) still require the card above, which assertCurrent re-checks.
    const groupAutomatic =
      automatic ??
      (mustAskNow(memoryWritePolicy(facts()))
        ? undefined
        : {
            assertCurrent,
            audit: () => memory.groupAutomaticAudit(groupId, context.botId),
          });
    const result = memory.groupExecute({ ...context, groupId }, input, groupAutomatic);
    return {
      text: outcomeText(local, result, context.language === "zh"),
      summary:
        context.language === "zh"
          ? result.proposal.status === "pending"
            ? "群共享记忆：请到群资料确认"
            : "已记进群共享记忆（可在群资料里修改或删除）"
          : result.proposal.status === "pending"
            ? "Group memory: confirm in group details"
            : "Saved to group memory (edit or delete it in group details)",
    };
  }

  let result: ReturnType<MemoryService["execute"]>;
  try {
    automatic?.assertCurrent();
    // A new project note is also a line in the folder's AGENTS.md: the owner confirms it on the
    // card with the diff, so neither the Bot's memory mode nor YOLO applies it.
    const projectMeta =
      scope === "project" && input.tool === "memory_add" && project
        ? memory.projectProposalForPath(project, input.args.text)
        : undefined;
    result = memory.execute(
      context.botId,
      context.messageId,
      input,
      !!automatic,
      automatic?.audit,
      groupId,
      assertCurrent,
      projectId,
      false,
      projectMeta,
    );
    if (result.proposal.status === "pending" && !projectMeta) {
      const proposalId = result.proposal.id;
      local.yolo.onRunEnabled(context, async () => {
        const confirmation = businessConfirmation(local, context, call);
        if (!confirmation) return;
        confirmation.assertCurrent();
        memory.acceptAutomatic(
          proposalId,
          () => {
            signal.throwIfAborted();
            confirmation.assertCurrent();
            confirmation.audit();
          },
          facts,
        );
      });
    }
  } catch (error) {
    if (!(error instanceof RpcError) || error.code !== -32602) throw error;
    return {
      text: "记忆不可用或达到100条/8000字上限，请先整理 / Memory unavailable or quota exceeded (100 notes / 8000 characters); consolidate first",
      isError: true,
    };
  }

  const category = result.proposal.category;
  const categoryLabel =
    context.language === "zh"
      ? category === "about_you"
        ? "关于你"
        : category === "work"
          ? "工作"
          : category === "how_to"
            ? "做事方式"
            : "其他"
      : category === "about_you"
        ? "About you"
        : category === "work"
          ? "Work"
          : category === "how_to"
            ? "How to work"
            : "Other";
  return {
    text: outcomeText(local, result, context.language === "zh"),
    summary:
      context.language === "zh"
        ? result.proposal.status === "pending"
          ? `想记住（${categoryLabel}）：等待确认`
          : `记忆已更新（${categoryLabel}，可撤销）`
        : result.proposal.status === "pending"
          ? `Memory proposal (${categoryLabel}) awaiting confirmation`
          : `Memory updated (${categoryLabel}, undo available)`,
  };
}
