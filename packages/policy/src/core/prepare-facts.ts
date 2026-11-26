// Prepare trusted filesystem and workspace facts for one policy decision.
import type { ScriptInputs } from "../commands/scripts.ts";
import { decisionFileSystem } from "../paths/paths.ts";
import { PolicyTargetError } from "./errors.ts";
import type { PolicyTrace } from "./explain.ts";
import { prepareRequestFacts, type RequestFacts } from "./request-facts.ts";
import type { CommandAnalysis, EvaluationInput, PathContext, PolicyOptions } from "./types.ts";

export async function preparePolicyFacts(
  input: EvaluationInput,
  options: PolicyOptions,
  analyze: (
    command: string,
    platform?: PolicyOptions["platform"],
    home?: string,
    inputs?: ScriptInputs,
  ) => CommandAnalysis,
  trace: PolicyTrace,
): Promise<RequestFacts> {
  const platform = input.boundary?.location?.platform ?? options.platform;
  const signal = input.signal;
  const remoteTarget = input.boundary?.location?.target?.startsWith("runner:") === true;
  const unresolvedRemoteFileSystem = {
    async realpath() {
      throw new PolicyTargetError("target_realpath_unavailable");
    },
  };
  const context: PathContext = {
    platform,
    // `~` is the workplace home for every tool, as for commands (execution injects it as their
    // HOME) and the UI. A file tool that expanded it to the computer user's home wrote outside
    // the workplace, where no file or changes card follows; that home stays reachable only by an
    // absolute path, and its credential folders stay protected through protectionHome.
    home: input.workplace.home,
    protectionHome: remoteTarget ? input.workplace.home : options.userHome,
    ...(platform === "win32" && !remoteTarget
      ? {
          windowsSystemDrive: options.windowsSystemDrive,
          windowsSystemTrees: options.windowsSystemTrees,
        }
      : {}),
    cwd: input.workplace.home,
    roots: [],
    fs: input.realpath
      ? {
          realpath: input.realpath,
          ...(input.canonicalize ? { canonicalize: input.canonicalize } : {}),
        }
      : remoteTarget
        ? unresolvedRemoteFileSystem
        : (options.fs ?? decisionFileSystem(platform)),
    signal,
  };
  let prepared: RequestFacts;
  try {
    prepared = await prepareRequestFacts(
      input,
      context,
      (command, inputs) => analyze(command, platform, context.home, inputs),
      trace,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof PolicyTargetError ||
      (error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(
          String(error.code),
        ))
    )
      return {
        incomplete: true,
        result: trace.result(
          {
            decision: "deny",
            reason: error instanceof PolicyTargetError ? error.check : "path_resolution_failed",
            risk: "normal",
            facts: [],
            canRemember: false,
          },
          "boundary",
        ),
      };
    throw error;
  }
  signal.throwIfAborted();
  // Shown on the card (and part of what is approved) so a background start is never
  // mistaken for a command that ends by itself.
  if (input.request.category === "run_command" && input.request.background)
    prepared.result.facts.push({ kind: "warning", value: "background_command" });
  return prepared;
}
