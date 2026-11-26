// Define the validated runner RPC and transport contracts.
import { z } from "zod";
import { HostComputerMethods } from "../computer/host.ts";
import { CapabilityManifestSchema, EndpointSessionEvents } from "../tools/endpoint-capabilities.ts";
import { PhoneControlRunnerMethods } from "./phone-control.ts";
import { RunnerPolicyMethods } from "./policy-facts.ts";

export const RUNNER_CAPABILITY_VERSIONS = {
  "runner.exec": 1,
  "runner.files": 1,
  "runner.background": 1,
  "runner.computer": 1,
  // Capability ids are lowercase (endpoint registry pattern); the RPC methods keep runner.managedGit.*.
  "runner.managed-git": 1,
} as const;

import { AbsolutePathSchema, CanonicalTimeSchema } from "../core/boundaries.ts";
import { GitEntryFactsSchema } from "../execution/git-entry.ts";

export const RunnerPlatformSchema = z.enum(["darwin", "win32", "linux"]);
export const RunnerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
export const RunnerTargetIdSchema = z.string().regex(/^runner:[A-Za-z0-9._-]{1,128}$/);
export const RunnerIdempotencyKeySchema = z.string().uuid();
export const RunnerDispatchOpIdSchema = z.string().uuid();
export const RunnerDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const RunnerTransferIdSchema = z.string().uuid();
export const RUNNER_TRANSFER_MAX_BYTES = 96 * 1024 * 1024;

export const RunnerRootIdentitySchema = z.strictObject({
  canonicalPath: AbsolutePathSchema,
  device: z.string().max(100).nullable(),
  inode: z.string().max(100).nullable(),
  role: z.enum(["primary", "readonly"]).optional(),
});
export const RunnerFileContextSchema = z.strictObject({
  policyOpId: z.string().uuid().optional(),
  cwd: AbsolutePathSchema,
  writeRoots: z.array(AbsolutePathSchema).max(202),
  denyWriteRoots: z.array(AbsolutePathSchema).max(202).optional(),
  rootIdentities: z.array(RunnerRootIdentitySchema).max(202).optional(),
  expectedPath: AbsolutePathSchema.optional(),
});
const NetworkSchema = z.strictObject({
  allowAll: z.boolean(),
  domains: z.array(z.string()).max(200),
});
export const RunnerCommandInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .max(1024 * 1024),
  cwd: AbsolutePathSchema,
  dataDir: AbsolutePathSchema,
  botHome: AbsolutePathSchema,
  skillGroupId: z.string().max(128).optional(),
  homeDir: AbsolutePathSchema.optional(),
  runId: z.string().min(1).max(128),
  toolCallId: z.string().min(1).max(128).optional(),
  writeRoots: z.array(AbsolutePathSchema).max(202),
  denyWriteRoots: z.array(AbsolutePathSchema).max(202).optional(),
  rootIdentities: z.array(RunnerRootIdentitySchema).max(202).optional(),
  network: NetworkSchema,
  pathEntries: z.array(AbsolutePathSchema).max(100).optional(),
  timeoutSec: z.number().positive().max(86400).optional(),
  allowUnisolated: z.boolean().optional(),
  secretEnv: z.record(z.string().max(256), z.string()).optional(),
  /** Entry plan issued by this runner's `runner.git.entries`; single use. */
  gitEntryPlanId: z.string().uuid().optional(),
  policyWritePaths: z.array(AbsolutePathSchema).max(8).optional(),
});
export const RunnerCommandResultSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stopped: z.boolean(),
  durationMs: z.number().nonnegative(),
  logPath: AbsolutePathSchema,
  truncatedOutput: z.string(),
});
export const RunnerBackgroundRecordSchema = z.strictObject({
  group: z.number().int(),
  processes: z
    .array(z.strictObject({ pid: z.number().int(), started: z.string().max(128) }))
    .max(4096),
});
const RunnerListeningSocketSchema = z.strictObject({
  pid: z.number().int().positive(),
  address: z.string().min(1).max(256),
  port: z.number().int().min(1).max(65535),
});
export const RunnerListenerScanSchema = z.discriminatedUnion("supported", [
  z.strictObject({
    supported: z.literal(true),
    sockets: z.array(RunnerListeningSocketSchema).max(4096),
    namespaced: z.array(z.number().int().positive()).max(4096).readonly().optional(),
  }),
  z.strictObject({
    supported: z.literal(false),
    reason: z.enum(["network_namespace", "platform_unsupported"]),
  }),
]);
export const RunnerJobRecordSchema = z.strictObject({
  jobId: z.string().min(1).max(128),
  logPath: AbsolutePathSchema,
  process: RunnerBackgroundRecordSchema,
  updatedAt: z.iso.datetime(),
});
export const RunnerJobRegistrySchema = z.strictObject({
  targetId: RunnerTargetIdSchema,
  jobs: z.array(RunnerJobRecordSchema).max(64),
});
export const RunnerBackgroundSnapshotSchema = z.strictObject({
  id: z.string().min(1).max(128),
  logPath: AbsolutePathSchema,
  running: z.boolean(),
  outputLines: z.number().int().min(0).max(1_000_000_000).optional(),
  permissionOnly: z.boolean().optional(),
  ports: z.array(z.number().int().min(1).max(65535)).max(4096),
  output: z.string().max(65536),
  record: RunnerBackgroundRecordSchema,
  listeners: RunnerListenerScanSchema,
  ended: z
    .strictObject({
      exitCode: z.number().int().nullable(),
      reason: z.enum(["exited", "stopped", "exposed", "failed"]),
      errorCode: z.literal("listener_check_failed").optional(),
    })
    .nullable(),
});
export const RunnerBackgroundSnapshotsSchema = z.array(RunnerBackgroundSnapshotSchema).max(64);
export const RunnerBackgroundPageSchema = z.strictObject({
  items: z.array(RunnerBackgroundSnapshotSchema).max(8),
  nextCursor: z.string().min(1).max(128).optional(),
});
export const RunnerBackgroundOrphansSchema = z.array(RunnerBackgroundRecordSchema).max(8);
export const RunnerBackgroundOrphanResultSchema = z.strictObject({
  remaining: z.number().int().nonnegative(),
});

