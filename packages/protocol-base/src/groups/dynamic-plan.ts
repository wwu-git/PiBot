import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { AbsolutePathSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import {
  AcceptanceSchema,
  acceptanceTargetIssue,
  DeliverableSchema,
  SkillContractSchema,
} from "../skills/contract.ts";
import { SKILL_CONTRACT_MAX_CHARS, SkillDocumentBaseSchema } from "../skills/skills.ts";
import { ReportVerdictSchema } from "../skills/verdict.ts";
import { PlanRelaxationsSchema } from "./plan-relaxation.ts";
import { GroupPlanStartFailureSchema } from "./plan-start-failure.ts";
import { GroupVerificationSchema } from "./verification.ts";
import {
  GroupExecutionPlanSchema,
  GroupWorkflowRunStatusSchema,
  GroupWorkflowStepStatusSchema,
} from "./workflow.ts";

export const GROUP_PLAN_MAX_STEPS = 20;
export const GROUP_PLAN_MAX_REWRITES = 2;
export const GROUP_PLAN_MAX_CHARS = 64_000;
const key = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
const text = (max: number) => z.string().trim().min(1).max(max).refine(plainText);

// Report all corrections on raw model items before method entries can shift their indices.
const PlanAcceptanceSchema = AcceptanceSchema.superRefine((item, ctx) => {
  if (item.check === "manual" && !item.text)
    ctx.addIssue({ code: "custom", message: "acceptance_manual_text_required", path: ["text"] });
});

export const GroupPlanStepSchema = z.strictObject({
  id: key,
  title: text(200),
  owner: z.union([z.strictObject({ botId: IdSchema }), z.strictObject({ role: text(64) })]),
  task: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .refine((value) => plainText(value.replace(/[\r\n\t]/g, " "))),
  /**
   * One of the owner's methods (built-in key or skill name). Before validation the
   * program merges that method's deliverables and acceptance into this step; the plan may tighten
   * them, never loosen them (orchestration `group-plan-methods.ts`).
   */
  method: text(80).optional(),
  dependsOn: z
    .array(key)
    .max(GROUP_PLAN_MAX_STEPS - 1)
    .default([]),
  inputs: z
    .array(z.strictObject({ stepId: key, deliverableId: key }))
    .max(20)
    .default([]),
  deliverables: z.array(DeliverableSchema).min(1).max(10),
  acceptance: z.array(PlanAcceptanceSchema).min(1).max(20),
  maxFixRounds: z.number().int().min(0).max(2).default(2),
});

/**
 * The plan's shape alone: the `group_plan` tool declares it to the model and checks argument types
 * with it; the graph and check rules below stay in `GroupPlanSchema`, which reports fixed
 * issue codes the coordinator can act on.
 */
export const GroupPlanObjectSchema = z.strictObject({
  name: text(200),
  /** Model estimates inform confirmation only; they never set the execution budget. */
  estimatedCostUsd: z.number().finite().nonnegative().max(10_000),
  requiresConfirmation: z.boolean().optional(),
  steps: z.array(GroupPlanStepSchema).min(1).max(GROUP_PLAN_MAX_STEPS),
});

export const PlanDeliverySchema = z.strictObject({
  workspaceRoot: AbsolutePathSchema.max(4096),
  folder: AbsolutePathSchema.max(4096),
  rewrites: z
    .array(
      z.strictObject({
        stepId: key,
        deliverableId: key,
        from: text(4096),
        to: DeliverableSchema.shape.path,
      }),
    )
    .max(200),
});
export type PlanDelivery = z.infer<typeof PlanDeliverySchema>;

export const GroupPlanSchema = GroupPlanObjectSchema.superRefine((plan, ctx) => {
  const fail = (message: string, path: PropertyKey[]) =>
    ctx.addIssue({ code: "custom", message, path });
  const unique = (values: string[], path: PropertyKey[]) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) fail("plan_duplicate_id", [...path, index]);
      seen.add(value);
    });
  };
  unique(
    plan.steps.map((step) => step.id),
    ["steps"],
  );
  const steps = new Map(plan.steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of steps.get(id)?.dependsOn ?? [])
      if (steps.has(dependency) && !walk(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  const paths = new Set<string>();
  plan.steps.forEach((step, index) => {
    const root = ["steps", index];
    unique(step.dependsOn, [...root, "dependsOn"]);
    for (const dependency of step.dependsOn)
      if (dependency === step.id || !steps.has(dependency))
        fail("plan_dependency_missing", [...root, "dependsOn"]);
    if (!walk(step.id)) fail("plan_dependency_cycle", [...root, "dependsOn"]);
    unique(
      step.deliverables.map((item) => item.id),
      [...root, "deliverables"],
    );
    unique(
      step.acceptance.map((item) => item.id),
      [...root, "acceptance"],
    );
    const deliverables = new Map(step.deliverables.map((item) => [item.id, item]));
    step.deliverables.forEach((item, n) => {
      const path = item.path.normalize("NFKC").toLowerCase();
      if (paths.has(path)) fail("plan_output_collision", [...root, "deliverables", n, "path"]);
      paths.add(path);
      if (
        !step.acceptance.some((check) => check.check !== "manual" && check.deliverable === item.id)
      )
        fail("plan_automatic_check_required", [...root, "deliverables", n]);
    });
    step.acceptance.forEach((check, n) => {
      if (check.check === "manual") {
        if (!check.text) fail("plan_manual_text_required", [...root, "acceptance", n, "text"]);
        if (check.deliverable && !deliverables.has(check.deliverable))
          fail("plan_deliverable_missing", [...root, "acceptance", n, "deliverable"]);
        return;
      }
      const target = check.deliverable ? deliverables.get(check.deliverable) : undefined;
      if (!target) fail("plan_deliverable_missing", [...root, "acceptance", n, "deliverable"]);
      else {
        const issue = acceptanceTargetIssue(check, target);
        if (issue) fail(`plan_${issue}`, [...root, "acceptance", n, "check"]);
      }
    });
    step.inputs.forEach((input, n) => {
      if (
        !step.dependsOn.includes(input.stepId) ||
        !steps.get(input.stepId)?.deliverables.some((item) => item.id === input.deliverableId)
      )
        fail("plan_input_reference_invalid", [...root, "inputs", n]);
    });
  });
}).refine((plan) => JSON.stringify(plan).length <= GROUP_PLAN_MAX_CHARS, "plan_size_invalid");

