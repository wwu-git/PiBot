import { DatabaseSync } from "node:sqlite";
import {
  BotsRepo,
  ConversationsRepo,
  GroupsRepo,
  MessagesRepo,
  runMigrations,
} from "@pibot/storage";
import { expect, it } from "vitest";
import { extractionSource } from "../src/brain/memory-extraction.ts";

function estimatedCost(lines: string[]) {
  return lines.reduce((total, line) => {
    const units = Array.from(line).reduce(
      (sum, point) => sum + ((point.codePointAt(0) ?? 0) > 127 ? 4 * point.length : 1),
      0,
    );
    return total + Math.ceil(units / 4) + 4;
  }, 0);
}

it("includes a bounded excerpt of an oversized user message before advancing coverage", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runMigrations(db);
    const bot = new BotsRepo(db).ensureMainBot();
    const conversation = new ConversationsRepo(db).create({ botId: bot.id });
    const messages = new MessagesRepo(db);
    const send = (content: string) =>
      messages.create({ conversationId: conversation.id, role: "user", status: "done", content });

    send("Before");
    send(`Decision worth remembering ${"测🙂".repeat(12_000)}`);
    const after = send("After");

    const first = extractionSource(db, conversation.id, null);
    expect(first?.watermarkId).toBe(after.id);
    expect(first?.truncated).toBe(true);
    expect(first?.messageCount).toBe(3);
    const lines = first?.text.split("\n\n") ?? [];
    expect(lines[0]).toBe("User: Before");
    expect(lines[1]).toMatch(/^User: Decision worth remembering [测🙂]+\n\[message truncated\]$/u);
    expect(lines[1]?.isWellFormed()).toBe(true);
    expect(lines[2]).toBe("User: After");
    expect(estimatedCost(lines)).toBeLessThanOrEqual(12_000);

    const latest = send("New turn");
    const second = extractionSource(db, conversation.id, after.id);
    expect(second?.text).toBe("User: New turn");
    expect(second?.truncated).toBe(false);

    const oversized = send("A".repeat(60_000));
    const third = extractionSource(db, conversation.id, latest.id);
    expect(third?.messageCount).toBe(1);
    expect(third?.subjectMessageId).toBe(oversized.id);
    expect(third?.text.endsWith("[message truncated]")).toBe(true);
  } finally {
    db.close();
  }
}, 30_000);

it.each([
  {
    name: "whole user turns would exhaust the budget",
    turns: [`Long decision ${"L".repeat(60_000)}`, `Whole decision ${"W".repeat(47_960)}`],
    prefixes: ["Long decision", "Whole decision"],
  },
  {
    name: "two oversized user turns are pending",
    turns: [`First decision ${"A".repeat(60_000)}`, `Second decision ${"B".repeat(60_000)}`],
    prefixes: ["First decision", "Second decision"],
  },
])(
  "includes excerpts before advancing coverage when $name",
  ({ turns, prefixes }) => {
    const db = new DatabaseSync(":memory:");
    try {
      runMigrations(db);
      const bot = new BotsRepo(db).ensureMainBot();
      const conversation = new ConversationsRepo(db).create({ botId: bot.id });
      const messages = new MessagesRepo(db);
      const send = (content: string) =>
        messages.create({ conversationId: conversation.id, role: "user", status: "done", content });
      const tail = turns.map(send).at(-1);
      const source = extractionSource(db, conversation.id, null);
      const lines = source?.text.split("\n\n") ?? [];
      expect(lines.map((line) => line.split(" ").slice(1, 3).join(" "))).toEqual(prefixes);
      expect(lines.every((line) => line.endsWith("[message truncated]"))).toBe(true);
      expect(estimatedCost(lines)).toBeLessThanOrEqual(12_000);
      expect(source?.watermarkId).toBe(tail?.id);

      send("Later");
      expect(extractionSource(db, conversation.id, source?.watermarkId ?? null)?.text).toBe(
        "User: Later",
      );
    } finally {
      db.close();
    }
  },
  30_000,
);

it("keeps only whole eligible statements as group evidence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runMigrations(db);
    const bots = new BotsRepo(db);
    const coordinator = bots.ensureMainBot();
    const member = bots.create({
      name: "Member",
      isMain: false,
      avatarShape: "blob",
      avatarColor: "orange",
      avatarEyes: "marks",
      modelProvider: null,
      modelId: null,
      thinkingLevel: "off",
      systemPrompt: "",
    });
    const group = new GroupsRepo(db).create({
      name: "Extraction test",
      botIds: [coordinator.id, member.id],
      coordinatorBotId: coordinator.id,
    });
    const topic = new ConversationsRepo(db).forGroup(group.id);
    if (!topic) throw new Error("Missing group topic");
    const messages = new MessagesRepo(db);
    const send = (content: string) =>
      messages.create({ conversationId: topic.id, role: "user", status: "done", content });

    send(`Oversized group statement ${"A".repeat(60_000)}`);
    const full = send("Confirmed whole group statement");
    const source = extractionSource(db, topic.id, null, 12_000, group.id);

    expect(source?.text).toBe(`Owner [${full.id}]: ${full.content}`);
    expect(source?.groupSourceIds).toEqual([full.id]);
    expect(source?.groupSourceTexts).toEqual({ [full.id]: full.content });
    expect(source?.truncated).toBe(true);
  } finally {
    db.close();
  }
}, 30_000);

it("keeps a short earlier turn when an almost-full turn precedes the excerpt allocation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runMigrations(db);
    const bot = new BotsRepo(db).ensureMainBot();
    const conversation = new ConversationsRepo(db).create({ botId: bot.id });
    const messages = new MessagesRepo(db);
    const send = (content: string) =>
      messages.create({ conversationId: conversation.id, role: "user", status: "done", content });

    send("My timezone is UTC.");
    send(`Earlier decision ${"L".repeat(60_000)}`);
    const latest = `Latest decision ${"A".repeat((11_968 - 4) * 4 - "User: Latest decision ".length)}`;
    expect(estimatedCost([`User: ${latest}`])).toBe(11_968);
    const tail = send(latest);

    const source = extractionSource(db, conversation.id, null);
    const lines = source?.text.split("\n\n") ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("User: My timezone is UTC.");
    expect(lines[1]).toMatch(/^User: Earlier decision L+\n\[message truncated\]$/u);
    expect(lines[2]).toMatch(/^User: Latest decision A+\n\[message truncated\]$/u);
    expect(estimatedCost(lines)).toBeLessThanOrEqual(12_000);
    expect(source?.watermarkId).toBe(tail.id);

    send("Later");
    expect(extractionSource(db, conversation.id, tail.id)?.text).toBe("User: Later");
  } finally {
    db.close();
  }
}, 30_000);
