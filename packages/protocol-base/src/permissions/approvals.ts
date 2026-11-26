import { z } from "zod";
import { ComputerApprovalRequestSchema } from "../computer/apps.ts";
import { DraftMetadataSchema } from "../connectors/drafts.ts";
import { IdSchema } from "../core/ids.ts";
import { BotPageSchema } from "../core/page.ts";
import { LoginApprovalRequestSchema } from "../credentials/site.ts";
import { GrantScopeSchema } from "./grants.ts";
import { PolicyStepSchema } from "./policy-explain.ts";
import { CategorySchema, DomainSchema, IsolationSchema } from "./settings.ts";

const text = z.string().min(1);
const time = z.iso.datetime();
const count = z.number().int().nonnegative().safe();
export const ApprovalCategorySchema = z.union([CategorySchema, z.literal("memory")]);
export const RiskSchema = z.enum(["normal", "danger"]);
export const ApprovalStatusSchema = z.enum([
  "pending",
  "allowed",
  "denied",
  "auto_denied",
  "cancelled",
  "expired",
]);
export const ApprovalFinalStatusSchema = ApprovalStatusSchema.exclude(["pending"]);
export const ApprovalFactSchema = z.strictObject({
  kind: z.enum(["program", "read", "write", "network", "cwd", "warning"]),
  value: text,
  risk: RiskSchema.optional(),
  /**
   * Row name in the card's own language, for cards that list a change field by field (the
   * default Pi's management and dispatch cards); absent rows are named by `kind`.
   */
  label: z.string().min(1).max(80).optional(),
});
// The card's title and facts in each UI language, so a language switch also changes
// cards created before it. Optional: older approvals only have `title` / `facts`.
export const ApprovalTextSchema = z.strictObject({
  title: text,
  /** One sentence under the title that says what happens after "allow". */
  lead: z.string().max(1000).optional(),
  facts: z.array(ApprovalFactSchema),
});
export const ApprovalSchema = z
  .strictObject({
    id: IdSchema,
    botId: IdSchema,
    runId: IdSchema,
    messageId: IdSchema,
    conversationId: IdSchema.nullable().optional(),
    toolCallId: text,
    source: z.enum(["chat", "routine", "trial"]).optional(),
    routineRunId: IdSchema.nullable().optional(),
    canPreauthorize: z.boolean().optional(),
    category: ApprovalCategorySchema,
    risk: RiskSchema,
    title: text,
    conversationWebDomain: DomainSchema.optional(),
    taskWebRead: z.literal(true).optional(),
    /** ACP editor terminal: the card may be answered "allow for this session" (never a grant). */
    editorSession: z.literal(true).optional(),
    searchDisclosure: z
      .strictObject({
        provider: z.enum(["duckduckgo", "bing", "keyless"]),
        querySummary: text.max(240),
      })
      .optional(),
    command: text.optional(),
    url: text.optional(),
    domain: DomainSchema.optional(),
    facts: z.array(ApprovalFactSchema),
    explanation: z.array(PolicyStepSchema).max(200).optional(),
    localized: z.strictObject({ zh: ApprovalTextSchema, en: ApprovalTextSchema }).optional(),
    grantScope: z.lazy(() => GrantScopeSchema).optional(),
    // Grant card payload; resolved through `computer.grant.resolve`, never remembered.
    computer: ComputerApprovalRequestSchema.optional(),
    // First-login card; resolved through `credentials.login.resolve` (account choice).
    login: LoginApprovalRequestSchema.optional(),
    connectorConsent: z
      .strictObject({
        connectorId: IdSchema,
        revision: count.positive(),
        display: z
          .strictObject({
            name: z.strictObject({ zh: z.string().max(512), en: z.string().max(512) }),
            tool: z.string().max(4096),
            description: z.string().max(4096),
          })
          .optional(),
      })
      .optional(),
    // Display only: a connection tool card names the connection and the tool in words. The
    // decision is bound by the call itself (connector id, catalog version), never by this text.
    connectorCall: z
      .strictObject({
        bot: z.string().max(200),
        name: z.string().max(512),
        tool: z.string().max(4096),
        label: z.strictObject({ zh: z.string().max(4096), en: z.string().max(4096) }).optional(),
      })
      .optional(),
    secretUses: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
          revision: z.number().int().positive().safe(),
        }),
      )
      .max(200)
      .optional(),
    rememberOnly: z.literal("secrets").optional(),
    canRememberSecrets: z.boolean().optional(),
    draft: DraftMetadataSchema.optional(),
    canRemember: z.boolean(),
    canAddWritableFolder: z.boolean().optional(),
    expiresAt: time,
    isolation: IsolationSchema,
    status: ApprovalStatusSchema,
    remembered: z.boolean(),
    createdAt: time,
    resolvedAt: time.nullable(),
  })
  .refine((a) => {
    const source = a.source ?? (a.routineRunId ? "routine" : "chat");
    return (
      (source === "chat") === (a.routineRunId == null) &&
      (source === "chat" ||
        !a.canRemember ||
        (a.category === "send_out" && a.draft?.canRememberTool === true)) &&
      (!a.canPreauthorize || (source === "routine" && a.risk === "normal"))
    );
  }, "Invalid approval origin")
  .refine(
    (a) => a.category !== "memory" || (!a.canRemember && !a.canPreauthorize && !a.grantScope),
    "Memory confirmation cannot grant authority",
  )
  .refine(
    (a) => !a.computer || (a.category === "computer" && !a.canRemember),
    "Invalid computer approval",
  )
  .refine(
    (a) =>
      (!a.conversationWebDomain && !a.taskWebRead) ||
      (a.category === "web" &&
        a.risk === "normal" &&
        !a.routineRunId &&
        !a.login &&
        !a.computer &&
        !a.searchDisclosure &&
        !a.secretUses?.length &&
        !(a.conversationWebDomain && a.taskWebRead)),
    "Invalid conversation website consent",
  )
  .refine(
    (a) =>
      !a.editorSession ||
      (a.category === "run_command" &&
        a.risk === "normal" &&
        !a.canRemember &&
        !a.routineRunId &&
        !a.secretUses?.length),
    "Invalid session command consent",
  )
  .refine((a) => !a.login || (a.category === "web" && !a.computer), "Invalid login approval")
  .refine(
    (a) =>
      !a.connectorConsent ||
      (a.category === "connector" &&
        a.canRemember &&
        a.risk === "normal" &&
        a.grantScope?.kind === "connector" &&
        a.grantScope.connectorId === a.connectorConsent.connectorId &&
        !a.draft &&
        !a.routineRunId &&
        !a.computer &&
        !a.login &&
        !a.secretUses?.length),
    "Invalid connector consent",
  );
