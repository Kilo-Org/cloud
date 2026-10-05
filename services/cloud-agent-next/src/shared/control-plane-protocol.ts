import type {
  CloudAgentAssistantFailureReason,
  CloudAgentProviderOwnership,
  WorkspaceFailureSubtype,
} from '@kilocode/worker-utils/cloud-agent-failure';
import { z } from 'zod';
import { gitAuthorSchema, sessionAttachMcpServersSchema } from './sandbox-control-protocol.js';
import {
  sessionTerminalClosePayloadSchema,
  sessionTerminalConnectPayloadSchema,
  sessionTerminalCreatePayloadSchema,
  sessionTerminalResizePayloadSchema,
} from './sandbox-control-protocol.js';
import { sessionGitSummaryPayloadSchema } from './worktree-changes-wire.js';

export const CONTROL_PLANE_PROTOCOL_VERSION = 2;

/**
 * Launch-environment key that carries the allocation id. The wrapper echoes it
 * as `hello.allocationId`; the Sandbox DO must read the same name (B6).
 */
export const CONTROL_PLANE_ALLOCATION_ID_ENV = 'CONTROL_PLANE_ALLOCATION_ID';

export const CONTROL_PLANE_GIT_PLATFORMS = ['github', 'gitlab', 'bitbucket'] as const;
export type ControlPlaneGitPlatform = (typeof CONTROL_PLANE_GIT_PLATFORMS)[number];

/**
 * Route preparation steps. `sandbox_create` and `sandbox_start` come from the
 * Sandbox DO's allocation (provider create, then waiting for the wrapper's
 * `hello`); the rest come from the wrapper's `session.progress`.
 */
export const CONTROL_PLANE_PREPARATION_STEPS = [
  'sandbox_create',
  'sandbox_start',
  'clone',
  'restore',
  'checkout',
  'setup',
  'snapshot',
  'kilo_runtime',
  'kilo_session',
] as const;
export type ControlPlanePreparationStep = (typeof CONTROL_PLANE_PREPARATION_STEPS)[number];

/**
 * Event name the wrapper uses inside `session.events` to signal that it sealed
 * the current run batch (spec §10 "Finalization running"). Exported so the
 * wrapper chunk and the Session DO agree on one name.
 */
export const CONTROL_PLANE_WRAPPER_FINALIZING_EVENT = 'wrapper_finalizing';

/**
 * Setup-command lifecycle events the wrapper sends inside `session.events`.
 * The Session DO renders them as per-command preparation steps. `command` is
 * the 1-based command number in every event.
 */
export const CONTROL_PLANE_SETUP_EVENTS = {
  started: 'session.setup.started',
  output: 'session.setup.output',
  finished: 'session.setup.finished',
} as const;

const controlPlaneSetupCommandNumberSchema = z.number().int().min(1).max(20);

// Command bodies may contain inline credentials. Only these properties can be projected.
export const controlPlaneSetupEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(CONTROL_PLANE_SETUP_EVENTS.started),
    properties: z
      .object({
        command: controlPlaneSetupCommandNumberSchema,
        commandCount: controlPlaneSetupCommandNumberSchema,
      })
      .refine(value => value.command <= value.commandCount),
  }),
  z.object({
    type: z.literal(CONTROL_PLANE_SETUP_EVENTS.output),
    properties: z.object({
      command: controlPlaneSetupCommandNumberSchema,
      output: z.string().min(1).max(8_192),
    }),
  }),
  z.object({
    type: z.literal(CONTROL_PLANE_SETUP_EVENTS.finished),
    properties: z.object({
      command: controlPlaneSetupCommandNumberSchema,
      exitCode: z.number().int(),
      safeError: z.string().min(1).max(4_096).optional(),
    }),
  }),
]);
export type ControlPlaneSetupEvent = z.infer<typeof controlPlaneSetupEventSchema>;

export const CONTROL_PLANE_FAILURE_REASON_VALUES = [
  'preparation_timeout',
  'workspace_setup_failed',
  'agent_unavailable',
  'billing_blocked',
  'billing_unavailable',
  'invalid_configuration',
  'connection_lost',
  'sandbox_lost',
  'agent_restarted',
  'no_progress',
  'no_outcome',
  'prompt_failed',
  'sandbox_stopped',
  'execution_limit',
] as const;
export type ControlPlaneFailureReason = (typeof CONTROL_PLANE_FAILURE_REASON_VALUES)[number];

export const controlPlaneFailureReasonSchema = z.enum(CONTROL_PLANE_FAILURE_REASON_VALUES);

export const controlPlanePreparationStepSchema = z.enum(CONTROL_PLANE_PREPARATION_STEPS);

