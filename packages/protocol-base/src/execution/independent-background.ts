import { z } from "zod";
import { ProxyAddressSchema } from "../app/network-proxy.ts";
import { UiNavigationSchema } from "../bots/navigation.ts";
import { AbsolutePathSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import { WebUrlSchema } from "../core/values.ts";
import {
  ProviderImportDecisionSchema,
  ProviderImportIntentSchema,
} from "../providers/import-link.ts";

export const GuiHostMethods = {
  "gui.updates.proxy": {
    params: z.strictObject({ url: ProxyAddressSchema.nullable().optional() }),
    result: z.null(),
  },
  "gui.pick": {
    params: z.strictObject({
      defaultName: z.string().min(1).max(200).optional(),
      kind: z.enum([
        "file",
        "folder",
        "team-open",
        "team-save",
        "skill-import",
        "folder-create",
        // Connector import picks from the window process, like every other picker.
        "plugin-folder",
        "plugin-file",
      ]),
      defaultPath: AbsolutePathSchema.optional(),
    }),
    result: AbsolutePathSchema.nullable(),
  },
  /**
   * A warning dialog the windowless owner asks the window process to show (local MCP without
   * the sandbox: Windows, or "run as me"). The answer is the clicked button's index.
   */
  "gui.confirm": {
    params: z.strictObject({
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(1000),
      detail: z.string().max(64 * 1024),
      buttons: z.array(z.string().min(1).max(100)).min(2).max(3),
      defaultId: z.number().int().min(0).max(2),
      cancelId: z.number().int().min(0).max(2),
    }),
    result: z.strictObject({ response: z.number().int().min(0).max(2) }),
  },
  "gui.openPath": { params: z.strictObject({ path: AbsolutePathSchema }), result: z.null() },
  "gui.revealPath": { params: z.strictObject({ path: AbsolutePathSchema }), result: z.null() },
  "gui.openExternal": { params: z.strictObject({ url: WebUrlSchema }), result: z.null() },
} as const;

export const BackgroundPreferencesSchema = z.strictObject({
  exitBehavior: z.enum(["stop", "continue"]).default("stop"),
  startAtLogin: z.boolean().default(false),
  // Absence preserves older settings; consumers treat it as true only when the GUI is absent.
  showTrayWhenBackground: z.boolean().optional(),
  // Set once the owner has decided the start-at-login default for this data directory (on
  // for a new install, unchanged on an upgrade). Owner-only; not part of the GUI patch.
  loginDefaultApplied: z.boolean().optional(),
});
export type BackgroundPreferences = z.infer<typeof BackgroundPreferencesSchema>;
// Patch fields cannot inherit defaults: toggling login must never reset the saved exit policy.
export const BackgroundPreferencesPatchSchema = z.strictObject({
  exitBehavior: z.enum(["stop", "continue"]).optional(),
  startAtLogin: z.boolean().optional(),
  showTrayWhenBackground: z.boolean().optional(),
});
export const IndependentBackgroundStateSchema = z
  .strictObject({
    lifecycle: z.enum(["starting", "ready", "stopping", "stopped", "failed", "unsupported"]),
    // Old owners do not implement the independent tray policy; readiness alone is not a capability.
    backgroundTrayAvailable: z.boolean().optional(),
    startupFailure: z.literal("database_newer_than_app").optional(),
    // Last moment the starting child reported progress. The GUI keeps waiting while this
    // advances instead of failing on a fixed deadline; absent on owners that cannot report it.
    startupProgressAt: z.iso.datetime().optional(),
    // The phase the last progress beat came from. A waiting GUI names the step instead of
    // showing only a deadline; older owners omit it and keep the timestamp-only behaviour.
    startupPhase: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .optional(),
    // Optional for old owners; only the owner can certify standby after actual utility exit.
    brainPhase: z
      .enum(["working", "preparing", "prepared", "standby", "waking", "unavailable"])
      .optional(),
    instance: z.uuid().nullable(),
    version: z.string().min(1).max(100),
    startedAt: z.iso.datetime().nullable(),
    preferences: BackgroundPreferencesSchema,
    effectiveExitBehavior: z.enum(["stop", "continue"]),
    clients: z.number().int().min(0).max(8),
    management: z.strictObject({
      // systemd-user stays readable for older owners; Linux now uses XDG autostart.
      kind: z.enum(["launchd", "task-scheduler", "systemd-user", "xdg-autostart"]),
      available: z.boolean(),
      registered: z.boolean().nullable(),
      enabled: z.boolean().nullable(),
      reason: z.enum([
        "available",
        "unpackaged",
        "platform_unverified",
        "manager_unavailable",
        "data_dir",
        "query_failed",
      ]),
    }),
  })
  .refine(
    (state) =>
      state.lifecycle === "unsupported"
        ? state.instance === null &&
          state.startedAt === null &&
          state.effectiveExitBehavior === "stop"
        : state.instance !== null && state.startedAt !== null,
    { message: "background_owner_identity_required" },
  );
export type IndependentBackgroundState = z.infer<typeof IndependentBackgroundStateSchema>;
const empty = z.union([z.undefined(), z.strictObject({})]);
export const IndependentBackgroundMethods = {
  "background.serviceState": { params: empty, result: IndependentBackgroundStateSchema },
  "background.preferences": {
    params: BackgroundPreferencesPatchSchema,
    result: IndependentBackgroundStateSchema,
  },
  "background.stopService": {
    params: empty,
    result: z.strictObject({ status: z.literal("requested") }),
  },
} as const;

// Trusted main/owner channel, never registered in renderer Methods or model tools.
// ACP transport budgets are independent of the GUI's large attachment frames.
export const ACP_MAX_FRAME = 8 * 1024 * 1024;
/** Editors / tools attached to one running app at once. */
export const ACP_MAX_CONNECTIONS = 4;
export const AcpClientSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) =>
      [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    ),
  version: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) =>
      [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    ),
});
export type AcpClient = z.infer<typeof AcpClientSchema>;
export const AcpStateSchema = z.discriminatedUnion("connected", [
  z.strictObject({ connected: z.literal(false) }),
  z.strictObject({ connected: z.literal(true), client: AcpClientSchema }),
]);
export type AcpState = z.infer<typeof AcpStateSchema>;
export const AcpErrorSchema = z.enum([
  "acp_busy",
  "version_mismatch",
  "app_quit",
  "attach_unsupported_platform",
]);
export const AcpMethods = {
  "acp.state": { params: empty, result: AcpStateSchema },
  "acp.disconnect": { params: empty, result: z.strictObject({ ok: z.literal(true) }) },
} as const;
export const AcpEvents = { "acp.changed": AcpStateSchema } as const;
export type AcpLifecycleEvent =
  | { kind: "acp.attach" | "acp.detach"; client: AcpClient }
  | { kind: "acp.session.new"; botId: string; topicId: string; folders: string[] }
  // The client named an existing topic; `folders` is the working directory it asked for.
  | { kind: "acp.session.attach"; botId: string; topicId: string; folders: string[] };