export const RunnerOutputChunkSchema = z.strictObject({
  kind: z.literal("output"),
  text: z.string().max(128 * 1024),
});

const path = z.string().min(1).max(32768);
const contextWithPath = RunnerFileContextSchema.extend({ path });
export const RunnerFileRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("inspectPath"), input: contextWithPath }),
  z.strictObject({
    operation: z.literal("listEntries"),
    input: contextWithPath.extend({
      offset: z.number().int().min(0).max(10000).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      version: RunnerDigestSchema.optional(),
    }),
  }),
  z.strictObject({
    operation: z.literal("listDir"),
    input: contextWithPath.extend({ depth: z.number().int().min(1).max(3).optional() }),
  }),
  z.strictObject({
    operation: z.literal("readFile"),
    input: contextWithPath.extend({
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(2000).optional(),
    }),
  }),
  z.strictObject({
    operation: z.literal("readLog"),
    input: contextWithPath.extend({
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(2000).optional(),
    }),
  }),
  z.strictObject({
    operation: z.literal("observeChanges"),
    input: contextWithPath.extend({ depth: z.number().int().min(1).max(3).optional() }),
  }),
  z.strictObject({
    operation: z.literal("writeFile"),
    input: contextWithPath.extend({
      content: z.string().max(64 * 1024 * 1024),
      expectedHash: RunnerDigestSchema.nullable().optional(),
    }),
  }),
  z.strictObject({
    operation: z.literal("editFile"),
    input: contextWithPath.extend({
      old: z.string().optional(),
      new: z.string().optional(),
      replaceAll: z.boolean().optional(),
      edits: z
        .array(
          z.strictObject({ old: z.string(), new: z.string(), replaceAll: z.boolean().optional() }),
        )
        .max(500)
        .optional(),
    }),
  }),
  // Find_files / search_text / apply_patch ran on the local target only until now; the
  // runner's own local target already implements them, so the wire carries the same options.
  z.strictObject({
    operation: z.literal("findFiles"),
    input: contextWithPath.extend({ pattern: z.string().min(1).max(500) }),
  }),
  z.strictObject({
    operation: z.literal("searchText"),
    input: contextWithPath.extend({
      query: z.string().min(1).max(500),
      include: z.string().min(1).max(500).optional(),
      caseSensitive: z.boolean().optional(),
      matchNames: z.boolean().optional(),
      skipHardLinks: z.boolean().optional(),
    }),
  }),
  // No `path`: a patch names its own targets, which travel as `expectedPaths` so the runner can
  // refuse any file the brain did not authorize (same contract as the local target).
  z.strictObject({
    operation: z.literal("applyPatch"),
    input: RunnerFileContextSchema.extend({
      patch: z
        .string()
        .min(1)
        .max(1024 * 1024),
      expectedPaths: z.array(path).max(500),
    }),
  }),
]);
export type RunnerFileRequest = z.output<typeof RunnerFileRequestSchema>;
export type RunnerFileOperation = RunnerFileRequest["operation"];