export const GroupPlanDispositionSchema = z.strictObject({
  action: z.enum(["rewrite_step", "reassign_member", "split_step", "relax_check"]),
  stepId: key,
  reason: text(300).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  checkId: key.optional(),
});

export const GroupPlanCardSchema = z.strictObject({
  schemaVersion: z.literal(1),
  verification: GroupVerificationSchema.optional(),
  /** Absent on historical cards; selected once before confirmation, never inferred by the UI. */
  delivery: PlanDeliverySchema.optional(),
  id: IdSchema,
  groupId: IdSchema,
  originRunId: IdSchema,
  cycleId: IdSchema,
  budgetRootRunId: IdSchema,
  replacesWorkflowRunId: IdSchema.optional(),
  relaxations: PlanRelaxationsSchema.optional(),
  disposition: GroupPlanDispositionSchema.optional(),
  /** Dependencies the program dropped because the step never read from them. */
  droppedDependencies: z
    .number()
    .int()
    .min(0)
    .max(GROUP_PLAN_MAX_STEPS * (GROUP_PLAN_MAX_STEPS - 1))
    .optional(),
  status: z.enum(["pending", "ready", "starting", "started", "modify"]),
  startFailure: GroupPlanStartFailureSchema.optional(),
  // Older cards cannot prove user confirmation; recover them conservatively.
  confirmedByUser: z.boolean().default(false),
  plan: GroupPlanSchema,
  owners: z
    .array(z.strictObject({ stepId: key, botId: IdSchema }))
    .min(1)
    .max(20),
  budgetUsd: z.number().positive().max(10_000).nullable(),
});

