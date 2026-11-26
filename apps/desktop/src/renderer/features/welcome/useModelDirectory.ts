import { useMagpieDetection } from "@pibot/models/ui";
import type { MethodResults, ModelInfo, Provider } from "@pibot/protocol";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { requirePeer, SetupError } from "../settings/operations.ts";

export function useModelDirectory() {
  const { peer } = useRpc();
  const magpie = useMagpieDetection(true);
  const owner = useRef({ peer, epoch: 0, controller: new AbortController() });
  if (owner.current.peer !== peer)
    owner.current = { peer, epoch: owner.current.epoch + 1, controller: new AbortController() };
  const session = owner.current;
  const { epoch } = session;
  const serial = useRef(0);
  const detectSerial = useRef(0);
  const [data, setData] = useState<{ epoch: number; providers: Provider[]; models: ModelInfo[] }>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [ollama, setOllama] = useState<MethodResults["local.detectOllama"]>();
  const [detecting, setDetecting] = useState(true);
  const current = useCallback(
    () => owner.current === session && !session.controller.signal.aborted,
    [session],
  );
  const signal = useCallback(() => {
    if (!current()) throw new SetupError("setup.disconnected");
    return session.controller.signal;
  }, [current, session]);
  const refresh = useCallback(async () => {
    // An unmounted form may finish saving after reconnect; reject before touching the new read.
    const lifetime = signal();
    const read = ++serial.current;
    const ownsRead = () => current() && !lifetime.aborted && read === serial.current;
    const requestSignal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
    setLoading(true);
    try {
      const rpc = requirePeer(peer);
      const [providers, models] = await Promise.all([
        rpc.call("providers.list", undefined, { signal: requestSignal }),
        rpc.call("models.list", { availableOnly: true }, { signal: requestSignal }),
      ]);
      requestSignal.throwIfAborted();
      if (!current()) throw new SetupError("setup.disconnected");
      if (ownsRead()) {
        setData({ epoch, providers, models });
        setFailed(false);
      }
      return { providers, models };
    } catch (error) {
      if (ownsRead()) setFailed(true);
      throw error;
    } finally {
      if (ownsRead()) setLoading(false);
    }
  }, [peer, epoch, current, signal]);
  const detect = useCallback(async () => {
    if (!current()) return;
    const lifetime = signal();
    const read = ++detectSerial.current;
    const ownsRead = () => current() && !lifetime.aborted && read === detectSerial.current;
    const requestSignal = AbortSignal.any([lifetime, AbortSignal.timeout(10_000)]);
    setDetecting(true);
    try {
      const result = await requirePeer(peer).call("local.detectOllama", undefined, {
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      if (ownsRead()) setOllama(result);
    } catch {
      // Detection is optional; the catalog and manual local configuration remain available.
      if (ownsRead()) setOllama(undefined);
    } finally {
      if (ownsRead()) setDetecting(false);
    }
  }, [peer, current, signal]);
  useLayoutEffect(() => {
    const controller = new AbortController();
    session.controller = controller;
    setOllama(undefined);
    setFailed(false);
    void refresh().catch(() => {
      /* The model step displays the read failure and retry. */
    });
    void detect();
    return () => {
      controller.abort();
      serial.current++;
      detectSerial.current++;
    };
  }, [session, refresh, detect]);
  useRpcEvent("providers.changed", () => {
    void refresh().catch(() => {
      /* The catalog retains an explicit error until a successful read. */
    });
  });
  return {
    epoch,
    data: data?.epoch === epoch ? data : undefined,
    loading,
    failed,
    ollama,
    magpie: magpie.result,
    detecting,
    refresh,
    detect,
    current,
    signal,
  };
}
