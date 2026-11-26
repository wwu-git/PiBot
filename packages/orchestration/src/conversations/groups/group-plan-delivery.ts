import pathApi from "node:path";
import {
  folderName,
  planFolderName,
  resolveWorkflowFolder,
  type WorkspaceFileAccess,
  workflowOutputRoots,
} from "@pibot/brain/orchestration-kit";
import {
  DeliverablePathSchema,
  GROUP_PLAN_MAX_CHARS,
  GroupPlanToolSchema,
  type PlanDelivery,
  SkillContractSchema,
} from "@pibot/protocol-base";
import { isCodeFile } from "./group-verification-facts.ts";

const period = /^\d{4}-(?:\d{2}-\d{2}|W\d{2}|\d{2})(?:-\d{1,3})?$/;

/** Strip every repeated prefix now, so replanning cannot change an already canonical step. */
function canonicalPath(path: string, name: string, folder: string, paths = pathApi) {
  const equal = (a: string, b: string) =>
    paths.sep === "\\" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const roots = new Set(workflowOutputRoots().map((root) => root.toLowerCase()));
  let value = path;
  while (value) {
    if (folder && equal(value.slice(0, folder.length + 1), `${folder}/`)) {
      value = value.slice(folder.length + 1);
      continue;
    }
    const parts = value.split("/");
    // `.pibot/out` is two segments; the older roots are one.
    const two = `${parts[0] ?? ""}/${parts[1] ?? ""}`.toLowerCase();
    if (roots.has(two)) parts.splice(0, 2);
    else if (roots.has(parts[0]?.toLowerCase() ?? "")) parts.shift();
    else break;
    // Models copy either the plan name or its folder segment (older plans used the name).
    if (equal(parts[0] ?? "", planFolderName(name)) || equal(parts[0] ?? "", folderName(name))) {
      parts.shift();
      if (period.test(parts[0] ?? "")) parts.shift();
    }
    value = parts.join("/");
  }
  return DeliverablePathSchema.safeParse(value).data;
}

/** Do not resolve away traversal before validating it; removing a prefix must never hide `..`. */
export function relativeDeliveryPath(
  path: string,
  name: string,
  delivery: Pick<PlanDelivery, "workspaceRoot" | "folder">,
  access?: WorkspaceFileAccess,
) {
  const paths = access?.paths ?? pathApi;
  const { relative, isAbsolute, resolve, sep } = paths;
  const equal = (a: string, b: string) =>
    sep === "\\" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const portable = (path: string) => path.split(sep).join("/");
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part === "." || part === "..")) return undefined;
  const folder = portable(relative(delivery.workspaceRoot, delivery.folder));
  if (isAbsolute(path)) {
    const prefix = `${portable(resolve(delivery.folder))}/`;
    const value = portable(path);
    if (!equal(value.slice(0, prefix.length), prefix)) return undefined;
    return canonicalPath(value.slice(prefix.length), name, folder, paths);
  }
  // A foreign absolute path must not become a relative path on another platform.
  if (/^[A-Za-z]:|^\\|\\/.test(path)) return undefined;
  return canonicalPath(path, name, folder, paths);
}

/**
 * Windows acceptance 2026-11-21: a plan to fix calc.ps1 listed calc.ps1 and test.ps1 as the
 * implement step's deliverables. Deliverables are always written into the output folder, so the
 * member wrote fixed copies there and the project's own calc.ps1 never changed. A source file
 * that exists in the working folder, or sits in one of its existing folders, is the project's:
 * the step edits it in place and delivers a change note instead.
 */
async function projectSource(
  path: string,
  workspaceRoot: string,
  access: WorkspaceFileAccess,
  signal: AbortSignal,
) {
  const { resolve, dirname } = access.paths;
  if (!isCodeFile(path, access.paths)) return false;
  const kind = async (target: string) => {
    try {
      return (await access.probe(target, signal))?.kind;
    } catch (error) {
      if (signal.aborted) throw error;
      // Best effort: a folder the probe cannot read (an older runner) keeps the plan as written.
      return undefined;
    }
  };
  if ((await kind(resolve(workspaceRoot, path))) === "file") return true;
  const parent = dirname(path);
  return parent !== "." && (await kind(resolve(workspaceRoot, parent))) === "directory";
}

function projectSourceIssue(path: string, at: (string | number)[]) {
  return {
    code: "plan_deliverable_project_file",
    path: at,
    expected:
      "A new artifact such as 改动说明.md; project files are edited in place / 新产物，如 改动说明.md；项目文件原地修改",
    message: `「${path}」是工作文件夹里的项目文件。交付物只会写进产物目录，列它只会得到一份副本，项目本身不变。请在 task 里写明直接修改项目里的这个文件（新增的源码和测试也直接写进项目），交付物改为改动说明，例如 改动说明.md。 / ${path} is a project file in the working folder. Deliverables are written only to the output folder, so listing it yields a copy and leaves the project unchanged. Say in task to edit this project file in place (write new source and test files into the project too) and list a change note such as 改动说明.md as the deliverable.`,
  };
}

/**
 * Linux retest 2026-11-21: the coordinator added fileNaming checks ("uses the expected file name")
 * to 测试报告.md and 审查报告.md. fileNaming is the dated 主题_类型_YYYY-MM-DD convention, so the
 * check could never pass and every round failed until the step reached the user. A fixed name is
 * already checked by exists.
 */
