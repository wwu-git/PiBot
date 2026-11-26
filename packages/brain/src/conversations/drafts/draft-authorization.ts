import {
  connectionConfirmation,
  effectiveConfirmationMode,
  effectiveLevel,
  matchesGrant,
  matchesRoutinePreauth,
  type PolicyResult,
  recordPolicyStep,
} from "@pibot/policy";
import { type DraftMetadata, supportsDirectConnectionWrites } from "@pibot/protocol-base";
import type { DraftPayload } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runPermissionSources, runPermissions } from "../../core/run-permissions.ts";
import { runYolo } from "../../core/yolo.ts";
import type { LocalService } from "../../local-service.ts";
import { connectorPreauthIssue } from "../../runtime/unattended/connector-preauth.ts";
import { fail } from "./draft-content.ts";
import { hasRememberedConnectionTool } from "./draft-tool-grants.ts";

/**
 * The Bot's own `confirmEverySend` mark (owner decision 2026-11-24). Read from the Bot row, not the
 * run's settings: a group run takes the group's levels, which must not drop this.
 */
export function confirmsEverySend(local: LocalService, botId: string): boolean {
  return local.permissions.overrides(botId).confirmEverySend === true;
}

function routineGrant(
  local: LocalService,
  context: ToolRunContext,
  category: "send_out",
  scope: import("@pibot/protocol-base").GrantScope,
) {
  const owner = local.unattended;
  if (!context.routineRunId || !owner) return false;
  const run = owner.run(context.routineRunId);
  const routine = run.routineId ? owner.definition(run.routineId) : undefined;
  if (
    !routine ||
    routine.deletedAt ||
    !routine.enabled ||
    run.reason === "trial" ||
    routine.botId !== context.botId
  )
    return false;
  const wanted = { category, scope };
  return routine.preauth.some(
    (record) =>
      !record.revokedAt &&
      !connectorPreauthIssue(local, context.botId, record.operation) &&
      matchesRoutinePreauth(record.operation, wanted, local.deps.platform),
  );
}
export function automaticDraftAllowed(
  local: LocalService,
  context: ToolRunContext,
  draft: DraftMetadata,
  result: PolicyResult,
  /** The person just answered this same call's "ask every time" card (`PreparedTool.confirmedNow`). */
  confirmedNow = false,
) {
  const scope = result.grantScope;
  // Without the connectors capability there is nothing to send through.
  if (!local.connectors) return false;
  const connector = local.connectors.get(draft.connectorId);
  if (!connector) return false;
  const mode = effectiveConfirmationMode({
    connector,
    access: local.connectors.access(draft.connectorId),
  });
  const confirmation = connectionConfirmation(mode, true);
  if (confirmation === "blocked") return false;
  // Before remembered tool consent, routine pre-approval, YOLO and target grants: none of them
  // answers for a Bot that confirms every send; only the person's answer to this call does.
  if (confirmsEverySend(local, context.botId)) return confirmedNow;
  // Nothing remembered, no YOLO and no pre-authorization stands in for "ask every time"; only
  // the person's answer to this very call does.
  if (confirmation === "ask_now") return confirmedNow;
  if (
    mode === "direct_read_write" &&
    supportsDirectConnectionWrites(connector.kind) &&
    context.interactiveChat &&
    !context.routineRunId &&
    !context.routineSource &&
    !context.executionTaskId &&
    !context.auditSource
  )
    return "connector_direct_write" as const;
  // Outside direct writes, user identity still needs consent for this call.
  if (draft.identity === "user") return confirmedNow;
  const tool = local.connectors.tool(draft.connectorId, connector.catalogVersion, draft.tool);
  if (
    tool?.enabled &&
    hasRememberedConnectionTool(local, context.botId, draft.connectorId, tool, context)
  )
    return true;
  // Only Bot-identity operations reach reusable target consent and unattended permissions.
  if (context.routineRunId) return !!scope && routineGrant(local, context, "send_out", scope);
  if (runYolo(local, context)) return true;
  return (
    !!scope &&
    local
      .grants(context.botId, context)
      .some(
        (grant) =>
          !grant.revokedAt &&
          matchesGrant(
            grant,
            { botId: context.botId, category: "send_out", scope },
            local.deps.platform,
          ),
      )
  );
}
export async function evaluateDraft(
  local: LocalService,
  context: ToolRunContext,
  draft: DraftMetadata,
  payload: DraftPayload,
  signal: AbortSignal,
  confirmedNow = false,
): Promise<PolicyResult> {
  const permissions = local.tasks.settings(context, runPermissions(local, context));
  if (effectiveLevel(permissions.levels.connector, undefined) === "never")
    return fail("draftDenied", "connector_permission_denied");
  const policy = await local.getPolicy(signal);
  const result = await policy.evaluate({
    botId: context.botId,
    request: {
      category: "send_out",
      identity: draft.identity,
      connectorId: draft.connectorId,
      tool: draft.tool,
      target: draft.target,
      definitionDigest: payload.definitionDigest,
      targetDigest: payload.targetDigest,
      rememberable: draft.canRememberTarget,
    },
    settings: permissions,
    permissionSources: runPermissionSources(local, context),
    confirmEverySend: confirmsEverySend(local, context.botId),
    grants: local.grants(context.botId, context),
    workplace: { home: local.deps.dataDir, folders: [], currentId: "home" },
    yolo: runYolo(local, context),
    signal,
  });
  if (!local.connectors?.get(draft.connectorId)?.enabled)
    return fail("draftChanged", "draft_connector_changed");
  const authorization =
    result.decision !== "deny" &&
    automaticDraftAllowed(local, context, draft, result, confirmedNow);
  if (result.decision !== "deny") result.decision = authorization ? "allow" : "ask";
  recordPolicyStep(
    result,
    "connector",
    result.decision === "deny"
      ? result.reason
      : result.decision === "allow"
        ? typeof authorization === "string"
          ? authorization
          : "draft_automatic_authorized"
        : "draft_confirmation_required",
  );
  return result;
}