/** Bound on a live progress line within a step ("Receiving objects: 45%"). */
export const CONTROL_PLANE_PREPARATION_DETAIL_MAX_LENGTH = 200;
const controlPlanePreparationDetailSchema = z
  .string()
  .min(1)
  .max(CONTROL_PLANE_PREPARATION_DETAIL_MAX_LENGTH);

export const CONTROL_PLANE_ASSISTANT_FAILURE_REASONS = [
  'insufficient_credits',
  'rate_limited',
  'model_unavailable',
  'provider_authentication',
  'provider_unavailable',
  'provider_disconnect',
  'gateway_unavailable',
  'timeout',
  'invalid_request',
  'context_limit',
  'output_limit',
  'content_filter',
  'structured_output',
  'unknown',
] as const satisfies readonly CloudAgentAssistantFailureReason[];
export type ControlPlaneAssistantFailureReason =
  (typeof CONTROL_PLANE_ASSISTANT_FAILURE_REASONS)[number];

export const CONTROL_PLANE_PROVIDER_OWNERSHIP_VALUES = [
  'managed',
  'byok',
  'unknown',
] as const satisfies readonly CloudAgentProviderOwnership[];
export type ControlPlaneProviderOwnership =
  (typeof CONTROL_PLANE_PROVIDER_OWNERSHIP_VALUES)[number];

export const CONTROL_PLANE_WORKSPACE_FAILURE_SUBTYPES = [
  'git_clone_timeout',
  'git_checkout_timeout',
  'git_authentication_failed',
  'git_rate_limited',
  'git_network_failed',
  'git_pack_corrupt',
  'git_checkout_conflict',
  'git_branch_missing',
  'sandbox_storage_full',
  'kilo_import_timeout',
  'kilo_import_failed',
  'setup_command_timeout',
  'setup_command_failed',
  'workspace_setup_unknown',
] as const satisfies readonly WorkspaceFailureSubtype[];
export type ControlPlaneWorkspaceFailureSubtype =
  (typeof CONTROL_PLANE_WORKSPACE_FAILURE_SUBTYPES)[number];

type AssertNever<_T extends never> = true;
type _AssistantFailureReasonDriftGuard = AssertNever<
  Exclude<CloudAgentAssistantFailureReason, ControlPlaneAssistantFailureReason>
>;
type _ProviderOwnershipDriftGuard = AssertNever<
  Exclude<CloudAgentProviderOwnership, ControlPlaneProviderOwnership>
>;
type _WorkspaceFailureSubtypeDriftGuard = AssertNever<
  Exclude<WorkspaceFailureSubtype, ControlPlaneWorkspaceFailureSubtype>
>;

export const controlPlaneAssistantFailureReasonSchema = z.enum(
  CONTROL_PLANE_ASSISTANT_FAILURE_REASONS
);

export const controlPlaneProviderOwnershipSchema = z.enum(CONTROL_PLANE_PROVIDER_OWNERSHIP_VALUES);

export const controlPlaneWorkspaceFailureSubtypeSchema = z.enum(
  CONTROL_PLANE_WORKSPACE_FAILURE_SUBTYPES
);

// Kilo final-error reasons are free text from the wrapper; the closed set above
// covers only control-plane reasons.
export const controlPlaneOutcomeReasonSchema = z.string().min(1).max(4096);

export const controlPlaneRouteGitSchema = z
  .object({
    url: z.string().min(1).max(2048),
    token: z.string().min(1).max(4096).optional(),
    platform: z.enum(CONTROL_PLANE_GIT_PLATFORMS).optional(),
    author: gitAuthorSchema.optional(),
  })
  .strict();

export const controlPlaneKiloTargetsSchema = z
  .object({
    backendBaseUrl: z.string().url(),
    providerBaseUrl: z.string().url(),
    sessionIngestBaseUrl: z.string().url(),
  })
  .strict();

export const controlPlaneRouteKiloSchema = z
  .object({
    scopeId: z.string().min(1).max(256),
    token: z.string().min(1).max(4096),
    containmentEnabled: z.boolean().optional(),
    organizationId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .optional(),
    targets: controlPlaneKiloTargetsSchema,
  })
  .strict();

/**
 * How `session.prepare` left the workspace: cloned from scratch, already this
 * allocation's (a sibling session or a wrapper restart), or adopted from a
 * repository snapshot of another allocation.
 */
export const CONTROL_PLANE_WORKSPACE_OUTCOMES = ['cloned', 'same', 'adopted'] as const;
export type ControlPlaneWorkspaceOutcome = (typeof CONTROL_PLANE_WORKSPACE_OUTCOMES)[number];