const DATED = /^(.+)_([^_]+)_(\d{4})-(\d{2})-(\d{2})$/u;
function fixedNameChecks(
  steps: readonly {
    id: string;
    deliverables: readonly { id: string; path: string }[];
    acceptance?: readonly { id?: string; check?: string; deliverable?: string }[];
  }[],
  completed: ReadonlySet<string>,
) {
  const issues: { code: string; path: (string | number)[]; expected: string; message?: string }[] =
    [];
  steps.forEach((step, index) => {
    if (completed.has(step.id)) return;
    (step.acceptance ?? []).forEach((item, n) => {
      if (item.check !== "fileNaming") return;
      const target = step.deliverables.find((d) => d.id === item.deliverable);
      if (!target) return;
      const base = pathApi.posix.basename(target.path.replaceAll("\\", "/"));
      if (DATED.test(base.slice(0, base.length - pathApi.posix.extname(base).length))) return;
      issues.push({
        code: "plan_check_file_naming_fixed",
        path: ["steps", index, "acceptance", n, "check"],
        expected:
          "exists (or a 主题_类型_YYYY-MM-DD name) / exists（或 主题_类型_YYYY-MM-DD 命名）",
        message: `fileNaming 只检查「主题_类型_YYYY-MM-DD」这种带日期的命名；「${target.path}」是固定文件名，这项检查永远通不过。去掉这项检查（文件是否存在已由 exists 检查）。 / fileNaming only checks the dated topic_type_YYYY-MM-DD naming; ${target.path} has a fixed name, so this check can never pass. Remove it (exists already checks the file).`,
      });
    });
  });
  return issues;
}

/** Plan validation chooses without creating directories, so confirmation and execution refer to one folder. */
export async function preparePlanDelivery(
  value: unknown,
  workspaceRoot: string,
  signal: AbortSignal,
  previous?: PlanDelivery,
  access?: WorkspaceFileAccess,
  /** Passed or skipped steps of the plan being replaced: their accepted contract is kept as is. */
  completed: ReadonlySet<string> = new Set(),
): Promise<{
  value: unknown;
  delivery?: PlanDelivery;
  issues?: { code: string; path: (string | number)[]; expected: string; message?: string }[];
}> {
  const { relative, isAbsolute, sep } = access?.paths ?? pathApi;
  signal.throwIfAborted();
  const parsed = GroupPlanToolSchema.safeParse(value);
  if (!parsed.success) return { value };
  const input = parsed.data;
  if (JSON.stringify(value).length > GROUP_PLAN_MAX_CHARS) return { value };
  const wrongRoot = () => ({
    value,
    issues: [
      {
        code: "plan_delivery_workplace_changed",
        path: [] as (string | number)[],
        expected:
          "Keep the original artifact folder inside the current workplace / 原产物目录须仍在当前工作区内",
      },
    ],
  });
  if (previous && previous.workspaceRoot !== workspaceRoot) return wrongRoot();
  const place = await resolveWorkflowFolder(
    workspaceRoot,
    {
      name: input.name,
      root: planFolderName(input.name),
      contract: SkillContractSchema.parse({}),
      ...(previous ? { folder: previous.folder } : {}),
    },
    signal,
    undefined,
    access,
  );
  const inside = relative(workspaceRoot, place.folder);
  if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
    return wrongRoot();
  const delivery: PlanDelivery = { workspaceRoot, folder: place.folder, rewrites: [] };
  signal.throwIfAborted();
  const issues: { code: string; path: (string | number)[]; expected: string; message?: string }[] =
    [];
  const steps = input.steps.map((step, index) => ({
    ...step,
    deliverables: step.deliverables.map((item, n) => {
      const path = relativeDeliveryPath(item.path, input.name, delivery, access);
      if (!path) {
        issues.push({
          code: "plan_delivery_path_invalid",
          path: ["steps", index, "deliverables", n, "path"],
          expected:
            "Relative file path inside the artifact folder; no traversal / 产物目录内的相对文件路径，不得越界",
        });
        return item;
      }
      if (path !== item.path)
        delivery.rewrites.push({
          stepId: step.id,
          deliverableId: item.id,
          from: item.path,
          to: path,
        });
      return { ...item, path };
    }),
  }));
  if (access && !issues.length) {
    const checks = steps.flatMap((step, index) =>
      completed.has(step.id)
        ? []
        : step.deliverables.map(async (item, n) =>
            (await projectSource(item.path, workspaceRoot, access, signal))
              ? projectSourceIssue(item.path, ["steps", index, "deliverables", n, "path"])
              : undefined,
          ),
    );
    for (const issue of await Promise.all(checks)) if (issue) issues.push(issue);
    signal.throwIfAborted();
  }
  for (const issue of fixedNameChecks(steps, completed)) issues.push(issue);
  const key = (stepId: string, id: string) => `${stepId}/${id}`;
  const paths = new Map(
    steps.flatMap((step) =>
      step.deliverables.map((item) => [key(step.id, item.id), item.path] as const),
    ),
  );
  const rewritten = new Set(delivery.rewrites.map((item) => key(item.stepId, item.deliverableId)));
  for (const rewrite of previous?.rewrites ?? []) {
    const id = key(rewrite.stepId, rewrite.deliverableId);
    if (paths.get(id) === rewrite.to && !rewritten.has(id)) delivery.rewrites.push(rewrite);
  }
  return {
    value: { ...input, steps },
    delivery,
    ...(issues.length ? { issues: issues.slice(0, 20) } : {}),
  };
}
