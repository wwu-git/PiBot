import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { SkillContractSchema } from "../skills/contract.ts";

/** D2 execution input. D1 owns generation/confirmation; the engine validates again on admission. */
export const GroupExecutionPlanSchema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("contract"),
      skillId: IdSchema,
      version: z.number().int().positive().nullable(),
    }),
    z.strictObject({ kind: z.literal("dynamic"), planId: IdSchema, originRunId: IdSchema }),
  ]),
  name: z.string().trim().min(1).max(200),
  contract: SkillContractSchema.refine(
    (contract) => !!contract.steps?.length,
    "Plan steps required",
  ),
  inputs: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(200),
        kind: z.enum(["folder", "file", "text"]),
        value: z.string().max(16_000),
      }),
    )
    .max(12)
    .default([]),
});
export type GroupExecutionPlan = z.infer<typeof GroupExecutionPlanSchema>;

export const GroupWorkflowRunStatusSchema = z.enum([
  "running",
  "waiting",
  "passed",
  "failed",
  "cancelled",
]);
export const GroupWorkflowStepStatusSchema = z.enum([
  "waiting",
  "ready",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
]);
export const GroupWorkflowDecisionSchema = z.strictObject({
  groupId: IdSchema,
  workflowRunId: IdSchema,
  stepId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  title: z.string().min(1).max(200),
  ownerBotId: IdSchema,
  attempt: z.number().int().nonnegative().safe(),
  state: z.enum(["pending", "resolved"]),
  confirmationRequired: z.boolean().optional(),
  /** One final confirmation, bound to the exact executions whose manual checks were deferred. */
  reviewSteps: z
    .array(
      z.strictObject({
        stepId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
        title: z.string().min(1).max(200),
        taskId: IdSchema,
        executionRunId: IdSchema,
        attempt: z.number().int().nonnegative().safe(),
        checks: z.array(z.string().max(300)).max(20),
      }),
    )
    .min(1)
    .max(20)
    .optional(),
  reasonCode: z.string().min(1).max(100).optional(),
  resolution: z.enum(["retry", "skip", "reassign", "accept"]).optional(),
  reassignedTo: z.string().min(1).max(200).optional(),
  note: z.string().max(500).optional(),
  /** `context_full`: what the stopped run was reading (redacted file names) for the card. */
  reading: z.string().max(300).optional(),
});

export type GroupWorkflowRunStatus = z.infer<typeof GroupWorkflowRunStatusSchema>;
export type GroupWorkflowStepStatus = z.infer<typeof GroupWorkflowStepStatusSchema>;
export type GroupWorkflowDecision = z.infer<typeof GroupWorkflowDecisionSchema>;
