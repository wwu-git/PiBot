import {
  IdSchema,
  MemoryCategorySchema,
  MemoryNoteSchema,
  MemorySchema,
  MemoryScopeSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

export const memoryInputSchemas = {
  memory_add: z.strictObject({
    scope: MemoryScopeSchema.optional(),
    text: MemorySchema.shape.text,
    category: MemoryCategorySchema,
    why: MemoryNoteSchema.optional(),
    how: MemoryNoteSchema.optional(),
    expiresAt: MemorySchema.shape.expiresAt,
  }),
  memory_update: z
    .strictObject({
      scope: MemoryScopeSchema.optional(),
      id: IdSchema,
      text: MemorySchema.shape.text.optional(),
      category: MemoryCategorySchema.optional(),
      // null clears a field; undefined leaves it as stored.
      why: MemoryNoteSchema.nullable().optional(),
      how: MemoryNoteSchema.nullable().optional(),
      expiresAt: MemorySchema.shape.expiresAt,
    })
    .refine(
      (value) =>
        value.text !== undefined ||
        value.category !== undefined ||
        value.why !== undefined ||
        value.how !== undefined,
    ),
  memory_remove: z.strictObject({ scope: MemoryScopeSchema.optional(), id: IdSchema }),
} as const;

// Reads are a separate shape because they never go through the write policy or proposals.
export const memoryReadSchemas = {
  memory_search: z.strictObject({
    scope: MemoryScopeSchema.optional(),
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  memory_read: z.strictObject({ scope: MemoryScopeSchema.optional(), id: IdSchema }),
} as const;

export type MemoryReadInput = {
  [K in keyof typeof memoryReadSchemas]: {
    tool: K;
    args: z.infer<(typeof memoryReadSchemas)[K]>;
  };
}[keyof typeof memoryReadSchemas];

export function parseMemoryReadInput(tool: string, input: unknown): MemoryReadInput {
  if (!(tool in memoryReadSchemas)) throw new Error(`Unknown memory read tool: ${tool}`);
  const name = tool as keyof typeof memoryReadSchemas;
  return { tool: name, args: memoryReadSchemas[name].parse(input) } as MemoryReadInput;
}

export type MemoryToolInput = {
  [K in keyof typeof memoryInputSchemas]: {
    tool: K;
    args: z.infer<(typeof memoryInputSchemas)[K]>;
  };
}[keyof typeof memoryInputSchemas];

export function parseMemoryInput(tool: string, input: unknown): MemoryToolInput {
  if (!(tool in memoryInputSchemas)) throw new Error(`Unknown memory tool: ${tool}`);
  const name = tool as keyof typeof memoryInputSchemas;
  return { tool: name, args: memoryInputSchemas[name].parse(input) } as MemoryToolInput;
}

/**
 * Why/how travel through a proposal row, where NULL means "the caller did not mention it".
 * An explicit null in the tool input means "clear the field", so it is encoded as an empty string
 * and turned back into null when the proposal is applied.
 */
export function noteValue(
  value: string | null | undefined,
  prior: string | null | undefined,
): string | null {
  if (value === null) return "";
  return value ?? prior ?? null;
}
