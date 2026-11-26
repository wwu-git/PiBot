import { isIpLiteral, privateNetworkHost } from "@pibot/protocol-base";
import type { CommandAnalysis } from "../core/types.ts";

export {
  browserPrivateNetworkHost,
  privateNetworkHost,
  privateNetworkOrigin,
} from "@pibot/protocol-base";

/** Programs whose bare operands are hosts (`ping router.local`, `nc 10.0.0.2 80`). */
const NETWORK_PROGRAMS = new Set([
  "curl",
  "wget",
  "ping",
  "ping6",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "nmap",
  "traceroute",
  "traceroute6",
  "tracepath",
  "mtr",
  "dig",
  "nslookup",
  "host",
  "arping",
  "iperf",
  "iperf3",
  "ftp",
  "http",
  "xh",
  "mosquitto_pub",
  "mosquitto_sub",
  "snmpget",
  "snmpwalk",
  "adb",
]);

export function isNetworkProgram(program: string) {
  const name = (program.split(/[\\/]/).at(-1) ?? program).toLowerCase().replace(/\.exe$/, "");
  return NETWORK_PROGRAMS.has(name);
}

/**
 * The host a command word names: a URL, `user@host[:path]`, `host:port`, or (for a network
 * program's operands) a bare host. A bare word elsewhere is a file name as often as a host
 * (`config.local`), so only an IP literal counts there.
 */
function wordHost(word: string, networkProgram: boolean): string | undefined {
  const value = word.trim();
  if (!value || value.length > 2048) return undefined;
  if (value.startsWith("-")) {
    const option = /^--?[\w-]+=(.+)$/.exec(value)?.[1];
    return option ? wordHost(option, networkProgram) : undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return new URL(value).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  const at = value.lastIndexOf("@");
  const rest = at >= 0 ? value.slice(at + 1) : value;
  const bracket = /^\[([^\]]+)\]/.exec(rest)?.[1];
  if (bracket) return bracket;
  // An IPv6 literal without brackets has several colons; host:port / host:path has one.
  const host = (rest.match(/:/g) ?? []).length > 1 ? rest.split("%")[0] : rest.split(/[:/]/)[0];
  const marked = at >= 0 || /^[^:/]+:\d{1,5}$/.test(rest);
  return host && (networkProgram || marked || isIpLiteral(host.toLowerCase())) ? host : undefined;
}

/**
 * The local-network hosts a command names in its words (and the domains analysis found), so its
 * card can say where it goes. A host reached only through a name that resolves privately is not
 * seen here; the sandbox proxy still refuses it until the user approves that host.
 */
export function privateCommandHosts(analysis: CommandAnalysis | undefined): string[] {
  if (!analysis) return [];
  const hosts = new Set<string>();
  const add = (candidate: string | undefined) => {
    const host = candidate ? privateNetworkHost(candidate) : undefined;
    if (host) hosts.add(host);
  };
  for (const domain of analysis.domains) add(domain);
  for (const { program, args } of analysis.commands) {
    const name = (program.split(/[\\/]/).at(-1) ?? program).toLowerCase().replace(/\.exe$/, "");
    const networkProgram = NETWORK_PROGRAMS.has(name);
    for (const arg of args) add(wordHost(arg, networkProgram));
  }
  return [...hosts].sort().slice(0, 16);
}
