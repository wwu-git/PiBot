import { IdSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { DirectFailureSchema, defaultRemoteDirect, RemoteDirectSchema } from "./direct.ts";
import { PhoneDataStateSchema } from "./phone-data.ts";

export const DeviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v));
export const RelayUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "wss:" &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Invalid relay address");
export const RemoteSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  relay: z.enum(["official", "custom"]),
  relayUrl: RelayUrlSchema.nullable(),
  desktopName: DeviceNameSchema,
  keepAwake: z.boolean(),
  direct: RemoteDirectSchema.default(defaultRemoteDirect),
  lanDiscovery: z.boolean().default(true),
  version: z.number().int().nonnegative().safe(),
});
export const RemoteReasonSchema = z.enum([
  "off",
  "connecting",
  "ready",
  "sleeping",
  "link_unavailable",
  "rpc_unavailable",
  "relay_unavailable",
  "secrets_unavailable",
  "connection_failed",
  "keep_awake_unsupported",
]);
export const RemoteStateSchema = z.strictObject({
  reason: RemoteReasonSchema,
  onlineDevices: z.number().int().min(0).max(32),
  pairingAvailable: z.boolean(),
  keepAwake: z.enum(["off", "requested", "unsupported"]),
});
export const RunnerConnectionStateSchema = z.enum([
  "connecting",
  "online",
  "reconnecting",
  "drain_failed",
]);
export const RunnerConnectionPathSchema = z.enum(["lan", "address", "punched", "relay"]);
export const RunnerConnectionSchema = z.union([
  RunnerConnectionStateSchema,
  z.strictObject({ state: RunnerConnectionStateSchema, path: RunnerConnectionPathSchema }),
]);
export const DeviceViewSchema = z.strictObject({
  id: IdSchema,
  name: DeviceNameSchema,
  kind: z.enum(["phone", "runner"]).default("phone"),
  target: z
    .string()
    .regex(/^runner:[a-f0-9]{64}$/)
    .optional(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  online: z.boolean(),
  runnerConnection: RunnerConnectionSchema.optional(),
  directFailure: DirectFailureSchema.optional(),
  /** Last selected path; displayed only while online. Old records start on relay. */
  path: z.enum(["direct", "relay", "lan", "punched"]).default("relay"),
  revocationPending: z.boolean().optional(),
  /** The data switches the phone reported in its current session; absent when offline. */
  phoneData: PhoneDataStateSchema.optional(),
  /**
   * The runner's own probe, so a Linux host that cannot isolate commands has a visible
   * cause instead of looking broken; absent when no runner session has reported yet.
   */
  isolation: z
    .strictObject({ available: z.boolean(), reason: z.string().min(1).max(100).optional() })
    .optional(),
});
export const PairStatusSchema = z.strictObject({
  id: IdSchema,
  status: z.enum(["waiting", "paired", "expired", "cancelled", "failed"]),
  expiresAt: z.iso.datetime(),
  deviceId: IdSchema.optional(),
  securityCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  /** While waiting: why this computer cannot reach the relay the code points to. */
  relayProblem: z.enum(["unreachable", "tls", "certificate"]).optional(),
});
export const RemoteSessionUpdateSchema = z.strictObject({
  wake: z.boolean().optional(),
  foreground: z.boolean(),
  pushToken: z
    .string()
    .max(256)
    .regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/)
    .nullable()
    .optional(),
  language: z.enum(["zh", "en"]),
});
export const InteractiveClientSchema = z.enum(["available", "quit"]);
export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>;
export type RemoteState = z.infer<typeof RemoteStateSchema>;
export type DeviceView = z.infer<typeof DeviceViewSchema>;
export type PairStatus = z.infer<typeof PairStatusSchema>;
export type RemoteSessionUpdate = z.infer<typeof RemoteSessionUpdateSchema>;
