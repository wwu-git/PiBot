import type { Connector, ConnectorTool } from "@pibot/plugins-contract/full";
import { SettingsLine, SettingsRow, SettingsSection, useSettings } from "@pibot/renderer-kit";
import { Chip, SegmentedControl, Switch } from "@pibot/ui";
import { type ReactNode, useState } from "react";
import type { useConnectorPage } from "../../shell/remote.ts";
import { ConnectorFeedback, ConnectorPagination } from "../ConnectorFeedback.tsx";
import styles from "../connections/drawer.module.css";
import { sharedToolPrefix, toolDescription, toolTitle } from "../connections/local-text.ts";

type ToolPage = ReturnType<typeof useConnectorPage<ConnectorTool>>;
type ToolPatch = { tool: string; enabled: boolean; readOnly: boolean };
// A long list folds after four rows, so 修改 stays in view under a long 查看 list.
const SHOWN = 4;

/** The labels people read for this connection's tools, shared by every tab. */
export function useToolLabels(product: string, tools: readonly Pick<ConnectorTool, "tool">[] = []) {
  const { t, language } = useSettings();
  const products = [product, sharedToolPrefix(tools.map((tool) => tool.tool))];
  return {
    title: (tool: Pick<ConnectorTool, "tool" | "title">) => toolTitle(tool, language, t, products),
    description: (tool: ConnectorTool) => toolDescription(tool, language),
  };
}

/** 能做什么: 查看 and 修改, one switch per tool and the confirmation each change asks for. */
export function ToolsTab({
  tools,
  connector,
  product,
  disabled,
  note,
  save,
}: {
  tools: ToolPage;
  connector: Connector;
  product: string;
  disabled: boolean;
  note?: ReactNode;
  save(patch: ToolPatch): void;
}) {
  const { t } = useSettings();
  const items = tools.value?.items ?? [];
  const labels = useToolLabels(product, items);
  const read = items.filter((tool) => tool.readOnly);
  const write = items.filter((tool) => !tool.readOnly);
  const mode = connector.confirmationMode;
  const chip = (tool: ConnectorTool) => {
    if (!tool.enabled) return undefined;
    if (!tool.readOnly && mode === "read_only")
      return <Chip>{t("connections.drawer.chipOff")}</Chip>;
    if (!tool.readOnly && mode === "direct_read_write")
      return <Chip tone="ok">{t("connections.drawer.chipDirect")}</Chip>;
    if (!tool.readOnly || mode === "always_ask")
      return <Chip tone="orange">{t("connections.drawer.chipAsk")}</Chip>;
    return undefined;
  };
  const row = (tool: ConnectorTool) => {
    const name = labels.title(tool);
    const description = labels.description(tool);
    return (
      <SettingsRow
        key={`${tool.catalogVersion}:${tool.tool}`}
        icon={tool.readOnly ? "eye" : "edit"}
        tone={!tool.enabled ? "neutral" : tool.readOnly ? "blue" : "orange"}
        label={name}
        note={description.length > 160 ? `${description.slice(0, 157)}…` : description}
      >
        {chip(tool)}
        <Switch
          checked={tool.enabled}
          label={t("connections.drawer.toolSwitch", { name })}
          disabled={disabled || tools.loading || !!tools.error}
          onCheckedChange={(enabled) => save({ tool: tool.tool, enabled, readOnly: tool.readOnly })}
        />
      </SettingsRow>
    );
  };
  return (
    <>
      {note}
      {read.length > 0 && (
        <ToolGroup title={t("connections.drawer.readCount", { count: read.length })}>
          {read.map(row)}
        </ToolGroup>
      )}
      {write.length > 0 && (
        <ToolGroup title={t("connections.drawer.writeCount", { count: write.length })}>
          {write.map(row)}
        </ToolGroup>
      )}
      {!tools.loading && !tools.error && !items.length && (
        <SettingsLine>{t("connections.drawer.noTools")}</SettingsLine>
      )}
      <ConnectorFeedback loading={tools.loading} error={tools.error} retry={tools.refresh} />
      <ConnectorPagination
        previous={tools.previous}
        next={tools.next}
        disabled={tools.loading || disabled}
      />
    </>
  );
}

function ToolGroup({ title, children }: { title: string; children: ReactNode[] }) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const hidden = children.length - SHOWN;
  return (
    <SettingsSection title={title}>
      {open || hidden <= 0 ? children : children.slice(0, SHOWN)}
      {hidden > 0 && (
        <button
          type="button"
          className={styles.more}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("connections.drawer.less") : t("connections.drawer.more", { count: hidden })}
          {open ? "" : " ›"}
        </button>
      )}
    </SettingsSection>
  );
}

/**
 * 按工具调整归类 (高级): read (done directly), change (asks first) or off, per tool. The person's
 * own classification wins over what the server declared.
 */
export function ToolKindRows({
  tools,
  product,
  disabled,
  save,
}: {
  tools: ToolPage;
  product: string;
  disabled: boolean;
  save(patch: ToolPatch): void;
}) {
  const { t } = useSettings();
  const labels = useToolLabels(product, tools.value?.items);
  return (
    <>
      {tools.value?.items.map((tool) => {
        const label = labels.title(tool);
        const mode = !tool.enabled ? "disabled" : tool.readOnly ? "read_only" : "confirm_write";
        return (
          <SettingsRow
            key={`${tool.catalogVersion}:${tool.tool}`}
            label={label}
            note={
              tool.readOnlyLocked
                ? t("connectors.toolMode.readOnlyLocked")
                : tool.suggestedReadOnly
                  ? t("connectors.suggested")
                  : undefined
            }
          >
            <SegmentedControl
              label={t("connectors.toolModeFor", { name: label })}
              disabled={disabled || tools.loading || !!tools.error}
              value={mode}
              options={[
                {
                  value: "read_only",
                  label: t("connectors.toolMode.readOnly"),
                  disabled: tool.readOnlyLocked,
                },
                { value: "confirm_write", label: t("connectors.toolMode.confirmWrite") },
                { value: "disabled", label: t("connectors.toolMode.disabled") },
              ]}
              onValueChange={(next) =>
                save({
                  tool: tool.tool,
                  enabled: next !== "disabled",
                  readOnly: next === "read_only",
                })
              }
            />
          </SettingsRow>
        );
      })}
    </>
  );
}
