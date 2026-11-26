import { isAbsolute, relative, sep } from "node:path";
import {
  type Group,
  type GroupTaskBrief,
  GroupTaskBriefSchema,
  type GroupTaskBriefStep,
  type KernelMethodParams,
  type WorkflowStep,
} from "@pibot/protocol-base";
import {
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  MessagesRepo,
  RunFileChangesRepo,
} from "@pibot/storage";
import { stepWorkspaces } from "./group-plan-progress.ts";
import { workspaceSteps } from "./group-plan-step-workspaces.ts";
import type { GroupService } from "./group-service.ts";
import { type StoredWorkflow, workflowOf } from "./group-workflow-snapshot.ts";

const slash = (value: string) => value.split(sep).join("/").replaceAll("\\", "/");
// Display only: file systems on macOS and Windows match names without case.
const key = (value: string) => slash(value).normalize("NFC").toLowerCase();

/** A path inside `root`, as the group file browser addresses it; undefined when outside. */
function inside(root: string, path: string) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return slash(rel);
}

/** The group folder (or the group's own folder) the plan's output folder lies in. */
async function outputRoot(
  service: GroupService,
  group: Group,
  folder: string,
  signal: AbortSignal,
) {
  for (const item of group.folders ?? []) {
    const rel = inside(item.path, folder);
    if (rel !== undefined) return { folderId: item.id, name: item.name, rel };
  }
  const home = await service.deps.local.workplaces.groupHome(group.id, signal);
  const rel = inside(home, folder);
  return rel === undefined ? undefined : { folderId: "home" as const, name: group.name, rel };
}

/**
 * The step task as the coordinator wrote it. The started contract keeps it on one line (contract
 * text is single-line), which would run a bullet list together; the plan card it was started from
 * keeps the line breaks. Used only when it is the same text, so the screen never shows other words
 * than the member was given.
 */
function cardTask(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  workflow: StoredWorkflow,
  stepId: string,
  text: string,
) {
  if (workflow.source.kind !== "dynamic") return text;
  const conversationId = new MessagesRepo(service.deps.db).get(
    record.sourceMessageId,
  )?.conversationId;
  const card = conversationId
    ? service.plans.repo.byCardId(conversationId, workflow.source.planId)?.card
    : undefined;
  const original = card?.plan.steps.find((item) => item.id === stepId)?.task;
  return original?.replace(/[\r\n\t]/g, " ").trim() === text.trim() ? original : text;
}

/**
 * The structured brief of a plan step's task, from the stored plan, step rows, hand-off record and
 * the member runs' recorded file writes. Null for a task that is not a plan step.
 */
