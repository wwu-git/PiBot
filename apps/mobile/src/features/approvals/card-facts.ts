import { approvalFactText, approvalText } from "@pibot/client-core";
import type { Approval } from "@pibot/protocol";
import type { useLanguage, useSharedText } from "../../runtime/context.tsx";
import type { IconName } from "../../ui/icons.tsx";

/** The desktop approval card's header mark: danger, web, file, connector or command. */
export function approvalIcon(approval: Approval): IconName {
  if (approval.risk === "danger") return "warning";
  if (approval.category === "web") return "globe";
  if (["write_file", "read_file", "list_dir"].includes(approval.category)) return "file";
  return approval.category === "connector" ? "link" : "terminal";
}
/** What the request acts on, for the monospace block: the command or URL, else the first fact. */
export function approvalTarget(
  approval: Approval,
  language: ReturnType<typeof useLanguage>,
  shared: ReturnType<typeof useSharedText>,
) {
  // Pi's cards list each change as a labelled row; a target block would repeat the first one.
  if (isPiManagerApproval(approval)) return undefined;
  if (approval.command) return approval.command;
  if (approval.url) return approval.url;
  const fact = approvalText(approval, language).facts[0];
  return fact ? approvalFactText(fact, shared) : undefined;
}

/** The default Pi's management and hand-off cards: a lead line and labelled rows, no target block. */
export function isPiManagerApproval(approval: Approval) {
  return approval.category === "bot_management" || approval.category === "work_dispatch";
}
/** "Don't ask again" on Pi's cards sets Pi's own level for that kind to always. */
export function piRememberText(approval: Approval, shared: ReturnType<typeof useSharedText>) {
  return shared(
    approval.category === "work_dispatch"
      ? "approval.piRemember.work_dispatch"
      : "approval.piRemember.bot_management",
  );
}
/** The card's lead sentence in the reader's language (only Pi's cards have one). */
export function approvalLead(approval: Approval, language: ReturnType<typeof useLanguage>) {
  const text = approvalText(approval, language);
  return "lead" in text ? text.lead : undefined;
}
