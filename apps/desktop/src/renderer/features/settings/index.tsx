// Hosts the desktop settings navigation and selected settings page.
import { ComputerUseSettings } from "@pibot/computer-use/ui";
import { ModelsSettings } from "@pibot/models/ui";
import { RemoteSettingsPage } from "@pibot/remote/ui";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  type SettingsTarget,
  setupStyles as styles,
  useNavigation,
  useSettingsDialog,
  useT,
} from "@pibot/renderer-kit";
import { Button, CloseButton, type IconName, IconTile, type Tone } from "@pibot/ui";
import { type CSSProperties, useId, useState } from "react";
import { BrowserSettings } from "./browser.tsx";
import dialogStyles from "./dialog.module.css";
import { GeneralSettings } from "./general.tsx";
import { PermissionsSettings } from "./permissions/permissions.tsx";
import { ScheduleSettings } from "./ScheduleSettings.tsx";
import { SearchSettings } from "./search-settings.tsx";

/** Each settings page has its own colour and mark. */
/** The one-line lead under a page title (settings-lively.html); pages without one keep theirs. */
const LEADS: Partial<
  Record<
    (typeof SETTINGS_SECTIONS)[number],
    | "settings.lead.general"
    | "settings.lead.models"
    | "settings.lead.computer"
    | "settings.lead.routines"
  >
> = {
  general: "settings.lead.general",
  models: "settings.lead.models",
  computer: "settings.lead.computer",
  routines: "settings.lead.routines",
};
const LOOK: Record<SettingsSectionId, [IconName, Tone]> = {
  general: ["settings", "blue"],
  models: ["key", "violet"],
  permissions: ["shield", "orange"],
  computer: ["hand", "pink"],
  routines: ["clock", "amber"],
  remote: ["phone", "teal"],
  browser: ["globe", "blue"],
};
const pageStyle = (id: SettingsSectionId) =>
  ({
    "--page-c": `var(--avatar-${LOOK[id][1]})`,
    "--accent-fill": `var(--avatar-${LOOK[id][1]})`,
    "--accent-knob": "var(--on-tone)",
    "--accent-ink": `var(--ink-${LOOK[id][1]})`,
  }) as CSSProperties;

export function SettingsScreen({
  section,
  target,
  onClose,
}: {
  section: SettingsSectionId;
  target?: SettingsTarget;
  onClose(): void;
}) {
  const t = useT();
  const titleId = useId();
  const { openSettings } = useNavigation();
  const { dialog, closing, close, trapFocus } = useSettingsDialog(onClose);
  const [dirty, setDirty] = useState(false);
  const [modelsVisited, setModelsVisited] = useState(section === "models");
  return (
    <dialog
      ref={dialog}
      // biome-ignore lint/a11y/noRedundantRoles: Keep the product's explicit dialog accessibility contract.
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={dialogStyles.dialog}
      data-closing={closing || undefined}
      onKeyDown={trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || dirty) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close();
      }}
    >
      <div className={styles.root}>
        <nav className={styles.nav} aria-label={t("settings.title")}>
          <strong className={dialogStyles.navTitle}>{t("settings.title")}</strong>
          {SETTINGS_SECTIONS.map((item) => (
            <Button
              key={item}
              variant="ghost"
              className={dialogStyles.navItem}
              style={pageStyle(item)}
              aria-current={section === item ? "page" : undefined}
              onClick={() => {
                if (item === "models") setModelsVisited(true);
                openSettings(item);
              }}
            >
              <IconTile icon={LOOK[item][0]} tone={LOOK[item][1]} />
              {t(`settings.${item}`)}
            </Button>
          ))}
        </nav>
        <div className={`${styles.main} ${dialogStyles.lively}`} style={pageStyle(section)}>
          {/* The close button lives in this fixed header so it never floats over content. */}
          <header className={styles.header}>
            <h1
              id={titleId}
              tabIndex={-1}
              data-dialog-initial-focus
              className={dialogStyles.heading}
            >
              {t(`settings.${section}`)}
            </h1>
            <CloseButton label={t("setup.close")} onClick={close} />
          </header>
          <div className={styles.scroll} data-settings-scroll>
            <div className={styles.content}>
              {LEADS[section] && <p className={dialogStyles.lead}>{t(LEADS[section])}</p>}
              {section === "general" && <GeneralSettings />}
              {section === "computer" && <ComputerUseSettings />}
              {section === "routines" && <ScheduleSettings />}
              {section === "remote" && <RemoteSettingsPage />}
              {section === "browser" && <BrowserSettings />}
              {section === "permissions" && (
                <PermissionsSettings target={target === "passwords" ? target : undefined} />
              )}
              {(modelsVisited || section === "models") && (
                <div hidden={section !== "models"}>
                  <ModelsSettings
                    active={section === "models"}
                    searchSettings={<SearchSettings />}
                    target={section === "models" && target === "pi-model" ? target : undefined}
                    onDirtyChange={setDirty}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
