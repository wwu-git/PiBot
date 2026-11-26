import type { CustomProvider, MethodResults, Provider } from "@pibot/models-contract/full";
import { useRpc, useT } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";
import {
  requirePeer,
  SetupError,
  testProvider,
  validateCustom,
  writeCredential,
} from "../../setup/operations.ts";
import type { ImageModelRow } from "../selection/custom-image-models.tsx";
import {
  applyCapabilities,
  type ModelRow,
  modelConfig,
  modelRow,
  modelSnapshot,
  patchModel,
} from "../selection/custom-model-state.ts";
import { customPresets } from "./custom-presets.ts";
import type { Task } from "./provider-form.tsx";

type SavedProvider = MethodResults["customProviders.get"];
export interface HeaderRow {
  rowId: string;
  name: string;
  value: string;
}
interface FormState {
  name: string;
  baseUrl: string;
  api: CustomProvider["api"];
  key: string;
  headers: HeaderRow[];
  clearHeaders: boolean;
  models: ModelRow[];
  imageApi: NonNullable<CustomProvider["imageApi"]> | "none";
  imageModels: ImageModelRow[];
  compat: Record<string, boolean>;
}
// Dirty baselines must never retain credential values.
const snapshot = ({ key: _key, headers: _headers, ...form }: FormState) =>
  JSON.stringify({ ...form, models: form.models.map(modelSnapshot) });
const presets = Object.fromEntries(
  Object.entries(customPresets).map(([id, preset]) => [id, Object.values(preset.urls)[0]]),
);
function headerInput(headers: HeaderRow[]) {
  const names = new Set<string>();
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (!name || names.has(name)) throw new SetupError("models.custom.invalid");
    names.add(name);
  }
  return headers.length
    ? Object.fromEntries(headers.map((header) => [header.name, header.value]))
    : undefined;
}

