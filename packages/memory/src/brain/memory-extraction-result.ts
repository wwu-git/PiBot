// Validates model candidates and keeps extraction writes in the memory service.
import type { MemoryExtraction } from "@pibot/storage";
import { type ExtractionCandidate, parseExtractionDraft } from "./memory-extraction.ts";
import type { MemoryService } from "./memory-service.ts";
import { looksLikeWorkFact } from "./memory-work-facts.ts";

/**
 * Maintainers 2026-11-11: a new user note from a non-main Bot that carries an unmistakable work marker
 * (path, command, commit, task id…) is that Bot's working fact, not a fact about the person, so it
 * is kept in the Bot's own scope instead of reaching every Bot. The main Bot is the shared
 * assistant and keeps the model's choice; updates keep their target note's scope.
 */
function scopedCandidate(candidate: ExtractionCandidate, mainBot: boolean): ExtractionCandidate {
  if (candidate.kind === "project")
    return { ...candidate, scope: "bot", kind: "method", category: "work" };
  if (mainBot || candidate.scope !== "user" || candidate.action !== "add") return candidate;
  if (!looksLikeWorkFact(candidate.text)) return candidate;
  return {
    ...candidate,
    scope: "bot",
    category: candidate.category === "how_to" ? "how_to" : "work",
  };
}

export function applyExtractionCandidates(
  memory: MemoryService,
  row: MemoryExtraction,
  messageId: string,
  draft: unknown,
  groupSourceIds?: readonly string[],
  groupSourceTexts?: Readonly<Record<string, string>>,
  receipt?: { replyId: string; notes: { id: string; text: string }[]; noted?: ReadonlySet<string> },
) {
  const parsed = parseExtractionDraft(draft);
  const citing = new Map<string, number>();
  for (const candidate of parsed.candidates)
    if (candidate.sourceMessageId)
      citing.set(candidate.sourceMessageId, (citing.get(candidate.sourceMessageId) ?? 0) + 1);
  const counts = {
    raw: parsed.rawCount,
    valid: parsed.candidates.length,
    applied: 0,
    proposed: 0,
    reasons: {} as Record<string, number>,
    acceptedFactProposalIds: [] as string[],
  };
  if (parsed.dropped) counts.reasons.candidate_invalid = parsed.dropped;
  const mainBot = memory.active(row.botId).isMain;
  const project = memory.projectForConversation(row.conversationId);
  for (const raw of parsed.candidates) {
    const candidate = row.groupId
      ? raw
      : raw.kind === "project" && project
        ? { ...raw, scope: "project" as const }
        : scopedCandidate(raw, mainBot);
    if (candidate !== raw)
      counts.reasons.candidate_rescoped_bot = (counts.reasons.candidate_rescoped_bot ?? 0) + 1;
    // The Bot saved this note itself in the same turn and its receipt is already shown.
    if (candidate.action === "update" && candidate.id && receipt?.noted?.has(candidate.id)) {
      counts.reasons.candidate_duplicate = (counts.reasons.candidate_duplicate ?? 0) + 1;
      continue;
    }
    try {
      const sourceId = row.groupId ? candidate.sourceMessageId : messageId;
      if (
        row.groupId &&
        (candidate.scope !== "group" || !sourceId || !groupSourceIds?.includes(sourceId))
      )
        throw new TypeError("candidate_source_denied");
      const source = row.groupId && sourceId ? groupSourceTexts?.[sourceId] : undefined;
      const value = memory.applyExtraction(
        row.botId,
        receipt?.replyId ?? sourceId ?? messageId,
        source && citing.get(sourceId ?? "") === 1
          ? { ...candidate, text: keepIdentifiers(candidate.text, source) }
          : candidate,
        row.groupId,
        project?.id,
      );
      const code = value.memory ? "candidate_applied" : "candidate_proposed";
      if (value.memory) {
        counts.applied++;
        if (
          !receipt &&
          !row.groupId &&
          value.proposal.status === "accepted" &&
          (value.memory.scope === "bot" || value.memory.scope === "user")
        )
          counts.acceptedFactProposalIds.push(value.proposal.id);
        receipt?.notes.push({ id: value.memory.id, text: value.memory.text });
      } else {
        counts.proposed++;
      }
      counts.reasons[code] = (counts.reasons[code] ?? 0) + 1;
    } catch (error) {
      const code = candidateErrorCode(error);
      counts.reasons[code] = (counts.reasons[code] ?? 0) + 1;
    }
  }
  return counts;
}

/** Mixed letters and digits: codes, hashes, ticket numbers. Plain numbers and words never match. */
const IDENTIFIER =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]{4,62}[A-Za-z0-9](?![A-Za-z0-9_-])/gu;
const NOTE_MAX = 300;

/**
 * Real run (2026-11-11): the model shortened a confirmed group agreement and dropped its
 * exact value, so the note lost the one fact a member needs later. The instruction already says
 * to keep identifiers; this is the program check. It only runs when one candidate cites the
 * statement, so an identifier is never attached to an unrelated note, and never grows a note
 * past its limit.
 */
export function keepIdentifiers(text: string, source: string): string {
  const missing = [...new Set(source.match(IDENTIFIER) ?? [])]
    .filter((token) => !text.includes(token))
    .slice(0, 3);
  if (!missing.length) return text;
  const next = `${text}（${missing.join("、")}）`;
  return next.length <= NOTE_MAX ? next : text;
}

/** Only fixed reason codes and counts leave the worker; never stringify a model/error body. */
export function extractionErrorCode(error: unknown): string {
  if (error instanceof Error && ["ZodError", "SyntaxError", "TypeError"].includes(error.name))
    return "draft_invalid";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const allowed = new Set([
    "no_model",
    "auth_failed",
    "output_limit",
    "aborted",
    "context_too_large",
    "budget_exhausted",
    "provider_error",
    "rate_limited",
    "timeout",
    "network_error",
  ]);
  return allowed.has(code) ? code : "extraction_failed";
}

export function candidateErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "candidate_failed";
  if (
    ["candidate_scope_denied", "candidate_target_missing", "candidate_source_denied"].includes(
      error.message,
    )
  )
    return error.message;
  if (error.name === "ZodError") return "candidate_invalid";
  if (error.message === "memory_similar") return "candidate_duplicate";
  if (/Unknown owned memory|target no longer exists/.test(error.message))
    return "candidate_target_missing";
  if (
    /outside Bot|unavailable|Invalid memory owner|trusted group|Unknown active Bot/.test(
      error.message,
    )
  )
    return "candidate_scope_denied";
  if (/conflict/.test(error.message)) return "candidate_conflict";
  if (/quota/i.test(error.message)) return "candidate_quota";
  return "candidate_failed";
}