export const controlPlaneRouteSpecSchema = z
  .object({
    sessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    directory: z.string().min(1).max(1024),
    createdOnPlatform: z.string().max(256).optional(),
    branch: z.string().min(1).max(256).optional(),
    branchMode: z.literal('working').optional(),
    git: controlPlaneRouteGitSchema.optional(),
    kilo: controlPlaneRouteKiloSchema.optional(),
    env: z.record(z.string().max(256), z.string().max(8192)).optional(),
    /**
     * Materialized (plaintext) MCP servers for `KILO_CONFIG_CONTENT.mcp`. Only
     * the Sandbox DO adds this to the `session.prepare` frame; it is never stored
     * in a route spec or the Session DO registration. The durable metadata keeps
     * only the encrypted envelopes.
     */
    mcp: sessionAttachMcpServersSchema.optional(),
    setupCommands: z.array(z.string().max(500)).max(20).optional(),
    runtimeIsolation: z.enum(['per-session']).optional(),
    attemptId: z.string().min(1).max(128),
    /**
     * Only the Sandbox DO adds this to the `session.prepare` frame, like `mcp`: the
     * wrapper may save the workspace as a repository snapshot after setup. It is
     * never stored in a route spec.
     */
    capture: z.literal(true).optional(),
  })
  .strict();

/**
 * DO-only credential source (plan "Clarification (2026-09-27, B3 credentials)").
 * The Session DO has the session metadata; the Sandbox DO does not. `prepare`
 * carries this minimal issue-time snapshot privately so the Sandbox DO can mint
 * and re-issue the per-session Git and Kilo credential grant. It must never be
 * serialized into a wrapper frame.
 */
export const controlPlaneCredentialRepositorySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('github'),
      repo: z.string().min(1),
      token: z.string().min(1).optional(),
      githubIntegrationId: z.string().uuid().optional(),
      githubAccessPurpose: z.enum(['workflow', 'agent']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('gitlab'),
      url: z.string().min(1),
      token: z.string().min(1).optional(),
      gitlabTokenManaged: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('bitbucket'),
      url: z.string().min(1),
      workspaceUuid: z.string().uuid(),
      repositoryUuid: z.string().uuid(),
      bitbucketIntegrationId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('git'),
      url: z.string().min(1),
      token: z.string().min(1).optional(),
      platform: z.enum(['github', 'gitlab']).optional(),
    })
    .strict(),
]);

export const controlPlaneCredentialSourceSchema = z
  .object({
    userId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    kiloToken: z
      .string()
      .min(1)
      .max(64 * 1024),
    orgId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .optional(),
    createdOnPlatform: z.string().max(100).optional(),
    repository: controlPlaneCredentialRepositorySchema.optional(),
    /**
     * Worker-encrypted `profile.mcpServers` snapshot. Persisted only inside this
     * DO-private source; the Sandbox DO re-validates it and decrypts it only when
     * building a `session.prepare` frame. Opaque here so the shared schema (and
     * the wrapper bundle) never imports the worker persistence schema.
     */
    mcpServers: z.record(z.string().min(1).max(100), z.unknown()).optional(),
    /** Credential scope (worktree id); defaults to the route's session id. */
    scopeId: z.string().min(1).max(256).optional(),
  })
  .strict();

/**
 * Session DO -> Sandbox DO `prepare` input (spec §10). The DO-only credential
 * source is required: without it the Sandbox DO cannot issue a grant and the
 * route fails closed. The wrapper spec must not carry `git.token` or `kilo`;
 * both are supplied by the issued grant (B3 review 2, N3).
 */
export const controlPlanePrepareInputSchema = z
  .object({
    spec: controlPlaneRouteSpecSchema,
    credentials: controlPlaneCredentialSourceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.spec.git?.token !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['spec', 'git', 'token'],
        message: 'prepare spec must not carry a git token',
      });
    }
    if (value.spec.kilo !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['spec', 'kilo'],
        message: 'prepare spec must not carry kilo credential material',
      });
    }
    if (value.spec.mcp !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['spec', 'mcp'],
        message: 'prepare spec must not carry materialized MCP servers',
      });
    }
    if (value.spec.capture !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['spec', 'capture'],
        message: 'prepare spec must not carry a snapshot capture request',
      });
    }
  });

export type ControlPlaneCredentialRepository = z.infer<
  typeof controlPlaneCredentialRepositorySchema
>;
export type ControlPlaneCredentialSource = z.infer<typeof controlPlaneCredentialSourceSchema>;
export type ControlPlanePrepareInput = z.infer<typeof controlPlanePrepareInputSchema>;