/** Trusted, in-process host seam; never a wire authorization or a tool. */
export interface AcpAttachmentPort {
  state(): AcpState;
  disconnect(signal: AbortSignal): Promise<void>;
  subscribe(listener: (event: AcpLifecycleEvent) => void): () => void;
}
export const AcpChannelSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("attach"),
    id: z.uuid(),
    connection: z.uuid(),
    client: AcpClientSchema,
  }),
  z.strictObject({ type: z.literal("detach"), id: z.uuid(), connection: z.uuid() }),
  z.strictObject({ type: z.literal("reply"), id: z.uuid(), ok: z.boolean() }),
  z.strictObject({
    type: z.literal("frame"),
    connection: z.uuid(),
    id: z.uuid(),
    message: z.unknown(),
  }),
  z.strictObject({ type: z.literal("ack"), connection: z.uuid(), id: z.uuid() }),
  z.strictObject({ type: z.literal("closed"), connection: z.uuid() }),
]);
export type AcpChannel = z.infer<typeof AcpChannelSchema>;

export const BackgroundControlSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("attach") }),
  z.strictObject({ type: z.literal("acp-attach"), client: AcpClientSchema }),
  z.strictObject({ type: z.literal("acp-detach") }),
  z.strictObject({ type: z.literal("detach"), stop: z.boolean().optional() }),
  z.strictObject({ type: z.literal("focus"), at: z.iso.datetime() }),
  z.strictObject({ type: z.literal("blur") }),
  z.strictObject({ type: z.literal("brain-state") }),
  z.strictObject({ type: z.literal("diagnostics") }),
  z.strictObject({ type: z.literal("ui-ready") }),
  z.strictObject({ type: z.literal("navigate"), target: UiNavigationSchema }),
  z.strictObject({ type: z.literal("provider-import"), intent: ProviderImportIntentSchema }),
  z.strictObject({
    type: z.literal("provider-import-decide"),
    decision: ProviderImportDecisionSchema,
  }),
  z.strictObject({ type: z.literal("provider-import-dismiss") }),
  z.strictObject({ type: z.literal("preferences"), patch: BackgroundPreferencesPatchSchema }),
  z.strictObject({ type: z.literal("state") }),
  z.strictObject({ type: z.literal("stop-service") }),
  z.strictObject({ type: z.literal("restart-brain") }),
]);
export const BackgroundBrainRequestSchema = z.strictObject({
  type: z.literal("background-control"),
  id: z.uuid(),
  operation: z.enum(["client", "preferences"]),
  connected: z.boolean().optional(),
  preferences: BackgroundPreferencesSchema.optional(),
});
export const BackgroundBrainReplySchema = z.strictObject({
  type: z.literal("background-reply"),
  id: z.uuid(),
  ok: z.boolean(),
  preferences: BackgroundPreferencesSchema.optional(),
});
export const BackgroundLoopbackEndpointSchema = z
  .string()
  .regex(/^tcp:127\.0\.0\.1:[1-9][0-9]{3,4}$/)
  .refine((value) => {
    const port = Number(value.split(":")[2]);
    return port >= 1024 && port <= 65535 && value === `tcp:127.0.0.1:${port}`;
  });

