import type { Message } from "@pibot/protocol";
import { describe, expect, it, vi } from "vitest";
import { committedReply } from "./run-reply.ts";

const botId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const assistantMessageId = "00000000-0000-4000-8000-000000000004";
const pageId = "00000000-0000-4000-8000-000000000005";
const at = "2026-01-01T00:00:00.000Z";

function readReply(status: Message["status"]) {
  const terminal: Message = {
    botId,
    conversationId,
    runId,
    id: assistantMessageId,
    role: "assistant",
    content: "Partial result",
    status,
    errorCode: status === "aborted" ? "aborted" : null,
    usage: null,
    createdAt: at,
    updatedAt: at,
  };
  const page: Message = {
    ...terminal,
    id: pageId,
    content: "",
    status: "done",
    errorCode: null,
    usage: { attachmentContinuationOf: assistantMessageId },
    attachments: [
      { id: pageId, kind: "file", name: "result.txt", size: 5, mimeType: "text/plain" },
    ],
  };
  const client = { call: vi.fn().mockResolvedValue([terminal, page]) } as unknown as Parameters<
    typeof committedReply
  >[0];
  return committedReply(
    client,
    botId,
    { runId, conversationId, assistantMessageId },
    (work) => work,
  );
}

describe("terminal CLI reply with attachment continuation", () => {
  it("waits for the actual streaming reply even after attachment delivery", async () => {
    expect(await readReply("streaming")).toBeUndefined();
  });

  it("preserves the original reply and its abort status", async () => {
    expect(await readReply("aborted")).toMatchObject({
      id: assistantMessageId,
      content: "Partial result",
      status: "aborted",
      errorCode: "aborted",
    });
  });
});