/**
 * A saved plan's run request, snapshotted on the user's group message so the coordinator
 * run that becomes the plan's origin and budget root submits exactly what the user started.
 */
export const GroupPlanTemplateRunSchema = z.strictObject({
  skillId: IdSchema,
  version: z.number().int().positive().nullable(),
  name: z.string().trim().min(1).max(200),
  contract: SkillContractSchema.refine((contract) => !!contract.planTemplate, "plan_template"),
  inputs: GroupExecutionPlanSchema.shape.inputs,
});

/** Marks the program's completion message of a dynamic plan whose every step passed. */
export const GroupPlanDoneSchema = z.strictObject({ workflowRunId: IdSchema });

/** Same shape as `WorkflowDocumentSchema`; saving still goes only through `skills.createWorkflow`. */
export const GroupPlanTemplateDocumentSchema = SkillDocumentBaseSchema.extend({
  contract: SkillContractSchema,
}).refine(
  (document) => JSON.stringify(document.contract).length <= SKILL_CONTRACT_MAX_CHARS,
  "Contract too large",
);

/** Fixed program reason codes only (e.g. `user_stopped`, `budget_exhausted`), never prose. */
export const GroupPlanStopReasonSchema = z
  .string()
  .regex(/^[a-z_]{1,40}$/)
  .nullable();
/**
 * Live program facts of one started plan for its card: step states from the engine, cost from
 * the budget root's ledger (`costUsd` null when some request had no known price).
 */
export const GroupPlanProgressSchema = z.strictObject({
  workflowRunId: IdSchema,
  status: GroupWorkflowRunStatusSchema,
  stoppedReason: GroupPlanStopReasonSchema,
  deliveryReview: z
    .strictObject({
      status: z.enum(["pending", "unavailable", "covered", "partial"]),
      covered: z.number().int().min(0).max(40),
      uncovered: z.number().int().min(0).max(40),
      supplementStepId: key.optional(),
    })
    .optional(),
  steps: z
    .array(
      z.strictObject({
        stepId: key,
        executionRunId: IdSchema.nullable().optional(),
        status: GroupWorkflowStepStatusSchema,
        attempt: z.number().int().nonnegative().safe(),
        verdict: ReportVerdictSchema.optional(),
        verdictResolution: z
          .strictObject({ kind: z.enum(["repaired", "skipped", "accepted"]), stepId: key })
          .optional(),
        /**
         * Maintainers 2026-11-14: where a writing step works. `own`: its own workspace; `merging`:
         * passed, waiting for its merge; `merged`; `conflict`; `shared`: taking turns instead.
         */
        workspace: z.enum(["own", "merging", "merged", "conflict", "shared"]).optional(),
        conflictFiles: z.array(z.string().max(500)).max(20).optional(),
        /** Maintainers 2026-11-20: the group's pause stopped this step; it runs again on continue. */
        paused: z.literal(true).optional(),
      }),
    )
    .max(GROUP_PLAN_MAX_STEPS),
  passed: z.number().int().min(0).max(GROUP_PLAN_MAX_STEPS),
  total: z.number().int().min(0).max(GROUP_PLAN_MAX_STEPS),
  /**
   * The plan waits for the user's choice on its card: `replan_limit` (no replans left: continue
   * with the remaining steps or start a new plan) or `fix_skipped` (a repair was skipped, so the
   * listed reviewed steps keep their FAIL verdict: accept them as they are or stop).
   */
  choice: z
    .strictObject({
      kind: z.enum(["replan_limit", "fix_skipped"]),
      stepIds: z.array(key).max(GROUP_PLAN_MAX_STEPS),
    })
    .optional(),
  costUsd: z.number().finite().nonnegative().nullable(),
  pendingCostRequests: z.number().int().nonnegative().optional(),
  budgetUsd: z.number().positive().max(10_000).nullable(),
});

