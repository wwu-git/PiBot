import { ChatFontSizeSchema } from "@pibot/protocol";
import { useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { Avatar, Button, type IconName, IconTile, SegmentedControl, type Tone } from "@pibot/ui";
import { useState } from "react";
import { AboutYouMenuItem } from "./AboutYouMenuItem.tsx";
import { AppDialog } from "./AppDialog.tsx";
import { AboutPanel, FeedbackPanel, openWebsite } from "./AppPanels.tsx";
import { AvatarUpload } from "./AvatarUpload.tsx";
import styles from "./app-menu.module.css";
import { ConversationImportDialog } from "./conversation-import/ConversationImportDialog.tsx";
import { MenuPopover } from "./MenuPopover.tsx";
import { UpdatesPanel } from "./UpdatesPanel.tsx";

type Panel = "profile" | "about" | "feedback" | "updates";
type MenuPanel = Panel | "conversation-import";
/** One colour per destination, shared by the menu tile and its dialog's mark. */
const marks: Record<Panel, { icon: IconName; tone: Exclude<Tone, "neutral" | "red"> }> = {
  profile: { icon: "user", tone: "violet" },
  about: { icon: "info", tone: "violet" },
  feedback: { icon: "message", tone: "orange" },
  updates: { icon: "refresh", tone: "green" },
};
export function AppMenu() {
  const { t, settings, update } = useSettings(),
    { peer } = useRpc(),
    { openSettings } = useNavigation();
  const [menu, setMenu] = useState<{ opener: HTMLElement; x: number; y: number }>(),
    [panel, setPanel] = useState<MenuPanel>(),
    [failed, setFailed] = useState(false);
  const show = (next: MenuPanel) => {
    setMenu(undefined);
    setPanel(next);
  };
  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-label={t("appMenu.title")}
        title={t("appMenu.title")}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setFailed(false);
          setMenu(
            menu ? undefined : { opener: event.currentTarget, x: rect.left, y: rect.top - 360 },
          );
        }}
      >
        <Avatar
          size={36}
          shape="blob"
          color="violet"
          eyes="marks"
          image={settings?.userAvatar}
          label={t("appMenu.profile")}
        />
      </button>
      {menu && (
        <MenuPopover {...menu} close={() => setMenu(undefined)}>
          <Button
            variant="ghost"
            role="menuitem"
            className={styles.profile}
            onClick={() => show("profile")}
          >
            <Avatar size={38} image={settings?.userAvatar} label={t("appMenu.profile")} />
            <span>
              {t("appMenu.profile")}
              <small>{t("appMenu.editAvatar")}</small>
            </span>
          </Button>
          {/* Language and appearance are switched often enough to sit one click from the avatar. */}
          <div className={styles.prefs}>
            <div className={styles.pref}>
              <span>{t("language.label")}</span>
              <SegmentedControl
                label={t("language.label")}
                disabled={!peer}
                value={settings?.language ?? "system"}
                options={(["system", "zh", "en"] as const).map((value) => ({
                  value,
                  label: t(`language.${value}`),
                }))}
                onValueChange={(language) => void update({ language })}
              />
            </div>
            <div className={styles.pref}>
              <span>{t("theme.label")}</span>
              <SegmentedControl
                label={t("theme.label")}
                disabled={!peer}
                value={settings?.theme ?? "system"}
                options={(["system", "light", "dark"] as const).map((value) => ({
                  value,
                  label: t(`theme.${value}`),
                }))}
                onValueChange={(theme) => void update({ theme })}
              />
            </div>
            <div className={styles.pref}>
              <span>{t("chatFont.label")}</span>
              <SegmentedControl
                label={t("chatFont.label")}
                disabled={!peer}
                value={settings?.chatFontSize ?? "medium"}
                options={ChatFontSizeSchema.options.map((value) => ({
                  value,
                  label: t(`chatFont.${value}`),
                }))}
                onValueChange={(chatFontSize) => void update({ chatFontSize })}
              />
            </div>
          </div>
          <div className={styles.separator} />
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              openSettings("general");
            }}
          >
            <IconTile icon="settings" tone="blue" size="sm" />
            {t("settings.title")}
          </Button>
          <Button
            variant="ghost"
            role="menuitem"
            disabled={!peer}
            onClick={() =>
              void openWebsite(peer).then(
                () => setMenu(undefined),
                () => setFailed(true),
              )
            }
          >
            <IconTile icon="globe" tone="teal" size="sm" />
            {t("appMenu.website")}
          </Button>
          <AboutYouMenuItem close={() => setMenu(undefined)} />
          <Button
            variant="ghost"
            role="menuitem"
            disabled={!peer}
            onClick={() => show("conversation-import")}
          >
            <IconTile icon="download" tone="teal" size="sm" />
            {t("conversationImport.title")}
          </Button>
          <Button variant="ghost" role="menuitem" onClick={() => show("about")}>
            <IconTile icon="info" tone="violet" size="sm" />
            {t("appMenu.about")}
          </Button>
          <Button variant="ghost" role="menuitem" onClick={() => show("feedback")}>
            <IconTile icon="message" tone="orange" size="sm" />
            {t("appMenu.feedback")}
          </Button>
          <div className={styles.separator} />
          <Button variant="ghost" role="menuitem" disabled={!peer} onClick={() => show("updates")}>
            <IconTile icon="refresh" tone="green" size="sm" />
            {t("appMenu.updates")}
          </Button>
          {failed && (
            <p role="alert" className={styles.error}>
              {t("workspace.failed")}
            </p>
          )}
        </MenuPopover>
      )}
      <ConversationImportDialog
        open={panel === "conversation-import"}
        close={() => setPanel(undefined)}
      />
      {panel && panel !== "conversation-import" && (
        <AppDialog
          title={t(`appMenu.${panel}`)}
          mark={panel === "profile" ? undefined : marks[panel]}
          close={() => setPanel(undefined)}
        >
          {panel === "about" && <AboutPanel />}
          {panel === "feedback" && <FeedbackPanel />}
          {panel === "updates" && <UpdatesPanel />}
          {panel === "profile" && (
            <>
              <div className={styles.brand}>
                <Avatar size={80} image={settings?.userAvatar} label={t("appMenu.profile")} />
              </div>
              <AvatarUpload
                image={settings?.userAvatar}
                disabled={!peer}
                change={async (userAvatar) => {
                  await update({ userAvatar });
                  return true;
                }}
              />
            </>
          )}
        </AppDialog>
      )}
    </>
  );
}
