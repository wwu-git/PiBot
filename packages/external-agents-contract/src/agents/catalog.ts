/*
 * The external agents Pi Bot knows how to run and what each one needs from
 * the sandbox. The allowances were measured with each agent running in the sandbox;
 * execution re-checks every entry against its own fixed exception list, so this table can narrow
 * the boundary for an agent but never open a path execution does not already allow it to open.
 */
import { z } from "zod";

export const ExternalAgentIdSchema = z.enum([
  "codex",
  "claude",
  "cursor",
  "opencode",
  "antigravity",
  "custom",
]);
export type ExternalAgentId = z.infer<typeof ExternalAgentIdSchema>;
export type KnownAgentId = Exclude<ExternalAgentId, "custom">;

export interface AgentAllowances {
  /** Home-relative paths (POSIX separators) the agent reads and writes: its config and login. */
  readWrite: readonly string[];
  /** Home-relative files it only reads (macOS: the login keychain file, never the folder). */
  readOnly: readonly string[];
  /** macOS mach services beyond the sandbox defaults. */
  machLookup: readonly string[];
  /** Exact unix sockets (Cursor resolves DNS itself; never a whole directory such as /var/run). */
  unixSockets: readonly string[];
  /** Network allowlist of the agent's own service. */
  network: readonly string[];
  /**
   * macOS: it serves itself over a local port (OpenCode's ACP mode is a client of its own HTTP
   * server). This also lets code in the sandbox reach any port on this computer's loopback.
   */
  localBinding?: boolean;
}

export interface AdapterPackage {
  /** npm package that speaks ACP for an agent without a built-in ACP mode. */
  name: string;
  version: string;
  /** Sum of the pinned tarballs, shown before the user agrees to download. */
  bytes: number;
  /** Environment variable that points the adapter at the user's installed program. */
  programEnv: "CODEX_PATH" | "CLAUDE_CODE_EXECUTABLE";
}

export interface AgentDescriptor {
  id: KnownAgentId;
  /** Brand name as each vendor asks it to be written ("Claude Agent", "OpenCode"). */
  name: string;
  vendor: string;
  /** Command names looked up on PATH, in order; never a prefix match (`codex2` is not Codex). */
  commands: readonly string[];
  /** ACP over the program itself (`args`) or over a pinned adapter package. */
  launch:
    | { kind: "native"; args: readonly string[] }
    | { kind: "adapter"; adapter: AdapterPackage };
  installUrl: string;
  /** The terminal command the user runs to sign in; Pi Bot never runs or proxies it. */
  loginCommand: string;
  allowances: Partial<Record<"darwin" | "linux" | "win32", AgentAllowances>>;
  /**
   * macOS / Linux: the agent runs commands without asking each time (Codex without its own
   * sandbox has no setting that asks per command; maintainers 2026-11-14 option A). Pi Bot says so.
   */
  noPerCommandAsk?: boolean;
}

const keychain = "Library/Keychains/login.keychain-db";
const trustd = ["com.apple.trustd.agent", "com.apple.trustd"] as const;

const codexNetwork = ["api.openai.com", "chatgpt.com", "auth.openai.com"] as const;
const claudeNetwork = [
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "console.anthropic.com",
] as const;
const cursorNetwork = ["api2.cursor.sh", "*.cursor.sh", "cursor.com", "*.cursor.com"] as const;
/**
 * OpenCode reaches whichever provider the user configured. Its own service and model list, plus
 * the providers the owner uses with it (2026-11-14: OpenRouter, DeepSeek). Another provider needs
 * a custom agent command with its domains, until Pi Bot reads OpenCode's provider settings.
 */
const opencodeNetwork = [
  "opencode.ai",
  "*.opencode.ai",
  "models.dev",
  "openrouter.ai",
  "api.deepseek.com",
] as const;

const posix = (allowances: AgentAllowances) => ({
  darwin: allowances,
  linux: { ...allowances, readOnly: [], machLookup: [], unixSockets: [] },
});

