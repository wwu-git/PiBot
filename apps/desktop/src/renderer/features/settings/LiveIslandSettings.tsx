import {
  LIVE_ISLAND_KINDS,
  LiveIslandContentSchema,
  type LiveIslandKind,
  type Settings,
} from "@pibot/protocol";
import {
  SettingsLine,
  SettingsRow,
  SettingsSection,
  setupStyles,
  useSettings,
} from "@pibot/renderer-kit";
import { SegmentedControl, Switch } from "@pibot/ui";

/**
 * Settings › General, first section: the always-on-top pill with the busy Bots. Desktop only;
 * where the session cannot keep a window on top (Wayland) the controls stay off and say why.
 */
export function LiveIslandSettings({
  disabled,
  change,
}: {
  disabled: boolean;
  change(patch: Partial<Settings>): void;
}) {
  const { t, settings } = useSettings();
  // No window while rendering statically (tests); the desktop preload always sets it.
  const support =
    (typeof window === "undefined" ? undefined : window.pibot?.liveIsland) ?? "supported";
  const unsupported = support !== "supported";
  const on = !unsupported && (settings?.liveIsland ?? true);
  const off = disabled || !on;
  const kinds = new Set<LiveIslandKind>(settings?.liveIslandKinds ?? LIVE_ISLAND_KINDS);
  const toggle = (kind: LiveIslandKind, checked: boolean) => {
    const next = new Set(kinds);
    if (checked) next.add(kind);
    else next.delete(kind);
    // Keep the fixed order, so the stored list does not depend on the click order.
    change({ liveIslandKinds: LIVE_ISLAND_KINDS.filter((value) => next.has(value)) });
  };
  return (
    <SettingsSection title={t("liveIsland.title")}>
      <SettingsRow
        icon="island"
        tone="violet"
        label={t("liveIsland.show")}
        note={t("liveIsland.showNote")}
      >
        <Switch
          label={t("liveIsland.show")}
          checked={on}
          disabled={disabled || unsupported}
          onCheckedChange={(liveIsland) => change({ liveIsland })}
        />
      </SettingsRow>
      {unsupported && (
        <SettingsLine role="status" tone="warn" dot="warn">
          {t("liveIsland.unsupported")}
        </SettingsLine>
      )}
      <SettingsRow
        icon="island"
        tone="violet"
        label={t("liveIsland.content")}
        note={t("liveIsland.contentNote")}
      >
        <SegmentedControl
          label={t("liveIsland.content")}
          disabled={off}
          value={settings?.liveIslandContent ?? "full"}
          options={LiveIslandContentSchema.options.map((value) => ({
            value,
            label: t(`liveIsland.content.${value}`),
          }))}
          onValueChange={(liveIslandContent) => change({ liveIslandContent })}
        />
      </SettingsRow>
      <SettingsRow
        icon="island"
        tone="violet"
        label={t("liveIsland.kinds")}
        note={t("liveIsland.kindsNote")}
      >
        <fieldset
          aria-label={t("liveIsland.kinds")}
          disabled={off}
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            gap: "8px 18px",
            margin: 0,
            padding: 0,
            border: 0,
            minWidth: 0,
          }}
        >
          {LIVE_ISLAND_KINDS.map((kind) => (
            <label key={kind} className={setupStyles.check}>
              <input
                type="checkbox"
                checked={kinds.has(kind)}
                onChange={(event) => toggle(kind, event.currentTarget.checked)}
              />
              {t(`liveIsland.kind.${kind}`)}
            </label>
          ))}
        </fieldset>
      </SettingsRow>
    </SettingsSection>
  );
}