export const controlPlanePromptTurnSchema = z.discriminatedUnion('type', [
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

const controlPlanePromptAgentSchema = z
  .object({
    mode: z.string().min(1).max(64),
    model: z.string().min(1).max(256).regex(/\S/),
    variant: z.string().min(1).max(64).optional(),
  })
  .strict();

const controlPlanePromptPayloadBaseSchema = z
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

export const controlPlanePromptPayloadSchema = z.union([
  controlPlanePromptPayloadBaseSchema.extend({
    turn: controlPlanePromptTurnSchema.options[0],
    agent: controlPlanePromptAgentSchema,
  }),
  controlPlanePromptPayloadBaseSchema.extend({
    turn: controlPlanePromptTurnSchema.options[1],
    agent: controlPlanePromptAgentSchema.partial({ model: true }),
  }),
]);

const controlPlaneRouteUnknownSchema = z.object({ state: z.literal('unknown') }).strict();
const controlPlaneRoutePreparingSchema = z
  .object({
    state: z.literal('preparing'),
    attemptId: z.string().min(1).max(128),
    step: controlPlanePreparationStepSchema.optional(),
    detail: controlPlanePreparationDetailSchema.optional(),
  })
  .strict();
const controlPlaneRouteReadySchema = z
  .object({ state: z.literal('ready'), attemptId: z.string().min(1).max(128) })
  .strict();
const controlPlaneRouteReconnectingSchema = z
  .object({ state: z.literal('reconnecting'), attemptId: z.string().min(1).max(128) })
  .strict();
const controlPlaneRouteFailedSchema = z
  .object({
    state: z.literal('failed'),
    attemptId: z.string().min(1).max(128),
    reason: controlPlaneFailureReasonSchema,
    subtype: controlPlaneWorkspaceFailureSubtypeSchema.optional().catch(undefined),
  })
  .strict();
const controlPlaneRouteLostSchema = z
  .object({
    state: z.literal('lost'),
    attemptId: z.string().min(1).max(128),
    reason: controlPlaneFailureReasonSchema,
  })
  .strict();

export const controlPlaneRouteViewSchema = z.discriminatedUnion('state', [
  controlPlaneRouteUnknownSchema,
  controlPlaneRoutePreparingSchema,
  controlPlaneRouteReadySchema,
  controlPlaneRouteReconnectingSchema,
  controlPlaneRouteFailedSchema,
]);

export const controlPlaneRouteUpdateSchema = z.discriminatedUnion('state', [
  controlPlaneRouteUnknownSchema,
  controlPlaneRoutePreparingSchema,
  controlPlaneRouteReadySchema,
  controlPlaneRouteReconnectingSchema,
  controlPlaneRouteFailedSchema,
  controlPlaneRouteLostSchema,
]);

export const controlPlaneEventSchema = z
  .object({
    type: z.string().min(1).max(256),
    properties: z.record(z.string(), z.unknown()),
    timestamp: z.string().min(1).optional(),
  })
  .strict();

export const controlPlaneEventsNotificationSchema = z
  .object({ events: z.array(controlPlaneEventSchema).min(1) })
  .strict();

export const controlPlaneOutcomeSchema = z
  .object({
    sessionId: z.string().min(1),
    status: z.enum(['completed', 'failed', 'cancelled']),
    reason: controlPlaneOutcomeReasonSchema.optional(),
    assistantReason: controlPlaneAssistantFailureReasonSchema.optional(),
    providerOwnership: controlPlaneProviderOwnershipSchema.optional(),
    lastMessageId: z.string().min(1).max(128),
  })
  .strict();

export const controlPlaneDeliverPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    messages: z.array(controlPlanePromptPayloadSchema).min(1),
  })
  .strict();

export const controlPlaneDeliverResultSchema = z.enum(['sent', 'not_ready']);

export const controlPlaneSessionRefPayloadSchema = z
  .object({ sessionId: z.string().min(1) })
  .strict();

export const controlPlaneAnswerReplySchema = z.discriminatedUnion('action', [
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
  z
    .object({
      action: z.literal('permission'),
      permissionId: z.string().min(1).max(256),
      response: z.enum(['always', 'once', 'reject']),
      message: z.string().max(1024).optional(),
    })
    .strict(),
]);

export const controlPlaneAnswerPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    reply: controlPlaneAnswerReplySchema,
  })
  .strict();

export const controlPlaneDispatchResultSchema = z.enum(['sent', 'not_connected']);

export const controlPlaneStatusResultSchema = z
  .object({
    sessionId: z.string().min(1),
    view: controlPlaneRouteViewSchema,
  })
  .strict();

export const controlPlaneSessionCredentialsPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    git: z
      .object({
        token: z.string().min(1).max(4096),
        platform: z.enum(CONTROL_PLANE_GIT_PLATFORMS).optional(),
      })
      .strict()
      .optional(),
    kilo: z.object({ token: z.string().min(1).max(4096) }).strict(),
    // Spec §6: when the route runs behind the runtime credential proxy, the
    // Worker-facade handle and facade targets travel here, not in the route
    // spec. The wrapper prefers these over the spec's alias and targets.
    proxy: z
      .object({
        handle: z.string().min(1).max(4096),
        targets: controlPlaneKiloTargetsSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const controlPlaneHelloFrameSchema = z
  .object({
    type: z.literal('hello'),
    wrapperId: z.string().min(1).max(128),
    allocationId: z.string().min(1).max(128),
    protocolVersion: z.literal(CONTROL_PLANE_PROTOCOL_VERSION),
    heartbeatAck: z.literal(true).optional(),
  })
  .strict();

const controlPlaneWelcomeFrameSchema = z
  .object({
    type: z.literal('welcome'),
    protocolVersion: z.literal(CONTROL_PLANE_PROTOCOL_VERSION),
    heartbeatAck: z.literal(true).optional(),
  })
  .strict();

const controlPlaneShutdownFrameSchema = z
  .object({
    type: z.literal('shutdown'),
    reason: z.string().min(1).max(256).optional(),
  })
  .strict();

const controlPlaneHeartbeatFrameSchema = z
  .object({
    type: z.literal('heartbeat'),
    active: z.boolean(),
    degraded: z.boolean(),
  })
  .strict();

const controlPlaneSessionPrepareFrameSchema = z
  .object({
    type: z.literal('session.prepare'),
    spec: controlPlaneRouteSpecSchema,
    credentials: controlPlaneSessionCredentialsPayloadSchema.optional(),
  })
  .strict();

const controlPlaneSessionProgressFrameSchema = z
  .object({
    type: z.literal('session.progress'),
    sessionId: z.string().min(1),
    step: controlPlanePreparationStepSchema,
    detail: controlPlanePreparationDetailSchema.optional(),
  })
  .strict();

const controlPlaneSessionReadyFrameSchema = z
  .object({
    type: z.literal('session.ready'),
    sessionId: z.string().min(1),
    workspace: z.enum(CONTROL_PLANE_WORKSPACE_OUTCOMES).optional().catch(undefined),
  })
  .strict();

/**
 * Wrapper to Sandbox DO: the workspace is prepared and holds no credential, so the
 * DO may snapshot the container. `commit` is diagnostic only.
 */
const controlPlaneWorkspaceCaptureFrameSchema = z
  .object({
    type: z.literal('workspace.capture'),
    sessionId: z.string().min(1),
    commit: z.string().min(1).max(64).optional(),
  })
  .strict();

/** Sandbox DO to wrapper: the capture finished; `ok` is false when nothing was saved. */
const controlPlaneWorkspaceCapturedFrameSchema = z
  .object({
    type: z.literal('workspace.captured'),
    sessionId: z.string().min(1),
    ok: z.boolean(),
  })
  .strict();

const controlPlaneSessionFailedFrameSchema = z
  .object({
    type: z.literal('session.failed'),
    sessionId: z.string().min(1),
    reason: controlPlaneFailureReasonSchema,
    step: controlPlanePreparationStepSchema.optional(),
    subtype: controlPlaneWorkspaceFailureSubtypeSchema.optional().catch(undefined),
  })
  .strict();

const controlPlaneSessionCredentialsFrameSchema =
  controlPlaneSessionCredentialsPayloadSchema.extend({
    type: z.literal('session.credentials'),
  });

const controlPlaneSessionPromptFrameSchema = z
  .object({
    type: z.literal('session.prompt'),
    sessionId: z.string().min(1),
    payload: controlPlanePromptPayloadSchema,
  })
  .strict();

const controlPlaneSessionAbortFrameSchema = z
  .object({
    type: z.literal('session.abort'),
    sessionId: z.string().min(1),
  })
  .strict();

const controlPlaneSessionAnswerFrameSchema = z
  .object({
    type: z.literal('session.answer'),
    sessionId: z.string().min(1),
    reply: controlPlaneAnswerReplySchema,
  })
  .strict();

const controlPlaneSessionReleaseFrameSchema = z
  .object({
    type: z.literal('session.release'),
    sessionId: z.string().min(1),
  })
  .strict();

const controlPlaneSessionEventsFrameSchema = z
  .object({
    type: z.literal('session.events'),
    sessionId: z.string().min(1),
    events: z.array(controlPlaneEventSchema).min(1),
  })
  .strict();

const controlPlaneSessionOutcomeFrameSchema = controlPlaneOutcomeSchema.extend({
  type: z.literal('session.outcome'),
});

const controlPlaneEventsDroppedFrameSchema = z
  .object({
    type: z.literal('events_dropped'),
    dropped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * Shared result error for a control request (worktree changes). The wire shape
 * replaces the legacy `ResponseFrame.error`; a request carries a `requestId`
 * and the wrapper answers with one result frame (spec §10).
 */
export const controlPlaneRequestErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().max(4096),
    retryable: z.boolean(),
  })
  .strict();

/** Route identity a control request runs against (spec §3). */
export const controlPlaneControlSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    directory: z.string().min(1).max(1024),
  })
  .strict();

