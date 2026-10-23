import { z } from 'zod';

export {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  WORKTREE_FILE_SCHEMA_VERSION,
  MAX_WORKTREE_FILE_BYTES,
  MAX_WORKTREE_SNAPSHOT_BYTES,
  MAX_WORKTREE_PATCH_LINES,
  MAX_WORKTREE_CONTENT_BYTES,
  MAX_WORKTREE_CONTENT_LINES,
  worktreeChangesFileSchema,
  worktreeFileOmissionReasonSchema,
  worktreeFileRecordSchema,
  worktreeSnapshotCaptureSchema,
  sessionGitSummaryPayloadSchema,
  sessionGitSummaryResultSchema,
  sessionGitSnapshotPayloadSchema,
  sessionGitSnapshotResultSchema,
  type WorktreeChangesFile,
  type WorktreeFileOmissionReason,
  type WorktreeFileRecord,
  type WorktreeSnapshotCapture,
  type SessionGitSummaryPayload,
  type SessionGitSummaryResult,
  type SessionGitSnapshotPayload,
  type SessionGitSnapshotResult,
} from './worktree-changes-wire.js';

export const MAX_SANDBOX_CONTROL_FRAME_BYTES = 12 * 1024 * 1024;

export const SANDBOX_CONTROL_ATTACH_TIMEOUT_MS = 8 * 60_000;

export const SANDBOX_OPERATIONS = [
  'sandbox.hello',
  'sandbox.status',
  'sandbox.reconcile',
  'sandbox.event.publish',
  'sandbox.event.publishBatch',
  'sandbox.shutdown',
  'worktree.prepareDeletion',
  'worktree.delete',
] as const;

export const SESSION_OPERATIONS = [
  'session.attach',
  'session.prompt',
  'session.permission.resolve',
  'session.question.resolve',
  'session.abort',
  'session.sync',
  'session.git.summary',
  'session.git.snapshot',
  'session.detach',
  'session.runtime.retire',
  'session.terminal.create',
  'session.terminal.resize',
  'session.terminal.close',
  'session.terminal.connect',
  'session.operation.get',
  'session.operation.ack',
] as const;

export const CONTROL_OPERATIONS = [...SANDBOX_OPERATIONS, ...SESSION_OPERATIONS] as const;

export const controlErrorCodes = [
  'protocol_error',
  'unauthorized',
  'payload_too_large',
  'unknown_operation',
  'handshake_required',
  'not_ready',
  'session_busy',
  'runtime_unhealthy',
  'idempotency_conflict',
  'event_rejected',
] as const;

export type ControlErrorCode = (typeof controlErrorCodes)[number];

export const terminalPtyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid PTY ID format');

export const sessionRequestIdentitySchema = z.object({
  sessionId: z.string().min(1),
  kiloSessionId: z.string().min(1),
  directory: z.string().min(1),
});

export const sessionEventIdentitySchema = z.object({
  directory: z.string().min(1),
  nativeRuntimeId: z.string().uuid().optional(),
  kiloSessionId: z.string().min(1).optional(),
  rootKiloSessionId: z.string().min(1).optional(),
});
export type SessionRequestIdentity = z.infer<typeof sessionRequestIdentitySchema>;
export type SessionEventIdentity = z.infer<typeof sessionEventIdentitySchema>;

export const worktreeDeletePayloadSchema = z
  .object({
    worktreeId: z.templateLiteral(['worktree_', z.uuid()]),
    directory: z.string().min(1).max(1024),
    sessionIds: z.array(z.string().startsWith('ses_').length(30)),
  })
  .strict();

export const worktreePrepareDeletionResultSchema = z
  .object({
    prepared: z.literal(true),
    sessionIds: z.array(z.string().startsWith('ses_').length(30)),
  })
  .strict();

export const worktreeDeleteResultSchema = z
  .object({
    deleted: z.literal(true),
    sessionIds: z.array(z.string().startsWith('ses_').length(30)),
  })
  .strict();

export type WorktreeDeletePayload = z.infer<typeof worktreeDeletePayloadSchema>;
export type WorktreeDeleteResult = z.infer<typeof worktreeDeleteResultSchema>;

export const gitAuthorSchema = z
  .object({
    name: z.string().min(1).max(256),
    email: z.string().min(1).max(320),
  })
  .strict();

const sessionAttachMcpValueSchema = z.string().max(8192);
const sessionAttachMcpValuesSchema = z
  .record(z.string().min(1).max(256), sessionAttachMcpValueSchema)
  .refine(values => Object.keys(values).length <= 50, {
    message: 'An MCP server can have at most 50 environment variables or headers',
  });
const sessionAttachMcpServerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('local'),
      command: z.array(z.string().max(8192)).min(1).max(50),
      environment: sessionAttachMcpValuesSchema.optional(),
      enabled: z.boolean().optional(),
      timeout: z.number().int().positive().max(3_600_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('remote'),
      url: z.string().url().max(4096),
      headers: sessionAttachMcpValuesSchema.optional(),
      enabled: z.boolean().optional(),
      timeout: z.number().int().positive().max(3_600_000).optional(),
    })
    .strict(),
]);
export const sessionAttachMcpServersSchema = z
  .record(z.string().min(1).max(100), sessionAttachMcpServerSchema)
  .refine(servers => Object.keys(servers).length <= 20, {
    message: 'A session can have at most 20 MCP servers',
  })
  .refine(servers => new TextEncoder().encode(JSON.stringify(servers)).byteLength <= 80 * 1024, {
    message: 'Serialized MCP configuration exceeds the 80 KiB limit',
  });

export const sessionAttachPayloadSchema = z
  .object({
    captureNativeRuntimeId: z.literal(true).optional(),
    snapshotIdentity: z.string().min(1).max(512).optional(),
    directory: z.string().min(1).max(1024).optional(),
    branch: z.string().min(1).max(256).optional(),
    branchMode: z.literal('working').optional(),
    kilo: z
      .object({
        scopeId: z.string().min(1).max(256),
        token: z.string().min(1).max(4096),
        containmentEnabled: z.boolean().optional(),
        organizationId: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
          .optional(),
        targets: z
          .object({
            backendBaseUrl: z.string().url(),
            providerBaseUrl: z.string().url(),
            sessionIngestBaseUrl: z.string().url(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    git: z
      .object({
        url: z.string().min(1).max(2048),
        token: z.string().min(1).max(4096).optional(),
        platform: z.enum(['github', 'gitlab', 'bitbucket']).optional(),
        author: gitAuthorSchema.optional(),
      })
      .strict()
      .optional(),
    env: z.record(z.string().max(256), z.string().max(8192)).optional(),
    mcp: sessionAttachMcpServersSchema.optional(),
    setupCommands: z.array(z.string().max(500)).max(20).optional(),
    runtimeIsolation: z.enum(['per-session']).optional(),
    preparation: z
      .object({
        attemptId: z.string().min(1).max(128),
        triggerMessageId: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict();

const terminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(200),
});

const terminalPtySchema = z.object({
  id: terminalPtyIdSchema,
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  status: z.enum(['running', 'exited']),
  pid: z.number().int(),
});

export const sessionTerminalCreatePayloadSchema = z
  .object({
    operationId: z.string().uuid(),
  })
  .extend(terminalSizeSchema.partial().shape)
  .strict()
  .refine(data => (data.cols === undefined) === (data.rows === undefined), {
    message: 'cols and rows must be provided together',
  });

export const sessionTerminalCreateResultSchema = z
  .object({
    pty: terminalPtySchema,
  })
  .strict();

export const sessionTerminalResizePayloadSchema = z
  .object({
    ptyId: terminalPtyIdSchema,
  })
  .extend(terminalSizeSchema.shape)
  .strict();

export const sessionTerminalResizeResultSchema = z
  .object({
    pty: terminalPtySchema,
  })
  .strict();

export const sessionTerminalClosePayloadSchema = z
  .object({
    ptyId: terminalPtyIdSchema,
  })
  .strict();

export const sessionTerminalCloseResultSchema = z
  .object({
    success: z.boolean(),
  })
  .strict();

export const sessionTerminalConnectPayloadSchema = z
  .object({
    ownerId: z.string().min(1),
    ptyId: terminalPtyIdSchema,
    bridgeGeneration: z.string().uuid(),
    capability: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const sessionTerminalConnectResultSchema = z
  .object({
    connected: z.literal(true),
  })
  .strict();
export type SessionAttachPayload = z.infer<typeof sessionAttachPayloadSchema>;
export type SessionTerminalCreatePayload = z.infer<typeof sessionTerminalCreatePayloadSchema>;
export type SessionTerminalCreateResult = z.infer<typeof sessionTerminalCreateResultSchema>;
export type SessionTerminalResizePayload = z.infer<typeof sessionTerminalResizePayloadSchema>;
export type SessionTerminalResizeResult = z.infer<typeof sessionTerminalResizeResultSchema>;
export type SessionTerminalClosePayload = z.infer<typeof sessionTerminalClosePayloadSchema>;
export type SessionTerminalCloseResult = z.infer<typeof sessionTerminalCloseResultSchema>;
export type SessionTerminalConnectPayload = z.infer<typeof sessionTerminalConnectPayloadSchema>;
export type SessionTerminalConnectResult = z.infer<typeof sessionTerminalConnectResultSchema>;
