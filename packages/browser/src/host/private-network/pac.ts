import type { BrowserRules } from "@pibot/browser-contract/full";

/** No DNS PAC helpers: only the transport is allowed to resolve an approved private name. */
export function privateProxyPac(
  rules: BrowserRules,
  routes: string | ReadonlyMap<string, string>,
): string {
  const origins = rules.privateOrigins ?? [];
  const routeMap = Object.fromEntries(
    origins.map((origin) => [origin, typeof routes === "string" ? routes : routes.get(origin)]),
  );
  const upstream = rules.proxy ? new URL(rules.proxy.url) : undefined;
  const fallback = upstream
    ? `${upstream.protocol === "https:" ? "HTTPS" : "PROXY"} ${upstream.host}`
    : "DIRECT";
  return `function FindProxyForURL(url, host) {
    host = host.toLowerCase().replace(/^\\[|\\]$/g, "").replace(/\\.$/, "");
    var scheme = url.slice(0, url.indexOf(":"));
    if (scheme === "ws") scheme = "http";
    if (scheme === "wss") scheme = "https";
    var authority = url.match(/^[^:]+:\\/\\/([^/]+)/);
    var port = authority && authority[1].match(/:(\\d+)$/);
    port = port ? port[1] : (scheme === "https" ? "443" : "80");
    var origin = scheme + "://" + (host.indexOf(":") >= 0 ? "[" + host + "]" : host) + ":" + port;
    var routes = ${JSON.stringify(routeMap)};
    if (Object.prototype.hasOwnProperty.call(routes, origin)) return routes[origin];
    if ((host === "localhost" || host === "127.0.0.1" || host === "::1") &&
      ${JSON.stringify(rules.localPorts ?? [])}.indexOf(Number(port)) >= 0) return "DIRECT";
    return ${JSON.stringify(fallback)};
  }`;
}
