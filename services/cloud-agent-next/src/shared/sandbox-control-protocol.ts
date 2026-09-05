import { z } from 'zod';
import { SandboxRuntimeVersionSchema } from './sandbox-status.js';

export {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  worktreeChangesFileSchema,
  sessionGitSummaryPayloadSchema,
  sessionGitSummaryResultSchema,
  type WorktreeChangesFile,
  type SessionGitSummaryPayload,
  type SessionGitSummaryResult,
} from './worktree-changes-wire.js';

export const SANDBOX_CONTROL_PROTOCOL_VERSION = 1;

export const MAX_SANDBOX_CONTROL_FRAME_BYTES = 1 * 1024 * 1024;

export const SANDBOX_CONTROL_WS_TAG = 'sandbox-control';

export const SANDBOX_CONTROL_AUTO_PING = 'ping';

export const SANDBOX_CONTROL_AUTO_PONG = 'pong';

export const SANDBOX_HELLO_DEADLINE_MS = 10_000;

export const SANDBOX_CONTROL_REQUEST_TIMEOUT_MS = 30_000;

export const SANDBOX_CONTROL_ATTACH_TIMEOUT_MS = 8 * 60_000;

export const SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS = 60 * 60_000;

export const SANDBOX_OPERATIONS = [
  'sandbox.hello',
  'sandbox.status',
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
  'session.detach',
  'session.runtime.retire',
  'session.terminal.create',
  'session.terminal.resize',
  'session.terminal.close',
  'session.terminal.connect',
] as const;

export const SANDBOX_EVENTS = ['sandbox.ready', 'sandbox.heartbeat'] as const;

export const SESSION_EVENTS = ['session.event', 'session.preparing'] as const;

export type SandboxOperation = (typeof SANDBOX_OPERATIONS)[number];
export type SessionOperation = (typeof SESSION_OPERATIONS)[number];
export type ControlOperation = SandboxOperation | SessionOperation;
export type SandboxEvent = (typeof SANDBOX_EVENTS)[number];
export type SessionEventName = (typeof SESSION_EVENTS)[number];
export type ControlEvent = SandboxEvent | SessionEventName;

export const CONTROL_OPERATIONS = [...SANDBOX_OPERATIONS, ...SESSION_OPERATIONS] as const;
export const CONTROL_EVENTS = [...SANDBOX_EVENTS, ...SESSION_EVENTS] as const;

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
] as const;

export type ControlErrorCode = (typeof controlErrorCodes)[number];

export const requestIdSchema = z.string().min(1).max(128);

export const terminalPtyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid PTY ID format');

export const wrapperInstanceIdSchema = z.string().uuid();

export const sessionRequestIdentitySchema = z.object({
  sessionId: z.string().min(1),
  kiloSessionId: z.string().min(1),
  directory: z.string().min(1),
});

export const sessionEventIdentitySchema = z.object({
  directory: z.string().min(1),
  kiloSessionId: z.string().min(1).optional(),
  rootKiloSessionId: z.string().min(1).optional(),
});

export const controlErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
});

export const requestFrameSchema = z.object({
  type: z.literal('request'),
  requestId: requestIdSchema,
  operation: z.string().min(1),
  session: sessionRequestIdentitySchema.optional(),
  payload: z.unknown(),
});

export const responseFrameSchema = z.object({
  type: z.literal('response'),
  requestId: requestIdSchema,
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: controlErrorSchema.optional(),
});

export const eventFrameSchema = z.object({
  type: z.literal('event'),
  event: z.string().min(1),
  session: sessionEventIdentitySchema.optional(),
  payload: z.unknown(),
});

export const controlFrameSchema = z.discriminatedUnion('type', [
  requestFrameSchema,
  responseFrameSchema,
  eventFrameSchema,
]);

export type RequestFrame = z.infer<typeof requestFrameSchema>;
export type ResponseFrame = z.infer<typeof responseFrameSchema>;
export type EventFrame = z.infer<typeof eventFrameSchema>;
export type ControlFrame = z.infer<typeof controlFrameSchema>;
export type SessionRequestIdentity = z.infer<typeof sessionRequestIdentitySchema>;
export type SessionEventIdentity = z.infer<typeof sessionEventIdentitySchema>;
export type ControlError = z.infer<typeof controlErrorSchema>;

