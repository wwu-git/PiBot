import { useNavigation, useT } from "@pibot/renderer-kit";
import { MemoryScopeView } from "../workspace/memory/settings/MemoryScopeView.tsx";
import { ABOUT_YOU_DIALOG } from "../workspace/memory/use-open-memory.ts";
import { AppDialog } from "./AppDialog.tsx";
import { MemoryDreamCards } from "./MemoryDreamCards.tsx";

export function AboutYouDialog() {
  const { dialog, closeDialog } = useNavigation();
  const t = useT();
  if (dialog?.owner !== ABOUT_YOU_DIALOG) return null;
  return (
    <AppDialog
      key={dialog.key}
      kind="about-you"
      mark={{ icon: "user", tone: "pink" }}
      title={t("appMenu.aboutYou")}
      close={() => closeDialog(dialog.key)}
    >
      <MemoryDreamCards />
      <MemoryScopeView owner={{ scope: "user", ownerId: "user" }} />
    </AppDialog>
  );
}
