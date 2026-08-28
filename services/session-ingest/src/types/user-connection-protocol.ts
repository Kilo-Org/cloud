import { z } from 'zod';

// Use z.string() for session IDs (not the strict sessionIdSchema from ws-protocol)
// because the CLI's remote-protocol.ts uses z.string() — the strict ses_ format
// is enforced by the per-session SessionIngestDO path, not the UserConnectionDO path.

// -- CLI → DO (CLIOutbound) ---------------------------------------------------

// Identity of the CLI process (kilo remote spawner) attached to this WebSocket.
// Newer CLIs include this on every heartbeat; legacy CLIs that predate the
// `kilo remote` spawner omit it entirely. The DO persists the latest value
// in the WebSocket attachment and uses it for `getConnectedInstances()`.
const instanceSchema = z.object({
  name: z.string().min(1).max(64),
  projectName: z.string().min(1).max(64),
  version: z.string().max(32).optional(),
});

export type Instance = z.infer<typeof instanceSchema>;

export const CLIOutboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heartbeat'),
    // Absent on CLI builds older than the protocolVersion field itself — treat
    // a missing value as a legacy CLI with no negotiated wire protocol.
    protocolVersion: z.string().optional(),
    // Per-connection capabilities advertised by the CLI. Absent on CLIs that
    // predate the field — treated as a legacy CLI with no opt-in features
    // (e.g. attachment uploads from the mobile viewer).
    capabilities: z
      .object({
        attachments: z.boolean().optional(),
        // Old form is absent sessionClone; treat missing as incapable until
        // every shipped CLI advertises it.
        sessionClone: z.boolean().optional(),
        // Old heartbeats omit browserJobsV1: normalize to unsupported until all old clients retire.
        browserJobsV1: z.boolean().optional(),
      })
      .optional(),
    // Optional identity of the spawning CLI process. Absent on legacy CLIs
    // (which are not spawned by `kilo remote`). When present, the DO
    // persists it in the WebSocket attachment and exposes it via
    // `getConnectedInstances()`.
    instance: instanceSchema.optional(),
    sessions: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        title: z.string(),
        gitUrl: z.string().optional(),
        gitBranch: z.string().optional(),
        parentSessionId: z.string().optional(),
        // Platform the session is running on (e.g. "darwin", "linux", "vscode").
        // Optional for backward compatibility with legacy CLIs.
        platform: z.string().max(32).optional(),
        // Pull-request link reported by the CLI. Distinct from `platform`
        // above, which is the client OS and stays unchanged. Absent on legacy
        // CLIs that predate this field.
        prLink: z
          .object({
            platform: z.string().min(1).max(32),
            prUrl: z.string().max(2048),
            prNumber: z.number().int().positive(),
          })
          .optional(),
      })
    ),
  }),
  z.object({
    type: z.literal('event'),
    sessionId: z.string(),
    parentSessionId: z.string().optional(),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
]);

// -- DO → CLI (CLIInbound) ----------------------------------------------------

export const CLIInboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('command'),
    id: z.string(),
    command: z.string(),
    sessionId: z.string().optional(),
    data: z.unknown().optional(),
    // Stable intent id forwarded from the web wire. The CLI does not
    // interpret it; it is echoed back on the response for the DO's
    // durable dedupe to match against the stored entry. Absent when the
    // web client did not supply one.
    // Bounded at 128 chars to keep storage keys safe.
    mutationId: z.string().max(128).optional(),
  }),
  z.object({
    type: z.literal('system'),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('heartbeat_ack'),
    // Old acknowledgements omit capabilities: normalize to unsupported until all old relays retire.
    capabilities: z.object({ browserJobsV1: z.boolean().optional() }).optional(),
  }),
]);

// -- Web UI → DO (WebOutbound) ------------------------------------------------

export const WebOutboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('command'),
    id: z.string(),
    sessionId: z.string().optional(),
    connectionId: z.string().optional(),
    command: z.string(),
    data: z.unknown().optional(),
    // Stable client-side intent id. When present, the DO uses it as the
    // correlation id so a retry with the same mutationId runs the command
    // once for the full TTL window (D8 dedupe). Absent on older clients;
    // the DO falls back to crypto.randomUUID() per D5.
    // Bounded at 128 chars to keep storage keys safe.
    mutationId: z.string().max(128).optional(),
  }),
  z.object({
    type: z.literal('ping'),
    nonce: z.string(),
    // Old web peers omit capabilities: normalize to unsupported until all old peers retire.
    capabilities: z.object({ browserJobsV1: z.boolean().optional() }).optional(),
  }),
]);

