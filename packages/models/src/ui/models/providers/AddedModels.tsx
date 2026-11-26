// Lets a built-in API-key provider use a model newer than the pinned catalog, by its id.
import { AddedModelIdSchema, type ModelInfo, type Provider } from "@pibot/models-contract/full";
import { setupStyles as styles, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, TextField } from "@pibot/ui";
import { useState } from "react";
import { requirePeer } from "../../setup/operations.ts";
import detailStyles from "./provider-detail.module.css";
import type { Task } from "./provider-form.tsx";

type Status =
  | { tone: "ok"; key: "models.addModel.works"; id: string }
  | {
      tone: "error";
      key:
        | "models.addModel.invalid"
        | "models.addModel.exists"
        | "models.addModel.rejected"
        | "models.addModel.untested";
      id: string;
    };

export function AddedModels({
  provider,
  models,
  task,
  refresh,
}: {
  provider: Provider;
  models: readonly ModelInfo[];
  task: Task;
  refresh(): Promise<void>;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Status>();
  const own = models.filter((model) => model.provider === provider.id);
  const added = own.filter((model) => model.addedByUser);
  const add = () => {
    const parsed = AddedModelIdSchema.safeParse(draft);
    if (!parsed.success) {
      setStatus({ tone: "error", key: "models.addModel.invalid", id: draft.trim() });
      return;
    }
    const id = parsed.data;
    if (own.some((model) => model.id === id)) {
      setStatus({ tone: "error", key: "models.addModel.exists", id });
      return;
    }
    setStatus(undefined);
    void task.run(async () => {
      const rpc = requirePeer(peer);
      await rpc.call("providers.addModel", { providerId: provider.id, modelId: id });
      setDraft("");
      await refresh();
      // One real request to the provider's own endpoint says whether it knows this id.
      const result = await rpc.call("providers.test", { providerId: provider.id, modelId: id });
      setStatus(
        result.ok
          ? { tone: "ok", key: "models.addModel.works", id }
          : {
              tone: "error",
              key:
                result.error === "provider_rejected" || result.error === "no_model"
                  ? "models.addModel.rejected"
                  : "models.addModel.untested",
              id,
            },
      );
    });
  };
  return (
    <section
      className={`${styles.stack} ${detailStyles.included}`}
      aria-label={t("models.addModel.title")}
    >
      <form
        className={detailStyles.addedModelForm}
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <TextField
          label={t("models.addModel.title")}
          value={draft}
          maxLength={200}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder={t("models.addModel.placeholder")}
          disabled={task.busy || !peer}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={task.busy || !peer || !draft.trim()}>
          {t("models.addModel.add")}
        </Button>
      </form>
      <p className={styles.note}>{t("models.addModel.note")}</p>
      {status && (
        <p role={status.tone === "error" ? "alert" : "status"} className={styles.note}>
          {t(status.key, { id: status.id, provider: provider.name })}
        </p>
      )}
      {added.length > 0 && (
        <ul className={detailStyles.addedModels}>
          {added.map((model) => (
            <li key={model.id}>
              <span>{model.id}</span>
              <Chip>{t("models.addedByUser")}</Chip>
              <Button
                variant="ghost"
                disabled={task.busy || !peer}
                aria-label={`${t("models.addModel.remove")} · ${model.id}`}
                onClick={() =>
                  void task.run(async () => {
                    await requirePeer(peer).call("providers.removeModel", {
                      providerId: provider.id,
                      modelId: model.id,
                    });
                    setStatus(undefined);
                    await refresh();
                  })
                }
              >
                {t("models.addModel.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