/**
 * The RPC result of a worktree-change request (spec §10): the wrapper's result
 * frame, surfaced by the Sandbox DO to the Session DO. It is a discriminated
 * union: an `ok` result always carries a `result` and a failure always carries
 * its error, so no caller invents a fallback error.
 */
export const controlPlaneControlResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: controlPlaneRequestErrorSchema }).strict(),
]);

/**
 * Bound on one Session DO -> Sandbox DO -> wrapper request round trip. Bounds
 * only the wrapper's reply, not provider work; not a spec timer.
 */
export const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;

/** Worktree-change request (snapshot = full files, summary = summary only). */
export const controlPlaneWorktreeCaptureInputSchema = z
  .object({
    operation: z.enum(['snapshot', 'summary']),
    session: controlPlaneControlSessionSchema,
    payload: sessionGitSummaryPayloadSchema,
  })
  .strict();

const controlPlaneWorktreeSnapshotFrameSchema = z
  .object({
    type: z.literal('worktree.snapshot'),
    requestId: z.string().min(1).max(128),
    session: controlPlaneControlSessionSchema,
    payload: sessionGitSummaryPayloadSchema,
  })
  .strict();

const controlPlaneWorktreeSummaryFrameSchema = z
  .object({
    type: z.literal('worktree.summary'),
    requestId: z.string().min(1).max(128),
    session: controlPlaneControlSessionSchema,
    payload: sessionGitSummaryPayloadSchema,
  })
  .strict();

const controlPlaneWorktreeResultFrameSchema = z.discriminatedUnion('ok', [
  z
    .object({
      type: z.literal('worktree.result'),
      requestId: z.string().min(1).max(128),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('worktree.result'),
      requestId: z.string().min(1).max(128),
      ok: z.literal(false),
      error: controlPlaneRequestErrorSchema,
    })
    .strict(),
]);

/**
 * Worktree-deletion payload (R2, spec §6 "Billing, credentials and deletion").
 * Same contract the legacy plane sends for `worktree.prepareDeletion` and
 * `worktree.delete` (`worktreeDeletePayloadSchema`), so the wrapper can reuse
 * `control/delete-worktree.ts` unchanged. Both requests answer with the shared
 * `worktree.result` frame.
 */
export const controlPlaneWorktreeDeletionPayloadSchema = z
  .object({
    worktreeId: z.templateLiteral(['worktree_', z.uuid()]),
    directory: z.string().min(1).max(1024),
    sessionIds: z.array(z.string().startsWith('ses_').length(30)),
  })
  .strict();

const controlPlaneWorktreePrepareDeletionFrameSchema = z
  .object({
    type: z.literal('worktree.prepareDeletion'),
    requestId: z.string().min(1).max(128),
    payload: controlPlaneWorktreeDeletionPayloadSchema,
  })
  .strict();

const controlPlaneWorktreeDeleteFrameSchema = z
  .object({
    type: z.literal('worktree.delete'),
    requestId: z.string().min(1).max(128),
    payload: controlPlaneWorktreeDeletionPayloadSchema,
  })
  .strict();

// --- terminals (B10) --------------------------------------------------------

/**
 * Session DO -> Sandbox DO terminal request (spec §10). The Sandbox DO forwards
 * exactly one request frame and returns the wrapper's `terminal.result`. The
 * payload/result shapes are the shared terminal data contracts; the wire is the
 * new request/result frame pair, replacing the legacy `ResponseFrame`.
 */
export const controlPlaneTerminalInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      session: controlPlaneControlSessionSchema,
      payload: sessionTerminalCreatePayloadSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('resize'),
      session: controlPlaneControlSessionSchema,
      payload: sessionTerminalResizePayloadSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('close'),
      session: controlPlaneControlSessionSchema,
      payload: sessionTerminalClosePayloadSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('connect'),
      session: controlPlaneControlSessionSchema,
      payload: sessionTerminalConnectPayloadSchema,
    })
    .strict(),
]);

const controlPlaneTerminalCreateFrameSchema = z
  .object({
    type: z.literal('terminal.create'),
    requestId: z.string().min(1).max(128),
    session: controlPlaneControlSessionSchema,
    payload: sessionTerminalCreatePayloadSchema,
  })
  .strict();

const controlPlaneTerminalResizeFrameSchema = z
  .object({
    type: z.literal('terminal.resize'),
    requestId: z.string().min(1).max(128),
    session: controlPlaneControlSessionSchema,
    payload: sessionTerminalResizePayloadSchema,
  })
  .strict();

