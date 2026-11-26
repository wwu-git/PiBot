// Helps users connect their browser after a run falls back to the Bot browser.
import type { BrowserExtensionStatusSchema, ChatNotice } from "@pibot/protocol";
import { useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useState } from "react";
import type { z } from "zod";
import styles from "../chat.module.css";
import lively from "../tools/lively.module.css";

type Status = z.infer<typeof BrowserExtensionStatusSchema>;
type BrowserId = NonNullable<Status["defaultBrowser"]>["id"];

const CHROME_STORE = "https://chromewebstore.google.com/detail/jfaelafpdicbnlnbngicngehehafpmbk";
const FIREFOX_STORE = "https://addons.mozilla.org/firefox/addon/pibot-browser/";
const STORES: Partial<Record<BrowserId, string>> = {
  chrome: CHROME_STORE,
  firefox: FIREFOX_STORE,
};
const WAIT_MS = 3 * 60_000;
const STATUS_POLL_MS = 2_000;
const STATUS_TIMEOUT_MS = 5_000;
const dismissedKey = "pibot.browser-extension.install.dismissed";

export function BrowserExtensionInstallCard({
  notice,
}: {
  notice: Extract<ChatNotice, { kind: "browser_extension" }>;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [status, setStatus] = useState<Status>();
  const [phase, setPhase] = useState<"ready" | "waiting" | "success" | "failed" | "closed">(
    "ready",
  );
  const [deadline, setDeadline] = useState(0);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissedKey) === "1";
    } catch {
      // Storage blocked: the card simply shows again.
      return false;
    }
  });

  const optedOut = status?.preference === "bot";
  useEffect(() => {
    if (!peer || dismissed || optedOut || (phase !== "ready" && phase !== "waiting")) return;
    const lifetime = new AbortController();
    let poll: ReturnType<typeof setTimeout> | undefined;
    const expire =
      phase === "waiting"
        ? setTimeout(() => setPhase("failed"), Math.max(0, deadline - Date.now()))
        : undefined;
    const refresh = async () => {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]);
      try {
        const value = await peer.call("browserExtension.status", {}, { signal });
        if (lifetime.signal.aborted) return;
        setStatus(value);
        if (phase === "waiting" && value.extension === "connected") {
          setPhase("success");
          return;
        }
      } catch {
        // The renderer may reconnect while the store is open; keep waiting for a fresh status.
      }
      if (phase === "waiting" && !lifetime.signal.aborted)
        poll = setTimeout(() => void refresh(), STATUS_POLL_MS);
    };
    void refresh();
    return () => {
      lifetime.abort();
      clearTimeout(poll);
      clearTimeout(expire);
    };
  }, [peer, phase, dismissed, optedOut, deadline]);
  useRpcEvent("browserExtension.changed", (value) => {
    setStatus(value);
    setPhase((current) => {
      if (value.extension === "connected" && (current === "waiting" || current === "failed"))
        return "success";
      if (value.extension !== "connected" && current === "success") return "ready";
      return current;
    });
  });

  if (!status || optedOut || dismissed || phase === "closed") return null;
  const id = status.defaultBrowser?.id;
  const store = id ? STORES[id] : undefined;
  if (phase === "ready" && status.extension === "connected") return null;
  if (phase === "ready" && id === "edge")
    return (
      <p className={styles.systemLine} role="note">
        {t("browserExtension.install.edgeFallback")}
      </p>
    );
  if (!store) return null;
  const browser = status.defaultBrowser?.name ?? "";

  const install = () => {
    if (!store) return;
    // The main process hands https links to the system browser, which is this default browser.
    window.open(store, "_blank", "noopener,noreferrer");
    setPhase("waiting");
    setDeadline(Date.now() + WAIT_MS);
  };
  const neverAsk = () => {
    try {
      localStorage.setItem(dismissedKey, "1");
    } catch {
      // Storage blocked: only this convenience is lost; the card closes for now.
    }
    setDismissed(true);
  };
  const title =
    phase === "success"
      ? t("browserExtension.install.success", { browser })
      : phase === "failed"
        ? t("browserExtension.install.failed")
        : t("browserExtension.install.title", { browser });

  return (
    <section
      className={`${lively.card} ${lively.extensionInstall}`}
      aria-label={title}
      data-notice-id={notice.id}
    >
      <header>
        <Icon name="globe" size={16} />
        <span>{title}</span>
      </header>
      <div className={lively.extensionBody}>
        {phase === "ready" && (
          <>
            <p>{t("browserExtension.install.description")}</p>
            <ol>
              <li>{t("browserExtension.install.step.open", { browser })}</li>
              <li>
                {t(
                  id === "firefox"
                    ? "browserExtension.install.step.addFirefox"
                    : "browserExtension.install.step.add",
                )}
              </li>
              <li>{t("browserExtension.install.step.connect")}</li>
            </ol>
          </>
        )}
        {phase === "waiting" && <p>{t("browserExtension.install.waiting", { browser })}</p>}
        {phase === "success" && <p>{t("browserExtension.install.successNote")}</p>}
        {phase === "failed" && <p>{t("browserExtension.install.failedNote")}</p>}
      </div>
      <footer>
        {(phase === "ready" || phase === "failed") && (
          <>
            <Button variant="primary" onClick={install}>
              {t(
                phase === "ready"
                  ? "browserExtension.install.open"
                  : "browserExtension.install.again",
              )}
            </Button>
            <Button variant="ghost" onClick={() => setPhase("closed")}>
              {t("browserExtension.install.useBot")}
            </Button>
          </>
        )}
        {phase === "waiting" && (
          <Button variant="ghost" onClick={install}>
            {t("browserExtension.install.again")}
          </Button>
        )}
        {phase !== "success" && (
          <Button variant="ghost" onClick={neverAsk}>
            {t("browserExtension.install.never")}
          </Button>
        )}
      </footer>
    </section>
  );
}