const FileEntrySchema = z.strictObject({
  name: z.string().max(32768),
  type: z.enum(["symlink", "directory", "file"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
});
export const RunnerListResultSchema = z.strictObject({
  path: AbsolutePathSchema,
  entries: z.array(FileEntrySchema).max(500),
  truncated: z.boolean(),
});
export const RunnerReadResultSchema = z.discriminatedUnion("type", [
  z.strictObject({
    path: AbsolutePathSchema,
    type: z.literal("binary"),
    size: z.number().int().nonnegative(),
  }),
  z.strictObject({
    path: AbsolutePathSchema,
    type: z.literal("text"),
    size: z.number().int().nonnegative(),
    text: z.string().max(256 * 1024),
    truncated: z.boolean(),
  }),
]);
export const RunnerWriteResultSchema = z.strictObject({
  path: AbsolutePathSchema,
  bytes: z.number().int().nonnegative(),
});
export const RunnerEditResultSchema = RunnerWriteResultSchema.extend({
  diff: z.string().max(8192),
});
export const RunnerBinaryPublicationSchema = z.strictObject({
  path: AbsolutePathSchema,
  bytes: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  revision: RunnerDigestSchema,
});
const SearchTruncationSchema = z.enum(["results", "scan_limit", "byte_limit", "time_limit"]);
export const RunnerFindResultSchema = z.strictObject({
  path: AbsolutePathSchema,
  files: z
    .array(z.strictObject({ name: z.string().max(32768), size: z.number().int().nonnegative() }))
    .max(200),
  truncated: SearchTruncationSchema.optional(),
  skippedUnreadable: z.number().int().nonnegative(),
});
export const RunnerSearchResultSchema = z.strictObject({
  path: AbsolutePathSchema,
  matches: z
    .array(
      z.strictObject({
        file: z.string().max(32768),
        line: z.number().int().min(1),
        text: z.string().max(512),
        name: z.literal(true).optional(),
      }),
    )
    .max(200),
  truncated: SearchTruncationSchema.optional(),
  // Absent when the bundled-rg engine stopped early and could not know.
  skippedLarge: z.number().int().nonnegative().optional(),
  skippedUnreadable: z.number().int().nonnegative(),
});
export const RunnerPatchResultSchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        path: AbsolutePathSchema,
        bytes: z.number().int().nonnegative(),
        deleted: z.boolean(),
      }),
    )
    .max(500),
  diff: z.string().max(8192),
});
const WorkspaceKindSchema = z.enum(["file", "directory", "blocked"]);
export const runnerFileResultSchemas = {
  inspectPath: z
    .strictObject({
      kind: WorkspaceKindSchema,
      size: z.number().nonnegative(),
      device: z.string().max(100),
      inode: z.string().max(100),
      links: z.string().max(100),
      version: RunnerDigestSchema,
    })
    .nullable(),
  listEntries: z.strictObject({
    entries: z
      .array(z.strictObject({ name: z.string().min(1).max(32768), kind: WorkspaceKindSchema }))
      .max(200),
    version: RunnerDigestSchema,
    offset: z.number().int().min(0).max(10200),
    more: z.boolean(),
  }),
  listDir: RunnerListResultSchema,
  readFile: RunnerReadResultSchema,
  readLog: RunnerReadResultSchema,
  observeChanges: RunnerListResultSchema,
  writeFile: RunnerWriteResultSchema,
  editFile: RunnerEditResultSchema,
  findFiles: RunnerFindResultSchema,
  searchText: RunnerSearchResultSchema,
  applyPatch: RunnerPatchResultSchema,
} as const;