export const sandboxHelloPayloadSchema = z.object({
  protocolVersion: z.literal(SANDBOX_CONTROL_PROTOCOL_VERSION),
  providerInstanceId: z.string().min(1).max(256),
  wrapperInstanceId: wrapperInstanceIdSchema.optional(),
  wrapperVersion: z.string().min(1).max(128).optional(),
  capabilities: z
    .object({
      runtimeIsolation: z.literal(true).optional(),
      runtimeRecovery: z.literal(true).optional(),
    })
    .strict()
    .optional(),
});

export const sandboxHelloResultSchema = z.object({
  protocolVersion: z.literal(SANDBOX_CONTROL_PROTOCOL_VERSION),
  handshakeComplete: z.literal(true),
  capabilities: z.object({ kiloVersionHeartbeat: z.boolean().optional() }).optional(),
});

export type SandboxHelloPayload = z.infer<typeof sandboxHelloPayloadSchema>;
export type SandboxHelloResult = z.infer<typeof sandboxHelloResultSchema>;

export const sandboxReadyPayloadSchema = z
  .object({
    kiloReady: z.literal(true),
    globalFeedAttached: z.literal(true),
  })
  .strict();

export const sandboxHeartbeatPayloadSchema = z
  .object({
    state: z.enum(['idle', 'active', 'finalizing']),
    activeKiloSessions: z.number().int().nonnegative().optional(),
    pendingMessages: z.number().int().nonnegative().optional(),
    kilo: z
      .object({
        ready: z.boolean(),
        version: SandboxRuntimeVersionSchema.nullable().optional().catch(undefined),
        reason: z
          .enum([
            'feed_stale',
            'feed_reconnected',
            'feed_ended',
            'feed_failed',
            'process_exited',
            'credential_refresh_failed',
            'control_disconnected',
            'shutdown',
          ])
          .optional(),
      })
      .strict(),
    sessions: z.array(
      z
        .object({
          kiloSessionId: z.string().min(1),
          state: z.enum(['idle', 'active', 'finalizing']),
          idleForMs: z.number().int().nonnegative(),
          waitingOn: z.enum(['model', 'tool', 'finalizing', 'preparation', 'input']).optional(),
        })
        .strict()
    ),
  })
  .strict();

export const sandboxStatusPayloadSchema = z.object({}).strict();

export const sandboxStatusResultSchema = z
  .object({
    healthy: z.boolean(),
    state: z.enum(['idle', 'active', 'finalizing']),
    version: z.string().min(1).max(128),
    kiloReady: z.boolean().optional(),
  })
  .strict();

export const sandboxShutdownPayloadSchema = z
  .object({
    reason: z.string().min(1).max(256).optional(),
  })
  .strict();

export const sandboxShutdownResultSchema = z
  .object({
    shuttingDown: z.literal(true),
  })
  .strict();

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

export const sessionAttachPayloadSchema = z
  .object({
    runtimeIsolation: z.literal('per-session').optional(),
    snapshotIdentity: z.string().min(1).max(512).optional(),
    directory: z.string().min(1).max(1024).optional(),
    branch: z.string().min(1).max(256).optional(),
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
      })
      .strict()
      .optional(),
    snapshot: z
      .object({
        url: z.string().min(1).max(4096),
      })
      .strict()
      .optional(),
    env: z.record(z.string().max(256), z.string().max(8192)).optional(),
    setupCommands: z.array(z.string().max(500)).max(20).optional(),
    preparation: z
      .object({
        attemptId: z.string().min(1).max(128),
        triggerMessageId: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict();

export const sessionAttachResultSchema = z
  .object({
    attached: z.literal(true),
  })
  .strict();

export const sessionPromptTurnSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('prompt'),
      prompt: z.string(),
      parts: z
        .array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal('text'), text: z.string() }).strict(),
            z
              .object({
                type: z.literal('file'),
                mime: z.string().min(1),
                url: z.string().min(1),
                filename: z.string().min(1).optional(),
              })
              .strict(),
          ])
        )
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      command: z.string().min(1).max(256),
      arguments: z.string(),
    })
    .strict(),
]);

