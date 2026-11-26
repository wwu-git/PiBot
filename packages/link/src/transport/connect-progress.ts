import { LinkError } from "../core/bytes.ts";
import { NoiseHandshakeError } from "./handshake.ts";

/**
 * Fixed diagnostic codes for runner links (2026-11-11 field reports: a Windows runner on a slow,
 * lossy uplink and a Linux acceptance host only ever logged `connection_failed`, so nobody could
 * tell DNS from TLS from a peer that never joined). Every value here is a closed set of words:
 * never an address, host name, room id, ticket or error message.
 */
export type RelayConnectStep = "dns" | "tcp" | "tls" | "ws_upgrade";
export type RunnerLinkStage =
  | RelayConnectStep
  | "relay"
  | "room_wait"
  | "noise_handshake"
  | "session_admission"
  | "session"
  | "direct";

/** Filled in by a socket constructor that can see its own connection steps (ws, undici). */
export interface ConnectProgress {
  step: RelayConnectStep;
  /** Fixed error class of the step that failed, from `networkErrorClass`. */
  error?: string;
  /** HTTP response status observed during a rejected WebSocket upgrade. */
  status?: number;
}

interface EmitterLike {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Tracks a raw TCP/TLS socket through lookup, connect and TLS so a stall names its step. */
export function observeConnectSocket(
  socket: EmitterLike,
  secure: boolean,
  progress: ConnectProgress,
) {
  progress.step = "dns";
  socket.once("lookup", (error: unknown) => {
    if (error) progress.error = networkErrorClass(error);
    else if (progress.step === "dns") progress.step = "tcp";
  });
  socket.once("connect", () => {
    progress.step = secure ? "tls" : "ws_upgrade";
  });
  socket.once("secureConnect", () => {
    progress.step = "ws_upgrade";
  });
  // Happy-eyeballs dialing reports each TCP attempt; an IP literal never emits `lookup`.
  socket.once("connectionAttempt", () => {
    if (progress.step === "dns") progress.step = "tcp";
  });
  socket.on("error", (error: unknown) => {
    const reason = networkErrorClass(error);
    if (progress.step === "dns" && reason !== "dns") progress.step = "tcp";
    progress.error ??= reason;
  });
}

const DNS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"]);
const UNREACHABLE = new Set([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
]);
const TIMEOUT = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ESOCKETTIMEDOUT"]);

/** One fixed word per failure class; the message itself is never kept. */
export function networkErrorClass(value: unknown): string {
  const error =
    value && typeof value === "object" && "error" in value && value.error ? value.error : value;
  const codes: string[] = [];
  let message = "";
  for (let current = error, depth = 0; current && depth < 3; depth++) {
    if (typeof current !== "object") break;
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.code === "string") codes.push(record.code);
    if (!message && typeof record.message === "string") message = record.message;
    current = record.cause;
  }
  if (!message && value && typeof value === "object" && "message" in value)
    message = typeof value.message === "string" ? value.message : "";
  const status = /Unexpected server response: (\d{3})/.exec(message)?.[1];
  if (status) return `http_${status.slice(0, 1)}xx`;
  for (const code of codes) {
    if (DNS.has(code)) return "dns";
    if (code === "ECONNREFUSED") return "refused";
    if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") return "reset";
    if (UNREACHABLE.has(code)) return "unreachable";
    if (TIMEOUT.has(code)) return "timeout";
    // An untrusted or mismatched certificate needs a different fix (install the relay's CA)
    // than a handshake that fails outright, so it is its own class.
    if (/^(CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_CERT_ALTNAME)/.test(code))
      return "certificate";
    if (/^(ERR_TLS|ERR_SSL|EPROTO$)/.test(code)) return "tls";
  }
  if (/timed out/i.test(message)) return "timeout";
  if (/closed before the connection was established/i.test(message)) return "cancelled";
  if (/non-101|invalid status|sec-websocket/i.test(message)) return "ws_rejected";
  return "failed";
}

/** A runner link that failed, with the step it reached. Keeps the `transport_closed` code. */
export class RunnerLinkError extends LinkError {
  constructor(
    readonly stage: RunnerLinkStage,
    readonly reason: string,
    readonly status?: number,
    readonly closeCode?: number,
    readonly wasClean?: boolean,
  ) {
    super("transport_closed");
  }
}

const FIXED_CODE = /^[a-z][a-z0-9_]{1,63}$/;

/** `{stage, reason}` for a log line; `fallback` names the stage the caller was in. */
export function runnerLinkFailure(
  error: unknown,
  fallback: RunnerLinkStage,
): {
  stage: RunnerLinkStage;
  reason: string;
  status?: number;
  closeCode?: number;
  wasClean?: boolean;
} {
  if (error instanceof RunnerLinkError)
    return {
      stage: error.stage,
      reason: error.reason,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.closeCode === undefined ? {} : { closeCode: error.closeCode }),
      ...(error.wasClean === undefined ? {} : { wasClean: error.wasClean }),
    };
  if (error instanceof NoiseHandshakeError)
    return { stage: "noise_handshake", reason: error.phase };
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return { stage: fallback, reason: error.name === "TimeoutError" ? "timeout" : "cancelled" };
  const code =
    error instanceof LinkError
      ? error.code
      : error instanceof Error && FIXED_CODE.test(error.message)
        ? error.message
        : undefined;
  return { stage: fallback, reason: code && FIXED_CODE.test(code) ? code : "unknown" };
}
