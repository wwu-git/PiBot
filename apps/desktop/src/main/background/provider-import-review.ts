import type { Logger } from "@pibot/observability";
import {
  type ProviderImportDecision,
  type ProviderImportIntent,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { startBrainHost } from "../brain/brain-host.ts";

type Brain = ReturnType<typeof startBrainHost>;
const REVIEW_MS = 120_000;

export function createProviderImportReview(open: () => void, logger: Logger) {
  let queued: { intent: ProviderImportIntent; client?: string } | undefined;
  let queueExpiry: ReturnType<typeof setTimeout> | undefined;
  let presenting: { client: string } | undefined;
  let shown: { client: string; id: string; brain: Brain } | undefined;
  const clearQueue = () => {
    clearTimeout(queueExpiry);
    queued = undefined;
  };
  const cancel = (id: string, brain: Brain) =>
    void brain
      .resolveProviderImport({ id, botIds: null })
      .catch(() => logger.warn("Provider import review cleanup unavailable"));
  const discard = () => {
    const previous = shown;
    shown = undefined;
    if (previous) cancel(previous.id, previous.brain);
  };
  return {
    offer(intent: ProviderImportIntent, client?: string) {
      clearQueue();
      presenting = undefined;
      discard();
      queued = { intent, client };
      queueExpiry = setTimeout(clearQueue, REVIEW_MS);
      queueExpiry.unref();
      open();
    },
    async present(client: string, brain: Brain) {
      const current = queued;
      if (!current || (current.client && current.client !== client)) return;
      clearQueue();
      const generation = { client };
      presenting = generation;
      let preview: Awaited<ReturnType<Brain["stageProviderImport"]>>;
      try {
        preview = await brain.stageProviderImport(current.intent);
      } catch {
        logger.warn("Provider import review unavailable");
        preview = { status: "refused" };
      }
      if (presenting !== generation) {
        if (preview.status === "review") cancel(preview.id, brain);
        return;
      }
      presenting = undefined;
      if (preview.status === "review") shown = { client, id: preview.id, brain };
      brain.navigate({ view: "provider-import", preview });
    },
    resolve(client: string, decision: ProviderImportDecision) {
      const current = shown;
      if (!current || current.client !== client || current.id !== decision.id) {
        if (decision.botIds === null) return { ok: true };
        throw new RpcError(RpcErrorCodes.invalidParams, "provider_import_expired");
      }
      shown = undefined;
      return current.brain.resolveProviderImport(decision);
    },
    dismiss(client: string) {
      if (queued?.client === client) clearQueue();
      if (presenting?.client === client) presenting = undefined;
      if (shown?.client === client) discard();
    },
    dispose() {
      presenting = undefined;
      clearQueue();
      discard();
    },
  };
}
