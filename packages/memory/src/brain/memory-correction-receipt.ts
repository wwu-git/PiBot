// Adds a persisted, redacted acknowledgement to the reply associated with a correction.
import type { DatabaseSync } from "node:sqlite";
import type { BrainRedactor } from "@pibot/brain/kit";
import { MemoryNotedSchema, memoryNoted as notedIn } from "@pibot/protocol-base";
import { MessagesRepo } from "@pibot/storage";

export function recordCorrectionReceipt(
  db: DatabaseSync,
  replyId: string,
  notes: { id: string; text: string }[],
  redactor: BrainRedactor,
) {
  const messages = new MessagesRepo(db);
  const reply = messages.get(replyId);
  if (reply?.status !== "done") return undefined;
  const usage =
    reply.usage && typeof reply.usage === "object" && !Array.isArray(reply.usage)
      ? reply.usage
      : {};
  // The Bot's own note from the turn and the extraction's later ones share one receipt.
  const earlier = notedIn(reply.usage) ?? [];
  const merged = MemoryNotedSchema.parse(
    [...new Map([...earlier, ...notes].map((note) => [note.id, note])).values()]
      .slice(0, 5)
      .map(({ id, text }) => ({
        id,
        text: redactor.redact(text).slice(0, 500),
      })),
  );
  return messages.update(reply.id, { usage: { ...usage, memoryNoted: merged } });
}
