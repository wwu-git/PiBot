import { PackageError, type RawEntry, redactValue, ZipError } from "@pibot/brain/kit";
import {
  type PermissionsSettings,
  RpcError,
  RpcErrorCodes,
  type TeamPreview,
  type TeamTemplate,
  TeamTemplateSchema,
  tightenOverrides,
} from "@pibot/protocol";
import type { Redactor } from "@pibot/secrets";
import { parseTeamFile } from "../../store/index.ts";
import {
  isTeamArchive,
  type ResolvedTeam,
  resolveTeam,
  type TeamSkillPackage,
  zipEntries,
} from "./team-archive.ts";

export interface ParsedTeam extends ResolvedTeam {
  /** Supporting files of every skill, for the preview (SKILL.md text is in the template). */
  files: NonNullable<TeamPreview["files"]>;
}

function previewFiles(template: TeamTemplate, skills: TeamSkillPackage[][]) {
  return template.bots.flatMap((bot, index) =>
    (skills[index] ?? []).flatMap((skill) =>
      skill.files.map((file) => ({
        ref: bot.ref,
        skill: skill.document.name,
        path: file.path,
        bytes: file.data.length,
        script: file.script,
        text: file.text,
      })),
    ),
  );
}

/** Stable error codes the import dialog explains; never the file's content. */
export function teamError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const reason = error instanceof PackageError || error instanceof ZipError ? error.message : "";
  if (reason === "too_large" || reason === "too_many_files")
    return new RpcError(RpcErrorCodes.invalidParams, "team_too_large");
  if (reason === "unsafe") return new RpcError(RpcErrorCodes.invalidParams, "team_unsafe");
  return new RpcError(RpcErrorCodes.invalidParams, "team_invalid");
}

/**
 * The one way a `.pibot` becomes a template: a version-3 entry list (an imported zip or a
 * built-in `<id>.pibot/` folder) or a version-1/2 JSON file, in the UI language, every string
 * redacted before anything else sees it.
 */
export function parseTeamEntries(
  entries: readonly RawEntry[],
  language: "zh" | "en",
  redactor: Redactor,
): ParsedTeam {
  try {
    const resolved = resolveTeam(entries, language);
    const template = TeamTemplateSchema.parse(redactValue(resolved.template, redactor));
    return { ...resolved, template, files: previewFiles(template, resolved.skills) };
  } catch (error) {
    throw teamError(error);
  }
}
export function parseTeamBytes(
  data: Buffer,
  language: "zh" | "en",
  redactor: Redactor,
): ParsedTeam {
  if (isTeamArchive(data)) {
    let entries: RawEntry[];
    try {
      entries = zipEntries(data);
    } catch (error) {
      throw teamError(error);
    }
    return parseTeamEntries(entries, language, redactor);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const template = TeamTemplateSchema.parse(redactValue(parseTeamFile(text), redactor));
    if (template.version === 3) throw new PackageError("no_team");
    const skills = template.bots.map((bot) =>
      (bot.skills ?? []).flatMap((skill) =>
        "body" in skill
          ? [
              {
                folder: "",
                enabled: skill.enabled,
                document: {
                  name: skill.name,
                  description: skill.description,
                  body: skill.body,
                  params: skill.params,
                },
                files: [],
              },
            ]
          : [],
      ),
    );
    return { template, skills, skipped: 0, files: [] };
  } catch (error) {
    throw teamError(error);
  }
}

/**
 * An imported or built-in Bot starts from the local defaults and may only be tightened.
 * "always" is lowered to "ask", a level not stricter than the default is dropped (it follows the
 * default) and a network scope never travels. The notes tell the preview what was changed.
 */
export function tightenTemplate(
  template: TeamTemplate,
  levels: PermissionsSettings["levels"],
): { template: TeamTemplate; notes: NonNullable<TeamPreview["permissionNotes"]> } {
  const notes: NonNullable<TeamPreview["permissionNotes"]> = [];
  const bots = template.bots.map((bot) => {
    const { network, confirmEverySend, ...supplied } = bot.permissionOverrides;
    const { overrides, lowered } = tightenOverrides(levels, supplied);
    const relaxed = (Object.keys(supplied) as (keyof typeof supplied)[]).filter(
      (category) => overrides[category] === undefined && !lowered.includes(category),
    );
    if (lowered.length || relaxed.length || network)
      notes.push({ ref: bot.ref, lowered, relaxed, network: !!network });
    return {
      ...bot,
      permissionOverrides: confirmEverySend ? { ...overrides, confirmEverySend } : overrides,
    };
  });
  return { template: { ...template, bots }, notes };
}