// -- V2 session system events -------------------------------------------------

export const SessionStatusSchema = z.enum(['idle', 'busy', 'question', 'permission', 'retry']);

export const SessionEventV2RowSchema = z.object({
  source: z.literal('v2'),
  sessionId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string().nullable(),
  createdOnPlatform: z.string().nullable(),
  organizationId: z.string().nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  status: SessionStatusSchema.nullable(),
  statusUpdatedAt: z.string().nullable(),
});

export const SessionRowEventPayloadSchema = z.object({
  source: z.literal('v2'),
  session: SessionEventV2RowSchema,
  changedAt: z.string(),
});

// Temporary rollout compatibility: remove the lightweight branch after all web clients consume full session rows.
export const SessionStatusUpdatedPayloadSchema = z.union([
  z.object({
    source: z.literal('v2'),
    session: SessionEventV2RowSchema,
    previousStatus: SessionStatusSchema.nullable(),
    status: SessionStatusSchema.nullable(),
    statusUpdatedAt: z.string().nullable(),
    changedAt: z.string(),
  }),
  z.object({
    source: z.literal('v2'),
    sessionId: z.string(),
    previousStatus: SessionStatusSchema.nullable(),
    status: SessionStatusSchema.nullable(),
    statusUpdatedAt: z.string().nullable(),
    updatedAt: z.string().optional(),
    changedAt: z.string(),
  }),
]);

export const SessionDeletedPayloadSchema = z.object({
  source: z.literal('v2'),
  sessionId: z.string(),
  parentSessionId: z.string().nullable(),
  organizationId: z.string().nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  createdOnPlatform: z.string().nullable(),
  deletedAt: z.string(),
});

export const SessionEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.created'), data: SessionRowEventPayloadSchema }),
  z.object({ type: z.literal('session.updated'), data: SessionRowEventPayloadSchema }),
  z.object({ type: z.literal('session.status.updated'), data: SessionStatusUpdatedPayloadSchema }),
  z.object({ type: z.literal('session.deleted'), data: SessionDeletedPayloadSchema }),
]);

// -- DO → Web UI (WebInbound) -------------------------------------------------

export const WebInboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    sessionId: z.string(),
    parentSessionId: z.string().optional(),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('system'),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('pong'),
    nonce: z.string(),
    // Old web peers omit capabilities: normalize to unsupported until all old peers retire.
    capabilities: z.object({ browserJobsV1: z.boolean().optional() }).optional(),
  }),
]);

// -- Inferred types -----------------------------------------------------------

export type CLIOutboundMessage = z.infer<typeof CLIOutboundMessageSchema>;
export type CLIInboundMessage = z.infer<typeof CLIInboundMessageSchema>;
export type WebOutboundMessage = z.infer<typeof WebOutboundMessageSchema>;
export type WebInboundMessage = z.infer<typeof WebInboundMessageSchema>;
export type SessionEventV2Row = z.infer<typeof SessionEventV2RowSchema>;
export type SessionRowEventPayload = z.infer<typeof SessionRowEventPayloadSchema>;
export type SessionStatusUpdatedPayload = z.infer<typeof SessionStatusUpdatedPayloadSchema>;
export type SessionDeletedPayload = z.infer<typeof SessionDeletedPayloadSchema>;
export type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;

// -- Negotiated browser jobs v1 -----------------------------------------------
// Keep this contract aligned with packages/cloud-agent-sdk/src/schemas.ts and
// the CLI remote-protocol.ts copy. Legacy parsers above intentionally stay narrow.

export const BROWSER_GOAL_MAX_BYTES = 16 * 1024;
export const BROWSER_RESULT_MAX_BYTES = 64 * 1024;
export const BROWSER_FRAME_MAX_BYTES = 128 * 1024;
export const BROWSER_PAGE_SIZE = 25;

export const browserCapabilitiesSchema = z.object({ browserJobsV1: z.boolean().optional() });
export const normalizedBrowserCapabilitiesSchema = browserCapabilitiesSchema
  .optional()
  // Old peers omit capabilities or browserJobsV1. Keep this fallback until all old peers retire.
  .transform(capabilities => ({ browserJobsV1: capabilities?.browserJobsV1 ?? false }));
