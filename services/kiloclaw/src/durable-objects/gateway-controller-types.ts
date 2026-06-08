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
// Agent config CRUD responses
// Mirror (controller side):
//   - controller/src/openclaw-agent-config.ts → AgentSummary, AgentConfigSummary
//   - controller/src/openclaw-agent-cli.ts     → CreateResultSchema, DeleteResultSchema
// Response schemas are intentionally lenient (settings as nullable strings, not
// enums) so a newer controller adding an enum value never fails cloud-side parsing.
// ──────────────────────────────────────────────────────────────────────

// Raw model value as authored in openclaw.json: a bare string or an object.
const AgentRawModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
    })
    .passthrough(),
]);

const AgentModelSummarySchema = z.object({
  primary: z.string().nullable(),
  fallbacks: z.array(z.string()),
});

const AgentSettingsSummarySchema = z.object({
  thinkingDefault: z.string().nullable(),
  verboseDefault: z.string().nullable(),
  reasoningDefault: z.string().nullable(),
  fastModeDefault: z.boolean().nullable(),
});

export const AgentSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  configured: z.boolean(),
  workspace: z.string().nullable(),
  agentDir: z.string().nullable(),
  model: AgentModelSummarySchema.extend({
    source: z.enum(['agent', 'defaults']).nullable(),
  }),
  rawModel: AgentRawModelSchema.nullable(),
  settings: AgentSettingsSummarySchema,
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentDefaultsSummarySchema = z.object({
  model: AgentModelSummarySchema.nullable(),
  settings: AgentSettingsSummarySchema,
});
export type AgentDefaultsSummary = z.infer<typeof AgentDefaultsSummarySchema>;

// GET /_kilo/config/agents → { etag, defaults, agents[] }
export const AgentConfigListResponseSchema = z.object({
  etag: z.string(),
  defaults: AgentDefaultsSummarySchema,
  agents: z.array(AgentSummarySchema),
});
export type AgentConfigListResponse = z.infer<typeof AgentConfigListResponseSchema>;

// GET /_kilo/config/agents/:id → { etag, agent }
export const AgentReadResponseSchema = z.object({
  etag: z.string(),
  agent: AgentSummarySchema,
});
export type AgentReadResponse = z.infer<typeof AgentReadResponseSchema>;

// PATCH /_kilo/config/agents/:id → { ok, etag, agent }
export const AgentMutationResponseSchema = z.object({
  ok: z.boolean(),
  etag: z.string(),
  agent: AgentSummarySchema,
});
export type AgentMutationResponse = z.infer<typeof AgentMutationResponseSchema>;

// PATCH /_kilo/config/agent-defaults → { ok, etag, defaults }
export const AgentDefaultsMutationResponseSchema = z.object({
  ok: z.boolean(),
  etag: z.string(),
  defaults: AgentDefaultsSummarySchema,
});
export type AgentDefaultsMutationResponse = z.infer<typeof AgentDefaultsMutationResponseSchema>;

// CLI create result — mirror controller/src/openclaw-agent-cli.ts CreateResultSchema.
const AgentCreateResultSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  workspace: z.string(),
  agentDir: z.string(),
  model: z.string().optional(),
  bindings: z
    .object({
      added: z.array(z.string()),
      updated: z.array(z.string()),
      skipped: z.array(z.string()),
      conflicts: z.array(z.string()),
    })
    .optional(),
});

// POST /_kilo/config/agents → { ok, etag, agent, created }
export const AgentCreateResponseSchema = z.object({
  ok: z.boolean(),
  etag: z.string(),
  agent: AgentSummarySchema,
  created: AgentCreateResultSchema,
});
export type AgentCreateResponse = z.infer<typeof AgentCreateResponseSchema>;

// DELETE /_kilo/config/agents/:id → { ok, filesystemDisposition, agentId, ... }
// filesystemDisposition is always 'unverified' — the controller does not confirm
// the workspace/state/session dirs were removed. The UI must surface this honestly.
export const AgentDeleteResponseSchema = z.object({
  ok: z.boolean(),
  filesystemDisposition: z.literal('unverified'),
  agentId: z.string(),
  workspace: z.string(),
  agentDir: z.string(),
  sessionsDir: z.string(),
  removedBindings: z.number().int(),
  removedAllow: z.number().int(),
});
export type AgentDeleteResponse = z.infer<typeof AgentDeleteResponseSchema>;

/**
 * Error envelope RETURNED (never thrown) by the agent gateway/DO methods.
 * Custom error properties (`.status`/`.code` on GatewayControllerError) are
 * stripped crossing the DO RPC boundary — only `.message` survives — so a typed
 * agent error must be returned as a serializable value and reconstructed into an
 * HTTP response in the platform route. Same pattern as kilo-cli-run.ts /
 * doctor-run.ts. `agentError` is a unique key not present on any success shape.
 */
export type AgentConfigErrorEnvelope = {
  agentError: {
    status: number;
    code: string | null;
    message: string;
  };
};

export function isAgentConfigErrorEnvelope(value: unknown): value is AgentConfigErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'agentError' in value &&
    typeof (value as { agentError: unknown }).agentError === 'object' &&
    (value as { agentError: unknown }).agentError !== null
  );
}

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
