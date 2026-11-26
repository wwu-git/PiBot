import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Own the already checked socket; agent:false would silently allocate an Agent and re-dial. */
export function forwardPrivateHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  socket: Socket,
  signal: AbortSignal,
): Promise<void> {
  const headers: IncomingHttpHeaders = { ...req.headers, host: url.host, connection: "close" };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  delete headers.upgrade;
  return new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      {
        method: req.method,
        path: url.pathname + url.search,
        headers,
        createConnection: () => socket,
        signal,
      },
      (response) => {
        request.setTimeout(0);
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.once("error", reject);
        response.once("end", resolve);
        response.pipe(res);
      },
    );
    request.setTimeout(20_000, () => request.destroy(new Error("private_network_timeout")));
    request.once("error", reject);
    req.once("error", () => request.destroy(new Error("private_network_cancelled")));
    res.once("close", () => request.destroy());
    req.pipe(request);
    socket.resume();
  }).finally(() => socket.destroy());
}

export function forwardPrivateUpgrade(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  url: URL,
  socket: Socket,
  signal: AbortSignal,
): Promise<void> {
  const headers: IncomingHttpHeaders = { ...req.headers, host: url.host };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  return new Promise<void>((resolve, reject) => {
    const request = httpRequest({
      method: req.method,
      path: url.pathname + url.search,
      headers,
      createConnection: () => socket,
      signal,
    });
    request.setTimeout(20_000, () => request.destroy(new Error("private_network_timeout")));
    request.once("error", reject);
    client.once("close", () => request.destroy());
    request.once("response", (response) => {
      response.destroy();
      reject(new Error("private_network_upgrade_refused"));
    });
    request.once("upgrade", (response, upstream, initial) => {
      request.setTimeout(0);
      const responseHeaders: string[] = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        if (response.rawHeaders[i]?.toLowerCase() !== "proxy-authenticate")
          responseHeaders.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      }
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join("\r\n")}\r\n\r\n`);
      if (initial.length) client.write(initial);
      if (head.length) upstream.write(head);
      pipePrivateTunnel(client, upstream);
      resolve();
    });
    request.end();
    socket.resume();
  });
}

export function pipePrivateTunnel(client: Duplex, upstream: Duplex) {
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  upstream.pipe(client);
  client.pipe(upstream);
  upstream.resume();
}
