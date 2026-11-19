import { environmentSetupCommandCountSchema, setupCommandsSchema } from './setup-script.js';
import {
  MAX_MCP_COMMAND_ARGS,
  MAX_MCP_COMMAND_ARG_LENGTH,
  MAX_MCP_ENV_OR_HEADER_KEY_LENGTH,
  MAX_MCP_ENV_OR_HEADERS_PER_SERVER,
  MAX_MCP_PLAINTEXT_BYTES,
  MAX_MCP_REMOTE_URL_LENGTH,
  MAX_MCP_SECRET_VALUE_LENGTH,
  MAX_MCP_SERVERS,
  MAX_MCP_SERVER_NAME_LENGTH,
} from './prepare-session-limits.js';
import {
  findReservedEnvVarName,
  MAX_ATTACH_ENV_KEYS,
  RESERVED_ENV_VARS_MESSAGE,
} from './runtime-environment.js';
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

const sessionAttachMcpValueSchema = z.string().max(MAX_MCP_SECRET_VALUE_LENGTH);
const sessionAttachMcpValuesSchema = z
  .record(z.string().min(1).max(MAX_MCP_ENV_OR_HEADER_KEY_LENGTH), sessionAttachMcpValueSchema)
  .refine(values => Object.keys(values).length <= MAX_MCP_ENV_OR_HEADERS_PER_SERVER, {
    message: `An MCP server can have at most ${MAX_MCP_ENV_OR_HEADERS_PER_SERVER} environment variables or headers`,
  });
const sessionAttachMcpServerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('local'),
      command: z.array(z.string().max(MAX_MCP_COMMAND_ARG_LENGTH)).min(1).max(MAX_MCP_COMMAND_ARGS),
      environment: sessionAttachMcpValuesSchema.optional(),
      enabled: z.boolean().optional(),
      timeout: z.number().int().positive().max(3_600_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('remote'),
      url: z.string().url().max(MAX_MCP_REMOTE_URL_LENGTH),
      headers: sessionAttachMcpValuesSchema.optional(),
      enabled: z.boolean().optional(),
      timeout: z.number().int().positive().max(3_600_000).optional(),
    })
    .strict(),
]);
export const sessionAttachMcpServersSchema = z
  .record(z.string().min(1).max(MAX_MCP_SERVER_NAME_LENGTH), sessionAttachMcpServerSchema)
  .refine(servers => Object.keys(servers).length <= MAX_MCP_SERVERS, {
    message: `A session can have at most ${MAX_MCP_SERVERS} MCP servers`,
  })
  .refine(
    servers =>
      new TextEncoder().encode(JSON.stringify(servers)).byteLength <= MAX_MCP_PLAINTEXT_BYTES,
    { message: 'Serialized MCP configuration exceeds the 80 KiB limit' }
  );

/**
 * The attach env starts from the stored profile env and carries the credential
 * names the preparation adds, so the cap is the profile cap plus those names.
 * Reserved names are the platform's: the workspace path, session home and pnpm
 * store are computed from them.
 */
const sessionAttachEnvSchema = z
  .record(z.string().max(256), z.string().max(8192))
  .refine(obj => Object.keys(obj).length <= MAX_ATTACH_ENV_KEYS, {
    message: `Maximum ${MAX_ATTACH_ENV_KEYS} environment variables allowed`,
  })
  .refine(obj => findReservedEnvVarName(Object.keys(obj)) === undefined, {
    message: RESERVED_ENV_VARS_MESSAGE,
  });

export const sessionAttachPayloadSchema = z
  .object({
    captureNativeRuntimeId: z.literal(true).optional(),
    snapshotIdentity: z.string().min(1).max(512).optional(),
    directory: z.string().min(1).max(1024).optional(),
    branch: z.string().min(1).max(256).optional(),
    branchMode: z.literal('working').optional(),
    /** Stacked workspace base: the branch the working branch starts from. */
    baseBranch: z.string().min(1).max(256).optional(),
    /** The resolved commit the working branch starts from. */
    baseSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .optional(),
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
    env: sessionAttachEnvSchema.optional(),
    mcp: sessionAttachMcpServersSchema.optional(),
    setupCommands: setupCommandsSchema.optional(),
    startCommands: setupCommandsSchema.optional(),
    environmentSetupCommandCount: environmentSetupCommandCountSchema.optional(),
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
