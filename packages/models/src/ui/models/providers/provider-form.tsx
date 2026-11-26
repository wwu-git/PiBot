// Presents the setup and management controls for a selected provider.
import {
  CHATGPT_CODEX_PROVIDER,
  MAGPIE_PROVIDER,
  type Provider,
  providerPlan,
} from "@pibot/models-contract/full";
import type { useTask } from "@pibot/renderer-kit";
import { setupStyles as styles, TaskStatus, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, TextField } from "@pibot/ui";
import { type ReactNode, useEffect, useState } from "react";
import { requirePeer, saveKey, testProvider, writeCredential } from "../../setup/operations.ts";
import modelStyles from "../models.module.css";
import { ChatGPTSignIn } from "./ChatGPTSignIn.tsx";
import { ClaudePlanNote } from "./ClaudePlanNote.tsx";
import { CloudProviderForm } from "./cloud-provider.tsx";
import { CustomProviderForm } from "./custom-provider.tsx";
import { MagpieProviderForm } from "./magpie.tsx";
import { modelCountText } from "./model-count.ts";
import detailStyles from "./provider-detail.module.css";
import { providerMonogram } from "./provider-monogram.ts";

export type Task = ReturnType<typeof useTask>;
export function ProviderForm({
  provider,
  testModelId,
  task,
  refresh,
  onDirtyChange,
  compact = false,
  saved,
  addModelIds,
}: {
  provider: Provider;
  testModelId?: string;
  /** Offered model ids to preselect in a custom provider's list (unsaved until the user saves). */
  addModelIds?: string[];
  task: Task;
  refresh(): Promise<void>;
  onDirtyChange?(dirty: boolean): void;
  /**
   * Onboarding already names the provider (its route or provider picker) and shows the
   * task status, and a first run has nothing to manage yet; it keeps only the key path.
   */
  compact?: boolean;
  /**
   * Onboarding's next step once a key is stored (its model picker). It takes the save row's
   * place while no replacement key is typed, so the step stays one screen tall.
   */
  saved?: ReactNode;
}) {
  const { peer } = useRpc();
  const t = useT();
  const [key, setKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (provider.auth === "apiKey") onDirtyChange?.(!!key);
  }, [key, provider.auth, onDirtyChange]);
  if (!provider.available)
    return (
      <aside className={styles.panel}>
        <strong>
          {t(
            provider.unavailableReason
              ? `errors.${provider.unavailableReason}`
              : "common.comingSoon",
          )}
        </strong>
      </aside>
    );
  const showSaved =
    saved !== undefined && provider.auth === "apiKey" && provider.configured && !key;
  const test = async () => {
    const rpc = requirePeer(peer);
    const result = await testProvider(rpc, provider.id, testModelId);
    task.setSuccess(
      t(
        result.verification === "credentials" ? "media.credentialsVerified" : "models.testSuccess",
        { count: result.modelCount ?? 0 },
      ),
    );
  };
  return (
    <aside
      aria-label={t("models.providerSettings")}
      className={compact ? styles.stack : `${styles.panel} ${styles.stack}`}
    >
      {!compact && (
        <div className={detailStyles.providerHeading}>
          <span
            aria-hidden="true"
            className={`${modelStyles.monogram} ${detailStyles.detailMonogram}`}
            data-group={provider.group}
          >
            {providerMonogram(provider.id, provider.name)}
          </span>
          <div>
            <h2>{provider.name}</h2>
            <p className={styles.note}>
              {t(`models.auth.${provider.auth}`)} · {modelCountText(provider, t)}
            </p>
          </div>
          {provider.configured && (
            <Chip tone="ok" className={detailStyles.connected}>
              {t("auth.state.connected")}
            </Chip>
          )}
        </div>
      )}
      {providerPlan(provider.id) && (
        <p className={styles.note}>
          {t("models.planKey", { plan: providerPlan(provider.id)?.name ?? "" })}
        </p>
      )}
      {provider.baseUrl && (
        <p className={styles.note}>{t("models.endpoint", { url: provider.baseUrl })}</p>
      )}
      {provider.id === "anthropic" && !compact && <ClaudePlanNote />}
      {provider.configured && provider.auth !== "oauth" && (
        <p>
          {provider.keyHint === undefined
            ? t("setup.saved")
            : t("models.keySaved", { hint: provider.keyHint })}
        </p>
      )}
      {!compact && <TaskStatus task={task} />}
      {provider.auth === "apiKey" ? (
        <>
          <form
            className={styles.stack}
            onSubmit={(event) => {
              event.preventDefault();
              // Without the submit button, Enter in the lone key field still submits the form.
              if (!key) return;
              void task.run(async () => {
                const rpc = requirePeer(peer);
                if (task.blocked) return;
                try {
                  await saveKey(rpc, provider.id, key);
                } finally {
                  setKey("");
                }
                await refresh();
                await test();
              });
            }}
          >
            <TextField
              label={t("models.apiKey")}
              description={provider.envVarName}
              type="password"
              autoComplete="new-password"
              value={key}
              disabled={task.busy || task.blocked || !peer}
              placeholder={t("models.pasteKey")}
              onChange={(event) => setKey(event.target.value)}
            />
            {/* Compact: once a key is saved, its hint line stands in for the note and the import. */}
            {!(compact && provider.configured) && (
              <p className={styles.note}>{t(compact ? "models.keyNoteShort" : "models.keyNote")}</p>
            )}
            {provider.envDetected && !(compact && provider.configured) && (
              <div className={detailStyles.envRow}>
                <p>{t("models.envDetected", { name: provider.envVarName ?? "" })}</p>
                <Button
                  variant="secondary"
                  disabled={task.busy || task.blocked || !peer}
                  onClick={() =>
                    void task.run(async () => {
                      await writeCredential(() =>
                        requirePeer(peer).call("providers.importFromEnv", {
                          providerId: provider.id,
                        }),
                      );
                      setKey("");
                      await refresh();
                      await test();
                    })
                  }
                >
                  {t("models.import")}
                </Button>
              </div>
            )}
            {!showSaved && (
              <Button type="submit" loading={task.busy} disabled={!key || task.blocked || !peer}>
                {t("models.saveAndTest")}
              </Button>
            )}
          </form>
          {showSaved && saved}
        </>
      ) : provider.auth === "oauth" ? (
        // The only sign-in provider is the ChatGPT plan (订阅); the heading above names it.
        <ChatGPTSignIn
          provider={provider}
          refresh={refresh}
          lead={
            <p className={styles.note}>
              {t(provider.id === CHATGPT_CODEX_PROVIDER ? "chatgpt.codex.intro" : "chatgpt.intro")}
            </p>
          }
        />
      ) : provider.id === MAGPIE_PROVIDER.id ? (
        <MagpieProviderForm
          provider={provider}
          refresh={refresh}
          task={task}
          onDirtyChange={onDirtyChange}
        />
      ) : provider.auth === "custom" ? (
        <CustomProviderForm
          provider={provider}
          testModelId={testModelId}
          addModelIds={addModelIds}
          task={task}
          refresh={refresh}
          onDirtyChange={onDirtyChange}
        />
      ) : provider.available && provider.auth === "cloud" ? (
        <CloudProviderForm
          provider={provider}
          task={task}
          refresh={refresh}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <>
          <strong>{t("common.comingSoon")}</strong>
          <p className={styles.note}>{t("models.cloudSoon")}</p>
        </>
      )}
      {!compact && provider.configured && provider.auth !== "oauth" && (
        <>
          {provider.auth === "apiKey" && (
            <Button
              variant="secondary"
              disabled={task.busy || !peer}
              onClick={() =>
                void task.run(async () => {
                  await requirePeer(peer).call("providers.selectAuth", {
                    providerId: provider.id,
                    auth: "apiKey",
                  });
                  await refresh();
                })
              }
            >
              {t(provider.selectedAuth === "apiKey" ? "auth.active" : "auth.use")}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={
              task.busy ||
              !peer ||
              (provider.selectedAuth !== undefined && provider.selectedAuth !== provider.auth)
            }
            onClick={() => void task.run(test)}
          >
            {t("models.test")}
          </Button>
          {confirmRemove ? (
            <div className={styles.stack}>
              <p>{t("models.removeConfirm", { provider: provider.name })}</p>
              <div className={styles.wrap}>
                <Button
                  disabled={task.busy || !peer}
                  onClick={() =>
                    void task.run(async () => {
                      await requirePeer(peer).call("providers.remove", {
                        providerId: provider.id,
                        ...(provider.auth === "apiKey" || provider.auth === "cloud"
                          ? { auth: provider.auth }
                          : {}),
                      });
                      setKey("");
                      setConfirmRemove(false);
                      await refresh();
                    })
                  }
                >
                  {t("setup.confirmRemove")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={task.busy}
                  onClick={() => setConfirmRemove(false)}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" disabled={task.busy} onClick={() => setConfirmRemove(true)}>
              {t("setup.remove")}
            </Button>
          )}
        </>
      )}
    </aside>
  );
}
