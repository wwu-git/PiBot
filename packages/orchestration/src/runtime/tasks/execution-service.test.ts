import { randomUUID } from "node:crypto";
import type { LocalService, ToolRunContext } from "@pibot/brain/orchestration-kit";
import type { ExecutionScope } from "@pibot/protocol-base";
import { BotsRepo, ConversationsRepo, openDatabase, runMigrations } from "@pibot/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionService } from "./execution-service.ts";

describe("execution tool catalog", () => {
  let db: ReturnType<typeof openDatabase>;
  let service: ExecutionService;
  let scope: ExecutionScope;
  const hasAuthority = vi.fn(() => false);
  const taskMode = vi.fn(() => "plan");

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    const { id: botId } = new BotsRepo(db).ensureMainBot();
    const { id: conversationId } = new ConversationsRepo(db).ensureDm(botId);
    scope = { botId, conversationId };
    hasAuthority.mockReset().mockReturnValue(false);
    taskMode.mockClear();
    service = new ExecutionService({
      deps: { db },
      tasks: { hasAuthority, mode: taskMode },
    } as unknown as LocalService);
  });

  afterEach(() => db.close());

  it("queries the real conversation mode once per catalog pass and rechecks direct calls", () => {
    const mode = vi.spyOn(service, "mode");
    const tools = ["read_file", "run_command", "write_file", "todo_list"];
    const executePass = service.catalogAvailability(scope);
    expect(mode).not.toHaveBeenCalled();
    expect(tools.filter(executePass)).toEqual(tools);
    expect(mode).toHaveBeenCalledTimes(1);

    service.repo.set(scope, { expectedVersion: 0, mode: "plan" });
    expect(tools.filter(service.catalogAvailability(scope))).toEqual(["read_file", "todo_list"]);
    expect(mode).toHaveBeenCalledTimes(2);
    expect(service.allows(scope, "run_command")).toBe(false);

    service.repo.set(scope, { expectedVersion: 1, mode: "execute" });
    expect(service.allows(scope, "run_command")).toBe(true);
    expect(mode).toHaveBeenCalledTimes(4);
  });

  it("preserves the pending-question short circuit and refuses an invalid scope", () => {
    const pausedContext = {
      ...scope,
      conversationId: randomUUID(),
      todoRun: {
        armed: false,
        progress: new Set<string>(),
        codeChanges: 0,
        paused: {
          reason: "needs_user",
          summary: "Waiting for a synthetic choice",
          question: {
            prompt: "Choose one",
            options: [
              { id: "continue", label: "Continue", description: "Proceed" },
              { id: "finish", label: "Finish", description: "Finish" },
            ],
            recommendedId: "continue",
          },
        },
      },
    } satisfies Partial<ToolRunContext>;
    const mode = vi.spyOn(service, "mode");
    const canOffer = service.catalogAvailability(pausedContext);
    expect(["read_file", "run_command"].filter(canOffer)).toEqual([]);
    expect(service.allows(pausedContext, "run_command")).toBe(false);
    expect(mode).not.toHaveBeenCalled();
    expect(() => canOffer("todo_list")).toThrow("execution_unavailable");
    expect(() => service.allows(pausedContext, "todo_list")).toThrow("execution_unavailable");
  });

  it("uses a delegated run's frozen mode when building the catalog", () => {
    hasAuthority.mockReturnValue(true);
    const context = { ...scope, runId: randomUUID(), executionTaskId: randomUUID() };
    expect(
      ["read_file", "run_command", "todo_list"].filter(service.catalogAvailability(context)),
    ).toEqual(["read_file", "todo_list"]);
    expect(taskMode).toHaveBeenCalledTimes(1);
    expect(service.allows(context, "run_command")).toBe(false);
    expect(taskMode).toHaveBeenCalledTimes(2);
  });
});
