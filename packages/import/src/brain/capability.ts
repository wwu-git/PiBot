// The desktop composition owns import registration, guarded source selection, and shutdown.
import type { BrainCapability } from "@pibot/brain/kit";
import type { ImportParams } from "@pibot/import-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { ImportStore } from "../store/index.ts";
import { ImportJobs } from "./jobs.ts";

export function importCapability(): BrainCapability {
  return {
    id: "import",
    register(ctx) {
      const store = new ImportStore(ctx.db, ctx.redactor, ctx.local.workplaces.repo);
      const jobs = new ImportJobs(ctx, store);
      const lifecycle = { start: () => jobs.recover(), stop: () => jobs.stop() };
      ctx.sleep.participate({ idle: () => jobs.idle() });
      if (!ctx.host.pickFile) return lifecycle;
      const handle = ctx.rpc.handle;
      const desktop = (source?: "acp") => {
        if (source === "acp") throw new RpcError(RpcErrorCodes.unsupported, "import_desktop_only");
      };
      handle("import.detect", ({ source }: ImportParams<"import.detect">, request) => {
        desktop(request.source);
        return jobs.detect(source, request.signal);
      });
      handle("import.preview", ({ source }: ImportParams<"import.preview">, request) => {
        desktop(request.source);
        return jobs.preview(source, request.signal);
      });
      handle("import.reviewMemories", (params: ImportParams<"import.reviewMemories">, request) => {
        desktop(request.source);
        return jobs.reviews.review(params, request.signal);
      });
      handle(
        "import.estimateDistillation",
        (params: ImportParams<"import.estimateDistillation">, request) => {
          desktop(request.source);
          return jobs.reviews.estimateDistillation(params);
        },
      );
      handle("import.history", (params: ImportParams<"import.history">, request) => {
        desktop(request.source);
        return jobs.history(params);
      });
      handle("import.reviewPlan", ({ importId }: ImportParams<"import.reviewPlan">, request) => {
        desktop(request.source);
        return jobs.reviews.plan(importId, request.signal);
      });
      handle("import.reviewProject", (params: ImportParams<"import.reviewProject">, request) => {
        desktop(request.source);
        return jobs.reviews.reviewProject(params, request.signal);
      });
      handle(
        "import.start",
        ({ importId, botId, ...options }: ImportParams<"import.start">, request) => {
          desktop(request.source);
          return jobs.start(importId, botId, options);
        },
      );
      handle("import.status", ({ importId }: ImportParams<"import.status">, request) => {
        desktop(request.source);
        return jobs.status(importId);
      });
      handle("import.cancel", ({ importId }: ImportParams<"import.cancel">, request) => {
        desktop(request.source);
        return jobs.cancel(importId);
      });
      handle("import.undo", ({ importId }: ImportParams<"import.undo">, request) => {
        desktop(request.source);
        return jobs.undo(importId);
      });
      return lifecycle;
    },
  };
}
