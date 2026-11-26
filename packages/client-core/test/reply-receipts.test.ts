import { attachmentContinuationOf, type Message, MessageSchema } from "@pibot/protocol";
import { describe, expect, it } from "vitest";
import { nextReply } from "../src/chat/next-reply.ts";
import { replyReceiptPositions } from "../src/chat/reply-receipts.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-01-01T00:00:00.000Z";

function delivered() {
  const files = Array.from({ length: 25 }, (_, index) => ({
    id: id(100 + index),
    kind: "file" as const,
    name: `result-${index}.txt`,
    mimeType: "text/plain",
    size: 5,
  }));
  const owner: Message = {
    id: id(4),
    botId: id(1),
    conversationId: id(2),
    runId: id(3),
    role: "assistant",
    content: "The partial output is retained.",
    status: "aborted",
    errorCode: "aborted",
    usage: { stopReason: "aborted" },
    attachments: files.slice(0, 10),
    createdAt: at,
    updatedAt: at,
  };
  const pages = [10, 20].map(
    (start, index): Message => ({
      ...owner,
      id: id(5 + index),
      content: "",
      status: "done",
      errorCode: null,
      usage: { attachmentContinuationOf: owner.id },
      attachments: files.slice(start, start + 10),
    }),
  );
  return { owner, pages, files, rows: [owner, ...pages] };
}

describe("attachment delivery receipt projection", () => {
  it("keeps one original-owner footer after reload without merging or duplicating file sources", () => {
    const { rows, owner, files } = delivered();
    const reloaded = rows.map((row) => MessageSchema.parse(JSON.parse(JSON.stringify(row))));
    const positions = replyReceiptPositions(reloaded);
    expect([...positions.values()].filter((position) => position.messageId)).toHaveLength(1);
    expect(positions.get(reloaded.at(-1)?.id ?? "")).toMatchObject({
      messageId: owner.id,
      message: { id: owner.id, status: "aborted", usage: owner.usage },
    });
    expect(reloaded.every((row) => (row.attachments?.length ?? 0) <= 10)).toBe(true);
    const sources = reloaded.flatMap((row) =>
      (row.attachments ?? []).map((file) => ({ messageId: row.id, attachmentId: file.id })),
    );
    expect(sources.map((source) => source.attachmentId)).toEqual(files.map((file) => file.id));
    expect(new Set(sources.map((source) => source.attachmentId)).size).toBe(25);
    expect(sources.at(-1)?.messageId).toBe(reloaded.at(-1)?.id);
  });

  it("keeps a single canonical receipt ID in a page-only history window", () => {
    const { owner, pages } = delivered();
    const positions = replyReceiptPositions(pages);
    expect([...positions.values()].map((position) => position.messageId)).toEqual([null, owner.id]);
    expect(positions.get(pages.at(-1)?.id ?? "")?.message).toBeUndefined();
  });

  it("tracks a visible owner settling and leaves next-reply recovery on the actual reply", () => {
    const { owner, pages } = delivered();
    const streaming = { ...owner, status: "streaming" as const };
    const before = replyReceiptPositions([streaming, ...pages]);
    const after = replyReceiptPositions([owner, ...pages]);
    expect(before.get(pages.at(-1)?.id ?? "")?.message).toBe(streaming);
    expect(after.get(pages.at(-1)?.id ?? "")?.message).toBe(owner);
    const user: Message = { ...owner, id: id(9), role: "user", content: "Make files." };
    expect(nextReply(owner.conversationId, [user, owner, ...pages], [], [])?.key).toBe(
      "nextReply.stopped",
    );
    expect(attachmentContinuationOf({ ...pages[0], id: owner.id } as Message)).toBeUndefined();
  });
});
