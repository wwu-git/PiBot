import type { DatabaseSync } from "node:sqlite";
import type { MemoryRecallObservation } from "@pibot/brain/kit";
import type { Memory } from "@pibot/protocol-base";
import { type RecallMemory, recordRecallInjection, recordRecallUsed } from "@pibot/storage";
import { recallKeywords, recallValues } from "./memory-recall-match.ts";
import { type RecallStream, recallSegment, recallStream } from "./memory-recall-stream.ts";

type Note = RecallMemory & { keywords: string[]; hits: Set<string>; matched: boolean };
type Observation = {
  botId: string;
  notes: Map<string, Note>;
  index: Map<string, Set<string>>;
  stream: RecallStream;
  hitNotes: Set<string>;
  bytes: number;
  events: number;
  reported: boolean;
  release(): void;
};

/** Only run-local token fragments live here. The database stores IDs, counts and times. */
export class MemoryRecallMetrics {
  private readonly runs = new Map<string, Observation>();
  private stopped = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly onError: () => void,
    private readonly visible: (botId: string, note: RecallMemory) => boolean,
  ) {}

  inject(runId: string, botId: string, notes: readonly Memory[], signal: AbortSignal) {
    if (
      this.stopped ||
      signal.aborted ||
      !notes.length ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId)
    )
      return;
    let observation = this.runs.get(runId);
    if (observation && observation.botId !== botId) return;
    if (!observation) {
      if (this.runs.size >= 64) return;
      const release = () => this.finish(runId, false);
      observation = {
        botId,
        notes: new Map(),
        index: new Map(),
        stream: recallStream(),
        hitNotes: new Set(),
        bytes: 0,
        events: 0,
        reported: false,
        release: () => signal.removeEventListener("abort", release),
      };
      signal.addEventListener("abort", release, { once: true });
      this.runs.set(runId, observation);
    }
    const selected: Memory[] = [];
    const admitted = new Set(observation.notes.keys());
    for (const note of notes.slice(0, 200)) {
      if (!admitted.has(note.id) && admitted.size >= 200) continue;
      admitted.add(note.id);
      selected.push(note);
    }
    try {
      const recorded = new Set(
        recordRecallInjection(
          this.db,
          runId,
          botId,
          selected.map((note) => ({
            ...note,
            scope: note.scope ?? "bot",
            ownerId: note.ownerId ?? botId,
          })),
          new Date().toISOString(),
        ),
      );
      for (const memory of selected) {
        if (!recorded.has(memory.id)) continue;
        const prior = observation.notes.get(memory.id);
        if (prior?.updatedAt === memory.updatedAt) continue;
        if (prior)
          for (const token of prior.keywords) {
            const ids = observation.index.get(token);
            ids?.delete(memory.id);
            if (!ids?.size) observation.index.delete(token);
          }
        const note: Note = {
          id: memory.id,
          updatedAt: memory.updatedAt,
          scope: memory.scope ?? "bot",
          ownerId: memory.ownerId ?? botId,
          keywords: recallKeywords(memory.text),
          hits: new Set(),
          matched: prior?.matched ?? false,
        };
        observation.notes.set(note.id, note);
        for (const token of note.keywords) {
          const ids = observation.index.get(token) ?? new Set();
          ids.add(note.id);
          observation.index.set(token, ids);
        }
      }
    } catch {
      // Optional measurement cannot turn a successful prompt into a failed user request.
      this.report(observation);
    }
  }

  observe(runId: string, value: MemoryRecallObservation) {
    const observation = this.runs.get(runId);
    if (this.stopped || !observation) return;
    if (observation.events >= 4096) {
      // A skipped suffix makes the pending word incomplete; EOF cannot certify its prefix.
      if (value.kind === "tool" || (value.kind === "reply" && value.text.length > 0))
        this.clearSegment(observation);
      return;
    }
    observation.events++;
    try {
      if (value.kind === "reply") this.scan(runId, observation, value.text, false);
      else {
        this.segmentEnd(runId, observation);
        if (value.kind === "tool")
          for (const field of recallValues(value.value)) {
            this.scan(runId, observation, field.text, field.complete);
            // Each parameter value is its own segment: fields never manufacture a word or hit set.
            this.clearSegment(observation);
          }
      }
    } catch {
      // Optional diagnostics contain no reply/tool text and are emitted at most once per run.
      this.report(observation);
    }
  }

  private scan(runId: string, observation: Observation, text: string, end: boolean) {
    const result = recallSegment(
      observation.stream,
      text,
      end,
      65_536 - observation.bytes,
      (word) => this.match(runId, observation, word),
    );
    observation.bytes = result.exhausted ? 65_536 : observation.bytes + result.consumed;
  }

  private match(runId: string, observation: Observation, word: string) {
    const normalized = word.normalize("NFKC").toLowerCase();
    const candidates = new Set<string>();
    for (const token of recallKeywords(normalized)) {
      for (const id of observation.index.get(token) ?? []) {
        observation.notes.get(id)?.hits.add(token);
        observation.hitNotes.add(id);
        candidates.add(id);
      }
    }
    // An ID must be the entire completed token, never a prefix or a substring in another ID.
    const idWord = word.toLowerCase();
    const explicit = observation.notes.has(idWord) ? idWord : undefined;
    if (explicit) candidates.add(explicit);
    for (const id of candidates) {
      const note = observation.notes.get(id);
      if (
        !note ||
        note.matched ||
        (explicit !== id && note.hits.size < Math.min(2, note.keywords.length || 2))
      )
        continue;
      if (!this.visible(observation.botId, note)) continue;
      recordRecallUsed(this.db, runId, note, new Date().toISOString());
      note.matched = true;
    }
  }

  private clearSegment(observation: Observation) {
    observation.stream = recallStream();
    for (const id of observation.hitNotes) observation.notes.get(id)?.hits.clear();
    observation.hitNotes.clear();
  }

  private segmentEnd(runId: string, observation: Observation) {
    this.scan(runId, observation, "", true);
    this.clearSegment(observation);
  }

  private report(observation: Observation) {
    if (observation.reported) return;
    observation.reported = true;
    this.onError();
  }

  finish(runId: string, complete = true) {
    const observation = this.runs.get(runId);
    if (observation && complete) {
      try {
        this.segmentEnd(runId, observation);
      } catch {
        this.report(observation);
      }
    }
    observation?.release();
    this.runs.delete(runId);
  }
  stop() {
    this.stopped = true;
    for (const id of this.runs.keys()) this.finish(id, false);
  }
}