export function useCustomProvider(
  provider: Provider,
  task: Task,
  refresh: () => Promise<void>,
  testModelId?: string,
  addModelIds?: string[],
) {
  const { peer } = useRpc();
  const t = useT();
  // Allocate before the first write: a lost response must not produce a second provider on retry.
  const [id] = useState(() => (provider.id === "new-custom" ? crypto.randomUUID() : provider.id));
  const [form, setForm] = useState<FormState>(
    (): FormState => ({
      name: provider.id === "new-custom" ? "" : provider.name,
      baseUrl: presets[provider.id] ?? "",
      api: "openai-completions",
      key: "",
      headers: [],
      clearHeaders: false,
      models: [],
      imageApi: "none",
      imageModels: [],
      compat: provider.id === "ollama" ? { supportsDeveloperRole: false } : {},
    }),
  );
  const [saved, setSaved] = useState<SavedProvider>();
  const [baseline, setBaseline] = useState(() => snapshot(form));
  const [loading, setLoading] = useState(provider.configured);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [capabilitiesError, setCapabilitiesError] = useState(false);
  const [capabilitiesAttempt, setCapabilitiesAttempt] = useState(0);
  const modelIds = JSON.stringify(
    form.models.filter((model) => model.id).map(({ rowId, id }) => ({ rowId, id })),
  );
  const registered = provider.configured || (provider.id === "new-custom" && !!saved);

  // Hydrate on registration/reconnection, not on every provider-list refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a new request.
  useEffect(() => {
    if (!registered) {
      setSaved(undefined);
      setLoading(false);
      setLoadError(false);
      return;
    }
    if (!peer) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(false);
    void peer.call("customProviders.get", { providerId: id }).then(
      (info) => {
        if (!active) return;
        setSaved(info);
        const hydrated = fromSaved(info);
        setBaseline(snapshot(hydrated));
        // Preselected additions leave the form dirty, so nothing is saved until the user saves.
        const known = new Set(hydrated.models.map((model) => model.id));
        const added = (addModelIds ?? [])
          .filter((model) => !known.has(model))
          .map((model) => modelRow({ id: model }));
        setForm(added.length ? { ...hydrated, models: [...hydrated.models, ...added] } : hydrated);
        setLoading(false);
      },
      () => {
        if (active) {
          setLoadError(true);
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [peer, id, registered, attempt]);

  // Resolve edited IDs without sending credentials or storing catalog-derived defaults.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately restarts resolution.
  useEffect(() => {
    if (!peer) return;
    let active = true;
    setCapabilitiesError(false);
    const timer = setTimeout(() => {
      const rows: Array<{ rowId: string; id: string }> = JSON.parse(modelIds);
      const ids = [...new Set(rows.map((row) => row.id))];
      if (!ids.length) return;
      void peer.call("customProviders.resolveModels", { models: ids.map((id) => ({ id })) }).then(
        ({ models }) => {
          if (!active) return;
          const capabilities = new Map(models.map((model) => [model.id, model.capabilities]));
          setForm((current) => ({
            ...current,
            models: current.models.map((row) => applyCapabilities(row, capabilities.get(row.id))),
          }));
        },
        () => {
          if (active) setCapabilitiesError(true);
        },
      );
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [peer, modelIds, capabilitiesAttempt]);

  function setField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }
  function changeModel(rowId: string, patch: Partial<ModelRow>) {
    setForm((current) => ({
      ...current,
      models: current.models.map((row) => (row.rowId === rowId ? patchModel(row, patch) : row)),
    }));
  }
  function changeHeader(rowId: string, patch: Partial<HeaderRow>) {
    setForm((current) => ({
      ...current,
      headers: current.headers.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
    }));
  }
  function setCompat(name: string, checked: boolean) {
    setForm((current) => {
      const compat = { ...current.compat };
      if (checked) compat[name] = false;
      else delete compat[name];
      return { ...current, compat };
    });
  }
  function credentials() {
    return {
      ...(form.key ? { apiKey: form.key } : {}),
      ...(form.headers.length
        ? { headers: headerInput(form.headers) }
        : form.clearHeaders
          ? { headers: {} }
          : {}),
    };
  }
  const credentialPending = !!form.key || !!form.headers.length || form.clearHeaders;
  const credentialBlocked = task.blocked && credentialPending;
  // Autosaves run one after another so an older write can never land after a newer one.
  const autosaveChain = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Maintainers 2026-11-13: a saved provider's non-secret fields (name, API format, address, image API
   * and models, model list, compatibility) take effect as they are changed. Keys and header values
   * keep the explicit 保存并测试, so this never sends a credential and skips while one is typed;
   * an incomplete form (no model selected, a bad address) waits for that button, which explains why.
   * A preset region change needs a new key and also waits. Resolves true when something was saved.
   */
  function autosave(): Promise<boolean> {
    const current = form;
    const run = async () => {
      if (!saved || credentialPending || snapshot(current) === baseline) return false;
      if (
        customPresets[provider.id] &&
        provider.id.endsWith("-api") &&
        saved.baseUrl !== current.baseUrl
      )
        return false;
      let payload: CustomProvider;
      try {
        payload = validateCustom({
          id,
          name: current.name,
          baseUrl: current.baseUrl,
          api: current.api,
          ...(Object.keys(current.compat).length ? { compat: current.compat } : {}),
          models: current.models.filter((model) => model.selected).map(modelConfig),
          ...(current.imageApi !== "none"
            ? {
                imageApi: current.imageApi,
                imageModels: current.imageModels.map(({ rowId: _rowId, ...model }) => model),
              }
            : {}),
        });
      } catch {
        return false;
      }
      const rpc = requirePeer(peer);
      await writeCredential(() => rpc.call("customProviders.upsert", payload));
      setBaseline(snapshot(current));
      setSaved((old) => (old ? { ...old, ...payload } : old));
      await refresh();
      return true;
    };
    const next = autosaveChain.current.then(run, run);
    autosaveChain.current = next.catch(() => undefined);
    return next;
  }
  async function save() {
    if (credentialBlocked) return;
    if (
      customPresets[provider.id] &&
      provider.id.endsWith("-api") &&
      !form.key &&
      !saved?.hasApiKey
    )
      throw new SetupError("models.keyInvalid");
    if (
      customPresets[provider.id] &&
      provider.id.endsWith("-api") &&
      saved &&
      saved.baseUrl !== form.baseUrl &&
      !form.key
    )
      throw new SetupError("models.regionKeyRequired");
    const payload = validateCustom({
      id,
      name: form.name,
      baseUrl: form.baseUrl,
      api: form.api,
      ...credentials(),
      ...(Object.keys(form.compat).length ? { compat: form.compat } : {}),
      models: form.models.filter((model) => model.selected).map(modelConfig),
      ...(form.imageApi !== "none"
        ? {
            imageApi: form.imageApi,
            imageModels: form.imageModels.map(({ rowId: _rowId, ...model }) => model),
          }
        : {}),
    });
    const rpc = requirePeer(peer);
    const result = await writeCredential(() => rpc.call("customProviders.upsert", payload));
    // Reset one-shot credential actions as soon as upsert succeeds, even if testing later fails.
    const committed = { ...form, key: "", headers: [], clearHeaders: false };
    setForm(committed);
    setBaseline(snapshot(committed));
    const { apiKey, headers, ...publicConfig } = payload;
    setSaved({
      ...publicConfig,
      id: result.id,
      hasApiKey: !!apiKey || (saved?.hasApiKey ?? false),
      hasHeaders: headers !== undefined ? !!Object.keys(headers).length : saved?.hasHeaders,
      headerNames: headers ? Object.keys(headers) : (saved?.headerNames ?? []),
    });
    await refresh();
    if (!payload.models.length) {
      task.setSuccess(t("media.savedImages"));
      return;
    }
    const tested = await testProvider(rpc, result.id, testModelId);
    task.setSuccess(
      t(
        tested.verification === "credentials" ? "media.credentialsVerified" : "models.testSuccess",
        { count: tested.modelCount ?? 0 },
      ),
    );
  }
  async function fetchModels() {
    try {
      await discoverModels();
    } catch (error) {
      if (
        provider.id === "ollama" &&
        form.baseUrl === presets.ollama &&
        error instanceof Error &&
        error.message === "network"
      )
        throw new SetupError("models.ollamaUnavailable");
      // Windows acceptance 2026-11-20: an unreachable address said only "操作失败". Name the
      // network failure, so the welcome step can offer the proxy (it reads the error key).
      if (
        error instanceof Error &&
        ["network", "proxy_unavailable", "proxy_auth_failed", "auth_failed"].includes(error.message)
      )
        throw new SetupError(
          `errors.${error.message as "network" | "proxy_unavailable" | "proxy_auth_failed" | "auth_failed"}`,
        );
      throw error;
    }
  }
  async function discoverModels() {
    if (form.imageApi !== "none" && !form.models.length)
      throw new SetupError("media.noChatDiscovery");
    const rpc = requirePeer(peer);
    const unchangedCredentials = !form.key && !form.headers.length && !form.clearHeaders;
    const unchangedConnection = saved?.baseUrl === form.baseUrl && saved.api === form.api;
    let found: MethodResults["customProviders.fetchModels"];
    if (saved && unchangedCredentials && unchangedConnection) {
      found = await writeCredential(() =>
        rpc.call("customProviders.fetchSavedModels", { providerId: saved.id }),
      );
    } else {
      // The renderer cannot combine new inputs with hidden saved secret values.
      if (
        saved &&
        ((!form.key && saved.hasApiKey) ||
          (!form.headers.length &&
            !form.clearHeaders &&
            (saved.hasHeaders || saved.headerNames.length)))
      )
        throw new SetupError("setup.saveBeforeDiscovery");
      const payload = validateCustom({
        name: form.name || "discovery",
        baseUrl: form.baseUrl,
        api: form.api,
        ...credentials(),
        models: [{ id: "discovery" }],
      });
      found = await rpc.call("customProviders.fetchModels", {
        baseUrl: payload.baseUrl,
        api: payload.api,
        ...(payload.apiKey ? { apiKey: payload.apiKey } : {}),
        ...(payload.headers ? { headers: payload.headers } : {}),
      });
    }
    const existing = new Map(form.models.map((model) => [model.id, model]));
    setField(
      "models",
      found.models.map((model) => existing.get(model.id) ?? modelRow(model)),
    );
    if (!found.models.length) task.setSuccess(t("models.custom.noModels"));
  }
  return {
    form,
    saved,
    loading,
    loadError,
    retry: () => setAttempt((value) => value + 1),
    setField,
    changeModel,
    capabilitiesError,
    retryCapabilities: () => setCapabilitiesAttempt((value) => value + 1),
    changeHeader,
    setCompat,
    credentialBlocked,
    dirty: snapshot(form) !== baseline || !!form.key || !!form.headers.length,
    save,
    autosave,
    fetchModels,
  };
}

function fromSaved(info: SavedProvider): FormState {
  return {
    name: info.name,
    baseUrl: info.baseUrl,
    api: info.api,
    key: "",
    headers: [],
    clearHeaders: false,
    models: info.models.map(modelRow),
    imageApi: info.imageApi ?? "none",
    imageModels: (info.imageModels ?? []).map((model) => ({
      ...model,
      rowId: crypto.randomUUID(),
    })),
    compat: info.compat ?? {},
  };
}
