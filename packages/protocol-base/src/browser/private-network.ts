// No Node builtins here: intrinsic decisions are also the phone's portable policy.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function ipv4(host: string): number[] | undefined {
  const match = IPV4.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}
const ipv6 = (host: string) => host.includes(":") && /^[0-9a-f:.]+$/.test(host);
export const isIpLiteral = (host: string) => !!ipv4(host) || ipv6(host);

const bare = (host: string) =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

/**
 * Maintainers 2026-11-14 ("ask each time"): the user's own network (a router's admin page, a device
 * being debugged) is reachable after a card per target and task: 10/8, 172.16/12, 192.168/16,
 * link-local, IPv6 ULA / link-local and mDNS `.local` names. Loopback is not part of it: the
 * Bot's own services keep their exception and everything else on loopback stays refused.
 */
export function privateNetworkHost(raw: string): string | undefined {
  const host = bare(raw);
  if (!host || host.length > 253 || /[\s/@%]/u.test(host)) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  const v4 = ipv4(mapped ?? host);
  if (v4) {
    const [a = 0, b = 0] = v4;
    const local =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    return local ? host : undefined;
  }
  if (ipv6(host)) return /^(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):/.test(host) ? host : undefined;
  // mDNS names are always on the local link; one label before ".local" at least.
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/.test(host) ? host : undefined;
}

/** Browser-only candidates. Names still require scoped DNS validation at the actual dial. */
export function browserPrivateNetworkHost(raw: string): string | undefined {
  const host = bare(raw);
  const octets = ipv4(host);
  if (octets?.[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) return host;
  if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/.test(host) && host.length <= 253)
    return host;
  return privateNetworkHost(host);
}

/** `http://192.168.1.1/x` → `http://192.168.1.1:80`; ws(s) count as the page's own origin. */
export function privateNetworkOrigin(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const scheme =
    parsed.protocol === "ws:" ? "http:" : parsed.protocol === "wss:" ? "https:" : parsed.protocol;
  if ((scheme !== "http:" && scheme !== "https:") || parsed.username || parsed.password)
    return undefined;
  const host = browserPrivateNetworkHost(parsed.hostname);
  if (!host) return undefined;
  const port = parsed.port || (scheme === "https:" ? "443" : "80");
  return `${scheme}//${ipv6(host) ? `[${host}]` : host}:${port}`;
}