export type BrowserCapabilities = z.infer<typeof normalizedBrowserCapabilitiesSchema>;

function browserText(maxBytes: number) {
  return z
    .string()
    .max(maxBytes)
    .refine(value => new TextEncoder().encode(value).byteLength <= maxBytes, {
      message: 'Text exceeds the UTF-8 byte limit',
    });
}

// Do not propagate Zod issues from proof-bearing inputs: even unknown key names
// can contain secrets. Consumers must not enable Zod's reportInput option.
function browserBoundary<T extends z.ZodType>(schema: T) {
  return z.unknown().transform((input, context): z.output<T> => {
    const parsed = schema.safeParse(input);
    if (
      parsed.success &&
      new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength < BROWSER_FRAME_MAX_BYTES
    ) {
      return parsed.data;
    }
    context.addIssue({ code: 'custom', message: 'Invalid browser message' });
    return z.NEVER;
  });
}

export const browserProviderIdSchema = z.templateLiteral(['bp_', z.uuid()]);
export const browserTaskIdSchema = z.templateLiteral(['bt_', z.uuid()]);
export const browserJobIdSchema = z.templateLiteral(['bj_', z.uuid()]);
export const browserInvocationIdSchema = z
  .string()
  .regex(/^b1\.[1-9][0-9]{0,15}\.[a-f0-9]{64}$/)
  .refine(
    value => {
      const createdAt = Number(value.split('.')[1]);
      return Number.isSafeInteger(createdAt) && createdAt <= 8_640_000_000_000_000;
    },
    { message: 'Invalid invocation timestamp' }
  );
const browserRequestIdSchema = z.uuid();
const browserTimestampSchema = z.iso.datetime({ precision: 3 });
const browserFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const browserProofSchema = z.string().regex(/^[a-f0-9]{64}$/);
const browserGoalSchema = browserText(BROWSER_GOAL_MAX_BYTES).min(1);
const browserGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const browserTabIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const browserOwnerSchema = z.strictObject({
  parentSessionId: browserText(128).regex(/^ses_[A-Za-z0-9_-]+$/),
  parentProof: browserProofSchema,
});

export const browserJobStatusSchema = z.enum([
  'queued',
  'awaiting_approval',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'timed_out',
]);
export const browserTerminalStatusSchema = browserJobStatusSchema.exclude([
  'queued',
  'awaiting_approval',
  'running',
]);
export const browserFailureReasonSchema = z.enum([
  'approval_denied',
  'permission_denied',
  'invocation_expired',
  'invocation_conflict',
  'conversation_busy',
  'capacity_exceeded',
  'tab_lost',
  'provider_lost',
  'provider_unavailable',
  'queue_timeout',
  'approval_timeout',
  'execution_timeout',
  'lease_expired',
  'effects_uncertain',
  'cancelled',
  'runner_failed',
  'unsupported',
  'invalid_request',
  'owner_mismatch',
  'not_found',
]);
export const browserReasonCodeSchema = z.enum(['completed', ...browserFailureReasonSchema.options]);

const browserHandleShape = {
  providerId: browserProviderIdSchema,
  browserTaskId: browserTaskIdSchema,
  jobId: browserJobIdSchema,
  invocationId: browserInvocationIdSchema,
};
export const browserJobHandleSchema = z.strictObject(browserHandleShape);
export type BrowserJobHandle = z.infer<typeof browserJobHandleSchema>;
const browserBindingShape = {
  providerId: browserProviderIdSchema,
  generation: browserGenerationSchema,
};
const browserJobBindingShape = { ...browserHandleShape, generation: browserGenerationSchema };

export const browserApprovedTabSchema = z.strictObject({
  tabId: browserTabIdSchema,
  title: browserText(1024),
  url: browserText(8192).url(),
  effectiveMode: z.enum(['safe', 'dangerous']),
});
export const browserDeadlinesSchema = z.strictObject({
  queue: browserTimestampSchema,
  approval: browserTimestampSchema.optional(),
  execution: browserTimestampSchema.optional(),
  lease: browserTimestampSchema.optional(),
});
const browserJobMetadataShape = {
  ...browserJobBindingShape,
  payloadFingerprint: browserFingerprintSchema,
  createdAt: browserTimestampSchema,
  expiresAt: browserTimestampSchema,
  deadlines: browserDeadlinesSchema,
};
const browserEvidenceSchema = z
  .strictObject({
    text: browserText(8192).min(1).optional(),
    title: browserText(1024).min(1).optional(),
    url: browserText(8192).url().optional(),
  })
  .refine(evidence => Object.keys(evidence).length > 0, {
    message: 'Evidence must contain an observation',
  });
