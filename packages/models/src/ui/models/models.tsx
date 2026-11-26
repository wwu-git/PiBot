// Coordinates model selection and provider management in Settings.
import { readMainBot } from "@pibot/client-core";
import {
  type Bot,
  MAGPIE_PROVIDER,
  type ModelInfo,
  type Provider,
} from "@pibot/models-contract/full";
import {
  SettingsBack,
  setupStyles as styles,
  useRpc,
  useRpcEvent,
  useT,
  useTask,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { ReactNode } from "react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { providerIdentity, requirePeer } from "../setup/operations.ts";
import modelStyles from "./models.module.css";
import { AddedModels } from "./providers/AddedModels.tsx";
import { MagpieDiscovery } from "./providers/magpie.tsx";
import { useMagpieDetection } from "./providers/magpie-detection.ts";
import { useNewModels } from "./providers/new-models.ts";
import { ProviderCatalog } from "./providers/ProviderCatalog.tsx";
import { ProviderModels } from "./providers/ProviderModels.tsx";
import { ProviderRegion } from "./providers/ProviderRegion.tsx";
import { namedProviders, providerCatalog } from "./providers/provider-catalog.ts";
import detailStyles from "./providers/provider-detail.module.css";
import { ProviderForm } from "./providers/provider-form.tsx";
import { AuxiliaryModelSettings } from "./selection/auxiliary-model.tsx";
import { DefaultModelSettings } from "./selection/default-model.tsx";
import { ModelCatalogRefresh } from "./selection/ModelCatalogRefresh.tsx";
import { ModelHealthNotice, useModelHealth } from "./selection/model-health.tsx";

export function ModelsSettings({
  active = true,
  target,
  onDirtyChange,
  searchSettings,
}: {
  active?: boolean;
  target?: "pi-model";
  searchSettings?: ReactNode;
  onDirtyChange?(dirty: boolean): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const magpieDetection = useMagpieDetection(active);
  const [selection, setSelection] = useState<string>();
  // Ids the user chose to add from a provider's new-models hint; the form preselects, never saves.
  const [adding, setAdding] = useState<{ identity: string; ids: string[] }>();
  const task = useTask(selection);
  const modelTask = useTask();
  const auxiliaryTask = useTask();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [allModels, setAllModels] = useState<ModelInfo[]>([]);
  const [dirty, setDirty] = useState(false);
  const dirtyChanged = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirtyChange?.(value);
    },
    [onDirtyChange],
  );
  const [pi, setPi] = useState<Bot>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const defaultPickerId = useId();
  const auxiliaryPickerId = useId();
  const health = useModelHealth(providers, models, allModels);
  const newModels = useNewModels(providers, active && !loading);
  const root = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLElement>(null);
  const listPosition = useRef(0);
  const selectedButton = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const lookup = useRef<AbortController>(undefined);
  const scope = useRef({ peer, active: false });
  const refresh = useCallback(async () => {
    if (!scope.current.active || scope.current.peer !== peer) return;
    lookup.current?.abort();
    const read = new AbortController();
    lookup.current = read;
    const serial = ++generation.current;
    try {
      const rpc = requirePeer(peer);
      const [catalog, available, main, included] = await Promise.all([
        rpc.call("providers.list", undefined, { signal: read.signal }),
        rpc.call("models.list", { availableOnly: true }, { signal: read.signal }),
        readMainBot(rpc, read.signal),
        rpc.call("models.list", { availableOnly: false }, { signal: read.signal }),
      ]);
      if (read.signal.aborted || serial !== generation.current) return;
      if (!main) throw new Error("Main Bot unavailable");
      setProviders(catalog);
      setAllModels(included);
      setModels(available);
      setPi(main);
      setLoadError(false);
    } catch {
      if (!read.signal.aborted && serial === generation.current) setLoadError(true);
    } finally {
      if (serial === generation.current) setLoading(false);
      read.abort();
      if (lookup.current === read) lookup.current = undefined;
    }
  }, [peer]);
  useLayoutEffect(() => {
    scope.current = { peer, active: true };
    setSelection(undefined);
    setProviders([]);
    setModels([]);
    setAllModels([]);
    setPi(undefined);
    setLoading(true);
    void refresh();
    return () => {
      scope.current.active = false;
      generation.current++;
      lookup.current?.abort();
    };
  }, [peer, refresh]);
  useRpcEvent("providers.changed", () => {
    void refresh();
  });
  const catalog = providerCatalog(
    namedProviders(
      providers,
      t("chatgpt.title"),
      t("chatgpt.codex.title"),
      t("models.magpie.name"),
    ),
    t("setup.customLabel"),
    t("models.payAsYouGo"),
  );
  const magpie = catalog.find((provider) => provider.id === MAGPIE_PROVIDER.id);
  const magpieDetected = magpieDetection.result?.running === true;
  // Discovery gates new entry points, not a configuration draft the user already opened.
  const chosen = catalog.find((provider) => providerIdentity(provider) === selection);
  function selectProvider(provider: Provider, button: HTMLElement, ids?: string[]) {
    selectedButton.current = button;
    listPosition.current =
      root.current?.closest<HTMLElement>("[data-settings-scroll]")?.scrollTop ?? 0;
    setAdding(ids ? { identity: providerIdentity(provider), ids } : undefined);
    setSelection(providerIdentity(provider));
  }

  const chosenIdentity = chosen && providerIdentity(chosen);
  // A saved model that has left the catalog cannot be tested; fall back to the provider default for
  // both the request and the label so they always name the same model.
  const savedTestModel =
    chosen && pi?.modelProvider === chosen.id ? (pi.modelId ?? undefined) : undefined;
  const testModelId = allModels.some(
    (model) => model.provider === chosen?.id && model.id === savedTestModel,
  )
    ? savedTestModel
    : undefined;
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>("[data-settings-scroll]");
    if (scroller) scroller.scrollTop = chosenIdentity ? 0 : listPosition.current;
    if (chosenIdentity) detail.current?.focus({ preventScroll: true });
    else {
      selectedButton.current?.focus({ preventScroll: true });
      onDirtyChange?.(false);
    }
  }, [chosenIdentity, onDirtyChange]);
  if (loading) return <p role="status">{t("setup.loading")}</p>;
  return (
    <div ref={root} className={modelStyles.modelsPage}>
      {loadError && (
        <div role="alert" className={styles.error}>
          {t("setup.failed")}{" "}
          <Button variant="secondary" onClick={() => void refresh()}>
            {t("setup.retry")}
          </Button>
        </div>
      )}
      <div hidden={!!chosen}>
        <div className={modelStyles.modelsList}>
          <MagpieDiscovery
            provider={magpie}
            result={magpieDetection.result}
            disabled={task.busy || modelTask.busy || auxiliaryTask.busy}
            open={selectProvider}
          />
          {!loadError && (health.default || health.auxiliary) && (
            <div className={modelStyles.health}>
              <ModelHealthNotice
                reason={health.default}
                label={t("models.defaultModel")}
                pickerId={defaultPickerId}
              />
              <ModelHealthNotice
                reason={health.auxiliary}
                label={t("models.auxiliaryModel")}
                pickerId={auxiliaryPickerId}
              />
            </div>
          )}
          {/* Keep model selection above the provider catalog and search settings. */}
          <DefaultModelSettings
            pickerId={defaultPickerId}
            health={health.default}
            models={models}
            providers={providers}
            task={modelTask}
            disabled={task.busy || auxiliaryTask.busy}
            target={target}
          />
          <AuxiliaryModelSettings
            pickerId={auxiliaryPickerId}
            health={health.auxiliary}
            models={models}
            providers={providers}
            task={auxiliaryTask}
            disabled={task.busy || modelTask.busy}
          />
          <ProviderCatalog
            providers={providers}
            magpieDetected={magpieDetected}
            selection={selection}
            disabled={task.busy || modelTask.busy || auxiliaryTask.busy}
            onSelect={selectProvider}
            newModels={newModels}
            onAddModels={(provider, ids, button) => selectProvider(provider, button, ids)}
          />
          {searchSettings}
        </div>
      </div>
      {chosen && (
        <section
          ref={detail}
          tabIndex={-1}
          aria-label={chosen.name}
          className={detailStyles.providerDetail}
        >
          <SettingsBack
            label={t("models.backToProviders")}
            disabled={task.busy}
            onClick={() => {
              setSelection(undefined);
              setDirty(false);
              onDirtyChange?.(false);
            }}
          />
          <ProviderRegion
            provider={chosen}
            providers={catalog}
            disabled={task.busy || dirty}
            change={(region) => setSelection(providerIdentity(region))}
          />
          <ProviderForm
            key={providerIdentity(chosen)}
            provider={chosen}
            testModelId={testModelId}
            task={task}
            refresh={refresh}
            onDirtyChange={dirtyChanged}
            addModelIds={adding?.identity === providerIdentity(chosen) ? adding.ids : undefined}
          />
          <ProviderModels
            key={providerIdentity(chosen)}
            provider={chosen}
            models={allModels}
            testModelId={testModelId}
          />
          {chosen.auth === "apiKey" && chosen.available && chosen.configured && (
            <AddedModels
              key={`added-${providerIdentity(chosen)}`}
              provider={chosen}
              models={allModels}
              task={task}
              refresh={refresh}
            />
          )}
          {chosen.id === "openrouter" && <ModelCatalogRefresh />}
        </section>
      )}
    </div>
  );
}
