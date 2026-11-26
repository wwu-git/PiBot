// Supply only trusted host paths to the command and outside-write policy.
import { sensitiveReadBoundary, windowsSystemTrees } from "@pibot/execution";
import type { ExecutionLocationTarget } from "@pibot/protocol-base";
import { abortable } from "../../core/abort.ts";
import type { LocalService } from "../../local-service.ts";

/**
 * Brain's part of the protected write list, handed to policy and read only when a
 * write leaves every workplace or Windows scans command text. Exec's sensitive roots are the same
 * list the command sandbox denies reading; the data directory holds every Bot's files, keys and databases.
 *
 * Only for this computer: a runner's paths are not checkable on a card and an editor terminal
 * (ACP) has no sandbox to open a single folder in, so both keep the hard refusal.
 */
export function protectedWriteRoots(
  local: LocalService,
  target: ExecutionLocationTarget | undefined,
  workplaceHome: string,
) {
  if (target !== undefined && target !== "local") return undefined;
  return async (signal: AbortSignal): Promise<readonly string[]> => {
    const boundary = await abortable(
      sensitiveReadBoundary(
        local.deps.platform,
        [local.deps.userHome, workplaceHome],
        local.deps.env,
      ),
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    );
    return [
      ...boundary.denyRead,
      local.deps.dataDir,
      ...(local.deps.platform === "win32" ? windowsSystemTrees(local.deps.env) : []),
    ];
  };
}
