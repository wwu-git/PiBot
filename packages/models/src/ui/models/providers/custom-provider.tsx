import { ApiSchema, ImageApiSchema, type Provider } from "@pibot/models-contract/full";
import { AppSelect, setupStyles as styles, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, Switch, TextField } from "@pibot/ui";
import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import modelStyles from "../models.module.css";
import { CustomImageModels } from "../selection/custom-image-models.tsx";
import { CustomModels } from "../selection/custom-models.tsx";
import { customPresets } from "./custom-presets.ts";
import detailStyles from "./provider-detail.module.css";
import type { Task } from "./provider-form.tsx";
import { useCustomProvider } from "./use-custom-provider.ts";

export function CustomProviderForm({
  provider,
  testModelId,
  task,
  refresh,
  onDirtyChange,
  addModelIds,
}: {
  provider: Provider;
  testModelId?: string;
  addModelIds?: string[];
  task: Task;
  refresh(): Promise<void>;
  onDirtyChange?(dirty: boolean): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const editor = useCustomProvider(provider, task, refresh, testModelId, addModelIds);
  const { form, saved, setField } = editor;
  const preset = customPresets[provider.id];
  const [customAddress, setCustomAddress] = useState(false);
  useEffect(() => {
    onDirtyChange?.(editor.dirty);
  }, [editor.dirty, onDirtyChange]);
  // Maintainers 2026-11-13: non-secret fields save at once — choices on change, text on blur / Enter.
  // The save runs after the render that holds the new value, so it reads the edited form.
  const [commits, setCommits] = useState(0);
  const commit = () => setCommits((value) => value + 1);
  const [autosaved, setAutosaved] = useState<"saved" | "failed">();
  const autosave = useRef(editor.autosave);
  autosave.current = editor.autosave;
  useEffect(() => {
    if (!commits) return;
    let active = true;
    void autosave.current().then(
      (done) => {
        if (active && done) setAutosaved("saved");
      },
      () => {
        if (active) setAutosaved("failed");
      },
    );
    return () => {
      active = false;
    };
  }, [commits]);
  useEffect(() => {
    if (autosaved !== "saved") return;
    const timer = setTimeout(() => setAutosaved(undefined), 2500);
    return () => clearTimeout(timer);
  }, [autosaved]);
  const commitOnLeave = (event: FocusEvent<HTMLFieldSetElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit();
  };
  const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    // Enter commits the field instead of submitting the credential form.
    event.preventDefault();
    event.currentTarget.blur();
  };
  return (
    <form
      className={styles.stack}
      onSubmit={(event) => {
        event.preventDefault();
        void task.run(editor.save);
      }}
    >
      {saved && <p className={styles.note}>{t("setup.custom.editNote")}</p>}
      {editor.loading && <p role="status">{t("setup.loading")}</p>}
      {editor.loadError && (
        <div role="alert" className={styles.error}>
          {t("setup.failed")}
          <Button variant="secondary" onClick={editor.retry}>
            {t("setup.retry")}
          </Button>
        </div>
      )}
      <fieldset
        disabled={task.busy || !peer || editor.loading || editor.loadError}
        className={styles.stack}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <div className={detailStyles.formPair}>
          <TextField
            label={t("models.custom.name")}
            value={form.name}
            required
            onChange={(event) => setField("name", event.target.value)}
            onBlur={commit}
            onKeyDown={blurOnEnter}
          />
          <AppSelect
            label={t("models.custom.api")}
            value={form.api}
            change={(value) => {
              setField("api", ApiSchema.parse(value));
              commit();
            }}
            options={ApiSchema.options.map((value) => ({
              value,
              label: t(`models.custom.api.${value}`),
            }))}
          />
        </div>
        {preset && Object.keys(preset.urls).length > 1 && (
          <AppSelect
            label={t("models.region")}
            value={
              customAddress
                ? "custom"
                : (Object.entries(preset.urls).find(([, url]) => url === form.baseUrl)?.[0] ??
                  "custom")
            }
            change={(region) => {
              if (region === "custom") {
                setCustomAddress(true);
                return;
              }
              const url = preset.urls[region];
              if (url) {
                setCustomAddress(false);
                setField("baseUrl", url);
                setField("key", "");
                setField("models", []);
                commit();
              }
            }}
            options={[
              ...Object.keys(preset.urls).map((value) => ({
                value,
                label: t(value === "china" ? "models.region.china" : "models.region.global"),
              })),
              { value: "custom", label: t("models.region.custom") },
            ]}
          />
        )}
        <TextField
          label={t("models.custom.baseUrl")}
          description={t("models.custom.baseUrlHint")}
          value={form.baseUrl}
          type="url"
          required
          onChange={(event) => {
            setCustomAddress(true);
            setField("baseUrl", event.target.value);
          }}
          onBlur={commit}
          onKeyDown={blurOnEnter}
        />
        <TextField
          label={t(preset && provider.id.endsWith("-api") ? "models.apiKey" : "models.custom.key")}
          required={!!preset && provider.id.endsWith("-api") && !saved?.hasApiKey}
          type="password"
          autoComplete="new-password"
          disabled={task.blocked}
          value={form.key}
          description={saved?.hasApiKey ? t("setup.keyUnchanged") : undefined}
          onChange={(event) => setField("key", event.target.value)}
        />
        {saved && !!saved.headerNames.length && (
          <p className={styles.note}>
            {t("setup.savedHeaders", { names: saved.headerNames.join(", ") })}
          </p>
        )}
        {saved?.hasHeaders && !saved.headerNames.length && (
          <p className={styles.note}>{t("setup.savedHeadersWithoutNames")}</p>
        )}
        <p className={styles.note}>{t("setup.headersNote")}</p>
        {(saved?.hasHeaders || !!saved?.headerNames.length) && (
          <p className={styles.note}>{t("setup.replaceHeaders")}</p>
        )}
        {form.headers.map((header) => (
          <div key={header.rowId} className={detailStyles.formPair}>
            <TextField
              label={t("models.custom.headerName")}
              value={header.name}
              required
              disabled={task.blocked}
              onChange={(event) => editor.changeHeader(header.rowId, { name: event.target.value })}
            />
            <TextField
              label={t("models.custom.headerValue")}
              type="password"
              autoComplete="new-password"
              value={header.value}
              disabled={task.blocked}
              onChange={(event) => editor.changeHeader(header.rowId, { value: event.target.value })}
            />
            <Button
              variant="ghost"
              onClick={() =>
                setField(
                  "headers",
                  form.headers.filter((row) => row.rowId !== header.rowId),
                )
              }
            >
              {t("setup.headerRemove")}
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          disabled={task.blocked}
          onClick={() =>
            setField("headers", [
              ...form.headers,
              { rowId: crypto.randomUUID(), name: "", value: "" },
            ])
          }
        >
          {t("models.custom.addHeader")}
        </Button>
        {/* Clearing headers removes a credential, so it waits for the explicit save. */}
        <div className={detailStyles.switchRow}>
          <span>{t("setup.clearHeaders")}</span>
          <Switch
            label={t("setup.clearHeaders")}
            checked={form.clearHeaders}
            disabled={task.blocked}
            onCheckedChange={(checked) => setField("clearHeaders", checked)}
          />
        </div>
        <AppSelect
          label={t("media.imageApi")}
          value={form.imageApi}
          change={(value) => {
            setField("imageApi", value === "none" ? "none" : ImageApiSchema.parse(value));
            commit();
          }}
          options={["none", ...ImageApiSchema.options].map((value) => ({
            value,
            label: t(
              `media.imageApi.${value as "none" | "openai-images" | "google-images" | "openrouter-images"}`,
            ),
          }))}
        />
        {form.imageApi !== "none" && (
          <fieldset className={detailStyles.plain} onBlur={commitOnLeave}>
            <CustomImageModels
              models={form.imageModels}
              change={(models) => setField("imageModels", models)}
            />
          </fieldset>
        )}
        <div className={modelStyles.sectionHeading}>
          <strong>{t("models.custom.selectModels")}</strong>
          <Button
            variant="secondary"
            disabled={form.imageApi !== "none" && !form.models.length}
            onClick={() => void task.run(editor.fetchModels)}
          >
            {t("models.custom.fetchModels")}
          </Button>
        </div>
        <fieldset className={detailStyles.plain} onBlur={commitOnLeave}>
          <CustomModels
            models={form.models}
            onChange={(models) => {
              setField("models", models);
              commit();
            }}
            onPatch={(rowId, patch) => {
              editor.changeModel(rowId, patch);
              // Ticks and switches apply at once; typed ids and limits apply on leaving the list.
              if (
                typeof patch.selected === "boolean" ||
                typeof patch.images === "boolean" ||
                typeof patch.reasoning === "boolean"
              )
                commit();
            }}
          />
        </fieldset>
        {editor.capabilitiesError && (
          <p role="alert" className={styles.error}>
            {t("models.custom.resolveError")}
            <Button variant="secondary" onClick={editor.retryCapabilities}>
              {t("setup.retry")}
            </Button>
          </p>
        )}
        <details>
          <summary>{t("models.custom.compat")}</summary>
          <div className={detailStyles.switchCard}>
            {(
              [
                ["supportsDeveloperRole", "models.custom.systemRole"],
                ["supportsReasoningEffort", "models.custom.noThinking"],
              ] as const
            ).map(([name, label]) => (
              <div key={name} className={detailStyles.switchRow}>
                <span>{t(label)}</span>
                <Switch
                  label={t(label)}
                  checked={form.compat[name] === false}
                  onCheckedChange={(checked) => {
                    editor.setCompat(name, checked);
                    commit();
                  }}
                />
              </div>
            ))}
          </div>
        </details>
        {autosaved && (
          <p role="status" className={styles.note}>
            {autosaved === "saved" ? <Chip tone="ok">{t("setup.saved")}</Chip> : t("setup.failed")}
          </p>
        )}
        <Button
          type="submit"
          disabled={
            editor.credentialBlocked ||
            (!form.models.some((model) => model.selected) &&
              (form.imageApi === "none" || !form.imageModels.length))
          }
        >
          {t(
            form.models.some((model) => model.selected)
              ? "models.saveAndTest"
              : form.imageApi !== "none" && form.imageModels.length
                ? "media.saveImages"
                : "common.save",
          )}
        </Button>
      </fieldset>
    </form>
  );
}
