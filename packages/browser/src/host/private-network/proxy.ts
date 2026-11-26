import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { dialPrivateTarget, type PrivateNetworkDial, privateTarget } from "./destination.ts";
import { forwardPrivateHttp, forwardPrivateUpgrade, pipePrivateTunnel } from "./forward.ts";

/** Shared by all origin endpoints of one Bot, so grants cannot multiply resource limits. */
export interface PrivateNetworkBudget {
  sockets: Set<Socket>;
  active: Set<Promise<void>>;
  pendingDials: number;
}

/** A capability of one live Bot run, never a general localhost forwarding proxy. */
export async function createPrivateNetworkProxy(
  origin: string,
  dial: PrivateNetworkDial,
  budget: PrivateNetworkBudget = { sockets: new Set(), active: new Set(), pendingDials: 0 },
) {
  const approved = new URL(origin);
  const approvedHost = approved.hostname.replace(/^\[|\]$/g, "");
  const approvedPort = Number(approved.port || (approved.protocol === "https:" ? 443 : 80));
  const username = "pibot";
  const password = randomBytes(32).toString("hex");
  const authorization = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  );
  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  const active = budget.active;
  const track = (socket: Socket) => {
    sockets.add(socket);
    budget.sockets.add(socket);
    // Errors are surfaced through the request owner, never the raw address or credentials.
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      budget.sockets.delete(socket);
    });
  };
  const authenticated = (req: IncomingMessage) => {
    const value = Buffer.from(req.headers["proxy-authorization"] ?? "");
    return (
      !lifetime.signal.aborted &&
      value.length === authorization.length &&
      timingSafeEqual(value, authorization)
    );
  };
  const run = (work: () => Promise<void>, fail: () => void) => {
    if (
      lifetime.signal.aborted ||
      budget.sockets.size + budget.pendingDials >= 256 ||
      active.size >= 64
    )
      return fail();
    const pending = work()
      .catch(fail)
      .finally(() => active.delete(pending));
    active.add(pending);
  };
  const targetSocket = async (req: IncomingMessage, tunnel: boolean, client: Duplex) => {
    const target = privateTarget(req.url ?? "", tunnel);
    // Chromium tunnels plain WS with CONNECT too. A dedicated endpoint binds that ambiguous
    // authority to one PAC-selected origin; session request rules verify the original scheme.
    const matches = tunnel
      ? target.host === approvedHost && target.port === approvedPort
      : target.origin === origin;
    if (!matches || lifetime.signal.aborted) throw new Error("private_network_denied");
    if (budget.sockets.size + budget.pendingDials >= 256) throw new Error("private_network_busy");
    budget.pendingDials++;
    const cancelled = new AbortController();
    const abort = () => cancelled.abort();
    client.once("close", abort);
    const signal = AbortSignal.any([
      lifetime.signal,
      cancelled.signal,
      AbortSignal.timeout(20_000),
    ]);
    try {
      const socket = await dialPrivateTarget(target, dial, signal);
      track(socket);
      if (lifetime.signal.aborted || client.destroyed) {
        socket.destroy();
        throw new Error("private_network_denied");
      }
      return { ...target, socket };
    } finally {
      budget.pendingDials--;
      client.off("close", abort);
    }
  };
  const challenge =
    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="PiBot private network"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
  const deny = (client: Duplex) =>
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  const server = createServer((req, res) => {
    if (!authenticated(req)) {
      res
        .writeHead(407, {
          "Proxy-Authenticate": 'Basic realm="PiBot private network"',
          Connection: "close",
        })
        .end();
      return;
    }
    run(
      async () => {
        const target = await targetSocket(req, false, req.socket);
        await forwardPrivateHttp(req, res, target.url, target.socket, lifetime.signal);
      },
      () => {
        if (!res.headersSent) res.writeHead(403).end();
        else res.destroy();
      },
    );
  });
  server.on("connect", (req, client, head) => {
    if (!authenticated(req)) return void client.end(challenge);
    run(
      async () => {
        const { socket } = await targetSocket(req, true, client);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) socket.write(head);
        pipePrivateTunnel(client, socket);
      },
      () => deny(client),
    );
  });
  server.on("upgrade", (req, client, head) => {
    if (!authenticated(req)) return void client.end(challenge);
    run(
      async () => {
        const target = await targetSocket(req, false, client);
        await forwardPrivateUpgrade(req, client, head, target.url, target.socket, lifetime.signal);
      },
      () => deny(client),
    );
  });
  server.on("connection", (socket) => {
    if (budget.sockets.size + budget.pendingDials >= 256 || lifetime.signal.aborted)
      socket.destroy();
    else track(socket);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  let closed: Promise<void> | undefined;
  return {
    route: `PROXY 127.0.0.1:${port}`,
    credentials: { host: "127.0.0.1", port, username, password },
    get active() {
      return !lifetime.signal.aborted;
    },
    /** Synchronous invalidation precedes async session reconfiguration and DNS completion. */
    revoke() {
      if (closed) return closed;
      lifetime.abort();
      closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      return closed;
    },
  };
}
