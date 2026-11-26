// Adapt the authenticated runner peer to the execution target interface.
import { randomUUID } from "node:crypto";
import type { BackgroundJob, ExecutionTarget, GitEntryResult } from "@pibot/execution";
import { ExecError } from "@pibot/execution";
import {
  type CapabilityManifest,
  createPeer,
  HostComputerMethods,
  type Params,
  type Port,
  type Result,
  RpcError,
  RpcErrorCodes,
  RunnerExecutionErrorSchema,
  type RunnerMethods,
  runnerEvents,
  runnerMethods,
} from "@pibot/protocol-base";
import { createCommandChannel } from "./remote-commands.ts";
import { createFileChannel } from "./remote-files.ts";
import { createRemoteManagedGit } from "./remote-managed-git.ts";
import { createReconcileChannel } from "./remote-reconcile.ts";
import type {
  DetachedJob,
  IssuedKey,
  Reconciliation,
  RemoteDeps,
  RemoteTarget,
} from "./remote-state.ts";
import { createTransferChannel } from "./remote-transfers.ts";

const MAX_RECONCILIATIONS = 1024;

export async function createRemoteExecutionTarget(
  port: Port,
  capabilities?: {
    receive(targetId: string, manifest: CapabilityManifest): void;
    enabled(): readonly string[];
    subscribe(listener: (ids: readonly string[]) => void): () => void;
    failed(): void;
    signal: AbortSignal;
  },
): Promise<RemoteTarget> {
  const peer = createPeer(port, {
    methods: runnerMethods,
    events: runnerEvents,
    errorDataSchema: RunnerExecutionErrorSchema,
  });
  const { call: rpc } = peer;
  const lifetime = new AbortController();
  const jobs = new Map<string, BackgroundJob>();
  const jobCleanups = new Map<string, { detach: () => void }>();
  const detachedJobs = new Map<string, DetachedJob>();
  const reconciliation = new Map<string, Omit<Reconciliation, "idempotencyKey">>();
  const dispatches = new Map<string, () => void | Promise<void>>();
  let disconnected = false;
  // A dropped link has to end the calls already in flight. Waiting for a peer that will
  // never answer is what left the folder's run (and its write lock) stuck after a runner restart.
  const linkLost = new AbortController();
  const link = AbortSignal.any([lifetime.signal, linkLost.signal]);
  const markDisconnected = () => {
    disconnected = true;
    if (!linkLost.signal.aborted) linkLost.abort(new ExecError("closed", "runner_disconnected"));
  };
  /** A caller's own cancellation and the link's death both end the call. */
  const callSignal = (signal: AbortSignal) => AbortSignal.any([signal, link]);
  /**
   * The peer's own close listener is registered before ours and rejects in-flight calls
   * with a bare `closed` error, so the cause is named here instead of relying on listener order.
   */
  async function call<M extends keyof RunnerMethods>(
    method: M,
    params: Params<RunnerMethods, M>,
    options?: Parameters<typeof peer.call>[2],
  ): Promise<Result<RunnerMethods, M>> {
    try {
      return await rpc(method, params, options);
    } catch (error) {
      if (link.aborted && !(error instanceof ExecError && error.reason === "runner_disconnected"))
        throw new ExecError("closed", "runner_disconnected");
      if (
        error instanceof RpcError &&
        (error.code === RpcErrorCodes.invalidParams || error.code === RpcErrorCodes.internal)
      ) {
        const check = RunnerExecutionErrorSchema.safeParse(error.data);
        if (check.success) throw new ExecError(check.data.code, check.data.reason);
      }
      // Unsupported, busy, cleanup and dispatch-denied still use their existing RPC codes.
      throw error;
    }
  }
  let offCapabilities = () => {};
  let retired = false;
  let pendingCapabilities: readonly string[] | undefined;
  let sending: Promise<void> | undefined;
  const sendCapabilities = (ids: readonly string[]) => {
    pendingCapabilities = ids;
    sending ??= (async () => {
      while (pendingCapabilities && !retired) {
        const current = pendingCapabilities;
        pendingCapabilities = undefined;
        await call(
          "runner.capabilities.set",
          { capabilities: [...current] },
          {
            timeoutMs: 10_000,
            signal: capabilities?.signal,
          },
        );
      }
    })().finally(() => {
      sending = undefined;
    });
    return sending.then((): Promise<void> | undefined =>
      pendingCapabilities && !retired ? sendCapabilities(pendingCapabilities) : undefined,
    );
  };
  let computerAvailable = false;
  // An older runner has no managed Git; group parallel work then stops with
  // runner_update_required instead of falling back to plain commands.
  let managedGitAvailable = false;
  let info: Result<RunnerMethods, "runner.info">;
  try {
    info = await call("runner.info", {}, { signal: capabilities?.signal, timeoutMs: 10_000 });
    if (capabilities) {
      let manifest: CapabilityManifest | undefined;
      try {
        manifest = await call(
          "runner.capabilities.negotiate",
          {},
          { signal: capabilities.signal, timeoutMs: 10_000 },
        );
      } catch (error) {
        if (!(error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound))
          throw error;
        // Only an explicit old-method response permits legacy behavior; timeouts never do.
      }
      if (manifest) {
        computerAvailable = manifest.capabilities.some(
          (c) => c.id === "runner.computer" && c.version === 1 && c.availability === "available",
        );
        managedGitAvailable = manifest.capabilities.some(
          (c) => c.id === "runner.managed-git" && c.version === 1 && c.availability === "available",
        );
        capabilities.receive(info.targetId, manifest);
        offCapabilities = capabilities.subscribe((ids) => {
          if (retired) return;
          void sendCapabilities(ids).catch(() => {
            if (retired) return;
            retired = true;
            offCapabilities();
            markDisconnected();
            capabilities.failed();
          });
        });
        await sendCapabilities(capabilities.enabled());
      }
    }
    try {
      await call("runner.executionChecks.enable", {});
    } catch (error) {
      if (!(error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound)) throw error;
      // The old host keeps its original coarse errors for the rest of this session.
    }
  } catch (error) {
    retired = true;
    offCapabilities();
    peer.dispose();
    throw error;
  }

  const transfer = createTransferChannel({ call, link, isDisconnected: () => disconnected });

  peer.handle("runner.dispatch.confirm", async ({ opId }) => {
    const confirm = dispatches.get(opId);
    if (!confirm) throw new RpcError(RpcErrorCodes.dispatchDenied, "Dispatch confirmation expired");
    await confirm();
    return null;
  });

  async function withDispatch<T>(
    confirm: () => void | Promise<void>,
    work: (dispatchOpId: string) => Promise<T>,
  ) {
    const dispatchOpId = randomUUID();
    dispatches.set(dispatchOpId, confirm);
    try {
      return await work(dispatchOpId);
    } finally {
      dispatches.delete(dispatchOpId);
    }
  }

  async function tracked<T>(
    key: IssuedKey,
    operation: string,
    work: () => Promise<T>,
    details?: { jobId?: string },
  ): Promise<T> {
    if (!reconciliation.has(key.idempotencyKey) && reconciliation.size >= MAX_RECONCILIATIONS)
      throw new RpcError(RpcErrorCodes.busy, "Runner reconciliation capacity exhausted");
    reconciliation.set(key.idempotencyKey, {
      issuedAt: key.issuedAt,
      operation,
      state: "pending",
      ...details,
    });
    try {
      const result = await work();
      reconciliation.delete(key.idempotencyKey);
      return result;
    } catch (error) {
      const held = reconciliation.get(key.idempotencyKey);
      if (held)
        reconciliation.set(key.idempotencyKey, {
          ...held,
          state: disconnected ? "detached" : "unknown",
        });
      throw error;
    }
  }

  const deps: RemoteDeps = {
    link,
    jobs,
    jobCleanups,
    detachedJobs,
    reconciliation,
    transfer,
    call,
    callSignal,
    isDisconnected: () => disconnected,
    withDispatch,
    tracked,
  };
  const files = createFileChannel(deps);
  const commands = createCommandChannel(deps);
  const ledger = createReconcileChannel(deps);

  const offClose =
    port.onClose?.(() => {
      retired = true;
      offCapabilities();
      markDisconnected();
      transfer.clear();
      dispatches.clear();
      for (const cleanup of jobCleanups.values()) cleanup.detach();
      for (const [key, held] of reconciliation)
        reconciliation.set(key, { ...held, state: "detached" });
    }) ?? (() => {});

  const target: RemoteTarget = {
    ...(managedGitAvailable
      ? { managedGit: createRemoteManagedGit({ call, callSignal, withDispatch }) }
      : {}),
    async syncPhoneAuthorizations(grants, signal) {
      await call("runner.phoneAuthorizations.set", { grants }, { signal, timeoutMs: 10_000 });
    },
    // The protocol carries the id as a plain string; RemoteTarget narrows it to `runner:<id>` and
    // the runner builds it that way (`host.ts`). Assert that one field instead of casting the
    // whole target, which used to hide it.
    targetId: info.targetId as `runner:${string}`,
    platform: info.platform,
    ...(computerAvailable
      ? {
          computer: {
            async call(method, input, signal, assertCurrent, blockedApps = ["*"]) {
              if (!(method in HostComputerMethods))
                throw new RpcError(RpcErrorCodes.methodNotFound, "computer_method_invalid");
              const operation = method as keyof typeof HostComputerMethods;
              const key = { idempotencyKey: randomUUID(), issuedAt: new Date().toISOString() };
              const descriptor = await withDispatch(assertCurrent, (dispatchOpId) =>
                tracked(key, "computer", () =>
                  call(
                    "runner.computer.call",
                    {
                      ...key,
                      dispatchOpId,
                      method: operation,
                      input,
                      blockedApps: [...blockedApps],
                    },
                    { signal: callSignal(signal), timeoutMs: 30_000 },
                  ),
                ),
              );
              return transfer.pullJson(descriptor, callSignal(signal), (value) =>
                HostComputerMethods[operation].result.parse(value),
              );
            },
          },
        }
      : {}),
    async commandProtectionRoots(signal: AbortSignal) {
      return (
        await call(
          "runner.command.protection",
          {},
          { signal: callSignal(signal), timeoutMs: 10_000 },
        )
      ).roots;
    },
    async realpath(path: string, signal: AbortSignal) {
      return (
        await call("runner.path.canonicalize", { path, cwd: path }, { signal: callSignal(signal) })
      ).path;
    },
    async canonicalizePath(path: string, cwd: string, signal: AbortSignal) {
      return call("runner.path.canonicalize", { path, cwd }, { signal: callSignal(signal) });
    },
    // An older runner answers methodNotFound; the brain then falls back to listDir.
    async listFolders(path: string | null | undefined, signal: AbortSignal) {
      return call("runner.folders.list", path === undefined ? {} : { path }, {
        signal: callSignal(signal),
      });
    },
    // Every other member here is async; a synchronous one made abortable() call .then on a
    // plain object, so the failure surfaced as "isolation_unknown" instead of this device's state.
    isolationStatus: async () => ({ ...info.isolation }),
    /** Scanned on the runner; the returned handle only names the runner-held plan. */
    async inspectGitEntries(
      input: Parameters<NonNullable<ExecutionTarget["inspectGitEntries"]>>[0],
      signal: AbortSignal,
    ): Promise<GitEntryResult> {
      const result = await call(
        "runner.git.entries",
        {
          invocations: input.invocations.map((item) => ({ args: [...item.args], cwd: item.cwd })),
          compound: input.compound,
          callId: input.callId,
          command: input.command,
        },
        { signal, timeoutMs: 30_000 },
      );
      if (result.status === "unsupported") {
        if (!result.facts)
          throw new RpcError(RpcErrorCodes.invalidRequest, "Runner entry facts missing");
        return { status: "unsupported", facts: result.facts };
      }
      if (!result.planId)
        throw new RpcError(RpcErrorCodes.invalidRequest, "Runner entry plan missing");
      const handle = { callId: input.callId, command: input.command, remotePlanId: result.planId };
      if (result.status === "none") return { status: "none", plan: Object.freeze(handle) };
      if (!result.facts)
        throw new RpcError(RpcErrorCodes.invalidRequest, "Runner entry facts missing");
      return {
        status: "confirmation-required",
        facts: result.facts,
        plan: Object.freeze({ ...handle, facts: result.facts }),
      };
    },
    ...files,
    ...commands,
    ...ledger,
    async dispose() {
      retired = true;
      offCapabilities();
      // Pending calls end with `runner_disconnected`, not a bare abort: callers surface it.
      markDisconnected();
      lifetime.abort();
      offClose();
      for (const cleanup of jobCleanups.values()) cleanup.detach();
      jobCleanups.clear();
      jobs.clear();
      dispatches.clear();
      transfer.clear();
      peer.dispose();
    },
  };
  return target;
}
