import { z, type ZodType } from 'zod';

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
  code: z.string().optional(),
  retryAfterSec: z.number().int().positive().optional(),
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
