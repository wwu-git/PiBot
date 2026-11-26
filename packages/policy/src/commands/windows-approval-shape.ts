// Prove the small set of Windows command shapes that need no consent to run without isolation.
import { isOutputTarget } from "./output-targets.ts";
import { powershellSegments } from "./powershell-segments.ts";

type Read = {
  path: string;
  category: "read_file" | "list_dir";
  enumerates?: boolean;
  recurse?: boolean;
  readEntries?: boolean;
};

const child = /^(?:get-childitem|gci|ls|dir)$/;
const content = /^(?:get-content|gc|cat|type)$/;
const item = /^(?:get-item|resolve-path|test-path)$/;
const location = /^(?:get-location|pwd)$/;
const plain = /^[\p{L}\p{M}\p{N}_.+:/\\-]+$/u;
const quoted = /^(?:'([\p{L}\p{M}\p{N}_.+:/\\ -]+)'|"([\p{L}\p{M}\p{N}_.+:/\\ -]+)")$/u;

export function windowsLiteralToken(token: string) {
  if (plain.test(token)) return token;
  const match = quoted.exec(token);
  return match?.[1] ?? match?.[2];
}

export function windowsLiteralPath(value: string) {
  const local = value.replace(/^[a-z]:[\\/]/i, "");
  return (
    !/^[\\/]/.test(value) &&
    !/[:*?~[\]]/.test(local) &&
    local
      .split(/[\\/]/)
      .every(
        (part) =>
          part === "." ||
          (part !== ".." &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)),
      )
  );
}

function pathRead(program: string, args: string[]): Read | undefined {
  const category = child.test(program) || item.test(program) ? "list_dir" : "read_file";
  const values = [...args];
  const enumerates = child.test(program);
  const recurse = enumerates && values[0]?.toLowerCase() === "-recurse";
  if (recurse) values.shift();
  if (/^-(?:path|literalpath)$/i.test(values[0] ?? "")) {
    values.shift();
    if (!values.length) return undefined;
  }
  if (!values.length && enumerates) return { path: ".", category, enumerates, recurse };
  if (values.length !== 1) return undefined;
  const token = values[0] ?? "";
  const path = windowsLiteralToken(token);
  if (!path || token.startsWith("-") || !windowsLiteralPath(path)) return undefined;
  return { path, category, enumerates, recurse };
}

/**
 * `Select-String` with named parameters reads the same way as its positional form: one literal
 * pattern and, unless piped, one literal path. Only plain matching switches are accepted.
 */
function namedSelectString(args: string[], piped: boolean) {
  let pattern: string | undefined;
  let path: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const name = args[index]?.toLowerCase() ?? "";
    if (/^-(?:simplematch|casesensitive)$/.test(name)) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-") || !windowsLiteralToken(value)) return;
    index++;
    if (name === "-pattern" && pattern === undefined) pattern = value;
    else if (/^-(?:path|literalpath)$/.test(name) && path === undefined && !piped) path = value;
    else return;
  }
  if (pattern === undefined || (!piped && path === undefined)) return;
  return { path };
}

function readSegment(program: string, args: string[], piped: boolean): Read[] | undefined {
  if (piped) {
    if (/^(?:measure-object|measure)$/.test(program) && !args.length) return [];
    if (
      program === "select-string" &&
      args.length === 1 &&
      windowsLiteralToken(args[0] ?? "") &&
      !args[0]?.startsWith("-")
    )
      return [];
    if (program === "select-string" && args[0]?.startsWith("-") && namedSelectString(args, true))
      return [];
    return undefined;
  }
  if (child.test(program) || content.test(program) || item.test(program)) {
    const read = pathRead(program, args);
    return read ? [read] : undefined;
  }
  if (
    (location.test(program) || /^(?:get-date|measure-object|measure)$/.test(program)) &&
    !args.length
  )
    return [];
  if (
    /^(?:echo|write-output)$/.test(program) &&
    args.every((arg) => windowsLiteralToken(arg) && !arg.startsWith("-"))
  )
    return [];
  if (
    program === "get-command" &&
    args.length === 2 &&
    args[0]?.toLowerCase() === "-listimported" &&
    /^[a-z][a-z0-9-]*$/i.test(args[1] ?? "")
  )
    return [];
  if (
    program === "select-string" &&
    args.length === 2 &&
    windowsLiteralToken(args[0] ?? "") &&
    !args[0]?.startsWith("-")
  ) {
    const read = pathRead(program, args.slice(1));
    return read ? [read] : undefined;
  }
  if (program === "select-string" && args[0]?.startsWith("-")) {
    const named = namedSelectString(args, false);
    const read = named?.path === undefined ? undefined : pathRead(program, [named.path]);
    return read ? [read] : undefined;
  }
  return undefined;
}

