import { lookup } from "node:dns/promises";
import { BlockList, connect, isIP, type Socket } from "node:net";
import {
  browserPrivateNetworkHost,
  privateNetworkHost,
  privateNetworkOrigin,
} from "@pibot/browser-contract/full";

export interface PrivateNetworkDial {
  resolve(
    host: string,
    signal: AbortSignal,
  ): Promise<readonly { address: string; family: number }[]>;
  connect(address: string, port: number, signal: AbortSignal): Promise<Socket>;
}

export const privateNetworkDial: PrivateNetworkDial = {
  async resolve(host, signal) {
    signal.throwIfAborted();
    const answers = await lookup(host, { all: true, verbatim: true });
    signal.throwIfAborted();
    return answers;
  },
  connect(address, port, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const socket = connect({ host: address, port });
      const abort = () => socket.destroy(new Error("private_network_cancelled"));
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      socket.once("error", (error) => {
        cleanup();
        reject(error);
      });
      socket.once("connect", () => {
        cleanup();
        resolve(socket);
      });
    });
  },
};

const hostOf = (url: URL) =>
  url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

export function privateTarget(value: string, tunnel = false) {
  const url = new URL(tunnel ? `https://${value}/` : value);
  if (url.username || url.password || (!tunnel && !["http:", "ws:"].includes(url.protocol)))
    throw new Error("private_network_denied");
  const origin = privateNetworkOrigin(url.href);
  if (!origin) throw new Error("private_network_denied");
  const host = hostOf(url);
  return { url, host, origin, port: Number(url.port || (tunnel ? 443 : 80)) };
}

/** Names select a destination class, never confer trust on DNS answers. */
export function scopedPrivateAddress(host: string, address: string, family: number): boolean {
  if (isIP(address) !== family || !browserPrivateNetworkHost(host)) return false;
  if (isIP(host)) return address === host;
  if (host.endsWith(".ts.net")) {
    // BlockList also normalizes compressed IPv6 spellings; IPv4-mapped loopback stays out.
    const scoped = new BlockList();
    scoped.addSubnet("100.64.0.0", 10, "ipv4");
    scoped.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");
    return scoped.check(address, family === 6 ? "ipv6" : "ipv4");
  }
  return host.endsWith(".local") && !!privateNetworkHost(address);
}

export async function dialPrivateTarget(
  target: ReturnType<typeof privateTarget>,
  dial: PrivateNetworkDial,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const family = isIP(target.host);
  const answers = family
    ? [{ address: target.host, family }]
    : await abortable(dial.resolve(target.host, signal), signal);
  if (
    !answers.length ||
    answers.length > 64 ||
    answers.some(({ address, family }) => !scopedPrivateAddress(target.host, address, family))
  )
    throw new Error("private_network_denied");
  signal.throwIfAborted();
  // All answers are in scope. Retry only failed setup, within one bounded operation; no
  // unchecked fallback or hostname re-resolution when an IPv6 route is unavailable.
  for (const answer of answers) {
    signal.throwIfAborted();
    try {
      return await dial.connect(answer.address, target.port, signal);
    } catch {
      signal.throwIfAborted();
    }
  }
  throw new Error("private_network_connection_failed");
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("private_network_cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