export const RunnerTransferDescriptorSchema = z.strictObject({
  transferId: RunnerTransferIdSchema,
  bytes: z.number().int().nonnegative().max(RUNNER_TRANSFER_MAX_BYTES),
  sha256: RunnerDigestSchema,
});
const TransferBeginSchema = z
  .strictObject({
    transferId: RunnerTransferIdSchema,
    bytes: z.number().int().positive().max(RUNNER_TRANSFER_MAX_BYTES),
    sha256: RunnerDigestSchema,
    idempotencyKey: RunnerIdempotencyKeySchema.optional(),
    issuedAt: CanonicalTimeSchema.optional(),
    dispatchOpId: RunnerDispatchOpIdSchema.optional(),
    request: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("file") }),
      z.strictObject({ kind: z.literal("binary_write"), path, context: RunnerFileContextSchema }),
      z.strictObject({ kind: z.literal("background_orphans") }),
    ]),
  })
  .refine((value) => {
    const key = !!value.idempotencyKey;
    const issued = !!value.issuedAt;
    const dispatch = !!value.dispatchOpId;
    if (value.request.kind === "background_orphans") return key && issued && !dispatch;
    if (value.request.kind === "binary_write") return key && issued && dispatch;
    return (key && issued && dispatch) || (!key && !issued && !dispatch);
  }, "Invalid transfer authorization fields");
const JournalResultSchema = z.strictObject({
  idempotencyKey: RunnerIdempotencyKeySchema,
  status: z.enum(["missing", "started", "done", "unknown", "expired"]),
  digest: RunnerDigestSchema.optional(),
  updatedAt: z.string(),
});
export const RunnerJournalEntrySchema = z.strictObject({
  idempotencyKey: RunnerIdempotencyKeySchema,
  issuedAt: CanonicalTimeSchema,
  status: z.enum(["started", "done", "unknown"]),
  digest: RunnerDigestSchema.optional(),
  updatedAt: z.iso.datetime(),
  targetId: RunnerTargetIdSchema,
  // Why an operation ended as `unknown`. Identifiers only — never a message, a path or
  // the command, which is what made a generic failure impossible to place afterwards.
  errorCode: z.string().min(1).max(80).optional(),
});
export type RunnerJournalEntry = z.output<typeof RunnerJournalEntrySchema>;