export const AGENTS: readonly AgentDescriptor[] = [
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    commands: ["codex"],
    launch: {
      kind: "adapter",
      adapter: {
        name: "@agentclientprotocol/codex-acp",
        version: "2.6.0",
        bytes: 407_881,
        programEnv: "CODEX_PATH",
      },
    },
    installUrl: "https://developers.openai.com/codex/cli",
    noPerCommandAsk: true,
    loginCommand: "codex login",
    allowances: {
      ...posix({
        readWrite: [".codex"],
        readOnly: [],
        // Codex verifies TLS through the system trust service: without trustd `codex doctor
        // --network-only` in the sandbox fails "TLS handshake or certificate validation failed"
        // and a real turn reports chatgpt.com unreachable (2026-11-14); with it all checks pass.
        machLookup: trustd,
        unixSockets: [],
        network: codexNetwork,
      }),
      win32: {
        readWrite: [".codex"],
        readOnly: [],
        machLookup: [],
        unixSockets: [],
        network: codexNetwork,
      },
    },
  },
  {
    id: "claude",
    name: "Claude Agent",
    vendor: "Anthropic",
    commands: ["claude"],
    launch: {
      kind: "adapter",
      adapter: {
        name: "@agentclientprotocol/claude-agent-acp",
        version: "0.107.0",
        bytes: 9_809_184,
        programEnv: "CLAUDE_CODE_EXECUTABLE",
      },
    },
    installUrl: "https://code.claude.com/docs/en/setup",
    loginCommand: "claude",
    allowances: {
      darwin: {
        readWrite: [".claude", ".claude.json"],
        readOnly: [keychain],
        machLookup: [],
        unixSockets: [],
        network: claudeNetwork,
      },
      linux: {
        readWrite: [".claude", ".claude.json"],
        readOnly: [],
        machLookup: [],
        unixSockets: [],
        network: claudeNetwork,
      },
      win32: {
        readWrite: [".claude", ".claude.json"],
        readOnly: [],
        machLookup: [],
        unixSockets: [],
        network: claudeNetwork,
      },
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    vendor: "Cursor",
    // Only the unambiguous name: a bare `agent` on PATH may be any program (security review S5).
    commands: ["cursor-agent"],
    // It updates itself in the background into ~/.local/share/cursor-agent, which the sandbox
    // keeps read-only; the user updates it outside Pi Bot instead (2026-11-14).
    launch: { kind: "native", args: ["--sandbox", "disabled", "--disable-auto-update", "acp"] },
    installUrl: "https://cursor.com/cli",
    loginCommand: "cursor-agent login",
    allowances: {
      darwin: {
        readWrite: [".cursor"],
        readOnly: [keychain],
        machLookup: trustd,
        unixSockets: ["/var/run/mDNSResponder", "/private/var/run/mDNSResponder"],
        network: cursorNetwork,
      },
      linux: {
        readWrite: [".cursor"],
        readOnly: [],
        machLookup: [],
        unixSockets: [],
        network: cursorNetwork,
      },
      win32: {
        readWrite: [".cursor"],
        readOnly: [],
        machLookup: [],
        unixSockets: [],
        network: cursorNetwork,
      },
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "Anomaly",
    commands: ["opencode"],
    launch: { kind: "native", args: ["acp"] },
    installUrl: "https://opencode.ai/docs",
    loginCommand: "opencode auth login",
    allowances: {
      ...posix({
        // XDG cache: models.json and the provider packages it installs at first start.
        readWrite: [
          ".config/opencode",
          ".local/share/opencode",
          ".local/state/opencode",
          ".cache/opencode",
          // Its global plugin/agent folder (it writes .gitignore and package.json there at start);
          // its own program in .opencode/bin stays read-only (execution's grant write denies).
          ".opencode",
        ],
        readOnly: [],
        machLookup: [],
        unixSockets: [],
        network: opencodeNetwork,
        // 2026-11-14: without it `opencode acp` exits with ServeError before initialize.
        localBinding: true,
      }),
      win32: {
        // XDG cache: models.json and the provider packages it installs at first start.
        readWrite: [
          ".config/opencode",
          ".local/share/opencode",
          ".local/state/opencode",
          ".cache/opencode",
          // Its global plugin/agent folder (it writes .gitignore and package.json there at start);
          // its own program in .opencode/bin stays read-only (execution's grant write denies).
          ".opencode",
        ],
        readOnly: [],
        machLookup: [],
        unixSockets: [],
        network: opencodeNetwork,
      },
    },
  },
  {
    id: "antigravity",
    name: "Antigravity",
    vendor: "Google",
    commands: ["agy"],
    launch: { kind: "native", args: ["acp", "--gemini-dir", ".pibot-agy"] },
    installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
    loginCommand: "agy acp --gemini-dir .pibot-agy --login",
    allowances: posix({
      readWrite: [".pibot-agy"],
      readOnly: [],
      machLookup: [],
      unixSockets: [],
      network: ["daily-cloudcode-pa.googleapis.com", "oauth2.googleapis.com"],
      // The ACP backend starts a local language server on a dynamically assigned port.
      localBinding: true,
    }),
  },
];

export const agentDescriptor = (id: KnownAgentId): AgentDescriptor => {
  const found = AGENTS.find((agent) => agent.id === id);
  if (!found) throw new Error(`Unknown agent ${id}`);
  return found;
};

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/);
/** A home-relative folder for a custom agent's own data; execution refuses protected ones. */
const homePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n\\]+$/);
const argument = z
  .string()
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value));

/** "Custom launch command": any ACP agent, with the same sandbox as the known ones. */
export const CustomAgentSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  /** Absolute program path or a bare command name looked up on PATH; never a shell line. */
  command: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((value) => !/[\0\r\n]/.test(value)),
  args: z.array(argument).max(32),
  readWrite: z.array(homePath).max(8),
  network: z.array(domain).max(32),
});
export type CustomAgent = z.infer<typeof CustomAgentSchema>;

/** Effective allowances for this platform; a custom agent's own are used as given. */
export function agentAllowances(
  agent: { id: ExternalAgentId; custom?: CustomAgent | null },
  platform: string,
): AgentAllowances {
  if (agent.id === "custom")
    return {
      readWrite: agent.custom?.readWrite ?? [],
      readOnly: [],
      machLookup: [],
      unixSockets: [],
      network: agent.custom?.network ?? [],
    };
  const key =
    platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "linux";
  return (
    agentDescriptor(agent.id).allowances[key] ?? {
      readWrite: [],
      readOnly: [],
      machLookup: [],
      unixSockets: [],
      network: [],
    }
  );
}
