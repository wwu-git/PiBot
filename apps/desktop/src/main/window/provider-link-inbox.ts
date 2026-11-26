import type { ProviderImportIntent } from "@pibot/protocol-base";
import { app } from "electron";

/** LaunchServices can deliver the link before app readiness or the GUI/owner role loads. */
export function captureProviderLinks(argv: readonly string[], signal: AbortSignal) {
  let listener: ((intent: ProviderImportIntent) => void) | undefined;
  let queued: string | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  const clear = () => {
    queued = undefined;
    clearTimeout(expiry);
  };
  const deliver = (url: string) => {
    const current = ++revision;
    // Avoid loading zod on the GUI startup path for ordinary app opens.
    void import("./provider-import-url.ts").then(
      ({ parseProviderImportUrl }) => {
        if (current === revision) listener?.(parseProviderImportUrl(url));
      },
      () => {
        if (current === revision) listener?.({ status: "refused" });
      },
    );
  };
  const receive = (url: string) => {
    if (!/^pibot:\/\/provider\/import(?=[?#]|$)/i.test(url)) return false;
    // Keep only one bounded raw link before bootstrap completes.
    const value = url.length <= 16_384 ? url : "pibot://provider/import";
    if (listener) deliver(value);
    else {
      clear();
      queued = value;
      expiry = setTimeout(clear, 120_000);
      expiry.unref();
    }
    return true;
  };
  const openUrl = (event: Electron.Event, url: string) => {
    if (receive(url)) event.preventDefault();
  };
  const secondInstance = (_event: Electron.Event, args: string[]) => {
    args.some(receive);
  };
  argv.some(receive);
  app.on("open-url", openUrl);
  app.on("second-instance", secondInstance);
  const dispose = () => {
    clear();
    listener = undefined;
    revision++;
    app.off("open-url", openUrl);
    app.off("second-instance", secondInstance);
  };
  signal.addEventListener("abort", dispose, { once: true });
  return {
    subscribe(next: (intent: ProviderImportIntent) => void) {
      if (signal.aborted) return () => {};
      listener = next;
      const initial = queued;
      clear();
      if (initial) deliver(initial);
      return () => {
        if (listener === next) {
          listener = undefined;
          revision++;
        }
      };
    },
  };
}
export type ProviderLinkInbox = ReturnType<typeof captureProviderLinks>;
