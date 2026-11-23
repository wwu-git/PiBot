import type { TranslationKey } from "@pibot/i18n";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Reads and actions share the connection wording, but a capability with its own codes (knowledge)
 * passes its own mapper so its copy is not flattened into 「失败了」.
 */
export type ErrorText = (error: unknown) => TranslationKey;

export function connectorError(error: unknown) {
  if (error instanceof RpcError) {
    if (error.message === "connector_confirmation_ended" && error.code === RpcErrorCodes.timeout)
      return "connectors.nativeConfirmationTimedOut" as const;
    if (error.message === "gui_dialog_busy") return "connectors.nativeConfirmationWaiting" as const;
    const importReason = {
      connector_import_manifest_not_found: "connectors.importReason.manifest_not_found",
      connector_import_mcp_duplicate: "connectors.importReason.mcp_duplicate",
      connector_import_path_outside_plugin: "connectors.importReason.path_outside_plugin",
      connector_import_file_too_large: "connectors.importReason.file_too_large",
      connector_import_layout_unsupported: "connectors.importReason.layout_unsupported",
    } as const;
    if (Object.hasOwn(importReason, error.message))
      return importReason[error.message as keyof typeof importReason];
    if (error.message === "connector_import_symlink") return "connectors.importSymlink" as const;
    if (error.message === "connector_confirmation_cancelled")
      return "connectors.confirmationCancelled" as const;
    if (error.message === "outside_sandbox_cancelled")
      return "connectors.outsideSandbox.cancelled" as const;
    if (error.message === "connector_credential_requires_secret_settings")
      return "connectors.secretSettingsRequired" as const;
    if (error.message === "connector_url_credential_unsupported")
      return "connectors.urlCredentialUnsupported" as const;
    if (error.message === "connector_command_substitution_unsupported")
      return "connectors.commandSubstitutionUnsupported" as const;
    if (error.message === "connector_plugin_secret_reference_unsupported")
      return "connectors.pluginSecretReferenceUnsupported" as const;
    // A skill deleted elsewhere is a changed snapshot, not a bad configuration or preview.
    if (error.code === RpcErrorCodes.connectorStale || error.message === "skill_not_found")
      return "connectors.stale" as const;
    if (error.code === RpcErrorCodes.pluginImportCommitted) return "connectors.committed" as const;
    if (
      error.code === RpcErrorCodes.pluginImportInvalid ||
      error.code === RpcErrorCodes.invalidParams
    )
      return "connectors.invalid" as const;
    if (error.code === RpcErrorCodes.connectorUnavailable) return "connectors.unavailable" as const;
    if (error.code === RpcErrorCodes.secretsUnavailable) {
      return error.message === "secure_storage_busy" ||
        error.message === "secure_storage_timeout" ||
        error.message === "secure_storage_session_pending"
        ? ("connectors.secureStorageBusy" as const)
        : ("connectors.secureStorageUnavailable" as const);
    }
    if (error.code === RpcErrorCodes.closed) return "connectors.offline" as const;
    if (error.code === RpcErrorCodes.busy) return "connectors.busy" as const;
    if (error.code === RpcErrorCodes.timeout) return "connectors.timeout" as const;
    // An internal failure is a bug; 「请重试」 sent people into retry loops that never end.
    if (error.code === RpcErrorCodes.internal) return "connectors.internal" as const;
  }
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "connectors.timeout" as const;
  return "connectors.failed" as const;
}

export function useConnectorRead<T>(
  load: (peer: Peer, signal: AbortSignal) => Promise<T>,
  mapError: ErrorText = connectorError,
) {
  const { peer } = useRpc();
  const [result, setResult] = useState<{ peer: Peer; load: typeof load; value: T }>();
  const [error, setError] = useState<TranslationKey>();
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A refresh invalidates in-flight snapshots.
  useEffect(() => {
    const owner = new AbortController();
    setError(undefined);
    setLoading(!!peer);
    if (!peer) return;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
    void load(peer, signal)
      .then((value) => {
        if (!owner.signal.aborted) setResult({ peer, load, value });
      })
      .catch((failure: unknown) => {
        if (!owner.signal.aborted) setError(mapError(failure));
      })
      .finally(() => {
        if (!owner.signal.aborted) setLoading(false);
      });
    return () => owner.abort();
  }, [peer, load, version, mapError]);
  const value = result?.peer === peer && result.load === load ? result.value : undefined;
  return {
    value,
    error: peer ? error : ("connectors.offline" as TranslationKey),
    loading,
    refresh,
  };
}

/** One bounded page at a time; changing snapshots retires every old cursor. */
export function useConnectorPage<T>(
  load: (
    peer: Peer,
    signal: AbortSignal,
    cursor?: string,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
  snapshot: number,
  resetOnChange = true,
  mapError: ErrorText = connectorError,
) {
  const [position, setPosition] = useState<{ snapshot: number; cursors: (string | undefined)[] }>({
    snapshot,
    cursors: [undefined],
  });
  const cursors = !resetOnChange || position.snapshot === snapshot ? position.cursors : [undefined];
  const cursor = cursors.at(-1);
  const read = useCallback(
    (peer: Peer, signal: AbortSignal) => load(peer, signal, cursor),
    [load, cursor],
  );
  const remote = useConnectorRead(read, mapError);
  const refresh = remote.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Even an unchanged first-page cursor needs a new snapshot.
  useEffect(() => refresh(), [snapshot, refresh]);
  return {
    ...remote,
    cursor,
    previous:
      cursors.length > 1
        ? () => setPosition({ snapshot, cursors: cursors.slice(0, -1) })
        : undefined,
    next: remote.value?.nextCursor
      ? () =>
          setPosition({ snapshot, cursors: [...cursors, remote.value?.nextCursor ?? undefined] })
      : undefined,
  };
}

/** Local cancellation only retires the UI waiter, never claims to undo accepted RPC work. */
export function useConnectorAction(changed: () => void, mapError: ErrorText = connectorError) {
  const { peer } = useRpc();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  const owner = useRef(new AbortController());
  const locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different transport retires local waiters, not the remote operation.
  useEffect(() => {
    owner.current = new AbortController();
    locked.current = false;
    setBusy(false);
    setError(undefined);
    return () => owner.current.abort();
  }, [peer]);
  async function run<T>(
    operation: (peer: Peer, signal: AbortSignal) => Promise<T>,
    timeoutMs = 30_000,
  ) {
    if (!peer || locked.current) return;
    const lifetime = owner.current;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const value = await operation(
        peer,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]),
      );
      return lifetime.signal.aborted ? undefined : value;
    } catch (failure) {
      if (!lifetime.signal.aborted) setError(mapError(failure));
      return undefined;
    } finally {
      if (!lifetime.signal.aborted) {
        locked.current = false;
        setBusy(false);
        // Conflict, timeout and lost ACK all require a fresh authoritative snapshot.
        changed();
      }
    }
  }
  return { run, busy, error, disabled: busy || !peer };
}
