import type { MethodResults } from "@pibot/models-contract/full";
import { useRpc } from "@pibot/renderer-kit";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

const lifetimeMs = 15_000;
const pollMs = 10_000;
const pageVisible = () => document.visibilityState !== "hidden";

type Scope = {
  peer: ReturnType<typeof useRpc>["peer"];
  controller: AbortController;
  active?: AbortController;
  expiry?: ReturnType<typeof setTimeout>;
};

/** A discovery proof expires independently of whether another probe ever finishes. */
export function useMagpieDetection(auto: boolean) {
  const { peer } = useRpc();
  const owner = useRef<Scope>({ peer, controller: new AbortController() });
  if (owner.current.peer !== peer) owner.current = { peer, controller: new AbortController() };
  const scope = owner.current;
  const [state, setState] = useState<{
    scope: Scope;
    checking: boolean;
    result?: MethodResults["local.detectMagpie"];
    proof?: { until: number };
  }>();
  const reset = useCallback(() => {
    scope.active?.abort();
    scope.active = undefined;
    clearTimeout(scope.expiry);
    scope.expiry = undefined;
    setState((previous) => (previous?.scope === scope ? undefined : previous));
  }, [scope]);
  const detect = useCallback(
    async (port?: number) => {
      if (
        owner.current !== scope ||
        !scope.peer ||
        scope.controller.signal.aborted ||
        scope.active ||
        !pageVisible()
      )
        return;
      const request = new AbortController();
      scope.active = request;
      const deadline = setTimeout(() => request.abort(), 3000);
      const signal = AbortSignal.any([scope.controller.signal, request.signal]);
      const current = () => owner.current === scope && scope.active === request;
      // Keep a still-current proof while refreshing, so the entry does not blink every poll.
      setState((previous) => ({
        ...(previous?.scope === scope ? previous : undefined),
        scope,
        checking: true,
      }));
      try {
        const result = await scope.peer.call("local.detectMagpie", { port }, { signal });
        signal.throwIfAborted();
        if (!current()) return;
        clearTimeout(scope.expiry);
        const proof = result.running ? { until: Date.now() + lifetimeMs } : undefined;
        setState({ scope, checking: false, result, proof });
        if (proof)
          scope.expiry = setTimeout(() => {
            // A superseded timer must never withdraw a newer successful proof.
            setState((previous) =>
              previous?.scope === scope && previous.proof === proof
                ? { scope, checking: previous.checking }
                : previous,
            );
          }, lifetimeMs);
      } catch {
        // Discovery is optional; failure/cancellation withdraws the earlier add entry.
        if (current() && !scope.controller.signal.aborted) {
          clearTimeout(scope.expiry);
          setState({ scope, checking: false, result: { running: false } });
        }
      } finally {
        clearTimeout(deadline);
        if (current()) scope.active = undefined;
      }
    },
    [scope],
  );
  useLayoutEffect(() => {
    scope.controller = new AbortController();
    reset();
    let poll: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const probe = async () => {
      const attempt = ++generation;
      clearTimeout(poll);
      if (!auto || !pageVisible()) return;
      await detect();
      if (attempt === generation && !scope.controller.signal.aborted && pageVisible())
        poll = setTimeout(() => void probe(), pollMs);
    };
    const focus = () => void probe();
    const visibility = () => {
      ++generation;
      clearTimeout(poll);
      if (!pageVisible()) reset();
      else void probe();
    };
    if (auto) {
      void probe();
      window.addEventListener("focus", focus);
    }
    document.addEventListener("visibilitychange", visibility);
    return () => {
      ++generation;
      scope.controller.abort();
      reset();
      clearTimeout(poll);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [auto, detect, reset, scope]);
  const visible = state?.scope === scope && !scope.controller.signal.aborted;
  const valid = !state?.result?.running || (state.proof && state.proof.until > Date.now());
  return {
    checking: visible && state.checking,
    result: visible && valid ? state.result : undefined,
    detect,
    reset,
  };
}
