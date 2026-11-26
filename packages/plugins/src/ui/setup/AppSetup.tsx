import {
  type BuiltinApp,
  type Connector,
  newConnectionDefaults,
} from "@pibot/plugins-contract/full";
import {
  SettingsFold,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useSettings,
} from "@pibot/renderer-kit";
import { Button, Chip, Icon, IconTile, SegmentedControl } from "@pibot/ui";
import { useId, useState } from "react";
import { ConnectorPanel } from "../page/ConnectorPanel.tsx";
import { DrawerField, DrawerHero, SecretInput } from "../page/connections/DrawerParts.tsx";
import styles from "../page/connections/drawer.module.css";
import { guideLinkKey } from "../page/connections/local-text.ts";
import { useConnectorAction } from "../shell/remote.ts";

/**
 * The connect drawer for a built-in app (本机日历, 本机通讯录, …), in the same layout as an
 * imported one. The trusted app catalog supplies modes, platform notes and help; tokens stay in
 * this local form.
 */
export function AppSetup({
  app,
  close,
  changed,
  connected,
}: {
  app: BuiltinApp;
  close(): void;
  changed(): void;
  connected(connector: Connector): void;
}) {
  const { t, language } = useSettings();
  const inputId = useId();
  const [modeId, setModeId] = useState(app.modes[0]?.id);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const mode = app.modes.find((row) => row.id === modeId);
  const gmailPassword = app.id === "gmail" && modeId === "app-password";
  const incomplete =
    (mode?.auth === "bearer" && !token.trim()) ||
    (gmailPassword &&
      (!/^[^\s@]+@[^\s@]+$/.test(email.trim()) ||
        !/^[A-Za-z0-9]{16}$/.test(token.replace(/ /g, ""))));
  const action = useConnectorAction(changed);
  const connect = async () => {
    if (!mode || !app.supported || incomplete) return;
    const submitted = gmailPassword ? token.replace(/ /g, "") : token.trim();
    setToken("");
    // The host may wait 630 seconds for native consent; both UI deadlines must outlive it.
    const timeoutMs = 660_000;
    const result = await action.run(async (peer, signal) => {
      return await peer.call(
        "apps.connect",
        {
          appId: app.id,
          mode: mode.id,
          // OAuth apps are started before the host's user-only authorize path invokes their
          // fixed oauthStartTool; this keeps the setup button a single action.
          // OAuth is enabled by the user-only authorize path below, after installation.
          enable: true,
          ...(submitted ? { token: submitted } : {}),
          ...(gmailPassword ? { email: email.trim() } : {}),
        },
        { signal, timeoutMs },
      );
    }, timeoutMs);
    if (result?.connectors[0]) connected(result.connectors[0]);
  };
  const local = app.category === "local";
  // Widened on purpose: the rows follow whatever the default becomes.
  const confirmation = newConnectionDefaults.confirmationMode as Connector["confirmationMode"];
  const name = app.name[language];
  return (
    <ConnectorPanel
      title={t("connections.drawer.connectTitle", { name })}
      close={close}
      busy={action.busy}
      footer={
        <>
          <Button variant="secondary" disabled={action.busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={action.busy}
            disabled={action.disabled || !app.supported || !mode || incomplete}
            onClick={() => void connect()}
          >
            {t("connections.drawer.connect")}
          </Button>
        </>
      }
    >
      <div className={styles.drawer}>
        <DrawerHero
          name={name}
          note={app.description[language]}
          chips={
            <>
              <Chip>{t("connections.drawer.chip.builtin")}</Chip>
              <Chip>
                {t(local ? "connections.drawer.chip.local" : "connections.drawer.chip.remote")}
              </Chip>
            </>
          }
        />
        {!app.supported && (
          <SettingsLine tone="danger" dot="danger" role="alert">
            {t("connectors.appUnsupported")}
          </SettingsLine>
        )}
        {mode && (
          <SettingsSection title={t("connections.drawer.prep")}>
            <div className={styles.prep}>
              <IconTile icon="file" tone="amber" size="lg" />
              <div className={styles.prepText}>
                <span>{mode.help[language]}</span>
                <a
                  className={styles.link}
                  href={mode.documentationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t(guideLinkKey(name), { name })}
                  <Icon name="link" size={13} />
                </a>
              </div>
            </div>
          </SettingsSection>
        )}
        {(app.modes.length > 1 || mode?.auth === "bearer" || gmailPassword) && (
          <SettingsSection title={t("connections.drawer.fill")}>
            {app.modes.length > 1 && (
              <SettingsRow label={t("connectors.connectionMode")} stacked>
                <SegmentedControl
                  label={t("connectors.connectionMode")}
                  value={modeId ?? ""}
                  options={app.modes.map((item) => ({
                    value: item.id,
                    label: item.capability[language],
                  }))}
                  disabled={action.disabled}
                  onValueChange={(value) => {
                    setModeId(value);
                    setToken("");
                  }}
                />
              </SettingsRow>
            )}
            {gmailPassword && (
              <DrawerField id={`${inputId}-email`} label={t("connectors.gmailEmail")} icon="user">
                <input
                  id={`${inputId}-email`}
                  type="email"
                  value={email}
                  maxLength={320}
                  autoComplete="email"
                  disabled={action.disabled}
                  onChange={(event) => setEmail(event.currentTarget.value)}
                />
              </DrawerField>
            )}
            {mode?.auth === "bearer" && (
              <DrawerField
                id={`${inputId}-token`}
                label={t(gmailPassword ? "connectors.gmailAppPassword" : "connectors.appToken")}
                required
                secret
              >
                <SecretInput
                  id={`${inputId}-token`}
                  label={t(gmailPassword ? "connectors.gmailAppPassword" : "connectors.appToken")}
                  value={token}
                  disabled={action.disabled}
                  onChange={setToken}
                />
              </DrawerField>
            )}
          </SettingsSection>
        )}
        {mode?.auth === "oauth" && <SettingsLine>{t("connectors.oauthNote")}</SettingsLine>}
        <SettingsSection title={t("connections.drawer.can")}>
          <SettingsRow
            icon="eye"
            tone="blue"
            label={t("connections.drawer.read")}
            note={t("connections.drawer.readFree")}
          >
            <Chip>{t("connections.drawer.chipDirect")}</Chip>
          </SettingsRow>
          <SettingsRow
            icon="edit"
            tone="orange"
            label={t("connections.drawer.write")}
            note={t(
              confirmation === "read_only"
                ? "connections.drawer.writeOff"
                : "connections.drawer.writeAsk",
            )}
          >
            <Chip tone="orange">{t("connections.drawer.chipAsk")}</Chip>
          </SettingsRow>
        </SettingsSection>
        <SettingsFold
          title={t("connections.drawer.tech")}
          summary={t("connections.drawer.techSummary")}
          icon="server"
          tone="neutral"
        >
          <SettingsRow
            icon="terminal"
            tone="teal"
            label={t("connections.drawer.run")}
            note={[
              t(local ? "connections.drawer.run.builtin" : "connections.drawer.chip.remote"),
              mode?.capability[language],
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          {local && (
            <SettingsRow
              icon="globe"
              tone="blue"
              label={t("connections.drawer.sites")}
              note={t("connections.drawer.sitesNone")}
            />
          )}
          <SettingsRow
            icon="key"
            tone="pink"
            label={t("connections.drawer.secrets")}
            note={
              mode?.auth === "bearer"
                ? t("connections.drawer.secretsCount", {
                    count: 1,
                    names: t(gmailPassword ? "connectors.gmailAppPassword" : "connectors.appToken"),
                  })
                : t("connections.drawer.secretsNone")
            }
          />
          <SettingsRow
            icon="shield"
            tone="green"
            label={t("connections.drawer.source")}
            note={t("connections.drawer.chip.builtin")}
          />
        </SettingsFold>
        {action.error && (
          <SettingsLine tone="danger" dot="danger" role="alert">
            {t(action.error)}
          </SettingsLine>
        )}
      </div>
    </ConnectorPanel>
  );
}