/** The Git invocations of one command, scanned on the runner where the repo lives. */
export const RunnerGitEntriesParamsSchema = z.strictObject({
  invocations: z
    .array(
      z.strictObject({
        args: z.array(z.string().max(4096)).max(512),
        cwd: AbsolutePathSchema,
      }),
    )
    .min(1)
    .max(16),
  compound: z.boolean(),
  callId: z.string().min(1).max(128),
  command: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
export const RunnerGitEntriesResultSchema = z.strictObject({
  status: z.enum(["none", "unsupported", "confirmation-required"]),
  facts: GitEntryFactsSchema.optional(),
  planId: z.string().uuid().optional(),
});

// Git object ids: SHA-1 (40) or SHA-256 (64). RunnerDigestSchema (64 only) refused every SHA-1 head.
const GitOidSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const ManagedIdentitySchema = z.strictObject({
  canonicalPath: AbsolutePathSchema,
  device: z.string().max(100).nullable(),
  inode: z.string().max(100).nullable(),
});
const ManagedRepositorySchema = z.strictObject({
  root: ManagedIdentitySchema,
  git: ManagedIdentitySchema,
  common: ManagedIdentitySchema,
  head: GitOidSchema,
  branch: z.string().min(1).max(512),
  clean: z.boolean(),
});
const ManagedOperationSchema = z.enum(["create", "commit", "integrate", "remove"]);
const ManagedBindingSchema = z.strictObject({
  managedId: z.string().uuid().optional(),
  source: ManagedRepositorySchema.optional(),
  target: ManagedRepositorySchema.optional(),
  expectedSourceHead: GitOidSchema.optional(),
  expectedTargetHead: GitOidSchema.optional(),
  /** remove: the integration tree the worktree's head must already be part of. */
  integratedInto: ManagedRepositorySchema.optional(),
  expectedBranch: z.string().max(512).optional(),
  authorizationVersion: z.string().max(128),
  groupId: z.string().uuid().optional(),
  taskId: z.string().max(128).optional(),
  expiresAt: CanonicalTimeSchema,
  parent: ManagedIdentitySchema.optional(),
  destination: AbsolutePathSchema.optional(),
  allowMerge: z.boolean().optional(),
  preserveBranch: z.boolean().optional(),
  commit: z
    .strictObject({
      name: z.string().max(200),
      email: z.string().max(320),
      message: z.string().max(10000),
    })
    .optional(),
});
const ManagedFileSchema = z.strictObject({
  path: z.string().min(1).max(32768),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(5 * 1024 * 1024),
  sha256: RunnerDigestSchema,
});
export const RunnerManagedGitInspectParamsSchema = z.strictObject({
  root: AbsolutePathSchema,
  /** Read-only questions answered in the same repository: is `a` an ancestor of `b`? */
  ancestor: z.strictObject({ a: GitOidSchema, b: GitOidSchema }).optional(),
  /** Does `path` carry this managed worktree's lock? */
  lock: z.strictObject({ path: AbsolutePathSchema, managedId: z.string().uuid() }).optional(),
  binding: ManagedBindingSchema.pick({
    authorizationVersion: true,
    groupId: true,
    taskId: true,
  }).optional(),
});
export const RunnerManagedGitInspectResultSchema = z.strictObject({
  repository: ManagedRepositorySchema.nullable(),
  ancestor: z.boolean().optional(),
  ownsLock: z.boolean().optional(),
  supported: z.boolean(),
  reason: z.string().max(80).optional(),
});
export const RunnerManagedGitPrepareParamsSchema = z.strictObject({
  operation: ManagedOperationSchema,
  binding: ManagedBindingSchema,
  files: z.array(ManagedFileSchema).max(500).optional(),
});
export const RunnerManagedGitPrepareResultSchema = z.strictObject({
  planId: z.string().uuid(),
  operation: ManagedOperationSchema,
  repository: ManagedRepositorySchema,
  files: z.array(ManagedFileSchema).max(500).optional(),
  filesHash: RunnerDigestSchema.optional(),
});
export const RunnerManagedGitExecuteParamsSchema = z.strictObject({
  planId: z.string().uuid(),
  idempotencyKey: RunnerIdempotencyKeySchema,
  issuedAt: CanonicalTimeSchema,
  dispatchOpId: RunnerDispatchOpIdSchema,
  filesHash: RunnerDigestSchema.optional(),
});
export const RunnerManagedGitExecuteResultSchema = z.strictObject({
  operation: ManagedOperationSchema,
  repository: ManagedRepositorySchema.nullable(),
  /** create: the `.pibot/wt` folder the runner prepared; the control side keeps it for remove. */
  parent: ManagedIdentitySchema.optional(),
  integrated: z.boolean(),
  cleaned: z.boolean(),
});
export type RunnerManagedGitInspectParams = z.output<typeof RunnerManagedGitInspectParamsSchema>;
export type RunnerManagedGitPrepareParams = z.output<typeof RunnerManagedGitPrepareParamsSchema>;
export type RunnerManagedGitPrepareResult = z.output<typeof RunnerManagedGitPrepareResultSchema>;
export type RunnerManagedGitExecuteParams = z.output<typeof RunnerManagedGitExecuteParamsSchema>;
export type RunnerManagedGitExecuteResult = z.output<typeof RunnerManagedGitExecuteResultSchema>;
export interface ManagedGitPort {
  inspect(
    input: RunnerManagedGitInspectParams,
    signal: AbortSignal,
  ): Promise<z.output<typeof RunnerManagedGitInspectResultSchema>>;
  prepare(
    input: RunnerManagedGitPrepareParams,
    signal: AbortSignal,
  ): Promise<RunnerManagedGitPrepareResult>;
  execute(
    input: RunnerManagedGitExecuteParams & { prepared: RunnerManagedGitPrepareParams },
    signal: AbortSignal,
  ): Promise<RunnerManagedGitExecuteResult>;
}

export const runnerMethods = {
  ...PhoneControlRunnerMethods,
  ...RunnerPolicyMethods,
  "runner.capabilities.negotiate": { params: z.strictObject({}), result: CapabilityManifestSchema },
  "runner.capabilities.set": {
    params: EndpointSessionEvents["endpoint.enabled"],
    result: z.null(),
  },
  "runner.git.entries": {
    params: RunnerGitEntriesParamsSchema,
    result: RunnerGitEntriesResultSchema,
  },
  "runner.managedGit.inspect": {
    params: RunnerManagedGitInspectParamsSchema,
    result: RunnerManagedGitInspectResultSchema,
  },
  "runner.managedGit.prepare": {
    params: RunnerManagedGitPrepareParamsSchema,
    result: RunnerManagedGitPrepareResultSchema,
  },
  "runner.managedGit.execute": {
    params: RunnerManagedGitExecuteParamsSchema,
    result: RunnerManagedGitExecuteResultSchema,
  },
  "runner.command.protection": {
    params: z.strictObject({}),
    result: z.strictObject({ roots: z.array(AbsolutePathSchema).max(16) }),
  },
  "runner.executionChecks.enable": {
    params: z.strictObject({}),
    result: z.null(),
  },
  "runner.info": {
    params: z.strictObject({}),
    result: z.strictObject({
      targetId: RunnerTargetIdSchema,
      platform: RunnerPlatformSchema,
      isolation: z.strictObject({ available: z.boolean(), reason: z.string().optional() }),
    }),
  },
  // One level of folder names for the desktop's folder chooser (never file contents).
  "runner.folders.list": {
    params: z.strictObject({ path: AbsolutePathSchema.nullable().optional() }),
    result: z.strictObject({
      path: AbsolutePathSchema.nullable(),
      parent: AbsolutePathSchema.nullable(),
      top: z.boolean(),
      folders: z
        .array(z.strictObject({ name: z.string().min(1).max(4096), path: AbsolutePathSchema }))
        .max(500),
      truncated: z.boolean(),
    }),
  },
  "runner.path.canonicalize": {
    params: z.strictObject({ path, cwd: AbsolutePathSchema }),
    result: z.strictObject({
      path: AbsolutePathSchema,
      device: z.string().max(100).nullable(),
      inode: z.string().max(100).nullable(),
    }),
  },
  "runner.command.run": {
    params: z.strictObject({
      idempotencyKey: RunnerIdempotencyKeySchema,
      issuedAt: CanonicalTimeSchema,
      dispatchOpId: RunnerDispatchOpIdSchema,
      input: RunnerCommandInputSchema,
    }),
    result: RunnerCommandResultSchema,
  },
  "runner.command.release": {
    params: z.strictObject({
      idempotencyKey: RunnerIdempotencyKeySchema,
      issuedAt: CanonicalTimeSchema,
      runId: z.string().min(1).max(128),
    }),
    result: z.null(),
  },
  "runner.background.start": {
    params: z.strictObject({
      idempotencyKey: RunnerIdempotencyKeySchema,
      issuedAt: CanonicalTimeSchema,
      dispatchOpId: RunnerDispatchOpIdSchema,
      input: RunnerCommandInputSchema.omit({ timeoutSec: true }).extend({
        jobId: z.string().min(1).max(128),
      }),
    }),
    result: RunnerTransferDescriptorSchema,
  },
  "runner.background.write": {
    params: z.strictObject({
      idempotencyKey: RunnerIdempotencyKeySchema,
      issuedAt: CanonicalTimeSchema,
      dispatchOpId: RunnerDispatchOpIdSchema,
      jobId: z.string().min(1).max(128),
      runId: z.string().min(1).max(128),
      text: z.string().max(65536),
      eof: z.boolean(),
      rootIdentities: z.array(RunnerRootIdentitySchema).max(202).optional(),
    }),
    result: z.strictObject({ bytes: z.number().int().nonnegative(), eof: z.boolean() }),
  },
  "runner.background.inspect": {
    params: z.strictObject({
      jobId: z.string().min(1).max(128),
      maxChars: z.number().int().min(1).max(65536),
    }),
    result: RunnerTransferDescriptorSchema.nullable(),
  },
  "runner.background.list": {
    params: z.strictObject({
      maxChars: z.number().int().min(1).max(65536),
      after: z.string().min(1).max(128).optional(),
    }),
    result: RunnerTransferDescriptorSchema,
  },
  "runner.background.stop": {
    params: z.strictObject({
      idempotencyKey: RunnerIdempotencyKeySchema,
      issuedAt: CanonicalTimeSchema,
      jobId: z.string().min(1).max(128),
    }),
    result: RunnerTransferDescriptorSchema,
  },
  "runner.background.ack": {
    params: z.strictObject({ jobId: z.string().min(1).max(128) }),
    result: z.null(),
  },
  "runner.binary.read": {
    params: z.strictObject({ path, context: RunnerFileContextSchema }),
    result: RunnerTransferDescriptorSchema.extend({ path: AbsolutePathSchema }),
  },
  "runner.transfer.begin": { params: TransferBeginSchema, result: z.null() },
  "runner.transfer.chunk": {
    params: z.strictObject({
      transferId: RunnerTransferIdSchema,
      sequence: z.number().int().nonnegative(),
      data: z.string().max(900000),
    }),
    result: z.null(),
  },
  "runner.transfer.commit": {
    params: z.strictObject({ transferId: RunnerTransferIdSchema }),
    result: RunnerTransferDescriptorSchema,
  },
  "runner.transfer.pull": {
    params: z.strictObject({
      transferId: RunnerTransferIdSchema,
      sequence: z.number().int().nonnegative(),
    }),
    result: z.strictObject({ data: z.string().max(900000), done: z.boolean() }),
  },
  "runner.transfer.cancel": {
    params: z.strictObject({ transferId: RunnerTransferIdSchema }),
    result: z.null(),
  },
  "runner.computer.call": {
    params: z
      .strictObject({
        blockedApps: z.array(z.string().min(1).max(512)).max(500),
        method: z.enum(
          Object.keys(HostComputerMethods) as [
            keyof typeof HostComputerMethods,
            ...(keyof typeof HostComputerMethods)[],
          ],
        ),
        input: z.unknown(),
        idempotencyKey: RunnerIdempotencyKeySchema,
        issuedAt: CanonicalTimeSchema,
        dispatchOpId: RunnerDispatchOpIdSchema,
      })
      .superRefine((value, ctx) => {
        if (!HostComputerMethods[value.method].params.safeParse(value.input).success)
          ctx.addIssue({ code: "custom", message: "computer_input_invalid" });
      }),
    result: RunnerTransferDescriptorSchema,
  },
  "runner.dispatch.confirm": {
    params: z.strictObject({ opId: RunnerDispatchOpIdSchema }),
    result: z.null(),
  },
  "runner.reconcile": {
    params: z.strictObject({
      idempotencyKey: RunnerIdempotencyKeySchema,
      issuedAt: CanonicalTimeSchema,
    }),
    result: JournalResultSchema,
  },
} as const;

export const runnerEvents = {} as const;
export type RunnerMethods = typeof runnerMethods;
export type RunnerEvents = typeof runnerEvents;