export const GroupPlanMethods = {
  /**
   * The current progress of a started plan. A plan replaced by replanning reports the active
   * replacement of the same budget root, so an earlier card keeps showing the live plan.
   */
  "groups.plan.progress": {
    params: z.strictObject({ groupId: IdSchema, workflowRunId: IdSchema }),
    result: GroupPlanProgressSchema,
  },
  /**
   * User stop of a started plan: aborts running step runs and any pending replan, keeps passed
   * deliverables and recorded cost, never replays anything. Idempotent on an already ended plan.
   */
  "groups.plan.stop": {
    params: z.strictObject({
      groupId: IdSchema,
      workflowRunId: IdSchema,
      confirmed: z.literal(true),
    }),
    result: GroupPlanProgressSchema,
  },
  /**
   * The user's answer to the plan's waiting `choice`: `continue` runs the remaining steps without
   * another replan (verdicts still failing are kept as they are), `accept` keeps a skipped
   * repair's FAIL verdicts as they are, `stop` and `new_plan` end the plan and keep its
   * deliverables. Error `group_plan_choice_unavailable` when the plan no longer waits for it.
   */
  "groups.plan.choose": {
    params: z.strictObject({
      groupId: IdSchema,
      workflowRunId: IdSchema,
      choice: z.enum(["continue", "accept", "stop", "new_plan"]),
      confirmed: z.literal(true),
    }),
    result: GroupPlanProgressSchema,
  },
  /**
   * A passed dynamic plan as a draft group workflow (no model call, nothing persisted).
   * Errors: `group_plan_template_unavailable` (not a fully passed dynamic plan of this group),
   * `group_plan_template_too_large` (exceeds the saved-contract limit).
   */
  "groups.plan.template": {
    params: z.strictObject({ groupId: IdSchema, workflowRunId: IdSchema }),
    result: z.strictObject({ document: GroupPlanTemplateDocumentSchema }),
  },
  "groups.plan.resolve": {
    params: z.strictObject({
      groupId: IdSchema,
      messageId: IdSchema,
      decision: z.enum(["start", "start_relaxed", "modify", "check"]),
    }),
    result: GroupPlanCardSchema,
  },
} as const;

export const GroupPlanEvents = {
  "groups.plan.changed": z
    .strictObject({
      groupId: IdSchema,
      conversationId: IdSchema,
      messageId: IdSchema,
      card: GroupPlanCardSchema,
      updatedAt: z.iso.datetime(),
    })
    .refine((event) => event.groupId === event.card.groupId),
} as const;

export type GroupPlan = z.output<typeof GroupPlanSchema>;
export type GroupPlanCard = z.infer<typeof GroupPlanCardSchema>;
export type GroupPlanTemplateRun = z.output<typeof GroupPlanTemplateRunSchema>;
export type GroupPlanProgress = z.output<typeof GroupPlanProgressSchema>;
export type GroupPlanTemplateDocument = z.output<typeof GroupPlanTemplateDocumentSchema>;

export function groupPlanNeedsConfirmation(plan: GroupPlan, budgetUsd: number | null): boolean {
  return (
    plan.requiresConfirmation === true ||
    plan.steps.length > 4 ||
    (budgetUsd !== null && plan.estimatedCostUsd > budgetUsd / 2)
  );
}

/**
 * Separates what a person reads in a step or task from the reference data the program attaches
 * for the model (the original request, changed-file lists). Screens show only the part before it
 * (video dry run 2026-11-20: the task panel printed the raw JSON).
 */
export const TASK_REFERENCE_SEPARATOR = "\n\n---- 参考资料 / Reference ----\n";

export function visibleTaskText(text: string): string {
  const index = text.indexOf(TASK_REFERENCE_SEPARATOR);
  return index < 0 ? text : text.slice(0, index);
}
