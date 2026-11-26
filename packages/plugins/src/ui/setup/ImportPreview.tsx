import {
  type Connector,
  type ConnectorAccess,
  type MethodResults,
  newConnectionDefaults,
} from "@pibot/plugins-contract/full";
import {
  hostPlatform,
  SettingsFold,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useSettings,
} from "@pibot/renderer-kit";
import { Chip, Icon, IconTile, Switch } from "@pibot/ui";
import { useId } from "react";
import { ConnectorAccessEditor } from "../page/ConnectorAccessEditor.tsx";
import { DrawerField, DrawerHero, SecretInput } from "../page/connections/DrawerParts.tsx";
import styles from "../page/connections/drawer.module.css";
import { guideLinkKey, localText } from "../page/connections/local-text.ts";

type Preview = MethodResults["plugins.previewImport"];
type ConfigValue = string | number | boolean;
type ConfigField = NonNullable<Preview["plugin"]>["config"][number];

// Keep only reviewable, sanitized metadata, never a second copy of raw JSON or headers/env values.
export function previewSummary(value: Preview) {
  return {
    previewId: value.previewId,
    digest: value.digest,
    expiresAt: value.expiresAt,
    declaredVersion: value.declaredVersion,
    name: value.manifest.name,
    description: value.manifest.description,
    plugin: value.plugin,
    commandWarnings: value.commandWarnings,
    servers: value.manifest.servers.map((server) => ({
      id: server.id,
      transport: server.transport,
      auth: server.auth.kind,
      secrets: server.auth.secretNames,
      domains: server.networkDomains,
      cwd: server.transport === "stdio" ? server.cwd : undefined,
      startupTimeoutSec: server.startupTimeoutSec,
      command: server.transport === "stdio" ? server.command : undefined,
      url: server.transport === "http" ? server.url : undefined,
      bundledNode:
        !!value.plugin &&
        server.transport === "stdio" &&
        (server.command === "node" || server.command === "node.exe"),
    })),
  };
}
export type PreviewSummary = ReturnType<typeof previewSummary>;

/** Whether a field is shown under the current values (`visibleWhen`). */
export function fieldVisible(
  field: ConfigField,
  fields: readonly ConfigField[],
  config: Record<string, ConfigValue>,
) {
  if (!field.visibleWhen) return true;
  const controlling = fields.find((candidate) => candidate.key === field.visibleWhen?.key);
  return (config[field.visibleWhen.key] ?? controlling?.default) === field.visibleWhen.equals;
}

/** The program name only; arguments can carry paths and are not something to read here. */
function commandName(command: string) {
  return command.split(/[\\/]/).at(-1) ?? command;
}

/**
 * The connect drawer's body for an imported package or MCP configuration: what it is, what to
 * prepare, the settings to fill, what it can do, and the technical details folded away.
 */