function cmdRead(args: string[]): Read[] | undefined {
  // /d suppresses cmd's inherited AutoRun. Restrict cmd to its own literal built-ins.
  const [disableAutoRun, execute, ...body] = args;
  if (disableAutoRun?.toLowerCase() !== "/d" || execute?.toLowerCase() !== "/c") return undefined;
  const quotedBody =
    body.length === 1 ? /^"([a-z0-9_.:+/\\ -]+) > ([a-z]+)"$/i.exec(body[0] ?? "") : undefined;
  const command =
    quotedBody && isOutputTarget(quotedBody[2] ?? "", "win32")
      ? (quotedBody[1] ?? "").trim().split(/ +/)
      : body;
  const [name, ...operands] = command;
  if (!operands.every((arg) => /^[a-z0-9_.:+/\\-]+$/i.test(arg))) return undefined;
  const program = name?.toLowerCase();
  if (program === "echo" && operands.every((arg) => !/[/\\:]/.test(arg))) return [];
  if (program !== "dir" && program !== "type") return undefined;
  if (operands.some((arg) => /^[/-]/.test(arg))) return undefined;
  const read = pathRead(program, operands);
  return read ? [read] : undefined;
}

function withoutNullSink(tokens: string[]) {
  if (tokens.length >= 3 && tokens.at(-2) === ">" && /^\$null$/i.test(tokens.at(-1) ?? ""))
    return tokens.slice(0, -2);
  return tokens;
}

export function windowsReadShape(command: string): Read[] | undefined {
  // PowerShell recognizes smart quotes as delimiters. Treat expansion/call syntax and comments
  // as unknown, including line continuations and cmd expansion, before using the shared lexer.
  if (
    /[\u2018-\u201f\x60#%&<^(){}@!*?[\],]|[/\\]{2}|[^\S \t\r\n]|\p{Cc}/u.test(
      command.replaceAll(/[\t\r\n]/g, " "),
    )
  )
    return undefined;
  const parsed = powershellSegments(command);
  if (parsed.unclosed || parsed.tooLong || parsed.pieces.length > 16) return undefined;
  const reads: Read[] = [];
  let previousRead = false;
  let pipelineSource: Read | undefined;
  let previousProgram = "";
  for (const { tokens, separator } of parsed.pieces) {
    if (!tokens.length) {
      if (separator === "|") return undefined;
      previousRead = false;
      continue;
    }
    const program = tokens[0]?.toLowerCase() ?? "";
    const cmd = program === "cmd.exe" || program === "cmd";
    const shape = withoutNullSink(tokens);
    const args = shape.slice(1);
    const piped = separator === "|";
    if (piped && (!previousRead || cmd)) return undefined;
    const found = cmd ? cmdRead(args) : readSegment(program, args, piped);
    if (!found) return undefined;
    if (piped && program === "select-string") {
      if (pipelineSource?.enumerates) pipelineSource.readEntries = true;
      else if (
        pipelineSource?.category !== "read_file" &&
        !/^(?:echo|write-output)$/.test(previousProgram)
      )
        return undefined;
    }
    pipelineSource = found.at(-1);
    previousProgram = program;
    reads.push(...found);
    previousRead = true;
  }
  return previousRead || reads.length ? reads : undefined;
}
