// Review expertise is shared data so every group can choose an independent member.
import type { GroupVerificationRules, VerificationKind } from "@pibot/protocol-base";

export const ROLE_VERIFICATION_KINDS: Readonly<Record<string, readonly VerificationKind[]>> = {
  "qa-engineer": ["code"],
  "code-reviewer": ["code"],
  researcher: ["research", "data"],
  "data-analyst": ["data", "research"],
  copywriter: ["content"],
  "social-media": ["content", "image"],
  "presentation-designer": ["content", "image"],
  "image-designer": ["image", "content"],
  "project-manager": ["content", "research", "data"],
  tutor: ["learning", "research", "content"],
  translator: ["content", "research"],
  "video-scriptwriter": ["content"],
  "product-manager": ["content", "research", "data"],
  // One-person company: the chief of staff checks every member's report; finance checks figures.
  "chief-of-staff": ["content", "research", "data"],
  "finance-assistant": ["data"],
  "operations-manager": ["content", "data"],
  "customer-support": ["content"],
};

export function canVerifyKind(
  roleId: string | undefined,
  kind: VerificationKind,
  rules: GroupVerificationRules = {},
): boolean {
  if (!roleId) return false;
  const kinds = Object.hasOwn(rules, roleId)
    ? rules[roleId]
    : Object.hasOwn(ROLE_VERIFICATION_KINDS, roleId)
      ? ROLE_VERIFICATION_KINDS[roleId]
      : undefined;
  return kinds?.includes(kind) ?? false;
}

export function verificationKind(file: string): VerificationKind {
  if (/\.(?:png|jpe?g|webp|gif|svg|avif)$/iu.test(file)) return "image";
  if (/\.(?:xlsx?|csv|tsv)$/iu.test(file)) return "data";
  if (/\.(?:md|docx?|pdf)$/iu.test(file)) return "research";
  if (/\.(?:pptx?|txt|rtf)$/iu.test(file)) return "content";
  return "code";
}
