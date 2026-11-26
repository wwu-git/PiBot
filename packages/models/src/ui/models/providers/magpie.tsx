// Keeps Magpie discovery and setup in the Models page using port-only inputs.
import {
  MAGPIE_PROVIDER,
  type MethodResults,
  magpiePort,
  type Provider,
} from "@pibot/models-contract/full";
import {
  layoutStyles,
  requirePeer,
  SettingsRow,
  SetupError,
  setupStyles as styles,
  useRpc,
  useT,
} from "@pibot/renderer-kit";
import { Button, TextField } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { useMagpieDetection } from "./magpie-detection.ts";
import type { Task } from "./provider-form.tsx";

export function MagpieDiscovery({
  provider,
  result,
  disabled,
  open,
}: {
  provider?: Provider;
  result?: MethodResults["local.detectMagpie"];
  disabled: boolean;
  open(provider: Provider, button: HTMLElement): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [dismissed, setDismissed] = useState(false);
  if (!provider || provider.configured || !result?.running || dismissed) return null;
  return (
    <section className={layoutStyles.card} aria-label={t("models.magpie.discoveryTitle")}>
      <SettingsRow
        icon="laptop"
        tone="violet"
        label={t("models.magpie.discoveryTitle")}
        note={t("models.magpie.discoveryNote", { version: result.version })}
      >
        <Button
          disabled={disabled || !peer}
          onClick={(event) => open(provider, event.currentTarget)}
        >
          {t("models.magpie.addAction")}
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={() => setDismissed(true)}>
          {t("models.magpie.notNow")}
        </Button>
      </SettingsRow>
    </section>
  );
}

export function MagpieProviderForm({
  provider,
  refresh,
  task,
  onDirtyChange,
}: {
  provider: Provider;
  refresh(): Promise<void>;
  task: Task;
  onDirtyChange?(dirty: boolean): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const savedPort =
    (provider.baseUrl && magpiePort(provider.baseUrl)) || MAGPIE_PROVIDER.defaultPort;
  const [port, setPort] = useState(String(savedPort));
  const { checking, detect, reset, result } = useMagpieDetection(false);
  const active = useRef<AbortController>(undefined);
  useEffect(() => {
    if (!peer) return;
    return () => active.current?.abort();
  }, [peer]);
  useEffect(() => setPort(String(savedPort)), [savedPort]);
  useEffect(() => onDirtyChange?.(port !== String(savedPort)), [onDirtyChange, port, savedPort]);
  const portNumber = Number(port);
  const valid = /^\d{1,5}$/.test(port) && portNumber >= 1 && portNumber <= 65535;
  async function save() {
    const rpc = requirePeer(peer);
    const request = new AbortController();
    active.current = request;
    try {
      const { count } = await rpc.call(
        "local.configureMagpie",
        { port: portNumber },
        { signal: request.signal },
      );
      await refresh();
      if (!request.signal.aborted) {
        setPort(String(portNumber));
        task.setSuccess(t("models.magpie.saved", { count }));
      }
    } catch (error) {
      if (error instanceof Error && error.message === "magpie_models_unavailable")
        throw new SetupError("models.magpie.modelsUnavailable");
      throw error;
    } finally {
      if (active.current === request) active.current = undefined;
    }
  }
  return (
    <form
      className={styles.stack}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !task.busy && peer) void task.run(save);
      }}
    >
      <TextField
        label={t("models.magpie.port")}
        description={t("models.magpie.portHint")}
        value={port}
        required
        inputMode="numeric"
        disabled={task.busy}
        onChange={(event) => {
          reset();
          setPort(event.target.value);
        }}
      />
      {result && (
        <p role="status" className={styles.note}>
          {result.running
            ? t("models.magpie.detected", { version: result.version })
            : t("models.magpie.notDetected")}
        </p>
      )}
      <div className={styles.wrap}>
        <Button
          variant="secondary"
          disabled={!peer || !valid || task.busy}
          loading={checking}
          onClick={() => void detect(portNumber)}
        >
          {t("models.magpie.detect")}
        </Button>
        <Button type="submit" disabled={!peer || !valid} loading={task.busy}>
          {t(provider.configured ? "models.magpie.refresh" : "models.magpie.add")}
        </Button>
      </div>
    </form>
  );
}
