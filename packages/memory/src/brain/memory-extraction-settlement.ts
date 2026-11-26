// Settles extraction candidates, coverage, diagnostics and the optional chat receipt.

import { memoryNoted } from "@pibot/protocol-base";
import {
  AuditRepo,
  type BackgroundTaskHealthRepo,
  MemoryDreamRepo,
  type MemoryExtraction,
  type MemoryExtractionsRepo,
  MessagesRepo,
} from "@pibot/storage";
import { recordCorrectionReceipt } from "./memory-correction-receipt.ts";
import type { ExtractionSource } from "./memory-extraction.ts";
import type { MemoryExtractionAttemptDeps } from "./memory-extraction-attempt.ts";
import { applyExtractionCandidates } from "./memory-extraction-result.ts";

export function settleExtraction(
  deps: MemoryExtractionAttemptDeps,
  repo: MemoryExtractionsRepo,
  health: BackgroundTaskHealthRepo,
  row: MemoryExtraction,
  source: ExtractionSource,
  result: { draft: unknown; tokens: number; costUsd?: number },
  replyId?: string,
) {
  const reply = replyId ? new MessagesRepo(deps.db).get(replyId) : undefined;
  const receipt = replyId
    ? {
        replyId,
        notes: [] as { id: string; text: string }[],
        noted: new Set(((reply && memoryNoted(reply.usage)) ?? []).map((note) => note.id)),
      }
    : undefined;
  const counts = applyExtractionCandidates(
    deps.memory,
    row,
    source.subjectMessageId,
    result.draft,
    source.groupSourceIds,
    source.groupSourceTexts,
    receipt,
  );
  repo.diagnostics(row.id, counts);
  const accepted = counts.applied + counts.proposed;
  audit(deps, row, source.messageCount, accepted);
  const failed = counts.raw && !accepted && !counts.reasons.candidate_duplicate;
  repo.finish(row.id, {
    status: failed ? "failed" : "done",
    coverageMessageId: replyId ? null : source.watermarkId,
    tokens: result.tokens,
    costUsd: result.costUsd,
    candidates: accepted,
    error: !counts.raw
      ? "no_candidates"
      : !counts.valid
        ? "candidates_invalid"
        : !accepted
          ? "candidates_not_applied"
          : null,
  });
  if (!failed && !replyId)
    new MemoryDreamRepo(deps.db).recordFacts(row.id, counts.acceptedFactProposalIds);
  // Wanted repeated zero results noticed, but "nothing worth remembering" is the normal
  // outcome of short task chats (run a command, make a page): as a card it told users to check
  // their models and keys for a working job (v0.0.2 test, 2026-11-14). It stays in the log line
  // above; only invalid or unapplied candidates, a real fault, count against health.
  if (failed)
    health.fail(
      "memory_extraction",
      row.botId,
      !counts.valid ? "candidates_invalid" : "candidates_not_applied",
    );
  else health.recover("memory_extraction", row.botId);
  if (!receipt?.notes.length) return undefined;
  return recordCorrectionReceipt(deps.db, receipt.replyId, receipt.notes, deps.redactor);
}

function audit(
  deps: MemoryExtractionAttemptDeps,
  row: MemoryExtraction,
  messages: number,
  applied: number,
) {
  new AuditRepo(deps.db, deps.redactor).append({
    botId: row.botId,
    kind: "memory.changed",
    summary: "Memory extracted automatically / 自动提炼记忆",
    detail: {
      actor: "automatic",
      reasonCode: "memory_extracted",
      conversationId: row.conversationId,
      messageCount: Math.min(messages, 50),
      ...(row.groupId ? { groupId: row.groupId } : {}),
      revision: applied,
    },
  });
}
