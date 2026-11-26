// Keep commands with opaque execution or sensitive Windows path syntax on the one-time card.
import { win32 } from "node:path";
import { powershellSegments } from "../commands/powershell-segments.ts";
import { windowsLiteralPath, windowsLiteralToken } from "../commands/windows-approval-shape.ts";
import { containsPath } from "../paths/paths.ts";
import {
  type CommandPathScope,
  isWritableCommandPath,
  windowsProtectedCommandPath,
} from "./command-path-risk.ts";

const WINDOWS_DELETE = /^(?:remove-item|ri|rm|rmdir|rd|del|erase)$/i;
const inlineType =
  /\badd-type\b(?!\s+[-\u2013-\u2015](?:path|literalpath|assemblyname)(?=[ :\t]))|\badd-type\b[^\r\n]*[-\u2013-\u2015](?:typedefinition|memberdefinition)(?=[\s:=])/i;
const dynamicExecution =
  /\b(?:invoke-expression|iex)\b|[-\u2013-\u2015](?:enc(?:odedcommand)?|encodedarguments)(?=$|[\s"'=:])|\[\s*(?:system\.management\.automation\.)?scriptblock\s*\]\s*::\s*create\b|\$\s*\(|(?:^|[;|\r\n])\s*[.&]\s*(?:\$|[(])|[-\u2013-\u2015]scriptblock(?=$|[\s:=])|--%/i;
const cmdExpansion = /\bcmd(?:\.exe)?\b[^\r\n]*?\/[ck]\s+[^\r\n]*(?:%[^%\s]+%|![^!\s]+!)/i;

function encodedShellArgument(command: string) {
  const launch = /\b(?:powershell|pwsh)(?:\.exe)?\b/i.exec(command);
  if (!launch) return false;
  const args = command.slice(launch.index + launch[0].length);
  for (const match of args.matchAll(
    /(?:^|[\s"'])(?:--?|[/\u2013-\u2015])([a-z]+)(?=$|[\s"'=:])/gi,
  )) {
    const flag = match[1]?.toLowerCase();
    if (flag && (flag === "ec" || "encodedcommand".startsWith(flag))) return true;
  }
  return false;
}

/** Forward-slash UNC is valid too, but the slashes in a URL scheme are not UNC. */
export function windowsNetworkOrDevicePath(text: string) {
  return /\\[\\/]|\/\\|(?<!:)\/\/|\bfile:\/\/(?=[^/])|\\(?:\?\?|device|global\?\?)\\/i.test(text);
}

export function windowsObfuscatedCommand(command: string) {
  const parsed = powershellSegments(command);
  return (
    parsed.tooLong ||
    parsed.unclosed ||
    command.includes("`") ||
    /(?:^|[\s"'=;(])[a-z]:(?![\\/])/i.test(command) ||
    dynamicExecution.test(command) ||
    encodedShellArgument(command) ||
    cmdExpansion.test(command) ||
    parsed.pieces.some(
      ({ separator, tokens }) =>
        separator === "&" && tokens.length > 0 && !windowsLiteralToken(tokens[0] ?? ""),
    ) ||
    inlineType.test(command)
  );
}

/** Exempt only an unchanged, literal PowerShell delete of one strict work-folder descendant. */
export function windowsDeleteTarget(command: string, cwd: string) {
  const { pieces } = powershellSegments(command);
  if (pieces.some((piece) => piece.afterPipeOrCall)) return undefined;
  const statements = pieces.filter((piece) => piece.tokens.length);
  const [program, ...args] = statements[0]?.tokens ?? [];
  if (statements.length !== 1 || !WINDOWS_DELETE.test(program ?? "")) return undefined;
  const operands: string[] = [];
  for (const arg of args) {
    if (/^-(?:recurse|force|literalpath|path)$/i.test(arg)) continue;
    if (/^[-/]/.test(arg)) return undefined;
    const value = windowsLiteralToken(arg);
    if (!value) return undefined;
    operands.push(value);
  }
  const target = operands[0];
  if (operands.length !== 1 || !target || !windowsLiteralPath(target)) return undefined;
  return win32.resolve(cwd, target);
}

export function safeWindowsDeletePath(
  path: string,
  protectedRoots: readonly string[],
  scope: CommandPathScope,
  ownRoots: readonly string[] = [],
) {
  return (
    !windowsProtectedCommandPath(path, protectedRoots, ownRoots) &&
    isWritableCommandPath(path, "win32", scope) &&
    ![...scope.writeRoots, ...scope.denyWriteRoots, ...protectedRoots].some((root) =>
      containsPath(path, root, "win32"),
    )
  );
}