const browserResultShape = {
  ...browserHandleShape,
  summary: browserText(32 * 1024).min(1),
  evidence: z.array(browserEvidenceSchema).max(32),
};
export const browserResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...browserResultShape,
      status: z.literal('succeeded'),
      reason: z.literal('completed'),
      effectsUncertain: z.literal(false),
    }),
    z.strictObject({
      ...browserResultShape,
      status: browserTerminalStatusSchema.exclude(['succeeded']),
      reason: browserFailureReasonSchema,
      effectsUncertain: z.boolean(),
    }),
  ])
  .refine(
    result =>
      new TextEncoder().encode(JSON.stringify(result)).byteLength <= BROWSER_RESULT_MAX_BYTES,
    {
      message: 'Result exceeds the serialized UTF-8 byte limit',
    }
  );
export type BrowserResult = z.infer<typeof browserResultSchema>;

function sameBrowserJob(left: BrowserJobHandle, right: BrowserJobHandle) {
  return (
    left.providerId === right.providerId &&
    left.browserTaskId === right.browserTaskId &&
    left.jobId === right.jobId &&
    left.invocationId === right.invocationId
  );
}

export const browserJobSnapshotSchema = z
  .strictObject({
    ...browserJobMetadataShape,
    status: browserJobStatusSchema,
    approvedTab: browserApprovedTabSchema.optional(),
    result: browserResultSchema.optional(),
  })
  .superRefine((job, context) => {
    const terminal = browserTerminalStatusSchema.safeParse(job.status).success;
    if (
      terminal !== (job.result !== undefined) ||
      (job.result && (job.status !== job.result.status || !sameBrowserJob(job, job.result)))
    ) {
      context.addIssue({ code: 'custom', message: 'Result must match the terminal job' });
    }
    if (
      (job.status === 'running' && !job.approvedTab) ||
      ((job.status === 'queued' || job.status === 'awaiting_approval') && job.approvedTab)
    ) {
      context.addIssue({ code: 'custom', message: 'Tab approval must match the job phase' });
    }
    const createdAt = Date.parse(job.createdAt);
    const expiresAt = Date.parse(job.expiresAt);
    if (
      createdAt > expiresAt ||
      Object.values(job.deadlines).some(
        deadline =>
          deadline !== undefined &&
          (Date.parse(deadline) < createdAt || Date.parse(deadline) > expiresAt)
      )
    ) {
      context.addIssue({ code: 'custom', message: 'Deadlines must stay within job retention' });
    }
  });
export type BrowserJobSnapshot = z.infer<typeof browserJobSnapshotSchema>;

// Model arguments never select parent, invocation, proof, user, or socket authority.
export const browserTaskArgumentsSchema = browserBoundary(
  z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('list') }),
    z.strictObject({
      operation: z.literal('run'),
      provider_id: browserProviderIdSchema,
      goal: browserGoalSchema,
      browser_task_id: browserTaskIdSchema.optional(),
    }),
    z.strictObject({
      operation: z.literal('status'),
      browser_task_id: browserTaskIdSchema,
      job_id: browserJobIdSchema.optional(),
    }),
    z.strictObject({
      operation: z.literal('cancel'),
      browser_task_id: browserTaskIdSchema,
      job_id: browserJobIdSchema.optional(),
    }),
    z.strictObject({ operation: z.literal('recover') }),
  ])
);
export type BrowserTaskArguments = z.infer<typeof browserTaskArgumentsSchema>;