const controlPlaneTerminalCloseFrameSchema = z
  .object({
    type: z.literal('terminal.close'),
    requestId: z.string().min(1).max(128),
    session: controlPlaneControlSessionSchema,
    payload: sessionTerminalClosePayloadSchema,
  })
  .strict();

const controlPlaneTerminalConnectFrameSchema = z
  .object({
    type: z.literal('terminal.connect'),
    requestId: z.string().min(1).max(128),
    session: controlPlaneControlSessionSchema,
    payload: sessionTerminalConnectPayloadSchema,
  })
  .strict();

const controlPlaneTerminalResultFrameSchema = z.discriminatedUnion('ok', [
  z
    .object({
      type: z.literal('terminal.result'),
      requestId: z.string().min(1).max(128),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('terminal.result'),
      requestId: z.string().min(1).max(128),
      ok: z.literal(false),
      error: controlPlaneRequestErrorSchema,
    })
    .strict(),
]);

export const controlPlaneWrapperFrameSchema = z.discriminatedUnion('type', [
  controlPlaneHelloFrameSchema,
  controlPlaneWelcomeFrameSchema,
  controlPlaneShutdownFrameSchema,
  controlPlaneHeartbeatFrameSchema,
  z.object({ type: z.literal('heartbeat_ack') }).strict(),
  controlPlaneSessionPrepareFrameSchema,
  controlPlaneSessionProgressFrameSchema,
  controlPlaneSessionReadyFrameSchema,
  controlPlaneWorkspaceCaptureFrameSchema,
  controlPlaneWorkspaceCapturedFrameSchema,
  controlPlaneSessionFailedFrameSchema,
  controlPlaneSessionCredentialsFrameSchema,
  controlPlaneSessionPromptFrameSchema,
  controlPlaneSessionAbortFrameSchema,
  controlPlaneSessionAnswerFrameSchema,
  controlPlaneSessionReleaseFrameSchema,
  controlPlaneSessionEventsFrameSchema,
  controlPlaneSessionOutcomeFrameSchema,
  controlPlaneEventsDroppedFrameSchema,
  controlPlaneWorktreeSnapshotFrameSchema,
  controlPlaneWorktreeSummaryFrameSchema,
  controlPlaneWorktreePrepareDeletionFrameSchema,
  controlPlaneWorktreeDeleteFrameSchema,
  controlPlaneWorktreeResultFrameSchema,
  controlPlaneTerminalCreateFrameSchema,
  controlPlaneTerminalResizeFrameSchema,
  controlPlaneTerminalCloseFrameSchema,
  controlPlaneTerminalConnectFrameSchema,
  controlPlaneTerminalResultFrameSchema,
]);

export type ControlPlaneRouteGit = z.infer<typeof controlPlaneRouteGitSchema>;
export type ControlPlaneRouteKilo = z.infer<typeof controlPlaneRouteKiloSchema>;
export type ControlPlaneRouteSpec = z.infer<typeof controlPlaneRouteSpecSchema>;
export type ControlPlanePromptTurn = z.infer<typeof controlPlanePromptTurnSchema>;
export type ControlPlanePromptPayload = z.infer<typeof controlPlanePromptPayloadSchema>;
export type ControlPlaneRouteView = z.infer<typeof controlPlaneRouteViewSchema>;
export type ControlPlaneRouteUpdate = z.infer<typeof controlPlaneRouteUpdateSchema>;
export type ControlPlaneEvent = z.infer<typeof controlPlaneEventSchema>;
export type ControlPlaneEventsNotification = z.infer<typeof controlPlaneEventsNotificationSchema>;
export type ControlPlaneOutcome = z.infer<typeof controlPlaneOutcomeSchema>;
export type ControlPlaneDeliverPayload = z.infer<typeof controlPlaneDeliverPayloadSchema>;
export type ControlPlaneDeliverResult = z.infer<typeof controlPlaneDeliverResultSchema>;
export type ControlPlaneSessionRefPayload = z.infer<typeof controlPlaneSessionRefPayloadSchema>;
export type ControlPlaneAnswerReply = z.infer<typeof controlPlaneAnswerReplySchema>;
export type ControlPlaneAnswerPayload = z.infer<typeof controlPlaneAnswerPayloadSchema>;
export type ControlPlaneDispatchResult = z.infer<typeof controlPlaneDispatchResultSchema>;
export type ControlPlaneStatusResult = z.infer<typeof controlPlaneStatusResultSchema>;
export type ControlPlaneSessionCredentialsPayload = z.infer<
  typeof controlPlaneSessionCredentialsPayloadSchema
