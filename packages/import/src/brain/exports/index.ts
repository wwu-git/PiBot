// Use the same decoding pass for preview and import so conversation counts cannot drift.
import { createHash } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { ExportDetails } from "@pibot/import-contract";
import {
  type ImportAdapter,
  ImportFailure,
  type ImportInput,
  type ImportRecord,
  type PreviewRecord,
  previewMessage,
} from "../adapter.ts";
import { chatgptConversation } from "./chatgpt.ts";
import { claudeConversation } from "./claude.ts";
import { jsonRecords } from "./json.ts";
import { type Supplement, supplementItems } from "./supplement.ts";
import { type ZipMember, zipDirectory, zipMember } from "./zip.ts";

type Vendor = "chatgpt" | "claude";
type PreviewSummary = Extract<PreviewRecord, { kind: "exportSummary" }>;
const MAX_JSON_BYTES = 768 * 1024 * 1024;
const MAX_SUPPLEMENTS = 10_000;

function components(directory: Map<string, ZipMember>, vendor: Vendor) {
  const pattern =
    vendor === "chatgpt" ? /^conversations(?:[-_]?\d+)?\.json$/ : /^conversations\.json$/;
  const candidates = [...directory.values()].filter(({ name }) =>
    pattern.test(name.split("/").at(-1) ?? ""),
  );
  const parent = candidates[0]?.name.replace(/[^/]+$/, "");
  if (
    parent === undefined ||
    parent.split("/").length > 2 ||
    candidates.some(({ name }) => name.replace(/[^/]+$/, "") !== parent)
  )
    throw new ImportFailure("format");
  const entries = candidates.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const optional = new Map<ZipMember, Supplement["kind"]>();
  const known: Record<string, Supplement["kind"]> = {
    "memories.json": "memories",
    "memory.json": "memories",
  };
  if (vendor === "chatgpt") known["custom_instructions.json"] = "customInstructions";
  else known["projects.json"] = "projects";
  for (const [name, kind] of Object.entries(known)) {
    const entry = directory.get(parent + name);
    if (entry) optional.set(entry, kind);
  }
  const total = [...entries, ...optional.keys()].reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_JSON_BYTES) throw new ImportFailure("limit");
  return { entries, optional };
}

function fileAttachment({ name }: ZipMember) {
  return (
    /(?:^|\/)(?:attachments|images|files|assets)\/(?:.*[^/])$/i.test(name) ||
    /(?:^|\/)file[-_][^/]+$/i.test(name) ||
    /\.(?:png|jpe?g|gif|webp|heic|svg|bmp|tiff?|wav|mp3|m4a|ogg|mp4|webm|pdf)$/i.test(name)
  );
}

type ExportItem = ImportRecord | Supplement | PreviewSummary;

export async function* exportItems(
  vendor: Vendor,
  input: ImportInput,
  signal: AbortSignal,
): AsyncGenerator<ExportItem> {
  if (!input.file) throw new ImportFailure("format");
  for await (const file of input.file(signal)) {
    const directory = await zipDirectory(file, signal);
    const { entries, optional } = components(directory, vendor);
    const summary: ExportDetails = {
      memories: 0,
      customInstructions: 0,
      projects: 0,
      skippedAttachments: 0,
      skippedFiles: [...directory.values()].filter(fileAttachment).length,
    };
    const instructionHashes = new Set<string>();
    const standalone = [...optional.values()].includes("customInstructions");
    const conversation = vendor === "chatgpt" ? chatgptConversation : claudeConversation;
    for (const entry of entries) {
      for await (const row of jsonRecords(zipMember(file, entry, signal), signal)) {
        let items = 0;
        for await (const item of conversation(row, signal)) {
          if (++items % 32 === 0) await yieldToLoop(undefined, { signal });
          if (item.kind === "attachments") summary.skippedAttachments += item.count;
          else if (item.kind === "instructions") {
            if (standalone) continue;
            for (const text of item.value) {
              if (!text?.trim()) continue;
              const key = createHash("sha256").update(text).digest("hex");
              if (instructionHashes.has(key)) continue;
              if (text.length > 65_536 || ++summary.customInstructions > MAX_SUPPLEMENTS)
                throw new ImportFailure("limit");
              instructionHashes.add(key);
              yield { kind: "customInstructions", text };
            }
          } else yield item;
        }
        await yieldToLoop(undefined, { signal });
      }
    }
    for (const [entry, kind] of optional) {
      for await (const row of jsonRecords(zipMember(file, entry, signal), signal, true)) {
        for (const item of supplementItems(kind, row)) {
          if (item.text && ++summary[kind] > MAX_SUPPLEMENTS) throw new ImportFailure("limit");
          yield item;
        }
        await yieldToLoop(undefined, { signal });
      }
    }
    yield { kind: "exportSummary", ...summary };
  }
}

export function exportAdapter(vendor: Vendor): ImportAdapter {
  return {
    async *detect(signal) {
      signal.throwIfAborted();
      yield true;
    },
    async *preview(input, signal) {
      for await (const item of exportItems(vendor, input, signal)) {
        if (item.kind === "topic") {
          yield {
            kind: "topic",
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            ...(item.project ? { project: item.project } : {}),
          };
        } else if (item.kind === "projects" && item.project) {
          yield { kind: "projectKnowledge", project: item.project, pieces: item.text ? 1 : 0 };
        } else if (item.kind === "message") {
          yield previewMessage(item);
        } else if (item.kind === "exportSummary") yield item;
      }
    },
    async *read(input, signal) {
      for await (const item of exportItems(vendor, input, signal)) {
        if (item.kind === "topic" || item.kind === "message") yield item;
      }
    },
  };
}
