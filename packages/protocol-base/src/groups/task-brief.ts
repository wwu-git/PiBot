import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { AcceptanceCheckSchema, DeliverableSchema } from "../skills/contract.ts";
import { GroupFolderSelectionSchema, GroupRelativePathSchema } from "./files.ts";
import { GroupWorkflowStepStatusSchema } from "./workflow.ts";

const stepKey = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const MAX_STEPS = 20;

/** One plan step as the flow strip shows it: who owns it, what it is called and where it is. */
export const GroupTaskBriefStepSchema = z.strictObject({
  stepId: stepKey,
  /** 1-based position in the plan, so "step 2 of 3" never depends on the renderer's sorting. */
  index: z.number().int().min(1).max(MAX_STEPS),
  title: z.string().min(1).max(200),
  ownerBotId: IdSchema,
  status: GroupWorkflowStepStatusSchema,
});

/** Where a delivered file can be opened through `groups.files.open` (null: not in a group folder). */
const OpenTargetSchema = z
  .strictObject({ folderId: GroupFolderSelectionSchema, path: GroupRelativePathSchema })
  .nullable();

/**
 * The structured facts behind a plan step's brief, read from the stored plan, step and hand-off
 * records (no model call). The renderer lays these out; it never parses the instruction text.
 */
export const GroupTaskBriefSchema = z.strictObject({
  workflowRunId: IdSchema,
  step: GroupTaskBriefStepSchema,
  total: z.number().int().min(1).max(MAX_STEPS),
  /** The coordinator's own words for this step (Markdown); null when the step runs a skill. */
  task: z.string().max(8_000).nullable(),
  /** The member skill a skill step runs, by name. */
  skill: z.string().max(200).nullable(),
  /** Steps this one waits for, and steps that wait for it. */
  previous: z.array(GroupTaskBriefStepSchema).max(MAX_STEPS - 1),
  next: z.array(GroupTaskBriefStepSchema).max(MAX_STEPS - 1),
  /** Files earlier steps hand to this one. */
  inputFiles: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(200),
        from: GroupTaskBriefStepSchema,
      }),
    )
    .max(40),
  /** The plan's run inputs (name / value), the same for every step. */
  inputs: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(200),
        kind: z.enum(["folder", "file", "text"]),
        value: z.string().max(16_000),
      }),
    )
    .max(12),
  deliverables: z
    .array(
      z.strictObject({
        id: DeliverableSchema.shape.id,
        path: DeliverableSchema.shape.path,
        kind: DeliverableSchema.shape.kind,
        delivered: z.boolean(),
        /** When the member last wrote it, from the run's recorded file changes. */
        deliveredAt: z.iso.datetime().nullable(),
        open: OpenTargetSchema,
      }),
    )
    .max(10),
  acceptance: z
    .array(
      z.strictObject({
        id: stepKey,
        check: AcceptanceCheckSchema,
        text: z.string().max(300).nullable(),
        /** The deliverable path the check reads, if any. */
        deliverable: z.string().max(200).nullable(),
        /** `person`: only someone confirming can pass it; every other check is the program's. */
        by: z.enum(["program", "person"]),
        state: z.enum(["pending", "pass", "fail", "waiting"]),
      }),
    )
    .max(20),
  /** The output folder (absolute) and the short form people recognise. */
  folder: z.strictObject({ path: z.string().min(1).max(4096), label: z.string().min(1).max(4096) }),
  /** `own`: writes in its own workspace and is merged after its checks; `shared`: group folder. */
  workspace: z.enum(["own", "shared"]),
});

export type GroupTaskBrief = z.infer<typeof GroupTaskBriefSchema>;
export type GroupTaskBriefStep = z.infer<typeof GroupTaskBriefStepSchema>;
