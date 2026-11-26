// Revalidate writable roots against the owning host’s protected locations.
import { sensitiveReadBoundary, windowsSystemDrive, windowsSystemTrees } from "@pibot/execution";
import { nodeFileSystem, protectedPaths } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import { abortable } from "../../core/abort.ts";
import type { LocalDependencies } from "../../core/local-types.ts";

/** Associated roots become inside writes, so the outside-write gate can no longer protect them. */
export async function assertWritableFolders(
  deps: Pick<LocalDependencies, "platform" | "userHome" | "dataDir" | "env">,
  paths: readonly string[],
  home: string,
  signal: AbortSignal,
) {
  const sensitive = await abortable(
    sensitiveReadBoundary(deps.platform, [deps.userHome, home], deps.env),
    signal,
  );
  const protection = await protectedPaths(
    {
      platform: deps.platform,
      ...(deps.platform === "win32"
        ? {
            windowsSystemDrive: windowsSystemDrive(deps.env),
            windowsSystemTrees: windowsSystemTrees(deps.env),
          }
        : {}),
      home: deps.userHome,
      cwd: home,
      roots: [...paths],
      fs: nodeFileSystem,
      signal,
    },
    [...sensitive.denyRead, deps.dataDir],
  );
  signal.throwIfAborted();
  if (paths.some((path) => protection.covers(path))) throw new RpcError(-32602, "protected_path");
}
