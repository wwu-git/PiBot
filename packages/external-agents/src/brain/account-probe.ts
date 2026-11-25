import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { KnownAgentId } from "@pibot/external-agents-contract";
import { type LaunchDeps, launchAgent } from "./acp/launch.ts";

export async function probeAccount(
  deps: LaunchDeps,
  agentId: KnownAgentId,
  program: string,
  signal: AbortSignal,
  isolation: "sandbox" | "unisolated",
): Promise<"unknown" | "login_required"> {
  if (agentId === "antigravity") return "unknown";
  const args =
    agentId === "codex"
      ? ["login", "status"]
      : agentId === "claude"
        ? ["auth", "status"]
        : agentId === "opencode"
          ? ["auth", "list"]
          : ["status"];
  const folder = await realpath(await mkdtemp(join(deps.tempDir, "agent-status-")));
  try {
    const stream = await launchAgent(deps, {
      agent: { id: agentId, custom: null },
      target: { kind: "program", path: program, args },
      cwd: folder,
      writeRoots: [folder],
      isolation,
      signal,
    });
    let output = "";
    try {
      await new Promise<void>((resolve) => {
        const finish = () => {
          off();
          closed();
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const off = stream.onMessage((line) => {
          output = (output + line).slice(-8192);
        });
        const closed = stream.onClose(finish);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
      signal.throwIfAborted();
      output += stream.stderrTail();
      return /not (?:logged|signed) in|not authenticated|"loggedIn"\s*:\s*false/i.test(output)
        ? "login_required"
        : "unknown";
    } finally {
      await stream.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
