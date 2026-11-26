// Hold a bounded, redacted review of optional export notes until the user confirms.
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { BrainRedactor } from "@pibot/brain/kit";
import type { ImportMemoryReview, ImportPreview } from "@pibot/import-contract";
import { MemorySchema, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  type ImportMemories,
  type ImportMemoryScope,
  type MemoryCandidate,
  type MemorySelection,
  normalized,
  type ReviewedMemory,
} from "../store/memories.ts";
import type { ImportPersonas, PersonaSelection } from "../store/personas.ts";
import type { ImportInput } from "./adapter.ts";
import { exportItems } from "./exports/index.ts";
import { redactImportText } from "./records.ts";

export type ReviewedImport = {
  dto: ImportMemoryReview;
  botId: string;
  scope: ImportMemoryScope | "persona";
  records: ReviewedMemory[];
  personaHash?: string;
};

export async function reviewMemories(input: {
  preview: ImportPreview;
  input: ImportInput;
  botId: string;
  scope: ImportMemoryScope | "persona";
  memories: ImportMemories;
  personas: ImportPersonas;
  redactor: BrainRedactor;
  signal: AbortSignal;
}): Promise<ReviewedImport> {
  const { source } = input.preview;
  if (source !== "chatgpt" && source !== "claude")
    throw new RpcError(RpcErrorCodes.unsupported, "import_memory_source_unsupported");
  const records: ReviewedMemory[] = [];
  const seen = new Set<string>();
  const persona = input.scope === "persona" ? input.personas.current(input.botId) : undefined;
  if (persona && redactImportText(input.redactor, persona.text) !== persona.text)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_persona_unavailable");
  const inspect =
    input.scope === "persona" ? undefined : input.memories.inspection(input.botId, input.scope);
  let omitted = 0;
  for await (const item of exportItems(source, input.input, input.signal)) {
    input.signal.throwIfAborted();
    if (item.kind !== "memories" && item.kind !== "customInstructions") continue;
    if (persona && item.kind !== "customInstructions") continue;
    const text = MemorySchema.shape.text.safeParse(redactImportText(input.redactor, item.text));
    if (!text.success || records.length >= 100 || seen.has(normalized(text.data))) {
      omitted++;
      continue;
    }
    seen.add(normalized(text.data));
    const candidate = {
      id: randomUUID(),
      text: text.data,
      category: item.kind === "memories" ? ("about_you" as const) : ("how_to" as const),
    };
    const reviewed = inspect?.(candidate) ?? {
      item: { ...candidate, outcome: "add" as const },
      conflict: "",
    };
    if (reviewed.item.existingText)
      reviewed.item.existingText = redactImportText(input.redactor, reviewed.item.existingText);
    records.push(reviewed);
    if (records.length % 8 === 0) await yieldToLoop(undefined, { signal: input.signal });
  }
  input.signal.throwIfAborted();
  return {
    dto: {
      reviewId: randomUUID(),
      items: records.map(({ item }) => item),
      omitted,
      ...(persona ? { personaBefore: redactImportText(input.redactor, persona.text) } : {}),
    },
    botId: input.botId,
    scope: input.scope,
    records,
    personaHash: persona?.hash,
  };
}

export function selectReview(
  review: ReviewedImport | undefined,
  botId: string,
  choice: { reviewId: string; selected: string[] },
): { memories?: MemorySelection; persona?: PersonaSelection } {
  if (!review || review.botId !== botId || review.dto.reviewId !== choice.reviewId)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_review_expired");
  const ids = new Set(choice.selected);
  const selected = review.records.filter(
    ({ item }) => ids.has(item.id) && item.outcome !== "duplicate",
  );
  if (ids.size !== choice.selected.length || ids.size !== selected.length)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_selection_invalid");
  if (review.scope !== "persona") return { memories: { scope: review.scope, selected } };
  if (!selected.length) return {};
  const text = selected.map(({ item }) => item.text).join("\n\n");
  if (!review.personaHash || text.length > 16_000)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_persona_limit");
  return { persona: { expected: review.personaHash, text } };
}

/** The compared role replaces the Bot's role with all the custom instructions it showed. */
export function selectPersona(review: ReviewedImport | undefined, botId: string, reviewId: string) {
  if (review?.scope !== "persona")
    throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_review_expired");
  const selected = review.records.map(({ item }) => item.id);
  return selectReview(review, botId, { reviewId, selected }).persona;
}

