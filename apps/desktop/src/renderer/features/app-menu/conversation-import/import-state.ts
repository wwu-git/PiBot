import type { TranslationKey } from "@pibot/i18n";
import { type MethodParams, type MethodResults, RpcError, RpcErrorCodes } from "@pibot/protocol";

export const sources = ["chatgpt", "claude", "claude-code", "codex", "cursor", "gemini"] as const;
export type Source = (typeof sources)[number];
export const marks: Record<Source, string> = {
  chatgpt: "C",
  claude: "A",
  "claude-code": "CC",
  codex: "Cx",
  cursor: "Cu",
  gemini: "G",
};
export const localSources = new Set<Source>(["claude-code", "codex", "cursor"]);

export type Preview = NonNullable<MethodResults["import.preview"]>;
export type Status = MethodResults["import.status"];
export type Plan = MethodResults["import.reviewPlan"];
export type PlanMemory = Plan["memories"][number];
export type ProjectDiff = MethodResults["import.reviewProject"];
export type Quote = NonNullable<MethodResults["import.estimateDistillation"]>;
export type Review = MethodResults["import.reviewMemories"];
export type FolderTarget = MethodParams["import.reviewProject"]["folder"];
/** "user" is 关于你; anything else is a Bot id. */
export type Destination = "user" | string;

export const reviewOptions = { timeoutMs: 95_000 };
export const backgroundOptions = { timeoutMs: 115_000 };

export const sameFolder = (left: FolderTarget, right: FolderTarget) =>
  left.kind === right.kind &&
  (left.kind !== "folder" || (right.kind === "folder" && left.folderId === right.folderId));

/** One source project's choices; `diff` is the AGENTS.md change reviewed for `folder`. */
export type ProjectChoice = {
  on: boolean;
  botId: string;
  folder: FolderTarget;
  diff?: ProjectDiff;
  diffFor?: FolderTarget;
  diffFailed?: boolean;
  /** The user read the diff and pressed "看过了，写入". */
  confirmed: boolean;
  open: boolean;
};

export type MemoryChoice = { on?: boolean; target?: Destination };

export function known(memory: PlanMemory, target: Destination) {
  return memory.known.find((entry) => entry.target === target);
}

export function startParams({
  preview,
  plan,
  botId,
  conversations,
  projects,
  memories,
  persona,
  quote,
}: {
  preview: Preview;
  plan?: Plan;
  botId: string;
  conversations: boolean;
  projects: Record<string, ProjectChoice>;
  memories: { id: string; target: Destination }[];
  persona?: { reviewId: string; botId: string };
  quote?: Quote;
}): MethodParams["import.start"] | undefined {
  const included = Object.entries(projects).filter(([, choice]) => choice.on);
  const hasMemories = !!plan && memories.length > 0;
  if (!botId || (!conversations && !included.length && !hasMemories && !persona)) return;
  return {
    importId: preview.importId,
    botId,
    conversations,
    ...(included.length && {
      projects: included.map(([key, choice]) => ({
        key,
        botId: choice.botId,
        folder: choice.folder,
        ...(choice.confirmed &&
        choice.diff &&
        choice.diffFor &&
        sameFolder(choice.diffFor, choice.folder)
          ? { reviewId: choice.diff.reviewId }
          : {}),
      })),
    }),
    ...(hasMemories && plan && { memories: { reviewId: plan.reviewId, items: memories } }),
    ...(persona && { persona }),
    ...(conversations && quote && { distillationQuoteId: quote.quoteId }),
  };
}

const stage: Record<Status["state"], number> = {
  running: 0,
  completed: 1,
  undoing: 2,
  cancelled: 3,
  failed: 3,
  undone: 3,
};

export function advanceStatus(current: Status, next: Status): Status {
  if (current.importId !== next.importId || stage[next.state] < stage[current.state])
    return current;
  // A late page-write event must not hide the compensation phase of the same running batch.
  if (current.cleanup && !next.cleanup && next.state === "running") return current;
  if (next.state === "running" && !next.cleanup) {
    return {
      ...next,
      topics: Math.max(current.topics, next.topics),
      messages: Math.max(current.messages, next.messages),
    };
  }
  if (next.cleanup || next.state === "undoing") {
    return {
      ...next,
      removed: {
        topics: Math.max(current.removed?.topics ?? 0, next.removed?.topics ?? 0),
        messages: Math.max(current.removed?.messages ?? 0, next.removed?.messages ?? 0),
      },
    };
  }
  return next;
}

export function startError(
  error: unknown,
): Extract<TranslationKey, `conversationImport.error.${string}`> {
  if (error instanceof RpcError && error.code === RpcErrorCodes.timeout)
    return "conversationImport.error.timeout";
  const code = error instanceof RpcError ? error.message : "";
  switch (code) {
    case "import_source_unsupported":
    case "import_desktop_only":
    case "import_memory_source_unsupported":
      return "conversationImport.error.unsupported";
    case "import_preview_busy":
    case "import_busy":
      return "conversationImport.error.busy";
    case "import_preview_timeout":
      return "conversationImport.error.timeout";
    case "import_preview_expired":
    case "import_memory_review_expired":
    case "import_project_review_expired":
    case "import_distillation_quote_expired":
      return "conversationImport.error.expired";
    case "import_format_chatgpt":
    case "import_format_claude":
    case "import_format_claude_code":
    case "import_format_codex":
    case "import_format_cursor":
    case "import_format_gemini":
      return "conversationImport.error.format";
    case "import_source_changed":
      return "conversationImport.error.source_changed";
    case "import_limit":
      return "conversationImport.error.limit";
    case "import_target":
      return "conversationImport.error.target";
    case "import_project_unavailable":
      return "conversationImport.error.project";
    case "import_persona_unavailable":
    case "import_persona_limit":
    case "import_memory_selection_invalid":
      return "conversationImport.error.selection";
    default:
      return "conversationImport.error.internal";
  }
}
