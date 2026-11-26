import { randomBytes, randomUUID } from "node:crypto";
import {
  RunnerDrainError,
  resumeRunnerDrain,
  runnerLinkFailure,
  runnerPairCode,
  waitRunnerRetry,
} from "@pibot/link";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { DeviceNameSchema, type PairStatus } from "@pibot/remote-contract";
import { transaction } from "@pibot/storage";
import { z } from "zod";
import { roomScope } from "../link/identity.ts";
import type { EndpointIdentity, RemoteLinkPort } from "../link/port.ts";
import type { RemoteResources } from "../runtime/context.ts";

const PhoneSchema = z.strictObject({
  // A runner's link reports `kind: "runner"`; the strict schema refused it, so adding a runner
  // from the desktop always failed at the "phone" stage (Linux acceptance 2026-11-20).
  kind: z.enum(["phone", "runner"]).optional(),
  publicKey: z.string().min(16).max(4096),
  name: DeviceNameSchema,
  room: z.string().min(1).max(512),
  roomSecret: z.string().min(16).max(8192),
  securityCode: z.string().regex(/^\d{6}$/),
});
// Room opens retry within this budget; one 20 s open plus backoff must fit at least twice.
// Kept below the devices.pairStart RPC timeout so the caller still hears the failure.
const PAIR_SETUP_MS = 60_000;
type RelayProblem = NonNullable<PairStatus["relayProblem"]>;

