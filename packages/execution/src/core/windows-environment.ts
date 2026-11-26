// Resolve Windows system locations from the owning host's environment.
import { win32 } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

function value(env: Environment, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1];
}

function drivePath(path: string | undefined): string | undefined {
  if (!path || !/^[a-z]:[\\/]/i.test(path) || /[\p{Cc}]/u.test(path)) return undefined;
  return path.charAt(0).toUpperCase() + win32.normalize(path).slice(1);
}

export function windowsSystemDrive(env: Environment): string | undefined {
  const drive = value(env, "systemdrive");
  if (drive && /^[a-z]:$/i.test(drive)) return `${drive.toUpperCase()}\\`;
  const root = installedWindowsRoot(env);
  return root && win32.parse(root).root;
}

export function installedWindowsRoot(env: Environment) {
  return drivePath(value(env, "systemroot")) ?? drivePath(value(env, "windir"));
}

export function windowsSystemRoot(env: Environment): string {
  return installedWindowsRoot(env) ?? win32.join(windowsSystemDrive(env) ?? "C:\\", "Windows");
}

export function windowsProgramFiles(env: Environment): string | undefined {
  return drivePath(value(env, "programw6432")) ?? drivePath(value(env, "programfiles"));
}

export function windowsSystemTrees(env: Environment): string[] {
  const drive = windowsSystemDrive(env);
  const programFiles = drivePath(value(env, "programfiles"));
  const trees = [
    installedWindowsRoot(env) ?? (drive && win32.join(drive, "Windows")),
    programFiles ?? (drive && win32.join(drive, "Program Files")),
    drivePath(value(env, "programw6432")),
    drivePath(value(env, "programfiles(x86)")) ??
      (drive && win32.join(drive, "Program Files (x86)")),
    drivePath(value(env, "programdata")) ?? (drive && win32.join(drive, "ProgramData")),
  ];
  return [...new Map(trees.flatMap((path) => (path ? [[path.toLowerCase(), path]] : []))).values()];
}
