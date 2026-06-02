import { z, type ZodType } from 'zod';
import {
  DELIVERY_CHANNELS,
  DELIVERY_REASONS,
  DELIVERY_STATUSES,
} from '../../plugins/kiloclaw-morning-briefing/src/delivery-constants';

export type GatewayProcessStatus = {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'shutting_down';
  pid: number | null;
  uptime: number;
  restarts: number;
  lastExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  } | null;
};

export const GatewayProcessStatusSchema: ZodType<GatewayProcessStatus> = z.object({
  state: z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed', 'shutting_down']),
  pid: z.number().int().nullable(),
  uptime: z.number(),
  restarts: z.number().int(),
  lastExit: z
    .object({
      code: z.number().int().nullable(),
      signal: z
        .custom<NodeJS.Signals>((value): value is NodeJS.Signals => typeof value === 'string')
        .nullable(),
      at: z.string(),
    })
    .nullable(),
});

export const GatewayCommandResponseSchema = z.object({
  ok: z.boolean(),
});

export const BotIdentityResponseSchema = z.object({
  ok: z.boolean(),
  path: z.string(),
});

export const UserProfileResponseSchema = z.object({
  ok: z.boolean(),
  path: z.string(),
});

export const ConfigRestoreResponseSchema = z.object({
  ok: z.boolean(),
  signaled: z.boolean(),
});

export const ControllerVersionResponseSchema = z.object({
  version: z.string(),
  commit: z.string(),
  // optional() for backward compat with older controllers that don't include these fields
  openclawVersion: z.string().nullable().optional(),
  openclawCommit: z.string().nullable().optional(),
  apiVersion: z.number().int().positive().optional(),
  capabilities: z
    .array(z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)*$/))
    .refine(
      capabilities =>
        capabilities.every((capability, index) => {
          if (index === 0) return true;
          return capabilities[index - 1] < capability;
        }),
      { message: 'Capabilities must be sorted and unique' }
    )
    .optional(),
});

export type ControllerHealthResponse = {
  status: 'ok';
  state: 'bootstrapping' | 'starting' | 'ready' | 'degraded';
  phase?: string;
  error?: string;
};

export const ControllerHealthResponseSchema: ZodType<ControllerHealthResponse> = z.object({
  status: z.literal('ok'),
  state: z.enum(['bootstrapping', 'starting', 'ready', 'degraded']),
  phase: z.string().optional(),
  error: z.string().optional(),
});

export const GatewayReadyResponseSchema = z.record(z.string(), z.unknown());

export const EnvPatchResponseSchema = z.object({
  ok: z.boolean(),
  signaled: z.boolean(),
});

export const ToolsMdSectionSyncResponseSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean(),
});

export const OpenclawWorkspaceImportFailureSchema = z.object({
  path: z.string(),
  operation: z.enum(['write', 'delete']),
  error: z.string(),
  code: z.string().optional(),
});

export const OpenclawWorkspaceImportResponseSchema = z.object({
  ok: z.boolean(),
  attemptedWriteCount: z.number().int().min(0),
  writtenCount: z.number().int().min(0),
  attemptedDeleteCount: z.number().int().min(0),
  deletedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  totalUtf8Bytes: z.number().int().min(0),
  failures: z.array(OpenclawWorkspaceImportFailureSchema),
});

const MorningBriefingSourceReadinessSchema = z.object({
  configured: z.boolean(),
  summary: z.string(),
});

const MorningBriefingDeliverySchema = z.object({
  channel: z.enum(DELIVERY_CHANNELS),
  status: z.enum(DELIVERY_STATUSES),
  target: z.string().optional(),
  accountId: z.string().optional(),
  reason: z.enum(DELIVERY_REASONS).optional(),
  error: z.string().optional(),
});

export const MorningBriefingStatusResponseSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  cronJobId: z.string().nullable().optional(),
  lastGeneratedDate: z.string().nullable().optional(),
  lastGeneratedAt: z.string().nullable().optional(),
  reconcileState: z.enum(['idle', 'in_progress', 'succeeded', 'failed']).optional(),
  lastReconcileAction: z.enum(['enable', 'disable']).nullable().optional(),
  desiredEnabled: z.boolean().optional(),
  observedEnabled: z.boolean().nullable().optional(),
  lastReconcileAt: z.string().nullable().optional(),
  lastReconcileError: z.string().nullable().optional(),
  sourceReadiness: z
    .object({
      github: MorningBriefingSourceReadinessSchema,
      linear: MorningBriefingSourceReadinessSchema,
      web: MorningBriefingSourceReadinessSchema,
    })
    .optional(),
  lastDelivery: z.array(MorningBriefingDeliverySchema).optional(),
  // Selected morning-briefing interest topics, sourced from the
  // `kiloclaw_morning_briefing_configs` Postgres row. Optional so callers
  // talking to an instance that pre-dates the table (or a Postgres-down
  // response) still parse; default to `[]` at the consumer.
  interestTopics: z.array(z.string()).optional(),
  code: z.string().optional(),
  retryAfterSec: z.number().int().positive().optional(),
  error: z.string().optional(),
});

export const MorningBriefingActionResponseSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  cronJobId: z.string().nullable().optional(),
  date: z.string().optional(),
  filePath: z.string().optional(),
  failures: z.array(z.string()).optional(),
  delivery: z.array(MorningBriefingDeliverySchema).optional(),
  code: z.string().optional(),
  retryAfterSec: z.number().int().positive().optional(),
  error: z.string().optional(),
});

/**
 * Response from `POST /_kilo/morning-briefing/onboarding-briefing`. The plugin
 * creates (or returns the existing) "Today's briefing" conversation and kicks
 * off briefing generation in the background.
 */
export const OnboardingBriefingResponseSchema = z.object({
  ok: z.boolean(),
  conversationId: z.string().optional(),
  alreadyStarted: z.boolean().optional(),
  error: z.string().optional(),
});

export const MorningBriefingInterestsRequestSchema = z.object({
  topics: z.array(z.string()),
});

export const MorningBriefingInterestsResponseSchema = z.object({
  ok: z.boolean(),
  interestTopics: z.array(z.string()).optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

export const MorningBriefingUserLocationResponseSchema = z.object({
  ok: z.boolean(),
  userLocation: z.string().nullable().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

export const MorningBriefingReadResponseSchema = z.object({
  ok: z.boolean(),
  dateKey: z.string().optional(),
  filePath: z.string().optional(),
  exists: z.boolean().optional(),
  markdown: z.string().nullable().optional(),
  error: z.string().optional(),
});

export class GatewayControllerError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'GatewayControllerError';
    this.status = status;
    this.code = code ?? null;
  }
}

// Treat the Openclaw config on disk as an opaque blob
export const OpenclawConfigResponseSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  etag: z.string(),
});

export const OpenclawFileWriteValidationSchema = z.enum(['warn-before-write', 'allow-invalid']);
export type OpenclawFileWriteValidation = z.infer<typeof OpenclawFileWriteValidationSchema>;

const OpenclawValidationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  allowedValues: z.array(z.string()).optional(),
});

export const FileWriteResponseSchema = z.union([
  z.object({ etag: z.string() }),
  z.object({
    outcome: z.literal('openclaw-validation-warning'),
    valid: z.literal(false),
    reason: z.enum(['invalid', 'validation-unavailable']),
    issues: z.array(OpenclawValidationIssueSchema),
  }),
]);
export type FileWriteResponse = z.infer<typeof FileWriteResponseSchema>;

// ──────────────────────────────────────────────────────────────────────
// Controller pairing responses
//
// These schemas describe the wire format returned by the controller's
// HTTP endpoints and must stay in sync with the canonical types in
// controller/src/pairing-cache.ts (CacheEntry, ChannelPairingRequest,
// DevicePairingRequest, ApproveResult). Cross-package imports are not
// possible, so changes to one must be mirrored in the other.
// Note: ApproveResult.statusHint is consumed by the route handler and
// not serialized to the client, so it is intentionally absent here.
// ──────────────────────────────────────────────────────────────────────

export const ControllerChannelPairingResponseSchema = z.object({
  requests: z.array(
    z.object({
      code: z.string(),
      id: z.string(),
      channel: z.string(),
      meta: z.unknown().optional(),
      createdAt: z.string().optional(),
    })
  ),
  lastUpdated: z.string(),
});

export const ControllerDevicePairingResponseSchema = z.object({
  requests: z.array(
    z.object({
      requestId: z.string(),
      deviceId: z.string(),
      role: z.string().optional(),
      platform: z.string().optional(),
      clientId: z.string().optional(),
      ts: z.number().optional(),
    })
  ),
  lastUpdated: z.string(),
});

export const ControllerPairingApproveResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

// ──────────────────────────────────────────────────────────────────────
// Kilo CLI run
// ──────────────────────────────────────────────────────────────────────

export const KiloCliRunStartResponseSchema = z.object({
  ok: z.boolean(),
  startedAt: z.string(),
});

export const KiloCliRunStatusResponseSchema = z.object({
  hasRun: z.boolean(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']).nullable(),
  output: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  prompt: z.string().nullable(),
});

// ──────────────────────────────────────────────────────────────────────
// OpenClaw doctor run (controller path, replacing the Fly exec route)
// ──────────────────────────────────────────────────────────────────────

export const OpenclawDoctorStartResponseSchema = z.object({
  ok: z.boolean(),
  runId: z.string(),
  startedAt: z.string(),
});

export const OpenclawDoctorStatusResponseSchema = z.object({
  hasRun: z.boolean(),
  runId: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']).nullable(),
  fix: z.boolean().nullable(),
  output: z.string().nullable(),
  outputBytes: z.number().int().min(0),
  outputTruncated: z.boolean(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  timedOut: z.boolean(),
});

export const OpenclawDoctorCancelResponseSchema = z.object({
  ok: z.boolean(),
});