const browserRequestShape = {
  type: z.literal('browser_request'),
  requestId: browserRequestIdSchema,
};
// An absent jobId selects only this conversation's latest job, after owner verification.
const browserOwnedLookupShape = {
  owner: browserOwnerSchema,
  browserTaskId: browserTaskIdSchema,
  jobId: browserJobIdSchema.optional(),
};
// Only authenticated, negotiated CLI sockets can submit these requests. Recover
// looks up a persisted invocation; it cannot carry a new goal or choose a provider.
export const browserRequestSchema = browserBoundary(
  z.discriminatedUnion('operation', [
    z.strictObject({
      ...browserRequestShape,
      operation: z.literal('list'),
      cursor: browserProviderIdSchema.optional(),
    }),
    z.strictObject({
      ...browserRequestShape,
      operation: z.literal('invoke'),
      owner: browserOwnerSchema,
      providerId: browserProviderIdSchema,
      browserTaskId: browserTaskIdSchema.optional(),
      invocationId: browserInvocationIdSchema,
      goal: browserGoalSchema,
    }),
    z.strictObject({
      ...browserRequestShape,
      operation: z.literal('status'),
      ...browserOwnedLookupShape,
    }),
    z.strictObject({
      ...browserRequestShape,
      operation: z.literal('cancel'),
      ...browserOwnedLookupShape,
    }),
    z.strictObject({
      ...browserRequestShape,
      operation: z.literal('recover'),
      owner: browserOwnerSchema,
      invocationId: browserInvocationIdSchema,
    }),
  ])
);
export type BrowserRequest = z.infer<typeof browserRequestSchema>;

export const browserProviderDescriptorSchema = z.strictObject({
  providerId: browserProviderIdSchema,
  label: browserText(128).min(1),
  availability: z.enum(['available', 'busy', 'unavailable']),
  queueDepth: z.number().int().min(0).max(100),
});
export const browserResponseSchema = browserBoundary(
  z.strictObject({
    type: z.literal('browser_response'),
    requestId: browserRequestIdSchema,
    response: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('providers'),
        providers: z.array(browserProviderDescriptorSchema).max(BROWSER_PAGE_SIZE),
        nextCursor: browserProviderIdSchema.optional(),
      }),
      // An acknowledgement is not progress or a terminal result, including cancel.
      z.strictObject({
        kind: z.literal('ack'),
        operation: z.enum(['invoke', 'cancel']),
        ...browserHandleShape,
      }),
      z.strictObject({ kind: z.literal('status'), job: browserJobSnapshotSchema }),
      z.strictObject({ kind: z.literal('recovered'), job: browserJobSnapshotSchema }),
      z.strictObject({ kind: z.literal('not_found'), invocationId: browserInvocationIdSchema }),
      z.strictObject({
        kind: z.literal('error'),
        code: browserFailureReasonSchema,
        message: browserText(1024).min(1),
        retryable: z.boolean(),
      }),
    ]),
  })
);
export type BrowserResponse = z.infer<typeof browserResponseSchema>;
export const browserEventSchema = browserBoundary(
  z.discriminatedUnion('event', [
    z.strictObject({
      type: z.literal('browser_event'),
      requestId: browserRequestIdSchema,
      event: z.literal('progress'),
      job: browserJobSnapshotSchema.refine(
        job => !browserTerminalStatusSchema.safeParse(job.status).success,
        {
          message: 'Progress cannot contain a terminal result',
        }
      ),
    }),
    z.strictObject({
      type: z.literal('browser_event'),
      requestId: browserRequestIdSchema,
      event: z.literal('result'),
      result: browserResultSchema,
    }),
  ])
);
export type BrowserEvent = z.infer<typeof browserEventSchema>;
export const browserCLIInboundMessageSchema = z.union([browserResponseSchema, browserEventSchema]);

// The registration proof stays on the authenticated provider-to-relay boundary.
// Generation zero means first registration; other values name the last grant.
// The relay allocates the next generation and binds it to the actual socket.
export const browserProviderOutboundMessageSchema = browserBoundary(
  z
    .discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('provider_register'),
        requestId: browserRequestIdSchema,
        providerId: browserProviderIdSchema,
        generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        providerProof: browserProofSchema,
        label: browserText(128).min(1),
        enabled: z.literal(true),
        recovery: z
          .strictObject({
            invocationId: browserInvocationIdSchema,
            tabId: browserTabIdSchema,
            tabClosed: z.literal(true),
            locksDrained: z.literal(true),
          })
          .optional(),
      }),
      // Read-only history requires proof, not registration or a generation grant.
      z.strictObject({
        type: z.literal('provider_status'),
        requestId: browserRequestIdSchema,
        providerId: browserProviderIdSchema,
        providerProof: browserProofSchema,
        cursor: browserJobIdSchema.optional(),
      }),
      z.strictObject({
        type: z.literal('provider_heartbeat'),
        requestId: browserRequestIdSchema,
        ...browserBindingShape,
        cursor: browserJobIdSchema.optional(),
      }),
      z.strictObject({
        type: z.literal('provider_approval'),
        ...browserJobBindingShape,
        approval: z.discriminatedUnion('decision', [
          z.strictObject({ decision: z.literal('approved'), tab: browserApprovedTabSchema }),
          z.strictObject({ decision: z.literal('denied'), reason: z.literal('approval_denied') }),
        ]),
      }),
      z.strictObject({
        type: z.literal('provider_result'),
        ...browserJobBindingShape,
        tab: browserApprovedTabSchema,
        result: browserResultSchema,
      }),
      z.strictObject({
        type: z.literal('provider_quiesced'),
        ...browserJobBindingShape,
        tabId: browserTabIdSchema,
      }),
      z.strictObject({
        type: z.literal('provider_unavailable'),
        ...browserBindingShape,
        reason: browserFailureReasonSchema,
        effectsUncertain: z.boolean(),
      }),
      // Provider Stop targets this profile's exact job, not a client-selected parent.
      z.strictObject({ type: z.literal('provider_cancel'), ...browserJobBindingShape }),
    ])
    .refine(
      message => message.type !== 'provider_result' || sameBrowserJob(message, message.result),
      {
        message: 'Provider result must match the job',
      }
    )
);
export type BrowserProviderOutboundMessage = z.infer<typeof browserProviderOutboundMessageSchema>;