const sessionPromptAgentSchema = z
  .object({
    mode: z.string().min(1).max(64),
    model: z.string().min(1).max(256).regex(/\S/),
    variant: z.string().min(1).max(64).optional(),
  })
  .strict();

const sessionPromptPayloadBaseSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    attachments: z
      .array(
        z
          .object({
            filename: z.string().min(1),
            mime: z.string().min(1),
            signedUrl: z.string().min(1),
            localPath: z.string().min(1),
          })
          .strict()
      )
      .optional(),
    finalization: z
      .object({
        autoCommit: z.boolean().optional(),
        condenseOnComplete: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const sessionPromptPayloadSchema = z.union([
  sessionPromptPayloadBaseSchema.extend({
    turn: sessionPromptTurnSchema.options[0],
    agent: sessionPromptAgentSchema,
  }),
  sessionPromptPayloadBaseSchema.extend({
    turn: sessionPromptTurnSchema.options[1],
    agent: sessionPromptAgentSchema.partial({ model: true }),
  }),
]);

export const sessionPromptResultSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    status: z.enum(['accepted', 'existing']),
  })
  .strict();

export const sessionPermissionResolvePayloadSchema = z
  .object({
    permissionId: z.string().min(1).max(256),
    response: z.enum(['always', 'once', 'reject']),
    message: z.string().max(1024).optional(),
  })
  .strict();

export const sessionPermissionResolveResultSchema = z
  .object({
    success: z.literal(true),
  })
  .strict();

export const sessionQuestionResolvePayloadSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('answer'),
      questionId: z.string().min(1).max(256),
      answers: z.array(z.array(z.string())),
    })
    .strict(),
  z
    .object({
      action: z.literal('reject'),
      questionId: z.string().min(1).max(256),
    })
    .strict(),
]);

export const sessionQuestionResolveResultSchema = z
  .object({
    success: z.literal(true),
  })
  .strict();

export const sessionAbortPayloadSchema = z
  .object({
    messageId: z.string().min(1).max(128).optional(),
    reason: z.string().min(1).max(256).optional(),
  })
  .strict();

export const sessionAbortResultSchema = z
  .object({
    status: z.enum(['aborted', 'already_idle']),
  })
  .strict();

export const sessionSyncPayloadSchema = z.object({}).strict();

export const sessionSyncResultSchema = z
  .object({
    status: z.object({ type: z.string().min(1) }).passthrough(),
    questions: z.array(z.unknown()),
    permissions: z.array(z.unknown()),
  })
  .strict();

export const sessionDetachPayloadSchema = z.object({}).strict();

export const sessionDetachResultSchema = z
  .object({
    detached: z.literal(true),
  })
  .strict();

export const sessionRuntimeRetirePayloadSchema = z
  .object({ recoveryId: z.string().uuid() })
  .strict();

export const sessionRuntimeRetireResultSchema = z
  .object({ recoveryId: z.string().uuid(), retired: z.literal(true) })
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

export const sessionEventPayloadSchema = z
  .object({
    type: z.string().min(1).max(256),
    properties: z.record(z.string(), z.unknown()),
    timestamp: z.string().min(1).optional(),
  })
  .strict();

export const sessionMessageOutcomeSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    status: z.enum(['completed', 'failed', 'cancelled']),
    reason: z.string().max(4096).optional(),
  })
  .strict();

export type SessionMessageOutcome = z.infer<typeof sessionMessageOutcomeSchema>;

export const sessionPreparingPayloadSchema = z
  .object({
    version: z.literal(2),
    attemptId: z.string().min(1).max(128),
    triggerMessageId: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    step: z.string().min(1).max(64),
    message: z.string().max(4096),
    action: z.string().min(1).max(64),
  })
  .passthrough();

