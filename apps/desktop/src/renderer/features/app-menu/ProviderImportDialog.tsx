import { FacePicker } from "@pibot/plugins/ui";
import { importedMagpieRoute, type UiNavigation } from "@pibot/protocol";
import { useNavigation, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { AppDialog } from "./AppDialog.tsx";
import styles from "./provider-import.module.css";

type Preview = Extract<UiNavigation, { view: "provider-import" }>["preview"];

export function ProviderImportDialog() {
  const t = useT();
  const { dialog, closeDialog } = useNavigation();
  if (dialog?.owner !== "provider-import") return null;
  const preview = dialog.state as Preview;
  const close = () => closeDialog(dialog.key);
  return preview.status === "refused" ? (
    <AppDialog
      title={
        preview.name
          ? t("providerImport.refusedFrom", { name: preview.name })
          : t("providerImport.refused")
      }
      kind="provider-import"
      mark={{ icon: "refresh", tone: "violet" }}
      close={close}
    >
      <p className={styles.intro}>{t("providerImport.refusedIntro")}</p>
      <p className={styles.note}>{t("providerImport.refusedNote")}</p>
      <Button variant="secondary" onClick={close}>
        {t("providerImport.gotIt")}
      </Button>
    </AppDialog>
  ) : (
    <ProviderImportReview key={dialog.key} preview={preview} close={close} />
  );
}

function ProviderImportReview({
  preview,
  close,
}: {
  preview: Extract<Preview, { status: "review" }>;
  close(): void;
}) {
  const t = useT();
  const { bots } = useWorkspace();
  // A local gateway such as Magpie forwards to services set up inside it; the card says so.
  const gateway = importedMagpieRoute(preview);
  const avatars = new Map(bots.map((bot) => [bot.id, bot.avatarImage]));
  const picker = preview.bots.map((bot) => ({ ...bot, avatarImage: avatars.get(bot.id) }));
  const [selected, setSelected] = useState(() => new Set(preview.initiallySelected));
  const [changing, setChanging] = useState(false);
  const [failed, setFailed] = useState(false);
  const consumed = useRef(false);
  const applying = useRef(false);
  const dismissing = useRef(false);
  const allowDismiss = () => {
    if (applying.current) return false;
    dismissing.current = true;
    return true;
  };
  const dismiss = () => {
    if (allowDismiss()) close();
  };
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(cancelTimer.current);
    return () => {
      // Strict-mode effect replay must not cancel a review that is still mounted.
      cancelTimer.current = setTimeout(() => {
        if (!consumed.current) {
          void window.pibot.resolveProviderImport({ id: preview.id, botIds: null }).catch(() => {
            // Closing the owner attachment also clears its review; the brain keeps a bounded TTL.
          });
        }
      });
    };
  }, [preview.id]);
  const confirm = async () => {
    if (consumed.current || dismissing.current || !selected.size) return;
    consumed.current = true;
    applying.current = true;
    setChanging(true);
    try {
      await window.pibot.resolveProviderImport({ id: preview.id, botIds: [...selected] });
      close();
    } catch {
      setFailed(true);
    } finally {
      applying.current = false;
      setChanging(false);
    }
  };

  return (
    <AppDialog
      title={t("providerImport.title", { name: preview.name })}
      kind="provider-import"
      mark={{ icon: "refresh", tone: "violet" }}
      busy={changing}
      canClose={allowDismiss}
      close={dismiss}
    >
      <p className={styles.intro}>{t("providerImport.intro", { name: preview.name })}</p>
      <div className={styles.grid}>
        <section className={styles.card}>
          <h2>{t("providerImport.changes")}</h2>
          <dl className={styles.facts}>
            <dt>{t("providerImport.provider")}</dt>
            <dd>
              {gateway ? t("providerImport.localGateway", { name: preview.name }) : preview.name}
            </dd>
            <dt>{t("providerImport.address")}</dt>
            {gateway ? (
              <dd>
                {t("providerImport.localAddress", { url: preview.baseUrl, name: preview.name })}
              </dd>
            ) : (
              <dd dir="ltr">{preview.baseUrl}</dd>
            )}
            <dt>{t("providerImport.model")}</dt>
            <dd dir="ltr">{preview.model}</dd>
            <dt>{t("providerImport.key")}</dt>
            <dd>
              {preview.hasKey
                ? t("providerImport.keyIncluded")
                : gateway
                  ? t("providerImport.gatewayNoKey", { name: preview.name })
                  : t("providerImport.noKey")}
            </dd>
          </dl>
        </section>
        <section className={styles.card}>
          <h2>{t("providerImport.applyTo")}</h2>
          <div className={styles.picker}>
            <FacePicker
              bots={picker}
              groups={[]}
              disabled={changing || failed}
              isOn={(_, id) => selected.has(id)}
              toggle={(_, id) =>
                setSelected((previous) => {
                  const next = new Set(previous);
                  if (!next.delete(id)) next.add(id);
                  return next;
                })
              }
            />
          </div>
          <p className={styles.note}>{t("providerImport.selectionNote")}</p>
        </section>
      </div>
      <p className={styles.note}>{t("providerImport.auditNote")}</p>
      {failed && <p role="alert">{t("providerImport.failed")}</p>}
      <div className={styles.actions}>
        <Button variant="secondary" disabled={changing} onClick={dismiss}>
          {t(failed ? "providerImport.ok" : "common.cancel")}
        </Button>
        {!failed && (
          <Button disabled={!selected.size} loading={changing} onClick={() => void confirm()}>
            {t("providerImport.switch")}
          </Button>
        )}
      </div>
    </AppDialog>
  );
}
