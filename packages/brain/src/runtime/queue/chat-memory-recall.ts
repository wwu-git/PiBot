import type { LocalToolPorts } from "@pibot/agent";
import type { MemoryRecallObservation, PersonalMemoryPort } from "../memory/port.ts";

/** Observations are optional and cannot interrupt a user run or change its policy gates. */
export function chatMemoryRecall(
  memory: PersonalMemoryPort | undefined,
  runId: string,
  signal: AbortSignal,
  onError: () => void,
) {
  let reported = false;
  const safely = (action: () => void) => {
    try {
      action();
    } catch {
      if (!reported) {
        reported = true;
        onError();
      }
    }
  };
  const observe = (value: MemoryRecallObservation) => {
    if (!signal.aborted) safely(() => memory?.observeRecall?.(runId, value));
  };
  return {
    observe,
    tools(ports: LocalToolPorts): LocalToolPorts {
      const execute: LocalToolPorts["execute"] = (call, toolSignal, output) => {
        if (!toolSignal.aborted) observe({ kind: "tool", value: call.input });
        return ports.execute(call, toolSignal, output);
      };
      // Definitions and loaded groups are accessors because the model and permissions can
      // affect them. Copying values here would pin the catalog before the model is selected.
      return Object.create(Object.getPrototypeOf(ports), {
        ...Object.getOwnPropertyDescriptors(ports),
        execute: { value: execute, enumerable: true, configurable: true, writable: true },
      }) as LocalToolPorts;
    },
    finish() {
      safely(() => memory?.finishRecall?.(runId));
    },
  };
}
