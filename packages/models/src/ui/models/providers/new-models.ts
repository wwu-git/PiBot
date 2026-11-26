// Notices models a saved custom provider now offers but its saved list does not include.
import { MAGPIE_PROVIDER, type Provider } from "@pibot/models-contract/full";
import { useRpc } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";

const CONCURRENCY = 2;
const TIMEOUT_MS = 8000;

/**
 * One quiet check per opening of the page: no polling and no retries. A provider that cannot be
 * reached simply shows no hint; the brain's RPC wrapper already records the redacted failure.
 * Models the provider stopped listing are ignored here, removing them stays the user's choice.
 */
export function useNewModels(providers: readonly Provider[], active: boolean) {
  const { peer } = useRpc();
  const [found, setFound] = useState<ReadonlyMap<string, string[]>>(new Map());
  // What each provider offered during this visit; later refreshes only re-read the saved list.
  const offeredCache = useRef(new Map<string, string[]>());
  const ids = providers
    .filter(
      (provider) =>
        provider.auth === "custom" && provider.configured && provider.id !== MAGPIE_PROVIDER.id,
    )
    .map((provider) => provider.id)
    .sort()
    .join("\n");
  // A providers.changed refresh re-reads the saved lists, so added models drop out at once.
  const revision = providers.map((provider) => `${provider.id}:${provider.modelCount}`).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed provider list re-reads saved lists.
  useEffect(() => {
    if (!active || !peer || !ids) {
      offeredCache.current.clear();
      setFound(new Map());
      return;
    }
    const controller = new AbortController();
    const queue = ids.split("\n");
    const next = new Map<string, string[]>();
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const options = { signal: controller.signal, timeoutMs: TIMEOUT_MS };
        try {
          const cached = offeredCache.current.get(id);
          const [saved, offered] = await Promise.all([
            peer.call("customProviders.get", { providerId: id }, options),
            cached ??
              peer
                .call("customProviders.fetchSavedModels", { providerId: id }, options)
                .then((result) => result.models.map((model) => model.id)),
          ]);
          offeredCache.current.set(id, offered);
          const known = new Set([
            ...saved.models.map((model) => model.id),
            ...(saved.imageModels ?? []).map((model) => model.id),
          ]);
          const fresh = [...new Set(offered)].filter((model) => !known.has(model));
          if (fresh.length) next.set(id, fresh);
        } catch {
          // Offline, signed out or slow: the hint is optional and the saved list keeps working.
        }
      }
    };
    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      if (!controller.signal.aborted) setFound(next);
    });
    return () => controller.abort();
  }, [active, peer, ids, revision]);
  return found;
}
