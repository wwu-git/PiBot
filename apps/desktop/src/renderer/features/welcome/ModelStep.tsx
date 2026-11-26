import {
  ChatGPTSignIn,
  configuredTextModels,
  groupedProviderCatalog,
  ProviderForm,
  ProviderRegion,
  providerCatalog,
  providerGroups,
} from "@pibot/models/ui";
import {
  CHATGPT_PLAN_PROVIDER,
  MAGPIE_PROVIDER,
  magpiePort,
  providerFamily,
} from "@pibot/protocol";
import {
  TaskStatus,
  useComboboxText,
  useModelOptions,
  useRpc,
  useSettings,
  useT,
  useTask,
} from "@pibot/renderer-kit";
import { Button, Chip, Combobox, type IconName, IconTile, type Tone } from "@pibot/ui";
import {
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import shared from "../../../../../../packages/renderer-kit/src/widgets/setup/setup.module.css";
import { NetworkProxySettings } from "../settings/network-proxy.tsx";
import {
  choosePiModel,
  configureOllama,
  providerIdentity,
  requirePeer,
  SetupError,
} from "../settings/operations.ts";
import { OllamaSetup } from "./OllamaSetup.tsx";
import { RECOMMENDED_ROUTES, RecommendedSetup } from "./RecommendedSetup.tsx";
import { useModelDirectory } from "./useModelDirectory.ts";
import styles from "./welcome.module.css";

type Mode = "recommended" | "chatgpt" | "local" | "provider" | "magpie";
const CHATGPT_PLANS = [
  "welcome.model.plan.go",
  "welcome.model.plan.plus",
  "welcome.model.plan.pro",
  "welcome.model.plan.business",
] as const;
// Four compact pick cards in a 2×2 grid (maintainers 2026-11-14), read row by row: OpenRouter, ChatGPT
// plan / local, API key. The recommended one carries a 推荐 chip.
const OTHER_ROUTES = [
  {
    id: "chatgpt",
    label: "chatgpt.title",
    note: "welcome.model.chatgptNote",
    icon: "message",
    tone: "green",
  },
  {
    id: "local",
    label: "welcome.model.local",
    note: "welcome.model.localNote",
    icon: "laptop",
    tone: "teal",
  },
  {
    id: "provider",
    label: "welcome.model.apiKey",
    note: "welcome.model.apiKeyShort",
    icon: "key",
    tone: "blue",
  },
] as const satisfies readonly {
  id: Exclude<Mode, "recommended">;
  label: string;
  note: string;
  icon: IconName;
  tone: Tone;
}[];

export interface ModelStepHandle {
  back(): void;
  next(): void;
}
export interface ModelStepStatus {
  busy: boolean;
  ready: boolean;
}

export function ModelStep({
  ref,
  onStatus,
  onBack,
  onContinue,
}: {
  ref: Ref<ModelStepHandle>;
  onStatus(status: ModelStepStatus): void;
  onBack(): void;
  onContinue(): void;
}) {
  const { peer } = useRpc();
  const t = useT();
  const { language } = useSettings();
  const route = RECOMMENDED_ROUTES[language];
  const recommendedValue = JSON.stringify([route.provider, route.model]);
  const [mode, setMode] = useState<Mode>("recommended");
  const [selection, setSelection] = useState<{ epoch: number; identity: string }>();
  const [model, setModel] = useState("");
  // A failed probe belongs to the selection that produced it.
  const taskScope = JSON.stringify([route.provider, mode, selection?.identity, model]);
  const task = useTask(taskScope);
  const confirmation = useTask(taskScope);
  const directory = useModelDirectory();
  const {
    epoch,
    data: current,
    loading,
    failed,
    ollama,
    magpie,
    detecting,
    refresh,
    detect,
  } = directory;
  const busy = task.busy || confirmation.busy;
  const isBusy = () => task.isBusy() || confirmation.isBusy();
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<{ action(): void }>();
  const [localModel, setLocalModel] = useState("");
  const providers = current?.providers ?? [];
  const magpieDetected = magpie?.running === true;
  const allCatalog = providerCatalog(providers, t("setup.customLabel"), t("models.payAsYouGo"));
  const magpieProvider = allCatalog.find(
    (entry) => entry.id === MAGPIE_PROVIDER.id && entry.available,
  );
  const magpieSelected =
    mode === "magpie" ||
    (selection?.epoch === epoch &&
      !!magpieProvider &&
      selection.identity === providerIdentity(magpieProvider));
  const catalog = allCatalog.filter(
    (entry) => entry.id !== MAGPIE_PROVIDER.id || magpieDetected || magpieSelected,
  );
  const recommended = catalog.find(
    (entry) => entry.id === route.provider && entry.auth === "apiKey" && entry.available,
  );
  // Settings › 订阅 › ChatGPT is the same provider, so a sign-in on either page is one stored state.
  const plan = catalog.find((entry) => entry.id === CHATGPT_PLAN_PROVIDER && entry.available);
  // Hidden only once the catalog says the release cannot sign in, so the grid does not jump
  // from three cards to four while the first read is in flight.
  const chatgptOffered = !current || !!plan?.chatgpt?.available;
  const onPlan = plan?.chatgpt?.state === "connected";
  const routes = [
    ...(magpieDetected && magpieProvider
      ? [
          {
            id: "magpie" as const,
            label: "models.magpie.welcomeTitle" as const,
            note: "models.magpie.welcomeNote" as const,
            mark: { icon: "laptop" as const },
            tone: "violet" as const,
          },
        ]
      : []),
    {
      id: "recommended" as const,
      label: route.label,
      note: route.note,
      mark: route.mark,
      tone: route.tone,
    },
    ...OTHER_ROUTES.filter((item) => item.id !== "chatgpt" || chatgptOffered).map((item) => ({
      ...item,
      mark: { icon: item.icon },
    })),
  ];
  const chosen =
    mode === "recommended"
      ? recommended
      : mode === "magpie"
        ? magpieProvider
        : selection?.epoch === epoch
          ? catalog.find(
              (entry) => providerIdentity(entry) === selection.identity && entry.available,
            )
          : undefined;
  const models = configuredTextModels(providers, current?.models ?? []).filter(
    (entry) =>
      (entry.provider !== MAGPIE_PROVIDER.id || magpieDetected || magpieSelected) &&
      (mode === "local"
        ? entry.provider === "ollama"
        : mode === "magpie"
          ? entry.provider === MAGPIE_PROVIDER.id
          : mode === "recommended"
            ? entry.provider === route.provider
            : mode === "chatgpt"
              ? // Only plan models: an OpenAI API key is the 「API Key」 route, not this one.
                onPlan && entry.provider === CHATGPT_PLAN_PROVIDER
              : true),
  );
  const grouped = groupedProviderCatalog(catalog);
  const chosenTile =
    chosen &&
    grouped.find(
      (entry) =>
        providerIdentity(entry) === providerIdentity(chosen) ||
        (providerFamily(entry.id) && providerFamily(entry.id) === providerFamily(chosen.id)),
    );
  const providerOptions = providerGroups
    // The ChatGPT plan has its own route card above; this picker is for keys and endpoints.
    .filter((group) => group !== "all" && group !== "subscription")
    .flatMap((group) => grouped.filter((entry) => entry.group === group))
    .map((entry) => ({
      value: providerIdentity(entry),
      label: `${entry.name}${entry.auth === "apiKey" ? "" : ` · ${t(entry.auth === "custom" && ["ollama", "lmstudio", "vllm"].includes(entry.id) ? "models.auth.local" : `models.auth.${entry.auth}`)}`}${entry.available ? "" : ` · ${t("common.comingSoon")}`}`,
      group: t(`models.group.${providerGroups.find((group) => group === entry.group) ?? "other"}`),
      keywords: [entry.id, entry.name, entry.auth, t(`models.auth.${entry.auth}`)],
      disabled: !entry.available,
    }));
  // The recommended card preselects its model as soon as the key has made it available.
  const modelValue =
    model ||
    (mode === "recommended" &&
    models.some((entry) => JSON.stringify([entry.provider, entry.id]) === recommendedValue)
      ? recommendedValue
      : "");
  const selected = models.find(
    (entry) => JSON.stringify([entry.provider, entry.id]) === modelValue,
  );
  const options = useModelOptions(
    models,
    providers.filter(
      (entry) => entry.selectedAuth === undefined || entry.selectedAuth === entry.auth,
    ),
    true,
  );
  const comboboxText = useComboboxText();

  const refreshForm = useCallback(async () => {
    await refresh();
  }, [refresh]);
  useLayoutEffect(() => {
    if (!directory.current()) return;
    setDirty(false);
    setPending(undefined);
    setSelection(undefined);
    setMode("recommended");
    setModel("");
  }, [directory.current]);
  useLayoutEffect(() => setLocalModel(ollama?.models[0]?.id ?? ""), [ollama]);
  const onDirtyChange = useCallback(
    (value: boolean) => {
      if (directory.current()) setDirty(value);
    },
    [directory.current],
  );
  // A discard confirmation owns navigation; form actions cannot race it through a portal.
  const formTask = {
    ...task,
    busy: busy || !!pending,
    run: (action: () => Promise<void>) =>
      pending || confirmation.isBusy() ? Promise.resolve() : task.run(action),
  };
  const request = (action: () => void) => {
    if (busy || isBusy() || !directory.current()) return;
    if (dirty) setPending({ action });
    else action();
  };
  const changeMode = (next: Mode) => {
    if (mode === next) return;
    request(() => {
      setDirty(false);
      setSelection(undefined);
      setModel("");
      setMode(next);
    });
  };
  const locked = busy || !!pending;
  const routeName = useId();
  const modelPicker = (
    <>
      <Combobox
        {...comboboxText}
        label={t("models.defaultModel")}
        placeholder={t("setup.chooseModel")}
        options={options}
        value={selected ? modelValue : ""}
        disabled={busy || loading || failed || dirty || !!pending || !models.length}
        onValueChange={setModel}
      />
      {!models.length && <p className={shared.note}>{t("models.noConfigured")}</p>}
    </>
  );
  const canConfirm =
    !!peer &&
    !!selected &&
    !loading &&
    !failed &&
    !dirty &&
    !pending &&
    !busy &&
    !task.error &&
    (mode !== "local" || selected.id === localModel);
  const ready = canConfirm && !confirmation.error;
  useLayoutEffect(() => onStatus({ busy, ready }), [onStatus, busy, ready]);
  const confirm = () => {
    if (!canConfirm || !selected || isBusy() || !directory.current()) return;
    const signal = AbortSignal.any([directory.signal(), AbortSignal.timeout(30_000)]);
    void confirmation.run(async () => {
      const fresh = await refresh();
      signal.throwIfAborted();
      if (
        !configuredTextModels(fresh.providers, fresh.models).some(
          (entry) => entry.provider === selected.provider && entry.id === selected.id,
        )
      )
        throw new SetupError("setup.noModels");
      if (selected.provider === MAGPIE_PROVIDER.id) {
        const port = magpiePort(
          fresh.providers.find((entry) => entry.id === MAGPIE_PROVIDER.id)?.baseUrl ?? "",
        );
        if (port === undefined) throw new SetupError("models.magpie.modelsUnavailable");
        const gateway = await requirePeer(peer).call(
          "local.detectMagpie",
          { port },
          { signal, timeoutMs: 3000 },
        );
        if (!gateway.running) throw new SetupError("models.magpie.modelsUnavailable");
      }
      await choosePiModel(requirePeer(peer), selected.provider, selected.id, signal);
      signal.throwIfAborted();
      if (directory.current()) onContinue();
    });
  };
  useImperativeHandle(ref, () => ({
    back: () => request(onBack),
    next: () => {
      if (ready) confirm();
    },
  }));
  return (
    <div className={shared.stack}>
      <TaskStatus task={task} />
      <TaskStatus task={confirmation} />
      {confirmation.error && (
        <Button variant="secondary" disabled={!canConfirm} onClick={confirm}>
          {t("setup.retryModelConfirmation")}
        </Button>
      )}
      {pending && (
        <section role="alert" className={shared.panel}>
          <p>{t("setup.discardProvider")}</p>
          <div className={shared.wrap}>
            <Button variant="secondary" disabled={busy} onClick={() => setPending(undefined)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (isBusy() || !directory.current()) return;
                const action = pending.action;
                setPending(undefined);
                setDirty(false);
                action();
              }}
            >
              {t("setup.discard")}
            </Button>
          </div>
        </section>
      )}
      {loading && <p role="status">{t("setup.loading")}</p>}
      {failed && (
        <p role="alert">
          {t("setup.failed")}{" "}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void refresh().catch(() => {
                // A catalog retry cannot clear a failed provider test or repeat a write.
              })
            }
          >
            {t("setup.retry")}
          </Button>
        </p>
      )}
      {/* Native radios: arrows move between the cards; a dirty form still asks before switching. */}
      <fieldset className={styles.routes} aria-label={t("welcome.model.route")}>
        {routes.map((card) => (
          <label
            key={card.id}
            className={styles.route}
            data-checked={mode === card.id || undefined}
            data-disabled={locked || undefined}
            data-wide={card.id === "magpie" || undefined}
          >
            <IconTile {...card.mark} tone={card.tone} size="lg" className={styles.routeTile} />
            <span className={styles.routeText}>
              <strong>
                {t(card.label)}
                {card.id === "recommended" && (
                  <Chip tone="violet">{t("welcome.model.recommendedTag")}</Chip>
                )}
              </strong>
              <span>{t(card.note)}</span>
            </span>
            <input
              type="radio"
              className={styles.radio}
              name={routeName}
              value={card.id}
              checked={mode === card.id}
              disabled={locked}
              onChange={() => changeMode(card.id)}
            />
          </label>
        ))}
      </fieldset>
      <div className={styles.routeBody}>
        {mode === "magpie" && magpieProvider && (
          <>
            <ProviderForm
              key={`${epoch}:${providerIdentity(magpieProvider)}`}
              provider={magpieProvider}
              task={formTask}
              refresh={refreshForm}
              onDirtyChange={onDirtyChange}
              compact
            />
            {modelPicker}
          </>
        )}
        {mode === "recommended" && (
          <RecommendedSetup
            route={route}
            provider={recommended}
            epoch={epoch}
            task={formTask}
            refresh={refreshForm}
            onDirtyChange={onDirtyChange}
            selected={selected}
            value={modelValue}
            options={options}
            disabled={busy || loading || failed || dirty || !!pending}
            change={setModel}
          />
        )}
        {mode === "chatgpt" && plan && (
          <>
            <ChatGPTSignIn
              provider={plan}
              refresh={refreshForm}
              lead={
                <>
                  <p className={shared.note}>{t("welcome.model.chatgptBody")}</p>
                  <ul className={styles.plans} aria-label={t("welcome.model.chatgptPlans")}>
                    {CHATGPT_PLANS.map((plan) => (
                      <li key={plan}>
                        <Chip tone="violet">{t(plan)}</Chip>
                      </li>
                    ))}
                  </ul>
                </>
              }
            />
            {onPlan ? (
              modelPicker
            ) : (
              <p className={shared.note}>{t("welcome.model.chatgptAfter")}</p>
            )}
          </>
        )}
        {mode === "local" && (
          <>
            <OllamaSetup
              result={ollama}
              selected={localModel}
              busy={busy || !!pending}
              detecting={detecting}
              change={(value) => {
                setLocalModel(value);
                setModel("");
              }}
              detect={() => void detect()}
              configure={() => {
                if (!ollama?.running || !localModel || isBusy() || pending || !directory.current())
                  return;
                void task.run(async () => {
                  const signal = directory.signal();
                  await configureOllama(requirePeer(peer), ollama.baseUrl, localModel, signal);
                  const fresh = await refresh();
                  signal.throwIfAborted();
                  if (
                    !configuredTextModels(fresh.providers, fresh.models).some(
                      (entry) => entry.provider === "ollama" && entry.id === localModel,
                    )
                  )
                    throw new SetupError("setup.noModels");
                  setModel(JSON.stringify(["ollama", localModel]));
                });
              }}
            />
            {!!ollama?.models.length && !models.length && (
              <p className={shared.note}>{t("models.noConfigured")}</p>
            )}
          </>
        )}
        {mode === "provider" && (
          <>
            <Combobox
              {...comboboxText}
              label={t("models.provider")}
              placeholder={t("setup.chooseProvider")}
              options={providerOptions}
              value={chosenTile ? providerIdentity(chosenTile) : ""}
              disabled={busy || loading || failed || !!pending}
              onValueChange={(identity) => {
                if (
                  !catalog.some((entry) => providerIdentity(entry) === identity && entry.available)
                )
                  return;
                if (
                  identity === selection?.identity ||
                  (chosenTile && identity === providerIdentity(chosenTile))
                )
                  return;
                request(() => {
                  setDirty(false);
                  setModel("");
                  setSelection({ epoch, identity });
                });
              }}
            />
            {chosen && (
              <ProviderRegion
                provider={chosen}
                providers={catalog}
                disabled={locked || dirty}
                change={(region) =>
                  request(() => {
                    setDirty(false);
                    setModel("");
                    setSelection({ epoch, identity: providerIdentity(region) });
                  })
                }
              />
            )}
            {chosen && (
              <ProviderForm
                key={`${epoch}:${providerIdentity(chosen)}`}
                provider={chosen}
                task={formTask}
                refresh={refreshForm}
                onDirtyChange={onDirtyChange}
                // The combobox above already names the provider and the step shows the task status.
                compact
                // A key provider swaps its save row for the picker once stored; the other auth
                // forms keep their own actions, so the picker follows them below.
                saved={chosen.auth === "apiKey" ? modelPicker : undefined}
              />
            )}
            {chosen?.auth !== "apiKey" && (
              <>
                <p className={shared.note}>{t("setup.onboardingProviderNote")}</p>
                {chosen && modelPicker}
              </>
            )}
          </>
        )}
      </div>
      {/* Online routes can need this proxy; Magpie owns its upstream connection itself. */}
      {mode !== "local" && !magpieSelected && (
        <ProxyEntry
          failure={
            [task, confirmation].find(
              (item) => !!item.errorKey && NETWORK_FAILURES.has(item.errorKey) && !item.busy,
            )?.error
          }
        />
      )}
    </div>
  );
}

/** A failed model step that a proxy can fix: the model service or the proxy itself unreachable. */
const NETWORK_FAILURES = new Set<string>([
  "errors.network",
  "errors.proxy_unavailable",
  "errors.proxy_auth_failed",
]);

/**
 * In some regions a model service is unreachable until a proxy is set; the welcome step reaches
 * the same proxy form as Settings, folded under a link, and offers it directly after a network
 * failure.
 */
function ProxyEntry({ failure }: { failure?: string }) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const place = useRef<HTMLDivElement>(null);
  // Acceptance 2026-11-20: the alert sits at the top of a long step, far above the button just
  // pressed, so a failure looked like nothing happened. Its text is repeated here, in view.
  useEffect(() => {
    if (failure) place.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [failure]);
  return (
    <div className={styles.proxy} ref={place}>
      {failure && !open && (
        <>
          <p className={shared.note}>{failure}</p>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t("welcome.model.proxyFromError")}
          </Button>
        </>
      )}
      <button
        type="button"
        className={styles.proxyToggle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {t("welcome.model.proxyToggle")}
      </button>
      {open && (
        <>
          <p className={shared.note}>{t("welcome.model.proxyHint")}</p>
          <NetworkProxySettings />
        </>
      )}
    </div>
  );
}
