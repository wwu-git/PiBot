// Keep the offline starter set identical in desktop builds and content checks.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Maintainers 2026-11-20: the spec's seven plus 小媒, 小演 and 小匠, and the research group with its
// members (研究员, 小数, 小演). Owner 2026-11-24: the one-person company group ships offline too,
// with its four new members (its developer is 小栈). A group's member roles must be in this list too.
export const MINIMAL_BUILTIN_ROLES = [
  "general-assistant",
  "personal-assistant",
  "researcher",
  "fullstack-dev",
  "copywriter",
  "qa-engineer",
  "code-reviewer",
  "social-media",
  "presentation-designer",
  "plugin-builder",
  "data-analyst",
  "chief-of-staff",
  "finance-assistant",
  "operations-manager",
  "customer-support",
] as const;

export const MINIMAL_BUILTIN_GROUPS = ["dev-lite", "research-group", "opc-team"] as const;

/** Only a generated directory may be replaced; the full catalog remains the release source. */
export function copyMinimalBuiltin(source: string, destination: string): void {
  const from = resolve(source);
  const to = resolve(destination);
  const separate = (parent: string, child: string) => {
    const path = relative(parent, child);
    return isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
  };
  if (!separate(from, to) || !separate(to, from))
    throw new Error("builtin_copy_overlapping_directories");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const file of ["professions.json", "history.json"])
    cpSync(join(source, file), join(destination, file));
  for (const [kind, ids] of [
    ["roles", MINIMAL_BUILTIN_ROLES],
    ["groups", MINIMAL_BUILTIN_GROUPS],
  ] as const) {
    mkdirSync(join(destination, kind), { recursive: true });
    for (const id of ids)
      cpSync(join(source, kind, `${id}.pibot`), join(destination, kind, `${id}.pibot`), {
        recursive: true,
      });
  }
}