export const ApprovalEvents = {
  "approval.requested": ApprovalSchema,
  "approval.resolved": z.strictObject({
    id: IdSchema,
    status: ApprovalFinalStatusSchema,
    remembered: z.boolean(),
  }),
} as const;
export const ApprovalPageSchema = BotPageSchema.extend({
  source: z.enum(["chat", "routine", "trial"]).optional(),
  routineRunId: IdSchema.optional(),
});
const _botId = z.strictObject({ botId: IdSchema });
const ok = z.strictObject({ ok: z.literal(true) });
export const ApprovalMethods = {
  "approvals.addWritableFolder": {
    params: z.strictObject({ id: IdSchema }),
    result: z.strictObject({ added: z.boolean() }),
  },
  "approvals.resolve": {
    params: z.strictObject({
      id: IdSchema,
      decision: z.enum(["allow", "deny"]),
      remember: z.boolean(),
      rememberSecrets: z
        .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
        .max(200)
        .refine((names) => new Set(names).size === names.length)
        .optional(),
      preauthorize: z.boolean().optional(),
      allowConversation: z.boolean().optional(),
      allowTaskWeb: z.boolean().optional(),
      /** ACP "allow for this session": this command shape, in this ACP session only. */
      allowSession: z.boolean().optional(),
      conversationId: IdSchema.optional(),
      connectorConsent: z.enum(["once", "bot", "all"]).optional(),
    }),
    result: ok,
  },
  "approvals.pending": { params: ApprovalPageSchema, result: z.array(ApprovalSchema).max(200) },
} as const;
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalFact = z.infer<typeof ApprovalFactSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type ApprovalFinalStatus = z.infer<typeof ApprovalFinalStatusSchema>;