// Provider frames never target ordinary web subscribers. Execution frames require
// a registered socket; status results require a proof-authorized request.
// A snapshot is reconciliation data, not permission to execute.
export const browserProviderInboundMessageSchema = browserBoundary(
  z
    .discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('provider_job'),
        job: browserJobSnapshotSchema.refine(job => job.status === 'awaiting_approval', {
          message: 'Dispatch requires tab approval',
        }),
        goal: browserGoalSchema,
        ownerLabel: browserText(128).min(1),
      }),
      z.strictObject({
        type: z.literal('provider_job_cancel'),
        ...browserJobBindingShape,
        reason: browserFailureReasonSchema,
      }),
      z.strictObject({
        type: z.literal('provider_snapshot'),
        ...browserBindingShape,
        requestId: browserRequestIdSchema.optional(),
        jobs: z.array(browserJobSnapshotSchema).max(BROWSER_PAGE_SIZE),
        nextCursor: browserJobIdSchema.optional(),
      }),
      // History grants no execution, lease, approval, or recovery authority.
      z
        .strictObject({
          type: z.literal('provider_status_result'),
          requestId: browserRequestIdSchema,
          providerId: browserProviderIdSchema,
          jobs: z.array(browserJobSnapshotSchema).max(BROWSER_PAGE_SIZE),
          nextCursor: browserJobIdSchema.optional(),
        })
        .refine(message => message.jobs.every(job => job.providerId === message.providerId), {
          message: 'History must match the requested provider',
        }),
      z.strictObject({
        type: z.literal('provider_lease_ack'),
        ...browserBindingShape,
        requestId: browserRequestIdSchema,
        leaseExpiresAt: browserTimestampSchema,
      }),
    ])
    .refine(
      message =>
        message.type !== 'provider_snapshot' ||
        message.jobs.every(
          job => job.providerId === message.providerId && job.generation === message.generation
        ),
      {
        message: 'Snapshot must match the registered provider',
      }
    )
);
export type BrowserProviderInboundMessage = z.infer<typeof browserProviderInboundMessageSchema>;

// Opt-in consumers adopt these separately; the legacy parser exports never widen.
export const cliOutboundWithBrowserMessageSchema = z.union([
  CLIOutboundMessageSchema,
  browserRequestSchema,
]);
export const cliInboundWithBrowserMessageSchema = z.union([
  CLIInboundMessageSchema,
  browserCLIInboundMessageSchema,
]);
export const webOutboundWithBrowserMessageSchema = z.union([
  WebOutboundMessageSchema,
  browserProviderOutboundMessageSchema,
]);
export const webInboundWithBrowserMessageSchema = z.union([
  WebInboundMessageSchema,
  browserProviderInboundMessageSchema,
]);
export type CLIOutboundWithBrowserMessage = z.infer<typeof cliOutboundWithBrowserMessageSchema>;
export type CLIInboundWithBrowserMessage = z.infer<typeof cliInboundWithBrowserMessageSchema>;
export type WebOutboundWithBrowserMessage = z.infer<typeof webOutboundWithBrowserMessageSchema>;
export type WebInboundWithBrowserMessage = z.infer<typeof webInboundWithBrowserMessageSchema>;
