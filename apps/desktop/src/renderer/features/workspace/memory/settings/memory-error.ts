import { RpcError } from "@pibot/protocol";

/** Conflict is a server CAS result, not a generic transport or schema failure. */
export function memoryErrorKey(error: unknown) {
  if (error instanceof RpcError && error.message === "memory_project_file_changed")
    return "memorySettings.projectFileChanged" as const;
  if (error instanceof RpcError && error.message === "memory_project_target_invalid")
    return "memorySettings.projectTargetInvalid" as const;
  if (error instanceof RpcError && error.message === "memory_move_copy_required")
    return "memorySettings.moveCopyRequired" as const;
  if (error instanceof RpcError && error.message === "memory_move_restore_required")
    return "memorySettings.moveRestoreRequired" as const;
  if (error instanceof RpcError && error.message === "memory_conflict")
    return "memorySettings.conflict" as const;
  if (error instanceof Error && error.message === "memory_export_changed")
    return "memorySettings.conflict" as const;
  if (
    error instanceof Error &&
    ["memory_export_limit", "memory_transfer_limit"].includes(error.message)
  )
    return "memorySettings.exportLimit" as const;
  return "memorySettings.failed" as const;
}