export type SandboxReadyPayload = z.infer<typeof sandboxReadyPayloadSchema>;
export type SandboxHeartbeatPayload = z.infer<typeof sandboxHeartbeatPayloadSchema>;
export type SandboxStatusPayload = z.infer<typeof sandboxStatusPayloadSchema>;
export type SandboxStatusResult = z.infer<typeof sandboxStatusResultSchema>;
export type SandboxShutdownPayload = z.infer<typeof sandboxShutdownPayloadSchema>;
export type SandboxShutdownResult = z.infer<typeof sandboxShutdownResultSchema>;
export type SessionAttachPayload = z.infer<typeof sessionAttachPayloadSchema>;
export type SessionAttachResult = z.infer<typeof sessionAttachResultSchema>;
export type SessionPromptPayload = z.infer<typeof sessionPromptPayloadSchema>;
export type SessionPromptResult = z.infer<typeof sessionPromptResultSchema>;
export type SessionPermissionResolvePayload = z.infer<typeof sessionPermissionResolvePayloadSchema>;
export type SessionPermissionResolveResult = z.infer<typeof sessionPermissionResolveResultSchema>;
export type SessionQuestionResolvePayload = z.infer<typeof sessionQuestionResolvePayloadSchema>;
export type SessionQuestionResolveResult = z.infer<typeof sessionQuestionResolveResultSchema>;
export type SessionAbortPayload = z.infer<typeof sessionAbortPayloadSchema>;
export type SessionAbortResult = z.infer<typeof sessionAbortResultSchema>;
export type SessionSyncPayload = z.infer<typeof sessionSyncPayloadSchema>;
export type SessionSyncResult = z.infer<typeof sessionSyncResultSchema>;
export type SessionDetachPayload = z.infer<typeof sessionDetachPayloadSchema>;
export type SessionDetachResult = z.infer<typeof sessionDetachResultSchema>;
export type SessionRuntimeRetirePayload = z.infer<typeof sessionRuntimeRetirePayloadSchema>;
export type SessionRuntimeRetireResult = z.infer<typeof sessionRuntimeRetireResultSchema>;
export type SessionTerminalCreatePayload = z.infer<typeof sessionTerminalCreatePayloadSchema>;
export type SessionTerminalCreateResult = z.infer<typeof sessionTerminalCreateResultSchema>;
export type SessionTerminalResizePayload = z.infer<typeof sessionTerminalResizePayloadSchema>;
export type SessionTerminalResizeResult = z.infer<typeof sessionTerminalResizeResultSchema>;
export type SessionTerminalClosePayload = z.infer<typeof sessionTerminalClosePayloadSchema>;
export type SessionTerminalCloseResult = z.infer<typeof sessionTerminalCloseResultSchema>;
export type SessionTerminalConnectPayload = z.infer<typeof sessionTerminalConnectPayloadSchema>;
export type SessionTerminalConnectResult = z.infer<typeof sessionTerminalConnectResultSchema>;
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;
export type SessionPreparingPayload = z.infer<typeof sessionPreparingPayloadSchema>;

const observationTimestampSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);

export const sandboxControlObservationSchema = z
  .object({
    ready: z.boolean(),
    receivedAt: observationTimestampSchema,
    idle: z
      .object({
        sessionCount: z.number().int().nonnegative(),
        sessionIdsHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type SandboxControlObservation = z.infer<typeof sandboxControlObservationSchema>;

export const sandboxControlSocketAttachmentSchema = z.object({
  handshakeComplete: z.boolean(),
  kiloReady: z.boolean().optional(),
  acceptedAt: z.number().int().nonnegative(),
  connectionId: z.string().uuid().optional(),
  protocolVersion: z.literal(SANDBOX_CONTROL_PROTOCOL_VERSION).optional(),
  providerInstanceId: z.string().min(1).max(256).optional(),
  wrapperInstanceId: wrapperInstanceIdSchema.optional(),
  runtimeIsolation: z.literal(true).optional(),
  runtimeRecovery: z.literal(true).optional(),
  observation: sandboxControlObservationSchema.optional(),
});

export type SandboxControlSocketAttachment = z.infer<typeof sandboxControlSocketAttachmentSchema>;