export function ImportPreview({
  preview,
  config,
  setValue,
  disabled,
  checking,
  settingsError,
  targets,
  setTargets,
}: {
  preview: PreviewSummary;
  config: Record<string, ConfigValue>;
  setValue(key: string, value: ConfigValue): void;
  disabled: boolean;
  checking: boolean;
  settingsError?: string;
  targets: ConnectorAccess;
  setTargets(access: ConnectorAccess): void;
}) {
  const { t, language } = useSettings();
  const inputId = useId();
  const card = preview.plugin?.application;
  const name = card?.name[language] || localText(preview.name[language], language);
  const mode = card?.modes[0];
  const help = mode?.help[language];
  const fields = preview.plugin?.config ?? [];
  const local = preview.servers.some((server) => server.transport === "stdio");
  // Widened on purpose: the rows follow whatever the default becomes.
  const confirmation = newConnectionDefaults.confirmationMode as Connector["confirmationMode"];
  // Imported secrets are stored as IMPORT_<installation>_<setting>; people read the setting's title.
  const titleOf = (name: string) => {
    const field = fields.find(
      (candidate) => candidate.key === name || name.endsWith(`_${candidate.key}`),
    );
    return field ? localText(field.title, language) : name.replace(/^IMPORT_[0-9A-F]+_/, "");
  };
  const secretNames = [...new Set(preview.servers.flatMap((server) => server.secrets))];
  const sites = [...new Set(preview.servers.flatMap((server) => server.domains))];
  const skipped = (preview.plugin?.components ?? []).filter(
    (component) => component.status === "unsupported",
  );
  const sandbox = t(
    hostPlatform() === "win32"
      ? "connections.drawer.run.unsandboxed"
      : "connections.drawer.run.sandboxed",
  );
  const runs = preview.servers.map((server) => {
    const base =
      server.transport === "http"
        ? t("connections.drawer.run.remote", { url: server.url ?? "" })
        : server.transport === "stdio"
          ? `${
              server.bundledNode
                ? t("connections.drawer.run.node")
                : t("connections.drawer.run.command", {
                    command: commandName(server.command ?? ""),
                  })
            }${sandbox}`
          : t("connections.drawer.run.builtin");
    const extras = [
      server.cwd && t("connectors.startup.cwd", { cwd: server.cwd }),
      server.startupTimeoutSec &&
        t("connectors.startup.timeout", { seconds: String(server.startupTimeoutSec) }),
    ].filter(Boolean);
    const detail = [base, ...extras].join(language === "zh" ? "；" : "; ");
    return preview.servers.length > 1
      ? t("connections.drawer.run.extra", { id: server.id, detail })
      : detail;
  });
  const field = (item: ConfigField) => {
    if (!fieldVisible(item, fields, config)) return null;
    const id = `${inputId}-${item.key}`;
    const label = localText(item.title, language);
    const value = config[item.key] ?? "";
    const note = item.description && item.description !== item.key ? item.description : "";
    const help = localText(
      note || (item.sensitive ? t("connectors.generatedSecret") : t("connectors.generatedSetting")),
      language,
    );
    if (item.type === "boolean")
      return (
        <SettingsRow key={item.key} label={label} note={help}>
          <Switch
            id={id}
            label={label}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => setValue(item.key, checked)}
          />
        </SettingsRow>
      );
    return (
      <DrawerField
        key={item.key}
        id={id}
        label={label}
        required={item.required}
        secret={item.sensitive}
        note={help}
        icon={item.sensitive ? "key" : item.type === "directory" ? "folder" : undefined}
      >
        {item.options?.length ? (
          <select
            id={id}
            value={String(value)}
            required={item.required}
            disabled={disabled}
            onChange={(event) => {
              const selected = item.options?.find(
                (option) => String(option.value) === event.currentTarget.value,
              );
              if (selected) setValue(item.key, selected.value);
            }}
          >
            {item.options.map((option) => (
              <option key={String(option.value)} value={String(option.value)}>
                {localText(option.label, language)}
              </option>
            ))}
          </select>
        ) : item.sensitive ? (
          <SecretInput
            id={id}
            label={label}
            value={String(value)}
            disabled={disabled}
            onChange={(next) => setValue(item.key, next)}
          />
        ) : (
          <input
            id={id}
            type={item.type === "number" ? "number" : "text"}
            value={String(value)}
            required={item.required}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              setValue(item.key, item.type === "number" && raw !== "" ? Number(raw) : raw);
            }}
          />
        )}
      </DrawerField>
    );
  };
  return (
    <div className={styles.drawer}>
      <DrawerHero
        name={name}
        note={card?.description[language] || localText(preview.description[language], language)}
        chips={
          <>
            <Chip>
              {preview.plugin
                ? preview.declaredVersion
                  ? t("connections.drawer.chip.plugin", { version: preview.declaredVersion })
                  : t("connections.drawer.chip.pluginNoVersion")
                : t("connections.drawer.chip.mcp")}
            </Chip>
            {preview.servers.length > 0 && (
              <Chip>
                {t(local ? "connections.drawer.chip.local" : "connections.drawer.chip.remote")}
              </Chip>
            )}
          </>
        }
      />
      {(!!preview.commandWarnings?.length || (hostPlatform() === "win32" && local)) && (
        <div className={styles.lines}>
          {preview.commandWarnings?.map((risk) => (
            <SettingsLine
              key={risk}
              tone={risk === "dangerous" ? "danger" : undefined}
              dot={risk === "dangerous" ? "danger" : "warn"}
              role="alert"
            >
              {t(
                risk === "dangerous"
                  ? "connectors.commandDangerous"
                  : "connectors.commandUnverified",
              )}
            </SettingsLine>
          ))}
          {hostPlatform() === "win32" && local && (
            <SettingsLine dot="warn" role="alert">
              {t("connectors.windowsWarning")}
            </SettingsLine>
          )}
        </div>
      )}
      {help && (
        <SettingsSection title={t("connections.drawer.prep")}>
          <div className={styles.prep}>
            <IconTile icon="file" tone="amber" size="lg" />
            <div className={styles.prepText}>
              <span>{help}</span>
              {mode?.documentationUrl && (
                <a
                  className={styles.link}
                  href={mode.documentationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t(guideLinkKey(name), { name })}
                  <Icon name="link" size={13} />
                </a>
              )}
            </div>
          </div>
        </SettingsSection>
      )}
      {fields.length > 0 && (
        <SettingsSection
          title={t("connections.drawer.fill")}
          action={
            checking ? (
              <small className={styles.fieldNote} role="status">
                {t("connections.drawer.checking")}
              </small>
            ) : undefined
          }
        >
          {fields.map(field)}
          {settingsError && (
            <SettingsLine tone="danger" dot="danger" role="alert">
              {settingsError}
            </SettingsLine>
          )}
        </SettingsSection>
      )}
      {preview.servers.length > 0 && (
        <SettingsSection
          title={t("connections.drawer.can")}
          action={<small className={styles.fieldNote}>{t("connections.drawer.canLater")}</small>}
        >
          <SettingsRow
            icon="eye"
            tone="blue"
            label={t("connections.drawer.read")}
            note={t("connections.drawer.readFree")}
          >
            <Chip tone={confirmation === "always_ask" ? "orange" : "neutral"}>
              {t(
                confirmation === "always_ask"
                  ? "connections.drawer.chipAsk"
                  : "connections.drawer.chipDirect",
              )}
            </Chip>
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
            <Chip tone={confirmation === "read_only" ? "neutral" : "orange"}>
              {t(
                confirmation === "read_only"
                  ? "connections.drawer.chipOff"
                  : "connections.drawer.chipAsk",
              )}
            </Chip>
          </SettingsRow>
          <SettingsLine>
            {t("connections.drawer.accessDefault", {
              access: t(`connectors.access.${newConnectionDefaults.accessMode}`),
            })}
          </SettingsLine>
        </SettingsSection>
      )}
      {!!preview.plugin?.skillCount && (
        <>
          {!preview.servers.length && (
            <SettingsSection title={t("connections.drawer.can")}>
              <SettingsRow
                icon="puzzle"
                tone="violet"
                label={t("connections.drawer.skills", { count: preview.plugin.skillCount })}
                note={preview.plugin.components
                  .filter(
                    (component) => component.kind === "skill" && component.status === "import",
                  )
                  .map((component) => localText(component.name, language))
                  .join(language === "zh" ? "、" : ", ")}
              />
            </SettingsSection>
          )}
          <ConnectorAccessEditor access={targets} disabled={disabled} save={setTargets} />
          {!targets.bots.length && !targets.groups.length && (
            <p className={styles.fieldNote}>{t("connectors.skillTargetRequired")}</p>
          )}
        </>
      )}
      <SettingsFold
        title={t("connections.drawer.tech")}
        summary={t("connections.drawer.techSummary")}
        icon="server"
        tone="neutral"
      >
        {preview.servers.length > 0 && (
          <SettingsRow
            icon="terminal"
            tone="teal"
            label={t("connections.drawer.run")}
            note={runs.join(" · ")}
          />
        )}
        {preview.servers.length > 0 && (
          <SettingsRow
            icon="globe"
            tone="blue"
            label={t("connections.drawer.sites")}
            note={t(sites.length ? "connections.drawer.sitesNote" : "connections.drawer.sitesNone")}
          >
            {sites.length > 0 && (
              <span className={styles.siteChips}>
                {sites.map((site) => (
                  <Chip key={site} className={styles.mono}>
                    {site}
                  </Chip>
                ))}
              </span>
            )}
          </SettingsRow>
        )}
        {preview.servers.length > 0 && (
          <SettingsRow
            icon="key"
            tone="pink"
            label={t("connections.drawer.secrets")}
            note={
              secretNames.length
                ? t("connections.drawer.secretsCount", {
                    count: secretNames.length,
                    names: secretNames.map(titleOf).join(language === "zh" ? "、" : ", "),
                  })
                : t("connections.drawer.secretsNone")
            }
          />
        )}
        {skipped.length > 0 && (
          <SettingsRow
            icon="warning"
            tone="amber"
            label={t("connections.drawer.skipped")}
            note={skipped
              .map((component) =>
                component.reason
                  ? `${component.name} · ${t(`connectors.unsupported.${component.reason}`)}`
                  : component.name,
              )
              .join(language === "zh" ? "；" : "; ")}
          />
        )}
        <SettingsRow
          icon="shield"
          tone="green"
          label={t("connections.drawer.source")}
          note={
            <span className={styles.mono}>
              {t(
                preview.plugin
                  ? "connections.drawer.source.plugin"
                  : "connections.drawer.source.json",
                { digest: preview.digest.slice(0, 8) },
              )}
            </span>
          }
        />
      </SettingsFold>
    </div>
  );
}