/** A failed relay open as one of the problems the pairing card can explain, or none. */
function relayProblem(error: unknown): RelayProblem | undefined {
  const { stage, reason } = runnerLinkFailure(error, "relay");
  if (reason === "certificate") return "certificate";
  if (reason === "tls" || stage === "tls") return "tls";
  if (
    ["dns", "refused", "unreachable", "reset"].includes(reason) ||
    ((stage === "dns" || stage === "tcp") && reason !== "cancelled")
  )
    return "unreachable";
  return undefined;
}
interface Attempt {
  state: PairStatus;
  controller: AbortController;
  handle?: Awaited<ReturnType<RemoteLinkPort["pair"]>>;
  timer?: ReturnType<typeof setTimeout>;
  settled: Promise<void>;
}
export class PairingManager {
  private current?: Attempt;
  /** A runner code just issued, protected after the answer that shows it has been sent. */
  private readonly issued: string[] = [];
  constructor(
    private readonly r: RemoteResources,
    private readonly completed: () => Promise<void>,
  ) {}
  status(id: string) {
    if (this.current?.state.id !== id)
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_pair_unavailable");
    return this.current.state;
  }
  async start(
    link: RemoteLinkPort,
    identity: EndpointIdentity,
    relayUrl: string,
    signal: AbortSignal,
    kind?: "runner",
  ) {
    await this.cancel();
    signal.throwIfAborted();
    const controller = new AbortController();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const attempt: Attempt = {
      state: { id: randomUUID(), status: "waiting", expiresAt },
      controller,
      settled: Promise.resolve(),
    };
    this.current = attempt;
    let confirmRunner: (() => void) | undefined;
    const pairSignal = AbortSignal.any([signal, controller.signal]);
    attempt.timer = setTimeout(() => {
      attempt.state.status = "expired";
      controller.abort();
    }, 600_000);
    // The observer starts before the RPC returns; a phone may complete before the next poll.
    let ready: (payload: string) => void = () => {};
    let failed: (error: unknown) => void = () => {};
    const payload = new Promise<string>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    attempt.settled = (async () => {
      let stage: "link" | "payload" | "phone" | "commit" = "link";
      let setupTimedOut = false;
      const setupTimer = setTimeout(() => {
        setupTimedOut = true;
        controller.abort();
      }, PAIR_SETUP_MS);
      try {
        const handle =
          kind === "runner"
            ? this.runnerHandle(
                link,
                identity,
                relayUrl,
                pairSignal,
                (confirm) => {
                  confirmRunner = confirm;
                },
                (problem) => {
                  if (attempt.state.status !== "waiting") return;
                  const { relayProblem: _previous, ...state } = attempt.state;
                  attempt.state = problem ? { ...state, relayProblem: problem } : state;
                },
              )
            : await link.pair({
                identity,
                relayUrl,
                name: this.r.settings.get().desktopName,
                expiresAt,
                signal: pairSignal,
              });
        attempt.handle = handle;
        // A late-created handle may already have rejected completion after cancellation.
        // Observe it before the guard; close still owns its actual resource settlement below.
        void handle.completed.catch(() => {});
        clearTimeout(setupTimer);
        pairSignal.throwIfAborted();
        stage = "payload";
        if (!handle.payload || handle.payload.length > 8192)
          throw new Error("remote_pair_payload_invalid");
        ready(handle.payload);
        stage = "phone";
        const phone = PhoneSchema.parse(await handle.completed);
        // The device must be the kind this attempt pairs: a phone cannot complete a runner pairing.
        if ((phone.kind ?? "phone") !== (kind === "runner" ? "runner" : "phone"))
          throw new Error("remote_pair_kind_mismatch");
        pairSignal.throwIfAborted();
        stage = "commit";
        this.r.ctx.redactor.add(phone.roomSecret);
        const id = randomUUID();
        const commit = await this.r.secrets.prepareSet(roomScope(id), "room", phone.roomSecret);
        pairSignal.throwIfAborted();
        if (
          this.current !== attempt ||
          attempt.state.status !== "waiting" ||
          Date.now() >= Date.parse(expiresAt)
        )
          throw new Error("remote_pair_expired");
        transaction(this.r.ctx.db, () => {
          commit();
          this.r.devices.add({
            id,
            ...(kind === "runner" ? { kind: "runner" as const } : {}),
            name: this.r.ctx.redactor.redact(phone.name),
            publicKey: phone.publicKey,
            room: phone.room,
          });
          this.r.audit(id, "devices.pairStart", "paired", "user");
        });
        confirmRunner?.();
        attempt.state = {
          ...attempt.state,
          status: "paired",
          deviceId: id,
          securityCode: phone.securityCode,
        };
        this.r.changed();
      } catch (error) {
        if (attempt.state.status === "waiting")
          attempt.state.status = pairSignal.aborted ? "cancelled" : "failed";
        // A failed "add phone" used to leave only the RPC code; keep the stage and a fixed reason
        // (link errors are fixed snake_case codes) so a missing QR can be diagnosed. No QR, room,
        // address or secret ever reaches this line.
        const code = error instanceof Error && /^[a-z][a-z0-9_]{2,47}$/.test(error.message);
        this.r.ctx.logger.warn(
          JSON.stringify({
            module: "remote-pair",
            event: "failed",
            stage,
            reason: setupTimedOut
              ? "setup_timeout"
              : signal.aborted || attempt.state.status === "cancelled"
                ? "cancelled"
                : attempt.state.status === "expired"
                  ? "expired"
                  : code
                    ? (error as Error).message
                    : error instanceof Error
                      ? error.name
                      : "unknown",
          }),
        );
        failed(new RpcError(RpcErrorCodes.unsupported, "remote_pair_failed"));
      } finally {
        clearTimeout(setupTimer);
        clearTimeout(attempt.timer);
        await attempt.handle?.close();
        attempt.handle = undefined;
      }
      if (attempt.state.status === "paired") await this.completed();
    })();
    // Retain the real settlement for cancellation; diagnostics contain no link error or QR data.
    void attempt.settled.catch(() => this.r.ctx.logger.warn("Remote pairing cleanup unavailable"));
    const shown = await payload;
    const issued = this.issued.splice(0);
    // The RPC answer is validated and posted in the same turn; from then on logs, chats and later
    // messages mask the code like any secret.
    if (issued.length)
      setTimeout(() => {
        for (const value of issued) this.r.ctx.redactor.add(value);
      }, 1_000).unref?.();
    return { id: attempt.state.id, payload: shown, expiresAt };
  }
  private runnerHandle(
    link: RemoteLinkPort,
    identity: EndpointIdentity,
    relayUrl: string,
    signal: AbortSignal,
    onCommit: (confirm: () => void) => void,
    onRelay: (problem: RelayProblem | undefined) => void,
  ) {
    const pair = link.pairRunner;
    if (!pair) throw new Error("remote_pair_unavailable");
    const code = runnerPairCode(randomBytes, relayUrl);
    // Every brain message to the UI is redacted on its way out, so registering the code now
    // replaced it with [REDACTED] in the very response that shows it to the user (owner
    // 2026-11-18). It joins the redactor once that response has gone (see `start`).
    this.issued.push(
      code,
      code.split("@")[0] ?? code,
      code.split("@")[0]?.replaceAll("-", "") ?? code,
    );
    const controller = new AbortController();
    const sessionSignal = AbortSignal.any([signal, controller.signal]);
    let accept!: (device: import("../link/port.ts").PairedPhone) => void;
    let reject!: (error: unknown) => void;
    let confirm!: () => void;
    let received = false;
    const committed = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const completed = new Promise<import("../link/port.ts").PairedPhone>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    let saved = false;
    onCommit(() => {
      saved = true;
      confirm();
    });
    let logged: RelayProblem | undefined;
    const work = (async () => {
      let failures = 0;
      while (failures < 3 && !sessionSignal.aborted) {
        let reachedPeer = false;
        try {
          await pair({
            identity,
            relayUrl,
            name: this.r.settings.get().desktopName,
            code,
            generated: true,
            onPeer: () => {
              reachedPeer = true;
              onRelay(undefined);
            },
            signal: sessionSignal,
            commit: async (device) => {
              received = true;
              accept(device);
              const abort = () => confirm();
              sessionSignal.addEventListener("abort", abort, { once: true });
              try {
                if (!sessionSignal.aborted) await committed;
              } finally {
                sessionSignal.removeEventListener("abort", abort);
              }
              sessionSignal.throwIfAborted();
            },
          });
          return;
        } catch (error) {
          if (
            error instanceof RunnerDrainError ||
            received ||
            signal.aborted ||
            controller.signal.aborted ||
            (reachedPeer && ++failures >= 3)
          ) {
            reject(error);
            if (error instanceof RunnerDrainError) throw error;
            return;
          }
          // The code keeps waiting while the relay cannot be opened; the card says why, and the
          // log gets one fixed line per distinct cause (never the address or the code).
          const problem = reachedPeer ? undefined : relayProblem(error);
          onRelay(problem);
          if (problem && problem !== logged) {
            logged = problem;
            const { stage, reason } = runnerLinkFailure(error, "relay");
            this.r.ctx.logger.warn(
              JSON.stringify({
                module: "remote-pair",
                event: "relay_unavailable",
                code: `relay_${problem}`,
                stage,
                reason,
              }),
            );
          }
          await waitRunnerRetry(1000, sessionSignal);
        }
      }
      reject(new Error("pairing_unavailable"));
    })();
    void work.catch(() => {});
    return {
      payload: code,
      completed,
      close: async () => {
        confirm();
        if (!saved || signal.aborted) controller.abort();
        try {
          await work;
        } catch (error) {
          await resumeRunnerDrain(error);
        }
      },
    };
  }

  async cancel(id?: string) {
    const attempt = this.current;
    if (!attempt || (id && attempt.state.id !== id)) return;
    if (attempt.state.status === "waiting") attempt.state.status = "cancelled";
    attempt.controller.abort();
    try {
      await attempt.settled;
    } catch {
      // A failed close retains ownership; an explicit cancellation may retry the idempotent close.
      await attempt.handle?.close();
      attempt.handle = undefined;
      attempt.settled = Promise.resolve();
    }
  }
  busy() {
    return this.current?.state.status === "waiting";
  }
}