export const BackgroundDescriptorSchema = z.strictObject({
  protocol: z.literal(1),
  instance: z.uuid(),
  version: z.string().min(1).max(100),
  endpoint: z.union([AbsolutePathSchema.max(240), BackgroundLoopbackEndpointSchema]),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(),
  utilityPid: z.number().int().positive().nullable(),
});
export const BackgroundWireSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("acp"), message: z.unknown() }),
  z.strictObject({ kind: z.literal("acp-error"), code: AcpErrorSchema }),
  z.strictObject({
    kind: z.literal("auth"),
    clientKind: z.literal("acp").optional(),
    pid: z.number().int().positive().safe(),
    protocol: z.literal(1),
    version: z.string().max(100),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    instance: z.uuid(),
  }),
  z.strictObject({ kind: z.literal("ready"), instance: z.uuid() }),
  z.strictObject({ kind: z.literal("ping") }),
  z.strictObject({ kind: z.literal("pong") }),
  z.strictObject({ kind: z.literal("business"), message: z.unknown() }),
  z.strictObject({ kind: z.literal("gui"), message: z.unknown() }),
  z.strictObject({ kind: z.literal("control"), id: z.uuid(), control: BackgroundControlSchema }),
  z.strictObject({
    kind: z.literal("reply"),
    id: z.uuid(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    code: z.number().int().min(-32768).max(-32000).optional(),
  }),
  z.strictObject({ kind: z.literal("status"), state: z.unknown() }),
  z.strictObject({ kind: z.literal("settings"), settings: z.unknown() }),
  z.strictObject({ kind: z.literal("open") }),
  z.strictObject({ kind: z.literal("quit"), stop: z.boolean().optional() }),
  // Overlay frames (owner → GUI main) and their acknowledgements. Frames bypass the
  // business request queue; the GUI main validates `message` before it reaches the window.
  z.strictObject({ kind: z.literal("browser-frame"), message: z.unknown() }),
  z.strictObject({
    kind: z.literal("browser-frame-ack"),
    groupId: IdSchema.optional(),
    botId: z.string().min(1).max(100),
    seq: z.number().int().nonnegative().safe(),
  }),
]);
export type BackgroundWire = z.infer<typeof BackgroundWireSchema>;
