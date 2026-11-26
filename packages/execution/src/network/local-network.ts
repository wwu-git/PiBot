// Run bounded local-network diagnostics using the platform’s system utilities.
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { win32 } from "node:path";
import { windowsSystemRoot } from "../core/windows-environment.ts";

/**
 * Maintainers 2026-11-14: a Bot debugging the user's network must see its state. Inside the command
 * sandbox it cannot: on Linux the command has its own network namespace (it sees only its own
 * loopback), on macOS Seatbelt refuses the routing socket and most network sysctls, so `netstat
 * -rn`, `route get default` or `arp -a` fail there. Opening those would mean sharing the host's
 * network with every sandboxed command. Instead Pi Bot runs a fixed set of read-only system
 * programs itself, with fixed arguments and no shell: none of them changes a setting, and no
 * model text reaches their argument list (the ping host is validated by policy first).
 */

const STEP_TIMEOUT_MS = 10_000;
const STEP_OUTPUT_BYTES = 48 * 1024;
const TOTAL_TEXT = 60_000;

interface Step {
  title: string;
  program: string;
  args: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function run(
  step: Step,
  env: Env,
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    let settled: string | undefined;
    const child = execFile(
      step.program,
      step.args,
      {
        encoding: "utf8",
        maxBuffer: STEP_OUTPUT_BYTES,
        timeout: STEP_TIMEOUT_MS,
        windowsHide: true,
        signal,
        // Fixed programs need no user configuration; English output keeps parsing by the model
        // predictable across machines.
        env: { ...minimalEnv(env, platform), LC_ALL: "C", LANG: "C" },
      },
      (error, stdout, stderr) => {
        const text = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
        settled = error && !text ? `(unavailable: ${errorCode(error)})` : text || "(no output)";
      },
    );
    // A timed-out or aborted step reports what it had; the others still run.
    child.once("close", () => resolve(settled ?? "(unavailable)"));
    child.once("error", () => resolve(settled ?? "(unavailable)"));
  });
}

function errorCode(error: Error & { code?: unknown; killed?: boolean }) {
  if (error.killed) return "timeout";
  return typeof error.code === "string" ? error.code : "failed";
}

// These programs run outside the sandbox with no card, so they must never be found through the
// user's PATH: a sandboxed command can write to folders that may be on it (a workspace bin,
// node_modules/.bin, ~/.local/bin when the workspace is home) and plant a fake `ip` there.
const UNIX_SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

/** System PATH and root only; nothing of the user's environment is passed on. */
function minimalEnv(source: Env, platform: NodeJS.Platform): Record<string, string> {
  if (platform !== "win32") return { PATH: UNIX_SYSTEM_PATH };
  const env: Record<string, string> = { SystemRoot: windowsSystemRoot(source) };
  for (const name of ["PATH", "Path"]) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}

function stateSteps(platform: NodeJS.Platform, env: Env): Step[] {
  if (platform === "darwin")
    return [
      { title: "Routes (netstat -rn)", program: "/usr/sbin/netstat", args: ["-rn"] },
      { title: "Neighbours (arp -an)", program: "/usr/sbin/arp", args: ["-an"] },
      {
        title: "Hardware ports (networksetup -listallhardwareports)",
        program: "/usr/sbin/networksetup",
        args: ["-listallhardwareports"],
      },
      { title: "DNS (scutil --dns)", program: "/usr/sbin/scutil", args: ["--dns"] },
      {
        title: "Wi-Fi (system_profiler SPAirPortDataType)",
        program: "/usr/sbin/system_profiler",
        args: ["SPAirPortDataType", "-detailLevel", "basic"],
      },
    ];
  if (platform === "linux")
    return [
      { title: "Addresses (ip -brief address)", program: "ip", args: ["-brief", "address"] },
      { title: "Routes (ip route)", program: "ip", args: ["route"] },
      { title: "Neighbours (ip neigh)", program: "ip", args: ["neigh"] },
      { title: "DNS (resolvectl status)", program: "resolvectl", args: ["status"] },
      {
        title: "Wi-Fi (nmcli device wifi list)",
        program: "nmcli",
        args: ["-t", "-f", "IN-USE,SSID,CHAN,FREQ,RATE,SIGNAL,SECURITY", "device", "wifi", "list"],
      },
    ];
  if (platform === "win32") {
    const system32 = win32.join(windowsSystemRoot(env), "System32");
    return [
      {
        title: "Configuration (ipconfig /all)",
        program: win32.join(system32, "ipconfig.exe"),
        args: ["/all"],
      },
      {
        title: "Routes (route print -4)",
        program: win32.join(system32, "ROUTE.EXE"),
        args: ["print", "-4"],
      },
      { title: "Neighbours (arp -a)", program: win32.join(system32, "ARP.EXE"), args: ["-a"] },
      {
        title: "Wi-Fi (netsh wlan show interfaces)",
        program: win32.join(system32, "netsh.exe"),
        args: ["wlan", "show", "interfaces"],
      },
    ];
  }
  return [];
}

function interfacesText() {
  const lines: string[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? [])
      lines.push(
        `${name} ${entry.family} ${entry.address}${entry.cidr ? ` (${entry.cidr})` : ""}${entry.internal ? " internal" : ""} mac ${entry.mac}`,
      );
  }
  return lines.join("\n") || "(none)";
}

/** Interfaces, routes, neighbours, DNS and Wi-Fi of this computer, as plain text sections. */
export async function readLocalNetworkState(options: {
  platform: NodeJS.Platform;
  env: Env;
  signal: AbortSignal;
}): Promise<string> {
  options.signal.throwIfAborted();
  const steps = stateSteps(options.platform, options.env);
  const outputs = await Promise.all(
    steps.map((step) => run(step, options.env, options.platform, options.signal)),
  );
  options.signal.throwIfAborted();
  const sections = [
    `## Interfaces\n${interfacesText()}`,
    ...steps.map((step, index) => `## ${step.title}\n${outputs[index]}`),
  ];
  const text = sections.join("\n\n");
  return text.length > TOTAL_TEXT ? `${text.slice(0, TOTAL_TEXT)}\n…(truncated)` : text;
}

/** Four echo requests to one host the user allowed; ICMP cannot pass the command sandbox. */
export async function pingLocalHost(options: {
  platform: NodeJS.Platform;
  env: Env;
  host: string;
  signal: AbortSignal;
}): Promise<string> {
  // Defence in depth: policy already accepted only a local-network host; never an option.
  if (!/^[0-9a-z][0-9a-z.:-]*$/i.test(options.host)) throw new Error("invalid_host");
  const step: Step =
    options.platform === "win32"
      ? {
          title: "ping",
          program: win32.join(windowsSystemRoot(options.env), "System32", "PING.EXE"),
          args: ["-n", "4", "-w", "2000", options.host],
        }
      : options.platform === "darwin"
        ? { title: "ping", program: "/sbin/ping", args: ["-c", "4", "-t", "8", options.host] }
        : { title: "ping", program: "ping", args: ["-c", "4", "-w", "8", options.host] };
  if (options.host.includes(":") && options.platform === "darwin") {
    step.program = "/sbin/ping6";
    step.args = ["-c", "4", options.host];
  }
  return run(step, options.env, options.platform, options.signal);
}