export async function taskBrief(
  service: GroupService,
  group: Group,
  params: KernelMethodParams["groups.tasks.brief"],
  signal: AbortSignal,
): Promise<GroupTaskBrief | null> {
  const task = service.tasks.get(params.taskId);
  if (!task || task.groupId !== group.id) return null;
  const handoff = service.handoffs.repo.get(task.id);
  const reference = handoff?.spec.workflowStep;
  if (!handoff || !reference) return null;
  const record = service.workflows.repo.get(reference.workflowRunId);
  if (!record || record.groupId !== group.id) return null;
  const workflow = workflowOf(record);
  const steps = workflow.contract.steps ?? [];
  const definition = steps.find((item) => item.id === reference.stepId);
  if (!definition) return null;
  const states = service.workflows.repo.steps(record.id);
  const stateOf = new Map(states.map((item) => [item.stepId, item]));
  const redact = (value: string) => service.deps.redactor.redact(value);
  const node = (step: WorkflowStep, state?: GroupWorkflowStepRecord): GroupTaskBriefStep => ({
    stepId: step.id,
    index: steps.indexOf(step) + 1,
    title: redact(step.title),
    ownerBotId: state?.ownerBotId ?? task.assigneeBotId,
    status: state?.status ?? "waiting",
  });
  const byId = new Map(steps.map((step) => [step.id, step]));
  const previous = definition.dependsOn.flatMap((id) => {
    const step = byId.get(id);
    return step ? [node(step, stateOf.get(id))] : [];
  });
  const next = steps
    .filter((step) => step.dependsOn.includes(definition.id))
    .map((step) => node(step, stateOf.get(step.id)));
  // Explicit plan references name the files; without them the step reads every prerequisite's.
  const references = definition.inputs?.length
    ? definition.inputs
    : definition.dependsOn.flatMap(
        (stepId) =>
          byId.get(stepId)?.deliverables.map((item) => ({ stepId, deliverableId: item.id })) ?? [],
      );
  const inputFiles = references.flatMap((reference) => {
    const step = byId.get(reference.stepId);
    const deliverable = step?.deliverables.find((item) => item.id === reference.deliverableId);
    return step && deliverable
      ? [{ path: deliverable.path, from: node(step, stateOf.get(step.id)) }]
      : [];
  });

  const result = handoff.result;
  const confirmed = service.handoffs.repo.view(task.id)?.userConfirmed === true;
  const own = workspaceSteps(record, workflow, states).has(definition.id);
  const workspace = stepWorkspaces(service, record, states).get(definition.id);
  // A file in a workspace that is not merged yet is not in the group folder the browser opens.
  const openable = !own || workspace === "merged";
  const root = await outputRoot(service, group, workflow.folder, signal);
  const writes = new RunFileChangesRepo(service.deps.db).lastWrites(
    service.runs.taskRunIds(task.id),
  );
  const deliverables = definition.deliverables.map((item) => {
    const suffix = `/${key(item.path)}`;
    const written = writes.find((write) =>
      `/${key(`${write.root}/${write.path}`)}`.endsWith(suffix),
    );
    // The program's check, once it ran, decides; until then the member's recorded writes do.
    const checked = result?.items.find(
      (entry) =>
        entry.deliverable === item.path && (entry.id.startsWith("#") || entry.check === "exists"),
    );
    const delivered = checked ? checked.status === "pass" : !!written;
    const path = root ? [root.rel, item.path].filter(Boolean).join("/") : undefined;
    return {
      id: item.id,
      path: item.path,
      kind: item.kind,
      delivered,
      deliveredAt: delivered ? (written?.at ?? null) : null,
      open: delivered && openable && root && path ? { folderId: root.folderId, path } : null,
    };
  });
  const acceptance = definition.acceptance.map((item) => {
    const checked = result?.items.find((entry) => entry.id === item.id);
    const person = item.check === "manual";
    const state = checked
      ? checked.status === "pass" || (checked.status === "manual" && confirmed)
        ? "pass"
        : checked.status === "fail"
          ? "fail"
          : "waiting"
      : person && result
        ? confirmed
          ? "pass"
          : "waiting"
        : "pending";
    const target = item.deliverable
      ? definition.deliverables.find((entry) => entry.id === item.deliverable)?.path
      : undefined;
    return {
      id: item.id,
      check: item.check,
      text: item.text ? redact(item.text) : null,
      deliverable: target ?? null,
      by: person ? ("person" as const) : ("program" as const),
      state,
    };
  });
  return GroupTaskBriefSchema.parse({
    workflowRunId: record.id,
    step: node(definition, stateOf.get(definition.id)),
    total: steps.length,
    task:
      typeof definition.task === "string"
        ? redact(cardTask(service, record, workflow, definition.id, definition.task))
        : null,
    skill:
      typeof definition.task === "string"
        ? null
        : (handoff.spec.workflow?.name ?? definition.task.skillId),
    previous,
    next,
    inputFiles,
    inputs: workflow.inputs.map((item) => ({ ...item, value: redact(item.value) })),
    deliverables,
    acceptance,
    folder: {
      path: workflow.folder,
      label: root ? [root.name, root.rel].filter(Boolean).join("/") : workflow.folder,
    },
    workspace: own ? "own" : "shared",
  });
}