>;
export type ControlPlaneHelloFrame = z.infer<typeof controlPlaneHelloFrameSchema>;
export type ControlPlaneWelcomeFrame = z.infer<typeof controlPlaneWelcomeFrameSchema>;
export type ControlPlaneShutdownFrame = z.infer<typeof controlPlaneShutdownFrameSchema>;
export type ControlPlaneHeartbeatFrame = z.infer<typeof controlPlaneHeartbeatFrameSchema>;
export type ControlPlaneSessionPrepareFrame = z.infer<typeof controlPlaneSessionPrepareFrameSchema>;
export type ControlPlaneSessionProgressFrame = z.infer<
  typeof controlPlaneSessionProgressFrameSchema
>;
export type ControlPlaneSessionReadyFrame = z.infer<typeof controlPlaneSessionReadyFrameSchema>;
export type ControlPlaneWorkspaceCaptureFrame = z.infer<
  typeof controlPlaneWorkspaceCaptureFrameSchema
>;
export type ControlPlaneWorkspaceCapturedFrame = z.infer<
  typeof controlPlaneWorkspaceCapturedFrameSchema
>;
export type ControlPlaneSessionFailedFrame = z.infer<typeof controlPlaneSessionFailedFrameSchema>;
export type ControlPlaneSessionCredentialsFrame = z.infer<
  typeof controlPlaneSessionCredentialsFrameSchema
>;
export type ControlPlaneSessionPromptFrame = z.infer<typeof controlPlaneSessionPromptFrameSchema>;
export type ControlPlaneSessionAbortFrame = z.infer<typeof controlPlaneSessionAbortFrameSchema>;
export type ControlPlaneSessionAnswerFrame = z.infer<typeof controlPlaneSessionAnswerFrameSchema>;
export type ControlPlaneSessionReleaseFrame = z.infer<typeof controlPlaneSessionReleaseFrameSchema>;
export type ControlPlaneSessionEventsFrame = z.infer<typeof controlPlaneSessionEventsFrameSchema>;
export type ControlPlaneSessionOutcomeFrame = z.infer<typeof controlPlaneSessionOutcomeFrameSchema>;
export type ControlPlaneEventsDroppedFrame = z.infer<typeof controlPlaneEventsDroppedFrameSchema>;
export type ControlPlaneRequestError = z.infer<typeof controlPlaneRequestErrorSchema>;
export type ControlPlaneControlSession = z.infer<typeof controlPlaneControlSessionSchema>;
export type ControlPlaneControlResult = z.infer<typeof controlPlaneControlResultSchema>;
export type ControlPlaneWorktreeCaptureInput = z.infer<
  typeof controlPlaneWorktreeCaptureInputSchema
>;
export type ControlPlaneWorktreeSnapshotFrame = z.infer<
  typeof controlPlaneWorktreeSnapshotFrameSchema
>;
export type ControlPlaneWorktreeSummaryFrame = z.infer<
  typeof controlPlaneWorktreeSummaryFrameSchema
>;
export type ControlPlaneWorktreeResultFrame = z.infer<typeof controlPlaneWorktreeResultFrameSchema>;
export type ControlPlaneWorktreeDeletionPayload = z.infer<
  typeof controlPlaneWorktreeDeletionPayloadSchema
>;
export type ControlPlaneWorktreePrepareDeletionFrame = z.infer<
  typeof controlPlaneWorktreePrepareDeletionFrameSchema
>;
export type ControlPlaneWorktreeDeleteFrame = z.infer<typeof controlPlaneWorktreeDeleteFrameSchema>;
export type ControlPlaneWorktreeDeletionRequestFrame =
  | ControlPlaneWorktreePrepareDeletionFrame
  | ControlPlaneWorktreeDeleteFrame;
export type ControlPlaneWorktreeRequestFrame =
  | ControlPlaneWorktreeSnapshotFrame
  | ControlPlaneWorktreeSummaryFrame;
export type ControlPlaneTerminalInput = z.infer<typeof controlPlaneTerminalInputSchema>;
export type ControlPlaneTerminalCreateFrame = z.infer<typeof controlPlaneTerminalCreateFrameSchema>;
export type ControlPlaneTerminalResizeFrame = z.infer<typeof controlPlaneTerminalResizeFrameSchema>;
export type ControlPlaneTerminalCloseFrame = z.infer<typeof controlPlaneTerminalCloseFrameSchema>;
export type ControlPlaneTerminalConnectFrame = z.infer<
  typeof controlPlaneTerminalConnectFrameSchema
>;
export type ControlPlaneTerminalResultFrame = z.infer<typeof controlPlaneTerminalResultFrameSchema>;
export type ControlPlaneTerminalRequestFrame =
  | ControlPlaneTerminalCreateFrame
  | ControlPlaneTerminalResizeFrame
  | ControlPlaneTerminalCloseFrame
  | ControlPlaneTerminalConnectFrame;
export type ControlPlaneWrapperFrame = z.infer<typeof controlPlaneWrapperFrameSchema>;
