// Keep optional vendor text available to a future explicitly confirmed mapping step.
import { z } from "zod";
import { ImportFailure, type ProjectRef } from "../adapter.ts";
import { claudeProjectKey } from "./claude.ts";

export type Supplement = {
  kind: "memories" | "customInstructions" | "projects";
  text: string;
  title?: string;
  /** Project knowledge and project-scoped memories name the project they belong to. */
  project?: ProjectRef;
};

const text = z.string().max(65_536);
const memory = z.union([
  text,
  z.object({ memory: text }),
  z.object({ text }),
  z.object({ content: text }),
]);
const memories = z.object({ memories: z.array(memory).max(10_000) });
// Claude keeps one summary of all chats plus one per project, keyed by the project's uuid.
const claudeMemories = z.object({
  conversations_memory: text.nullish(),
  project_memories: z.record(z.string().max(120), text).nullish(),
});
const instructions = z.object({
  about_user: text.optional(),
  about_model: text.optional(),
  custom_instructions: text.optional(),
  user_context: text.optional(),
  response_context: text.optional(),
});
const doc = z.object({ filename: z.string().optional(), content: text });
const project = z.object({
  uuid: z.string().max(120).optional(),
  name: z.string().optional(),
  prompt_template: text.nullish(),
  docs: z.array(doc).nullish(),
});

/** A summary memory reads as one fact per line; headings and blank lines are structure only. */
function* summaryLines(summary: string, project?: ProjectRef): Generator<Supplement> {
  for (const line of summary.split(/\r?\n/u)) {
    const body = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, "")
      .replace(/^\*\*(.+)\*\*$/u, "$1")
      .trim();
    if (!body || /^#{1,6}\s/u.test(line.trim())) continue;
    yield { kind: "memories", text: body, ...(project ? { project } : {}) };
  }
}

function* memoryItems(value: unknown): Generator<Supplement> {
  const claude = claudeMemories.safeParse(value);
  if (
    claude.success &&
    (claude.data.conversations_memory != null || claude.data.project_memories != null)
  ) {
    if (claude.data.conversations_memory) yield* summaryLines(claude.data.conversations_memory);
    for (const [uuid, summary] of Object.entries(claude.data.project_memories ?? {}))
      yield* summaryLines(summary, { key: claudeProjectKey(uuid), name: "" });
    return;
  }
  const nested = memories.safeParse(value);
  const values: unknown[] = nested.success ? nested.data.memories : [value];
  for (const candidate of values) {
    const item = memory.safeParse(candidate);
    if (!item.success) throw new ImportFailure("format");
    const row = item.data;
    const body =
      typeof row === "string"
        ? row
        : "memory" in row
          ? row.memory
          : "text" in row
            ? row.text
            : row.content;
    if (body.trim()) yield { kind: "memories", text: body };
  }
}

export function* supplementItems(kind: Supplement["kind"], value: unknown): Generator<Supplement> {
  if (kind === "memories") {
    yield* memoryItems(value);
    return;
  }
  if (kind === "customInstructions") {
    const parsed = instructions.safeParse(value);
    if (!parsed.success) throw new ImportFailure("format");
    for (const body of Object.values(parsed.data)) {
      if (body?.trim()) yield { kind, text: body };
    }
    return;
  }
  const parsed = project.safeParse(value);
  if (!parsed.success) throw new ImportFailure("format");
  const { uuid, name, prompt_template, docs } = parsed.data;
  // A project without a uuid still groups its own docs, keyed by its name.
  const id = uuid || (name ? `name:${name.slice(0, 100)}` : undefined);
  const ref = id ? { key: claudeProjectKey(id), name: (name ?? "").slice(0, 200) } : undefined;
  const owner = ref ? { project: ref } : {};
  let pieces = 0;
  if (prompt_template?.trim()) {
    pieces++;
    yield { kind, title: name, text: prompt_template, ...owner };
  }
  for (const { filename, content } of docs ?? []) {
    if (!content.trim()) continue;
    pieces++;
    yield { kind, title: filename ?? name, text: content, ...owner };
  }
  // A project without knowledge still names itself, so its chats get a readable project row.
  if (!pieces && ref) yield { kind, text: "", ...owner };
}
