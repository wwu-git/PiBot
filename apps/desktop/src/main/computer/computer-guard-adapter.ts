import { createComputerGuard as createGuard, createGuardWindow } from "@pibot/computer-use/host";
import { BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen, session } from "electron";
export function createComputerGuard(
  options: Pick<
    Parameters<typeof createGuard>[0],
    "logger" | "outputDir" | "platform" | "visibilityChanged"
  >,
) {
  return createGuard({
    ...options,
    globalShortcut,
    createWindow: (input) =>
      createGuardWindow({
        ...input,
        electron: {
          createWindow: (config) => new BrowserWindow(config),
          denyPermissions: (partition) =>
            session
              .fromPartition(partition)
              .setPermissionRequestHandler((_contents, _permission, callback) => callback(false)),
          ipcMain,
          nativeTheme,
          screen,
        },
      }),
  });
}
