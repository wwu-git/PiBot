import type { LocalToolCall } from "@pibot/agent";
import { type DraftResolve, type DraftView, RpcError } from "@pibot/protocol-base";
import { type DraftPayload, DraftsRepo, transaction } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import { runPermissions } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import {
  type ConnectorCallInput,
  ConnectorToolError,
  connectorDigest,
  type PreparedConnector,
} from "../../runtime/tools/connectors/connector-tools.ts";
import { routineOperationHash } from "../../runtime/unattended/operation.ts";
import { CalendarDirectory } from "./calendar-directory.ts";
import { evaluateDraft } from "./draft-authorization.ts";
import { canonicalDraftValue, draftCallDigest, fail, makeDraft } from "./draft-content.ts";
import { draftContext } from "./draft-context.ts";
import { resolveDraft } from "./draft-resolution.ts";
import { connectionToolRememberable } from "./draft-tool-grants.ts";
import { DraftWaitRegistry } from "./draft-waiting.ts";

interface DraftResponse {
  reply?: unknown;
  serviceMessage?: string;
}

export class DraftService {
  readonly repo: DraftsRepo;
  readonly calendars = new CalendarDirectory();
  private readonly waiting: DraftWaitRegistry;
  private readonly jobs = new Set<Promise<unknown>>();
  /** Send replies held only until the waiting tool call reads them (see execute). */
  private readonly replies = new Map<string, unknown>();
  /** Redacted service failure reasons, held the same way as replies. */
  private readonly failures = new Map<string, string>();
  private sweepCursor?: string;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly local: LocalService) {
    this.repo = new DraftsRepo(local.deps.db);
    this.waiting = new DraftWaitRegistry(local, this.repo);
    this.repo.recover();
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }
  private changed(approvalId: string) {
    this.waiting.changed(approvalId);
    const record = this.repo.get(approvalId);
    if (record)
      this.local.deps.peer.emit("drafts.changed", {
        approvalId,
        conversationId: record.view.conversationId,
        status: record.view.status,
      });
  }
  private sweep() {
    for (const id of this.repo.expired()) this.expire(id);
    const page = this.repo.list({ limit: 50, before: this.sweepCursor });
    this.sweepCursor = page.length === 50 ? page.at(-1)?.approvalId : undefined;
    const connectors = this.local.connectors;
    for (const row of page) {
      try {
        const stored = this.repo.get(row.approvalId);
        if (!stored) continue;
        const context = this.context(row, stored.payload);
        const levels = this.local.tasks.settings(
          context,
          runPermissions(this.local, context),
        ).levels;
        const connector = connectors?.get(row.draft.connectorId);
        if (
          levels.connector === "never" ||
          levels.send_out === "never" ||
          !connector?.enabled ||
          connector.revision !== row.draft.revision ||
          connector.catalogVersion !== row.draft.catalogVersion ||
          !["ready", "idle"].includes(connector.status)
        )
          this.cancel(row.approvalId);
      } catch {
        this.cancel(row.approvalId);
      }
    }
  }
  private expire(id: string) {
    if (this.repo.get(id)?.view.status !== "pending") return;
    transaction(this.local.deps.db, () => {
      this.repo.finish(id, "expired");
      this.local.approvals.repo.resolve(id, "expired");
    });
    this.changed(id);
    this.local.deps.peer.emit("approval.resolved", { id, status: "expired", remembered: false });
  }
  async list(query: { before?: string; limit?: number; botId?: string }) {
    await this.local.userSecrets.ready(this.local.shutdown.signal);
    this.sweep();
    return this.repo.list(query).map((view) => this.project(view));
  }
  private project(view: DraftView): DraftView {
    return {
      ...view,
      draft: {
        ...view.draft,
        target: this.local.deps.redactor.redact(view.draft.target),
        tool: this.local.deps.redactor.redact(view.draft.tool),
      },
    };
  }
  async get(
    id: string,
    conversationId: string,
  ): Promise<DraftView & { content: string; calendarName?: string; calendarTimeZone?: string }> {
    await this.local.userSecrets.ready(this.local.shutdown.signal);
    this.sweep();
    const current = this.repo.get(id);
    if (!current || current.view.conversationId !== conversationId)
      return fail("draftUnavailable", "draft_unavailable");
    if (current.view.status === "pending" && Date.parse(current.view.expiresAt) <= Date.now()) {
      this.expire(id);
      return this.get(id, conversationId);
    }
    const view = current.view;
    const calendarName =
      view.draft.operation === "calendar_create"
        ? (current.payload.calendarPresentation?.name ??
          this.calendars.name(
            view.botId,
            view.conversationId,
            view.draft.connectorId,
            view.draft.revision,
            view.draft.catalogVersion,
            current.payload.args.calendarId,
          ))
        : undefined;
    return {
      ...(current.payload.calendarPresentation
        ? { calendarTimeZone: current.payload.calendarPresentation.timeZone }
        : {}),
      ...(calendarName ? { calendarName: this.local.deps.redactor.redact(calendarName) } : {}),
      ...this.project(current.view),
      content: this.local.deps.redactor.redact(current.payload.content),
    };
  }
  async status(id: string, conversationId: string, signal = this.local.shutdown.signal) {
    const active = AbortSignal.any([
      signal,
      this.local.shutdown.signal,
      AbortSignal.timeout(20_000),
    ]);
    await this.local.userSecrets.ready(active);
    active.throwIfAborted();
    const result = this.repo.status(id, conversationId);
    if (!result) return fail("draftUnavailable", "draft_unavailable");
    return result;
  }
  private context(view: DraftView, payload: DraftPayload): ToolRunContext {
    const current = draftContext(this.local, view, payload);
    const live = this.waiting.context(view.approvalId);
    return live ? { ...current, signal: live.signal } : current;
  }
  receipt(id: string) {
    const row = this.repo.get(id);
    if (!row) return fail("draftUnavailable", "draft_unavailable");
    const userRejected =
      row.view.status === "discarded" &&
      this.local.approvals.repo
        .get(id)
        ?.explanation?.some(
          (step) => step.code === "approval_user_denied" && step.effect === "deny",
        ) === true;
    const target = this.local.deps.redactor.redact(
      [row.view.draft.connectorName, row.view.draft.target].filter(Boolean).join(" · "),
    );
    const calendar = row.view.draft.operation === "calendar_create";
    const conclusion = {
      sent: calendar
        ? `日程已创建（${target}）。 / Event created (${target}).`
        : `已发出（${target}）。 / Sent to ${target}.`,
      discarded: userRejected
        ? calendar
          ? "你没有同意创建日程，未创建；不要自动重试。 / You rejected event creation; no event was created. Do not retry automatically."
          : "你选择不发，未执行；不要自动重试。 / You chose not to send; nothing was sent. Do not retry automatically."
        : "操作已取消，未执行；不要自动重试。 / Cancelled; nothing was sent. Do not retry automatically.",
      pending:
        "等你在草稿卡查看正文并确认，尚未发送。 / Awaiting your review and confirmation on the draft card; not sent.",
      sending: `正在发送，结果尚未确定；不要重发，请到目标应用核对：${target}。 / Sending; outcome not yet known. Do not resend. Check the destination app: ${target}.`,
      unknown: `结果未知，不要重发；请到目标应用核对：${target}。 / Delivery result unknown. Do not resend; verify in the destination app: ${target}.`,
      failed:
        "发送失败，未确认送达；请先核对目标应用，不要自动重发。 / Send failed; delivery not confirmed. Check the destination app before any retry; never resend automatically.",
      expired:
        "确认已过期，尚未发送；需要时请用户重新发起。 / Confirmation expired; not sent. Ask the user to request it again if needed.",
    }[row.view.status];
    return {
      status: row.view.status,
      edited: row.view.edited,
      requiresUser: row.view.status === "pending",
      ...(userRejected ? { code: "user_rejected", userDecision: "rejected" } : {}),
      target,
      notice: conclusion,
      instruction:
        "严格按以上程序结论回答，使用用户语言；不猜测状态、不展示内部编号。 / Report the program conclusion above in the user's language; never infer a different status or expose internal identifiers.",
    };
  }

  private async create(
    context: ToolRunContext,
    call: LocalToolCall,
    input: ConnectorCallInput,
    prepared: PreparedConnector,
    signal: AbortSignal,
    gate: PreparedTool,
    response: DraftResponse,
  ) {
    if (!context.conversationId || this.local.execution.mode(context) === "plan")
      return fail("draftDenied", "draft_context_denied");
    const { draft, payload } = makeDraft(prepared, input, context, this.local.deps.redactor);
    // Normalization changes the immutable target digest; uncertain writes stay non-replayable.
    if (payload.calendarPresentation) {
      this.assertReplay(context, { ...input, args: payload.args });
      const name = this.calendars.name(
        context.botId,
        context.conversationId,
        prepared.connector.id,
        prepared.connector.revision,
        prepared.connector.catalogVersion,
        payload.args.calendarId,
      );
      if (name) payload.calendarPresentation.name = this.local.deps.redactor.redact(name);
    }
    draft.canRememberTool =
      draft.identity === "bot" && connectionToolRememberable(this.local, prepared.connector.id);
    if (gate?.capabilityConnector) {
      payload.capabilityId = gate.capabilityConnector.capabilityId;
      payload.capabilityImpl =
        context.capabilities?.get(gate.capabilityConnector.capabilityId) === "builtin"
          ? "builtin"
          : "connector";
    }
    payload.origin = {
      callDigest: draftCallDigest(call),
      ...(context.executionTaskId ? { executionTaskId: context.executionTaskId } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      ...(context.cycleId ? { cycleId: context.cycleId } : {}),
      ...(context.groupAuthorization
        ? { groupAuthorizationDigest: connectorDigest(context.groupAuthorization) }
        : {}),
      ...(context.routineRunId
        ? { routineRunId: context.routineRunId, routineSource: context.routineSource ?? "routine" }
        : {}),
      ...(gate ? { operationHash: routineOperationHash(gate) } : {}),
    };
    const sendLedger = this.sendLedger(context, call, draft, payload);
    if (sendLedger?.duplicate) return sendLedger.duplicate;
    // One key per intended send, for the server (`_meta`) and the records: the execution
    // journal's key of this tool call, else (journal bypassed across routine attempts) the ledger's.
    const idempotencyKey = this.local.toolJournal.keyFor(context.runId, call.id) ?? sendLedger?.key;
    if (idempotencyKey) payload.origin.idempotencyKey = idempotencyKey;
    const confirmedNow = gate?.confirmedNow === true;
    const result = await evaluateDraft(this.local, context, draft, payload, signal, confirmedNow);
    signal.throwIfAborted();
    if (this.local.execution.mode(context) === "plan")
      return fail("draftDenied", "draft_plan_denied");
    if (result.decision === "deny") {
      this.local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "policy.denied",
        summary: "Send blocked by permissions / 权限阻止对外发送",
        detail: {
          category: "send_out",
          connectorId: draft.connectorId,
          toolName: draft.tool,
          toolCallId: call.id,
          ...(context.groupId ? { groupId: context.groupId } : {}),
          reasonCode: result.reason,
          policySteps: result.explanation.map((step) => step.code),
        },
      });
      const levels = this.local.tasks.settings(context, runPermissions(this.local, context)).levels;
      return fail(
        "draftDenied",
        levels.send_out === "never" ? "send_permission_denied" : "draft_permission_denied",
      );
    }
    const automatic = result.decision === "allow";
    const directWrite = result.explanation.some((step) => step.code === "connector_direct_write");
    const lifecycle =
      !automatic && gate
        ? this.local.unattended?.approvalLifecycle(context, call, gate, { available: true })
        : undefined;
    let created = false;
    const approval = transaction(this.local.deps.db, () => {
      const existing =
        this.repo.byCall(context.runId, call.id) ??
        this.repo.byOperation(context.runId, draftCallDigest(call));
      if (existing) {
        const approval = this.local.approvals.repo.get(existing);
        if (!approval) throw new Error("Draft approval missing");
        return approval;
      }
      const value = this.local.approvals.repo.create({
        botId: context.botId,
        runId: context.runId,
        messageId: context.messageId,
        toolCallId: call.id,
        source: context.routineSource ?? "chat",
        routineRunId: context.routineRunId ?? null,
        ...(context.routineRunId
          ? {
              expiresAt: new Date(
                Date.now() + Math.min(86400000, context.routineApprovalWaitMs ?? 86400000),
              ).toISOString(),
            }
          : {}),
        category: "send_out",
        risk: "normal",
        title:
          draft.operation === "calendar_create"
            ? "创建日程 / Create event"
            : "对外发送草稿 / Send draft",
        facts: [],
        explanation: result.explanation,
        isolation: { available: true },
        canRemember:
          (!context.routineRunId && draft.canRememberTarget) || draft.canRememberTool === true,
        draft,
      });
      this.repo.create(value.id, draft, payload);
      if (sendLedger && context.routineRunId)
        this.local.unattended?.ledger?.bind(context.routineRunId, sendLedger.key, value.id);
      lifecycle?.requested(value);
      this.audit(value.id, "created");
      created = true;
      return value;
    });
    if (created) {
      this.waiting.track(approval.id, lifecycle);
      if (!directWrite) this.local.deps.peer.emit("approval.requested", approval);
      this.changed(approval.id);
    }
    if (created && automatic) {
      try {
        await this.resolve({ approvalId: approval.id, action: "send" }, "automatic", confirmedNow, {
          context,
          response,
        });
      } catch (error) {
        const outcome = this.repo.get(approval.id)?.view.status;
        // A durable failed/uncertain receipt is a tool result, not an invitation to retry.
        if (
          !(error instanceof RpcError) ||
          !outcome ||
          outcome === "pending" ||
          outcome === "sending"
        )
          throw error;
      }
    }
    return {
      approvalId: approval.id,
      status: this.repo.get(approval.id)?.view.status ?? "pending",
      requiresUser: !automatic,
    };
  }
  /**
   * An unattended run asks its ledger for this send's idempotency key. When an earlier
   * attempt of the same occurrence already holds a draft under that key that was (or may yet be)
   * delivered, nothing new is created and that draft's receipt answers instead. Failed, discarded
   * and expired drafts do not count, so a resume may send those again.
   */
  private sendLedger(
    context: ToolRunContext,
    call: LocalToolCall,
    draft: DraftView["draft"],
    payload: DraftPayload,
  ) {
    if (!context.routineRunId) return undefined;
    const ledger = this.local.unattended?.ledger;
    if (!ledger) return undefined;
    const { key, earlier } = ledger.intend(context, {
      callDigest: draftCallDigest(call),
      connectorId: draft.connectorId,
      tool: draft.tool,
      targetDigest: payload.targetDigest,
      target: draft.target,
      contentDigest: draft.contentDigest,
    });
    const blocking = earlier.find((id) => {
      const status = this.repo.get(id)?.view.status;
      return (
        status === "pending" || status === "sending" || status === "sent" || status === "unknown"
      );
    });
    if (!blocking) return { key };
    const routineRunId = context.routineRunId;
    transaction(this.local.deps.db, () => {
      ledger.duplicate(routineRunId, key, blocking);
      this.local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "connector.called",
        summary: "Send skipped: an earlier attempt covers it",
        detail: {
          approvalId: blocking,
          policySteps: [],
          connectorId: draft.connectorId,
          category: "send_out",
          actor: "system",
          source: context.routineSource ?? "routine",
          routineRunId,
          contentDigest: draft.contentDigest,
          contentLength: draft.contentLength,
          edited: false,
          reasonCode: "draft_duplicate",
        },
      });
    });
    return {
      key,
      duplicate: {
        approvalId: blocking,
        status: this.repo.get(blocking)?.view.status ?? "unknown",
        requiresUser: false,
        duplicate: true as const,
      },
    };
  }
  assertReplay(context: ToolRunContext, input: ConnectorCallInput) {
    // A changed tool-call ID or edited body cannot turn an uncertain/partial send into a retry.
    const tool = this.local.connectors?.tool(input.connectorId, input.catalogVersion, input.tool);
    const uncertainTarget = { ...input.args };
    if (tool?.draftBinding) delete uncertainTarget[tool.draftBinding.contentField];
    if (
      this.repo.uncertainTarget(
        context.runId,
        input.connectorId,
        input.tool,
        connectorDigest(canonicalDraftValue(uncertainTarget)),
      )
    )
      throw new ConnectorToolError("connector_draft_resolved");
    if (!context.routineRunId || !context.routineResume) return;
    // Without the owner the checkpoint cannot be read; refusing beats sending twice.
    if (!this.local.unattended) throw new ConnectorToolError("connector_draft_resolved");
    const run = this.local.unattended.run(context.routineRunId);
    const checkpoint = run.waitCheckpoint;
    const row = checkpoint ? this.repo.get(checkpoint.approvalId) : undefined;
    if (!row || row.view.status === "pending" || row.view.status === "sending") return;
    const immutable = { ...input.args };
    if (row.payload.contentField) delete immutable[row.payload.contentField];
    if (
      input.connectorId === row.view.draft.connectorId &&
      input.tool === row.view.draft.tool &&
      connectorDigest(canonicalDraftValue(immutable)) === row.payload.targetDigest
    )
      throw new ConnectorToolError("connector_draft_resolved");
  }
  verifyCheckpoint(runId: string, operationHash: string, call: LocalToolCall) {
    if (!this.local.unattended) return fail("draftChanged", "draft_checkpoint_changed");
    const run = this.local.unattended.run(runId);
    const row = run.waitCheckpoint ? this.repo.get(run.waitCheckpoint.approvalId) : undefined;
    const origin = row?.payload.origin;
    if (
      !row ||
      origin?.routineRunId !== run.id ||
      origin.operationHash !== operationHash ||
      origin.callDigest !== draftCallDigest(call) ||
      row.view.botId !== run.botId ||
      row.view.conversationId !== run.conversationId
    )
      return fail("draftChanged", "draft_checkpoint_changed");
    return row;
  }
  async execute(
    context: ToolRunContext,
    call: LocalToolCall,
    input: ConnectorCallInput,
    gate: PreparedTool,
    signal: AbortSignal,
  ) {
    if (!gate.connector) return fail("draftUnavailable", "connector_unavailable");
    const response: DraftResponse = {};
    const created = await this.create(context, call, input, gate.connector, signal, gate, response);
    if ("duplicate" in created)
      return {
        ...this.receipt(created.approvalId),
        duplicate: true,
        duplicateNotice:
          "本次因去重未发送；原发送结果以上述程序结论为准，不要自动重发。 / This attempt was skipped as a duplicate; use the program conclusion above for the original outcome. Do not resend automatically.",
      };
    try {
      await this.waiting.wait(
        context,
        created.approvalId,
        signal,
        () => this.cancel(created.approvalId),
        () => this.expire(created.approvalId),
      );
      const receipt = this.receipt(created.approvalId);
      // Maintainers 2026-10-31: after a confirmed send the Bot also gets what the service answered
      // (e.g. the new issue's link); the caller formats it as external data.
      const reply = "reply" in response ? response.reply : this.replies.get(created.approvalId);
      if (reply !== undefined && receipt.status === "sent") return { ...receipt, reply };
      const serviceMessage = response.serviceMessage ?? this.failures.get(created.approvalId);
      // The caller labels it as external data; "unknown" keeps no reason so it never reads as a
      // definite failure that invites a resend.
      return serviceMessage && receipt.status === "failed"
        ? { ...receipt, serviceMessage }
        : receipt;
    } finally {
      this.replies.delete(created.approvalId);
      this.failures.delete(created.approvalId);
    }
  }
  private cancel(id: string) {
    const row = this.repo.get(id);
    if (row?.view.status !== "pending") return;
    transaction(this.local.deps.db, () => {
      this.repo.finish(id, "discarded");
      this.local.approvals.repo.resolve(id, "denied");
      this.audit(id, "cancelled");
    });
    this.changed(id);
    this.local.deps.peer.emit("approval.resolved", { id, status: "denied", remembered: false });
  }
  async releaseForYolo(conversationId: string, groupId?: string) {
    let before: string | undefined;
    for (;;) {
      this.local.shutdown.signal.throwIfAborted();
      const page = this.repo.list({ before, limit: 200 });
      for (const row of page) {
        if (row.draft.identity !== "bot") continue;
        const stored = this.repo.get(row.approvalId);
        if (!stored) continue;
        try {
          const context = this.context(row, stored.payload);
          if (context.routineRunId || context.routineSource) continue;
          const source = context.executionTaskId ? this.local.tasks.source(context) : context;
          if (groupId ? source.groupId !== groupId : source.conversationId !== conversationId)
            continue;
          await this.resolve({ approvalId: row.approvalId, action: "send" }, "automatic");
        } catch {
          // A revoked source or uncertain delivery must never be retried by switching YOLO again.
          this.local.deps.logger.warn("Bot draft could not resolve after YOLO change");
        }
      }
      if (page.length < 200) break;
      before = page.at(-1)?.approvalId;
    }
  }
  resolve(
    input: DraftResolve,
    actor: "user" | "automatic" = "user",
    confirmedNow = false,
    liveCall?: { context: ToolRunContext; response: DraftResponse },
  ) {
    const job = resolveDraft(
      {
        local: this.local,
        repo: this.repo,
        context: (view, payload) => {
          const current = this.context(view, payload);
          return liveCall?.context.interactiveChat && !liveCall.context.auditSource
            ? { ...current, interactiveChat: true, signal: liveCall.context.signal }
            : current;
        },
        expire: (id) => this.expire(id),
        cancel: (id) => this.cancel(id),
        changed: (id) => this.changed(id),
        audit: (id, phase, actor) => this.audit(id, phase, actor),
        sent: (id, reply) => {
          if (liveCall) liveCall.response.reply = reply;
          else if (this.waiting.context(id)) this.replies.set(id, reply);
        },
        failed: (id, serviceMessage) => {
          if (!liveCall && !this.waiting.context(id)) return;
          const redacted = this.local.deps.redactor.redact(serviceMessage);
          if (liveCall) liveCall.response.serviceMessage = redacted;
          else this.failures.set(id, redacted);
        },
      },
      input,
      actor,
      confirmedNow,
    );
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return job;
  }
  private audit(id: string, phase: string, actor: "user" | "automatic" | "system" = "system") {
    const row = this.repo.get(id),
      approval = this.local.approvals.repo.get(id);
    if (!row || !approval) throw new Error("Draft audit record missing");
    this.local.approvals.audit.append({
      botId: approval.botId,
      runId: approval.runId,
      kind: "connector.called",
      summary: "Send draft state changed",
      detail: {
        approvalId: id,
        policySteps: (approval.explanation ?? []).map((step) => step.code),
        connectorId: row.view.draft.connectorId,
        toolName: row.view.draft.tool,
        ...(row.payload.capabilityId
          ? {
              capabilityId: row.payload.capabilityId,
              capabilityImpl: row.payload.capabilityImpl,
            }
          : {}),
        category: "send_out",
        actor,
        source: row.payload.origin?.routineSource ?? "chat",
        ...(row.payload.origin?.routineRunId
          ? { routineRunId: row.payload.origin.routineRunId }
          : {}),
        ...((row.payload.origin?.taskId ?? row.payload.origin?.executionTaskId)
          ? { taskId: row.payload.origin?.taskId ?? row.payload.origin?.executionTaskId }
          : {}),
        ...(row.payload.groupId ? { groupId: row.payload.groupId } : {}),
        contentDigest: row.view.draft.contentDigest,
        contentLength: row.view.draft.contentLength,
        edited: row.view.edited,
        reasonCode: `draft_${phase}`,
      },
    });
  }
  async dispose() {
    clearInterval(this.timer);
    this.calendars.dispose();
    this.waiting.dispose();
    await Promise.allSettled([...this.jobs]);
  }
}
export function registerDraftRpc(handle: KernelRegisterRpc, service: DraftService) {
  handle("drafts.get", async ({ approvalId, conversationId }) =>
    service.get(approvalId, conversationId),
  );
  handle("drafts.status", ({ approvalId, conversationId }, { signal }) =>
    service.status(approvalId, conversationId, signal),
  );
  handle("drafts.list", async (params) => service.list(params));
  handle("drafts.resolve", (params) => service.resolve(params));
}