type Target = "user" | string;
export type PlannedMemory = {
  candidate: Omit<MemoryCandidate, "outcome" | "existingText">;
  kind: "preference" | "method";
  project?: string;
  /** Destinations that already hold it, with the revision digest a later write must match. */
  known: Map<Target, ReviewedMemory>;
};
export type ReviewedPlan = {
  reviewId: string;
  memories: Map<string, PlannedMemory>;
};

/**
 * One pass over the export's memories, checked against 关于你 and every active Bot, so each item
 * can move to any destination without another review. Project memories are ways of working.
 */
export async function reviewPlan(input: {
  preview: ImportPreview;
  input: ImportInput;
  bots: readonly string[];
  memories: ImportMemories;
  redactor: BrainRedactor;
  signal: AbortSignal;
}) {
  const { source } = input.preview;
  const memories: PlannedMemory[] = [];
  let instructions: string | undefined;
  let omitted = 0;
  const anyBot = input.bots[0];
  if ((source === "chatgpt" || source === "claude") && anyBot) {
    const inspectors = new Map<Target, ReturnType<ImportMemories["inspection"]>>([
      ["user", input.memories.inspection(anyBot, "user")],
      ...input.bots.map((bot) => [bot, input.memories.inspection(bot, "bot")] as const),
    ]);
    const seen = new Set<string>();
    for await (const item of exportItems(source, input.input, input.signal)) {
      input.signal.throwIfAborted();
      if (item.kind === "customInstructions") {
        instructions ??= redactImportText(input.redactor, item.text).trim().slice(0, 300);
        continue;
      }
      if (item.kind !== "memories") continue;
      const text = MemorySchema.shape.text.safeParse(redactImportText(input.redactor, item.text));
      if (!text.success || memories.length >= 100 || seen.has(normalized(text.data))) {
        omitted++;
        continue;
      }
      seen.add(normalized(text.data));
      const kind = item.project ? ("method" as const) : ("preference" as const);
      const candidate = {
        id: randomUUID(),
        text: text.data,
        category: kind === "method" ? ("how_to" as const) : ("about_you" as const),
      };
      const known = new Map<Target, ReviewedMemory>();
      for (const [target, inspect] of inspectors) {
        const reviewed = inspect(candidate);
        if (reviewed.item.outcome === "add") continue;
        if (reviewed.item.existingText)
          reviewed.item.existingText = redactImportText(input.redactor, reviewed.item.existingText);
        known.set(target, reviewed);
      }
      memories.push({
        candidate,
        kind,
        ...(item.project ? { project: item.project.key } : {}),
        known,
      });
      if (memories.length % 8 === 0) await yieldToLoop(undefined, { signal: input.signal });
    }
  }
  input.signal.throwIfAborted();
  const review: ReviewedPlan = {
    reviewId: randomUUID(),
    memories: new Map(memories.map((memory) => [memory.candidate.id, memory])),
  };
  const dto = {
    reviewId: review.reviewId,
    memories: memories.map(({ candidate, kind, project, known }) => ({
      id: candidate.id,
      text: candidate.text,
      kind,
      ...(project ? { project } : {}),
      known: [...known].map(([target, { item }]) => ({
        target,
        outcome: item.outcome === "conflict" ? ("conflict" as const) : ("duplicate" as const),
        ...(item.existingText ? { existingText: item.existingText } : {}),
      })),
    })),
    omitted,
    ...(instructions ? { instructions } : {}),
  };
  return { review, dto };
}

/**
 * The confirmed items grouped by destination; each keeps the digest its destination had at
 * review time, so a memory changed since then fails the batch instead of being overwritten.
 */
export function selectPlan(
  review: ReviewedPlan | undefined,
  choice: { reviewId: string; items: { id: string; target: Target }[] },
  available: (botId: string) => boolean,
) {
  if (!review || review.reviewId !== choice.reviewId)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_review_expired");
  const groups = new Map<Target, ReviewedMemory[]>();
  const ids = new Set<string>();
  for (const { id, target } of choice.items) {
    const planned = review.memories.get(id);
    if (!planned || ids.has(id) || (target !== "user" && !available(target)))
      throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_selection_invalid");
    ids.add(id);
    const known = planned.known.get(target);
    if (known?.item.outcome === "duplicate") continue;
    const reviewed = known ?? {
      item: { ...planned.candidate, outcome: "add" as const },
      conflict: "",
    };
    groups.set(target, [...(groups.get(target) ?? []), reviewed]);
  }
  return groups;
}
