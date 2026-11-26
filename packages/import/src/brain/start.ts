// Turn the confirmed choices of one preview into a run plan, refusing anything not reviewed.
import type { CapabilityContext } from "@pibot/brain/kit";
import type { ImportParams } from "@pibot/import-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { ImportStore } from "../store/index.ts";
import { selectPersona, selectPlan } from "./memory-review.ts";
import { sameTarget } from "./project.ts";
import type { ImportSelection } from "./reviews.ts";
import type { ProjectPlan } from "./run.ts";

const invalid = (code: string) => new RpcError(RpcErrorCodes.invalidParams, code);

export function startPlan(
  selection: ImportSelection,
  botId: string,
  options: Omit<ImportParams<"import.start">, "importId" | "botId">,
  deps: {
    store: ImportStore;
    port: CapabilityContext["local"]["memoryImportDistillation"];
  },
) {
  const { store, port } = deps;
  const available = (bot: string) => store.availableBot(bot);
  const { preview } = selection;
  if (!available(botId)) throw invalid("import_target");
  const projects: ProjectPlan[] = [];
  for (const choice of options.projects ?? []) {
    const info = selection.projects.get(choice.key);
    if (!info || projects.some((plan) => plan.info.key === choice.key))
      throw invalid("import_memory_selection_invalid");
    if (!available(choice.botId)) throw invalid("import_target");
    const review = choice.reviewId ? selection.reviewed.get(choice.key) : undefined;
    if (
      choice.reviewId &&
      (review?.reviewId !== choice.reviewId || !sameTarget(review.target, choice.folder))
    )
      throw invalid("import_project_review_expired");
    if (review?.identity && store.projects.compensating(review.identity.root))
      throw invalid("import_busy");
    projects.push({
      info,
      botId: choice.botId,
      target: choice.folder,
      ...(review ? { review } : {}),
    });
  }
  const memories = options.memories
    ? selectPlan(selection.plan, options.memories, available)
    : new Map();
  let persona:
    | { botId: string; selection: NonNullable<ReturnType<typeof selectPersona>> }
    | undefined;
  if (options.persona) {
    if (!available(options.persona.botId)) throw invalid("import_target");
    const chosen = selectPersona(
      selection.persona,
      options.persona.botId,
      options.persona.reviewId,
    );
    if (chosen) persona = { botId: options.persona.botId, selection: chosen };
  }
  const projectTopics = (preview.projects ?? []).reduce((sum, { topics }) => sum + topics, 0);
  const conversations = (options.conversations ?? true) && preview.topics > projectTopics;
  const quote = selection.quote;
  const { distillationQuoteId } = options;
  if (
    distillationQuoteId &&
    (!conversations ||
      !port ||
      quote?.quoteId !== distillationQuoteId ||
      quote.botId !== botId ||
      port.estimate(botId)?.modelId !== quote.modelId)
  )
    throw invalid("import_distillation_quote_expired");
  // Named through CapabilityContext so the exported plan type does not reach into the brain's internals.
  const distillation:
    | { port: NonNullable<CapabilityContext["local"]["memoryImportDistillation"]>; modelId: string }
    | undefined =
    distillationQuoteId && quote && port ? { port, modelId: quote.modelId } : undefined;
  if (!conversations && !projects.length && !memories.size && !persona)
    throw invalid("import_memory_selection_invalid");
  if (preview.source === "gemini" && preview.topics === 0) throw invalid("import_format_gemini");
  return { conversations, projects, memories, persona, distillation };
}
