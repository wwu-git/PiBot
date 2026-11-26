import { type MethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { type Peer, useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { advanceStatus, backgroundOptions, type Status, startError } from "./import-state.ts";

export type ImportJob = {
  botId: string;
  importId: string;
  status?: Status;
  hasProject: boolean;
  cancelRequested: boolean;
  elapsedMs?: number;
  startedAt: number;
};

type JobAction = "start" | "cancel" | "undo";

export function useImportJob() {
  const { peer } = useRpc();
  const [job, setJob] = useState<ImportJob>();
  const [busy, setBusy] = useState<JobAction>();
  const [error, setError] = useState<ReturnType<typeof startError>>();
  const action = useRef<JobAction | undefined>(undefined);
  const attempt = useRef<{ id: string; acknowledged: boolean } | undefined>(undefined);
  const startRequest = useRef<{ peer: Peer; abort: AbortController } | undefined>(undefined);
  useEffect(
    () => () => {
      if (startRequest.current?.peer === peer) startRequest.current?.abort.abort();
    },
    [peer],
  );
  const rejectStart = useCallback((id: string, key: ReturnType<typeof startError>) => {
    if (attempt.current?.id !== id || attempt.current.acknowledged) return;
    attempt.current = undefined;
    setJob(undefined);
    setError(key);
  }, []);
  const apply = useCallback((next: Status) => {
    if (attempt.current?.id !== next.importId) return;
    attempt.current.acknowledged = true;
    setJob((previous) => {
      if (previous?.importId !== next.importId) return previous;
      const status = previous.status ? advanceStatus(previous.status, next) : next;
      return {
        ...previous,
        status,
        elapsedMs:
          status.state === "completed"
            ? (previous.elapsedMs ?? performance.now() - previous.startedAt)
            : previous.elapsedMs,
      };
    });
  }, []);
  useRpcEvent("import.progress", apply);

  const importId = job?.importId;
  const state = job?.status?.state;
  const pending = !!job && (!state || state === "running" || state === "undoing");
  const starting = busy === "start";
  useEffect(() => {
    if (!peer || !importId || !pending || starting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let retry = true;
      try {
        const status = await peer.call(
          "import.status",
          { importId },
          { signal: controller.signal, timeoutMs: 5000 },
        );
        if (!controller.signal.aborted) apply(status);
      } catch (failure) {
        // Ask only after start has settled. A timeout or closed peer cannot rule out a write.
        if (
          !controller.signal.aborted &&
          failure instanceof RpcError &&
          failure.code === RpcErrorCodes.invalidParams &&
          failure.message === "import_unknown" &&
          !attempt.current?.acknowledged
        ) {
          retry = false;
          rejectStart(importId, "conversationImport.error.startNotFound");
        }
      } finally {
        if (retry && !controller.signal.aborted) timer = setTimeout(poll, 1600);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [apply, importId, peer, pending, rejectStart, starting]);

  async function act(kind: JobAction, work: () => Promise<void>) {
    if (!peer || action.current) return;
    action.current = kind;
    setBusy(kind);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      setError(startError(failure));
    } finally {
      action.current = undefined;
      setBusy(undefined);
    }
  }

  function start(params: MethodParams["import.start"]) {
    if (!peer || attempt.current) return;
    void act("start", async () => {
      const id = params.importId;
      attempt.current = { id, acknowledged: false };
      setJob({
        importId: id,
        botId: params.botId,
        hasProject: !!params.projects?.some(({ reviewId }) => reviewId),
        cancelRequested: false,
        startedAt: performance.now(),
      });
      const abort = new AbortController();
      startRequest.current = { peer, abort };
      try {
        apply(await peer.call("import.start", params, { signal: abort.signal }));
      } catch (failure) {
        if (
          !abort.signal.aborted &&
          failure instanceof RpcError &&
          (failure.code === RpcErrorCodes.invalidParams ||
            failure.code === RpcErrorCodes.methodNotFound ||
            failure.code === RpcErrorCodes.unsupported)
        )
          rejectStart(id, startError(failure));
        // When an acknowledgement may be lost, retain this ID and let status settle the result.
      } finally {
        startRequest.current = undefined;
      }
    });
  }

  function cancel() {
    if (!peer || job?.status?.state !== "running" || job.status.cleanup) return;
    const { importId } = job;
    void act("cancel", async () => {
      setJob((value) => value && { ...value, cancelRequested: true });
      try {
        apply(await peer.call("import.cancel", { importId }, backgroundOptions));
      } catch (failure) {
        setJob((value) => value && { ...value, cancelRequested: false });
        throw failure;
      }
    });
  }

  function undo() {
    if (!peer || !job?.status) return;
    const { importId } = job;
    void act("undo", async () => {
      apply(await peer.call("import.undo", { importId }, backgroundOptions));
    });
  }

  /** Undo a batch from the import history (another session, or before a restart). */
  function undoPast(status: Status) {
    if (!peer || action.current || pending) return;
    const { importId } = status;
    attempt.current = { id: importId, acknowledged: true };
    setJob({
      importId,
      botId: "",
      status,
      hasProject: !!status.projectFiles,
      cancelRequested: false,
      startedAt: performance.now(),
    });
    void act("undo", async () => {
      apply(await peer.call("import.undo", { importId }, backgroundOptions));
    });
  }

  return {
    job,
    busy,
    connected: !!peer,
    error,
    start,
    cancel,
    undo,
    undoPast,
    clear() {
      if (action.current || pending) return;
      attempt.current = undefined;
      setJob(undefined);
      setError(undefined);
    },
  };
}
