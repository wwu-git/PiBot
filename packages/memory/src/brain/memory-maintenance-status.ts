// Projects local maintenance receipts through the existing read-only memory status RPC.
import type { DatabaseSync } from "node:sqlite";
import type { RegisterRpc } from "@pibot/brain/kit";
import type { KernelMethodParams } from "@pibot/protocol-base";
import { memoryStatus, readMemoryMaintenance } from "@pibot/storage";
import { dayStart } from "./memory-extraction-attempt.ts";
import type { MemoryService } from "./memory-service.ts";

export function registerMemoryStatus(handle: RegisterRpc, db: DatabaseSync, memory: MemoryService) {
  handle("memory.status", async (params: KernelMethodParams["memory.status"]) => {
    if ("botId" in params) {
      const { botId, scope, ownerId } = params;
      const counts = memory.status(botId, scope, ownerId);
      return scope === undefined && ownerId === undefined
        ? { ...counts, maintenance: readMemoryMaintenance(db, dayStart(), botId) }
        : counts;
    }
    return {
      ...memoryStatus(db, { scope: "user", ownerId: "user" }),
      maintenance: readMemoryMaintenance(db, dayStart()),
    };
  });
}
