// Enforce the long-message size limit before untrusted export text reaches storage.
import { ImportFailure, type ImportRecord } from "../adapter.ts";
import { LONG_MESSAGE_CHARS } from "../limits.ts";

export type ConversationItem =
  | ImportRecord
  | { kind: "attachments"; count: number }
  | { kind: "instructions"; value: readonly (string | undefined)[] };

export function readableText(parts: readonly string[]) {
  const text = parts.filter((part) => part.trim()).join("\n");
  if (text.length > LONG_MESSAGE_CHARS) throw new ImportFailure("limit");
  return text;
}
