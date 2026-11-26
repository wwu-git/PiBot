// Reviewer selection follows artifact expertise while keeping authors out of their own checks.
import type {
  Bot,
  GroupVerification,
  GroupVerificationRules,
  VerificationKind,
} from "@pibot/protocol-base";
import { canVerifyKind, verificationKind } from "@pibot/teams-contract";
import { implementationAuthors } from "./group-verification-facts.ts";

export function selectVerifiers(
  members: readonly Bot[],
  facts: GroupVerification,
  coordinatorBotId: string,
  rules: GroupVerificationRules = {},
): Bot[] | undefined {
  const authors = new Set(implementationAuthors(facts));
  const candidates = members.filter((bot) => !authors.has(bot.id) && bot.category !== "image");
  const selected = new Map<string, Bot>();
  const content = new Set([
    "copywriter",
    "social-media",
    "translator",
    "presentation-designer",
    "video-scriptwriter",
    // Post and reply drafts are outward content, checked as such rather than as research.
    "operations-manager",
    "customer-support",
  ]);
  const authorRoles = members.filter((bot) => authors.has(bot.id)).map((bot) => bot.role?.id);
  const kinds = facts.files.map((file): VerificationKind => {
    const kind = verificationKind(file);
    if (kind !== "research") return kind;
    if (authorRoles.includes("tutor")) return "learning";
    return authorRoles.some((role) => role && content.has(role)) ? "content" : kind;
  });
  // Code first: the notes and reports that come with a code change (change notes under .pibot/out)
  // are checked by the same QA and reviewer rather than needing a research specialist the group
  // may not have.
  const ordered = [...new Set(kinds)].sort((a, b) => Number(b === "code") - Number(a === "code"));
  for (const kind of ordered) {
    if (kind !== "code" && kinds.includes("code") && selected.size) continue;
    const specialists = candidates.filter((bot) => canVerifyKind(bot.role?.id, kind, rules));
    if (kind === "code") {
      const qa = specialists.find((bot) => bot.role?.id === "qa-engineer");
      const reviewer = specialists.find((bot) => bot.role?.id === "code-reviewer");
      if (qa && reviewer) {
        selected.set(qa.id, qa);
        selected.set(reviewer.id, reviewer);
        continue;
      }
    }
    const owner = specialists[0] ?? candidates.find((bot) => bot.id === coordinatorBotId);
    if (!owner) {
      // A kind nobody here specialises in is covered by verifiers already chosen for the rest.
      if (selected.size) continue;
      return;
    }
    selected.set(owner.id, owner);
  }
  return [...selected.values()];
}
