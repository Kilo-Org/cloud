import { z } from 'zod';
import {
  controlPlaneFailureReasonSchema,
  controlPlanePreparationStepSchema,
  controlPlaneWorkspaceFailureSubtypeSchema,
} from './control-plane-protocol.js';
import {
  CONTROL_OPERATIONS,
  controlErrorCodes,
  worktreeDeletePayloadSchema,
} from './sandbox-control-protocol.js';

export const OWNED_PROCESS_CLEANUP_UNREAPED = 'Owned process cleanup unreaped';
export const CONTROL_LOG_MAX_BATCH_BYTES = 256 * 1024;
export const CONTROL_LOG_MAX_BATCH_RECORDS = 128;
export const CONTROL_LOG_MAX_BUFFER_RECORDS = 512;
export const CONTROL_LOG_MAX_RECORD_BYTES = 4096;
export const CONTROL_LOG_MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const CONTROL_LOG_ARCHIVE_NAME = 'files.tar.gz';
export const CONTROL_LOG_GRANT_SECONDS = 4 * 60 * 60;
export const controlLogUploadResults = [
  'accepted',
  'http_rejection',
  'network_failure',
  'timeout',
  'cancelled',
] as const;
export type ControlLogUploadResult = (typeof controlLogUploadResults)[number];

/** Launch-env gate for the native control-plane stderr projector. */
export const CONTROL_PLANE_NATIVE_LOGS_ENV = 'CONTROL_PLANE_NATIVE_LOGS';

/** The one native stderr gate read, shared by the wrapper entry and process cleanup. */
export function nativeControlPlaneLogsEnabled(env: Record<string, string | undefined>): boolean {
  return env[CONTROL_PLANE_NATIVE_LOGS_ENV] === '1';
}

/**
 * The one native connection-phase list. The diagnostic schema and the wrapper
 * connection derive from it, so a new phase cannot be added to one and silently
 * dropped by the other.
 */
export const nativeConnectionPhases = [
  'idle',
  'connecting',
  'awaiting_welcome',
  'connected',
  'closed',
] as const;
export type NativeConnectionPhase = (typeof nativeConnectionPhases)[number];

/** Fault restart reasons; wrapper adds the deliberate `credentials` refresh. */
export const kiloRestartFaultReasonSchema = z.enum(['hang', 'exit', 'feed']);
export type KiloRestartFaultReason = z.infer<typeof kiloRestartFaultReasonSchema>;

export type ControlUploadFailureSample = {
  category: ControlLogUploadResult;
  statusCode?: number;
};

/**
 * Whether an upload failure belongs to a new stderr episode. Shared by the
 * diagnostic uploader and the archive uploader so their equality cannot drift:
 * a category change is a new episode, a 401/403 after a non-auth HTTP rejection
 * is the grant rejection, and any other repeat stays in the current episode.
 */
export function controlUploadFailureStartsEpisode(
  previous: ControlUploadFailureSample | undefined,
  next: ControlUploadFailureSample
): boolean {
  if (!previous) return true;
  if (previous.category !== next.category) return true;
  if (previous.category !== 'http_rejection') return false;
  const previousAuth = previous.statusCode === 401 || previous.statusCode === 403;
  const nextAuth = next.statusCode === 401 || next.statusCode === 403;
  return !previousAuth && nextAuth;
}

export type ControlDiagnosticFields = Record<string, string | number | boolean | undefined>;
export type ControlDiagnosticReporter = (event: string, fields: ControlDiagnosticFields) => void;

export const controlLogSandboxIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/);
export const controlLogAllocationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const controlLogWrapperIdSchema = z.string().uuid();
const identifier = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const milliseconds = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const syncStatusSchema = z.enum(['idle', 'busy', 'retry', 'finalizing', 'other']);

export const controlDiagnosticFieldsSchema = z
  .object({
    phase: z.enum([
      'starting',
      'ready',
      'stopping',
      'start_failed',
      'started',
      'deadline_expired',
      'finished',
      'failed',
      'prompt_started',
      'prompt_completed',
      'command_started',
      'command_completed',
      'compact_started',
      'compact_completed',
      'finalization_started',
      'autocommit_started',
      'autocommit_completed',
      'condense_started',
      'condense_completed',
      'execution_failed',
      'abort_started',
      'abort_completed',
      'abort_failed',
      'outcome_sending',
      'outcome_sent',
      'outcome_failed',
      'sending',
      'sent',
      'send_failed',
      'send_threw',
      'stopped',
      'opening',
      'stale',
      'reconnected',
      'ended',
      'freshness',
      'opened',
      'hello_sent',
      'hello_accepted',
      'closed',
      'retired',
      'hello_rejected',
      'reconnect_exhausted',
      'explicitly_closed',
      'connect_attempt',
      'retry_scheduled',
      'keepalive_sent',
      'keepalive_failed',
      'received',
      'completed',
      'response_sent',
      'response_failed',
      'response_skipped',
      'skipped',
      'publication_failed',
      'publication_receipt',
      'publication_summary',
      'forward_response_timeout',
      'outbox_rejected',
      'socket_overflow',
      'kilo_unavailable',
      'kilo_restarting',
      'kilo_restarted',
      'kilo_restart_failed',
      'kilo_memory_hold_started',
      'kilo_memory_hold_ended',
      'prepare_failed',
      'session_ready',
      'session_outcome',
      'status',
    ]),
    stage: z
      .enum([
        'attach_validation',
        'runtime_attach',
        'workspace_prepare',
        'git_setup',
        'setup_commands',
        'bootstrap_marker',
        'git_credentials',
        'session_registration',
        'session_probe',
        'session_restore',
        'session_create',
        'attachment_commit',
        'deletion_fence',
        'task_cancellation',
        'runtime_lookup',
        'sync_validation',
        'sync_status',
        'sync_questions',
        'sync_permissions',
        'sync_result',
        'directory_validation',
        'manifest_discovery',
        'session_abort',
        'manifest_growth',
        'process_cleanup',
        'terminal_cleanup',
        'session_delete',
        'session_delete_confirmation',
        'session_delete_unconfirmed',
        'directory_dispose',
        'runtime_retirement',
        'directory_removal',
        'root_detach',
      ])
      .optional(),
    workspaceAction: z.enum(['reuse', 'bootstrap', 'not_needed']).optional(),
    sessionResolution: z.enum(['existing', 'restored', 'created']).optional(),
    kind: z.enum(['preparation', 'execution', 'finalizing']).optional(),
    status: z.enum(['completed', 'failed', 'cancelled']).optional(),
    nativeStatus: z.enum(['missing', ...syncStatusSchema.options]).optional(),
    syncStatus: syncStatusSchema.optional(),
    category: z
      .enum([
        'outcome',
        'preparing',
        'session_event',
        'heartbeat',
        'ready',
        'other',
        ...controlLogUploadResults,
      ])
      .optional(),
    outcome: z
      .enum([
        'acknowledged',
        'rejected',
        'timed_out',
        'connection_closed',
        'late_reply',
        'tracking_evicted',
      ])
      .optional(),
    connectionState: z
      .enum([
        'idle',
        'starting',
        'connecting',
        'ready',
        'closing',
        'closed',
        'reconnecting',
        'unknown',
      ])
      .optional(),
    reason: z.string().min(1).max(128).optional(),
    preparationStep: controlPlanePreparationStepSchema.optional(),
    subtype: controlPlaneWorkspaceFailureSubtypeSchema.optional(),
    kiloRestartReason: kiloRestartFaultReasonSchema.optional(),
    memoryHoldOutcome: z
      .enum(['recovered', 'cleared', 'expired', 'restarted', 'stopped'])
      .optional(),
    interceptTrustFailure: z
      .enum(['cert_unavailable', 'cert_unreadable', 'cert_append_failed'])
      .optional(),
    outcomeReason: controlPlaneFailureReasonSchema.optional(),
    nativeConnectionPhase: z.enum(nativeConnectionPhases).optional(),
    failureReason: z
      .enum([
        'expired',
        'rejected',
        'queue_overflow',
        'socket_overflow',
        'disconnected',
        'send_failed',
        'publication_not_accepted',
        'publication_throw',
        'event_receipt_timeout',
        'event_ack_tracking_evicted',
      ])
      .optional(),
    operation: z.enum([...CONTROL_OPERATIONS, 'other']).optional(),
    retirementCause: z
      .enum([
        'event_feed_unhealthy',
        'process_exited',
        'credential_refresh_failed',
        'control_disconnected',
        'preparation_delivery_failed',
        'requested_shutdown',
        'sigterm',
        'sigint',
        'uncaught_exception',
        'unhandled_rejection',
        'cancellation_failed',
        'outcome_delivery_failed',
        'execution_deadline',
        'preparation_deadline',
        'unknown',
      ])
      .optional(),
    errorCode: z.enum([...controlErrorCodes, 'other']).optional(),
    retryable: z.boolean().optional(),
    detail: z.string().min(1).max(128).optional(),
    scopeId: identifier.optional(),
    worktreeId: worktreeDeletePayloadSchema.shape.worktreeId.optional(),
    sessionId: identifier.optional(),
    kiloSessionId: identifier.optional(),
    rootKiloSessionId: identifier.optional(),
    nativeRuntimeId: identifier.optional(),
    allocationId: controlLogAllocationIdSchema.optional(),
    wrapperInstanceId: controlLogWrapperIdSchema.optional(),
    receiptId: z.string().uuid().optional(),
    eventType: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
      .optional(),
    messageId: identifier.optional(),
    partId: identifier.optional(),
    toolStatus: z.enum(['pending', 'running', 'completed', 'error']).optional(),
    probeStatus: z.enum(['found', 'missing', 'unavailable']).optional(),
    probeStage: z.enum(['pre_deadline', 'deadline']).optional(),
    outputBytes: count.optional(),
    requestId: identifier.optional(),
    connectionId: identifier.optional(),
    incarnation: identifier.optional(),
    elapsedMs: milliseconds.optional(),
    deadlineAt: milliseconds.optional(),
    lastSentAt: milliseconds.optional(),
    sinceLastSentMs: milliseconds.optional(),
    lastEventAt: milliseconds.optional(),
    toolObservedAt: milliseconds.optional(),
    ageMs: milliseconds.optional(),
    sentAt: milliseconds.optional(),
    preparedAt: milliseconds.optional(),
    queueWaitMs: milliseconds.optional(),
    requestWaitMs: milliseconds.optional(),
    delayMs: milliseconds.optional(),
    sequence: count.optional(),
    eventsReceived: count.optional(),
    descendantProgressEvents: count.optional(),
    sessionCount: count.optional(),
    questionCount: count.optional(),
    permissionCount: count.optional(),
    bufferedBytes: count.optional(),
    bytes: count.optional(),
    attempt: count.optional(),
    outboxBytes: count.optional(),
    preparingCount: count.optional(),
    activeTurnCount: count.optional(),
    recentTerminalCount: count.optional(),
    runtimeCount: count.optional(),
    suspectedCount: count.optional(),
    restartingCount: count.optional(),
    unavailableCount: count.optional(),
    attemptCount: count.optional(),
    pendingCount: count.optional(),
    pendingBytes: count.optional(),
    socketBufferedBytes: count.optional(),
    outstandingEventAcks: count.optional(),
    outstandingEventAckBytes: count.optional(),
    acknowledgedCount: count.optional(),
    rejectedCount: count.optional(),
    timeoutCount: count.optional(),
    connectionClosedCount: count.optional(),
    trackingEvictionCount: count.optional(),
    lateReplyCount: count.optional(),
    failureCount: count.optional(),
    neverSentCount: count.optional(),
    sentWithoutResponseCount: count.optional(),
    expiredCount: count.optional(),
    queueOverflowCount: count.optional(),
    socketOverflowCount: count.optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    readyState: z.number().int().min(0).max(3).optional(),
    closeCode: z.number().int().min(0).max(65535).optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    wasClean: z.boolean().optional(),
    neverSent: z.boolean().optional(),
    sentWithoutResponse: z.boolean().optional(),
    ok: z.boolean().optional(),
    aborted: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    ownedTask: z.boolean().optional(),
    statusQueryPending: z.boolean().optional(),
    questionQueryPending: z.boolean().optional(),
    permissionQueryPending: z.boolean().optional(),
    workloadPhase: z
      .enum(['probe', 'applied', 'protection', 'migration', 'oom', 'stats', 'rollback', 'failed'])
      .optional(),
    workloadFailure: z
      .enum([
        'flag_off',
        'no_finite_limit',
        'below_minimum',
        'not_delegated',
        'occupied',
        'controller_unavailable',
        'readback_mismatch',
        'write_failed',
        'unavailable',
        'pid_changed',
        'membership_unconfirmed',
      ])
      .optional(),
    containerLimitBytes: count.optional(),
    aggregateMaxBytes: count.optional(),
    toolsMaxBytes: count.optional(),
    reserveBytes: count.optional(),
    appliedMaxBytes: count.optional(),
    readbackMaxBytes: count.optional(),
    serverMinBytes: count.optional(),
    currentBytes: count.optional(),
    peakBytes: count.optional(),
    anonBytes: count.optional(),
    fileBytes: count.optional(),
    shmemBytes: count.optional(),
    toolCurrentBytes: count.optional(),
    toolPeakBytes: count.optional(),
    serverCurrentBytes: count.optional(),
    serverPeakBytes: count.optional(),
    oomKills: count.optional(),
    oomGroupKills: count.optional(),
    toolOomKills: count.optional(),
    serverOomKills: count.optional(),
    migratedCount: count.optional(),
    toolCount: count.optional(),
    serverCount: count.optional(),
    pressureSomeTotal: count.optional(),
    pressureFullTotal: count.optional(),
    pressureAvailable: z.boolean().optional(),
    memoryMaxEvents: count.optional(),
    memoryOomEvents: count.optional(),
    cpuUsageUsec: count.optional(),
    cpuThrottledUsec: count.optional(),
    cpuThrottleCount: count.optional(),
    ioReadBytes: count.optional(),
    ioWriteBytes: count.optional(),
    toolCpuUsageUsec: count.optional(),
    serverCpuUsageUsec: count.optional(),
    toolIoReadBytes: count.optional(),
    toolIoWriteBytes: count.optional(),
    toolAnonBytes: count.optional(),
    toolFileBytes: count.optional(),
    toolShmemBytes: count.optional(),
    serverAnonBytes: count.optional(),
    serverFileBytes: count.optional(),
    serverShmemBytes: count.optional(),
    cpuController: z.boolean().optional(),
    siblingProtection: z.boolean().optional(),
    workloadLimitSource: z.enum(['cgroup', 'explicit', 'meminfo']).optional(),
  })
  .strict();

export const controlDiagnosticRecordSchema = z
  .object({
    timestamp: milliseconds,
    event: z.enum([
      'wrapper.lifecycle',
      'session.task',
      'session.execution',
      'control.heartbeat',
      'control.feed',
      'control.socket',
      'control.request',
      'control.event',
      'control.upload',
      'control.workload',
      'wrapper.status',
    ]),
    fields: controlDiagnosticFieldsSchema,
  })
  .strict();

export type ControlDiagnosticRecord = z.infer<typeof controlDiagnosticRecordSchema>;
export type RetirementCause = NonNullable<ControlDiagnosticRecord['fields']['retirementCause']>;

const NON_PROJECTABLE_PHASES = new Set(['keepalive_sent', 'keepalive_failed', 'retry_scheduled']);
const PROJECTABLE_SOCKET_PHASES = new Set(['closed', 'connect_attempt', 'hello_rejected']);
const PROJECTABLE_LIFECYCLE_PHASES = new Set([
  'starting',
  'ready',
  'stopping',
  'start_failed',
  'failed',
  'kilo_unavailable',
  'kilo_restarting',
  'kilo_restarted',
  'kilo_restart_failed',
  'kilo_memory_hold_started',
  'kilo_memory_hold_ended',
  'prepare_failed',
  'session_ready',
  'session_outcome',
]);

/**
 * The one native-stderr allowlist, next to the schema. Everything a native owner
 * projects into stderr must pass here: lifecycle start/ready/failure and the
 * normal prepare/outcome transitions, terminal task and execution phases, the
 * socket episode, upload failure, workload apply/failure, request failures, the
 * owner lines, and the periodic `wrapper.status` line. Heartbeats, keepalive and
 * retry scheduling are excluded.
 */
export function isProjectableControlDiagnostic(
  event: string,
  fields: ControlDiagnosticFields
): boolean {
  const phase = fields.phase;
  if (event === 'control.heartbeat') return false;
  if (typeof phase === 'string' && NON_PROJECTABLE_PHASES.has(phase)) return false;
  switch (event) {
    case 'wrapper.lifecycle':
      return typeof phase === 'string' && PROJECTABLE_LIFECYCLE_PHASES.has(phase);
    case 'control.socket':
      if (phase === 'connect_attempt') return fields.ok === false;
      return typeof phase === 'string' && PROJECTABLE_SOCKET_PHASES.has(phase);
    case 'session.task':
      return phase === 'finished' || phase === 'failed' || phase === 'deadline_expired';
    case 'session.execution':
      return (
        fields.status !== undefined ||
        phase === 'execution_failed' ||
        phase === 'outcome_sending' ||
        phase === 'outcome_sent' ||
        phase === 'outcome_failed' ||
        phase === 'abort_completed' ||
        phase === 'abort_failed'
      );
    case 'control.upload':
      return phase === 'failed';
    case 'control.workload':
      return (
        phase === 'failed' ||
        fields.workloadFailure !== undefined ||
        (phase === 'started' && fields.workloadPhase === 'applied')
      );
    case 'control.request':
      return phase === 'response_failed' || phase === 'forward_response_timeout';
    case 'wrapper.status':
      return phase === 'status';
    default:
      return false;
  }
}

const retirementCauseByReason = new Map<string, RetirementCause>([
  ['Kilo event feed is no longer healthy', 'event_feed_unhealthy'],
  ['feed_stale', 'event_feed_unhealthy'],
  ['feed_reconnected', 'event_feed_unhealthy'],
  ['feed_ended', 'event_feed_unhealthy'],
  ['feed_failed', 'event_feed_unhealthy'],
  ['process_exited', 'process_exited'],
  ['credential_refresh_failed', 'credential_refresh_failed'],
  ['Sandbox control connection lost', 'control_disconnected'],
  ['control_disconnected', 'control_disconnected'],
  ['Preparation event delivery failed', 'preparation_delivery_failed'],
  ['Sandbox shutting down', 'requested_shutdown'],
  ['Wrapper received SIGTERM', 'sigterm'],
  ['Wrapper received SIGINT', 'sigint'],
  ['Wrapper uncaught exception', 'uncaught_exception'],
  ['Wrapper unhandled rejection', 'unhandled_rejection'],
  ['Kilo cancellation failed', 'cancellation_failed'],
  ['Kilo cancellation was not confirmed', 'cancellation_failed'],
  ['Native cancellation did not settle', 'cancellation_failed'],
  ['Session outcome delivery failed', 'outcome_delivery_failed'],
  ['Session event delivery failed', 'outcome_delivery_failed'],
  ['Execution exceeded the 60 minute limit', 'execution_deadline'],
  ['Session preparation timed out', 'preparation_deadline'],
]);

export function diagnosticDetail(value: string): string | undefined {
  const detail = value.trim().slice(0, 128);
  return detail === '' ? undefined : detail;
}

export function classifyRetirementCause(...reasons: string[]): RetirementCause {
  for (const reason of reasons) {
    const mapped = retirementCauseByReason.get(reason);
    if (mapped) return mapped;
    if (reason.startsWith('feed_')) return 'event_feed_unhealthy';
    if (reason.startsWith('Session event delivery')) return 'outcome_delivery_failed';
  }
  return 'unknown';
}

export const controlLogIdentitySchema = z
  .object({
    sandboxId: controlLogSandboxIdSchema,
    allocationId: controlLogAllocationIdSchema,
    wrapperInstanceId: controlLogWrapperIdSchema,
  })
  .strict();

export type ControlLogIdentity = z.infer<typeof controlLogIdentitySchema>;

export const controlLogBatchSchema = z
  .object({
    version: z.literal(1),
    sequence: count,
    droppedRecords: count,
    droppedTerminalRecords: count.optional(),
    records: z.array(controlDiagnosticRecordSchema).min(1).max(CONTROL_LOG_MAX_BATCH_RECORDS),
  })
  .strict();

export type ControlLogBatch = z.infer<typeof controlLogBatchSchema>;

export function diagnosticSyncStatus(value: unknown): z.infer<typeof syncStatusSchema> {
  const parsed = syncStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'other';
}

export function isUnreapedOwnedProcessDiagnostic(record: ControlDiagnosticRecord): boolean {
  return (
    record.event === 'session.task' &&
    record.fields.stage === 'process_cleanup' &&
    record.fields.phase === 'failed' &&
    record.fields.ok === false
  );
}

export function emitControlDiagnostic(
  callback: ControlDiagnosticReporter | undefined,
  event: string,
  fields: ControlDiagnosticFields
): void {
  try {
    callback?.(event, fields);
  } catch {
    return;
  }
}

export function createControlDiagnosticRecord(
  event: string,
  fields: ControlDiagnosticFields,
  timestamp: number
): ControlDiagnosticRecord | undefined {
  try {
    const allowedFields: ControlDiagnosticFields = {};
    for (const key of Object.keys(controlDiagnosticFieldsSchema.shape)) {
      const value = fields[key];
      if (value !== undefined) allowedFields[key] = value;
    }
    const parsed = controlDiagnosticRecordSchema.safeParse({
      timestamp,
      event,
      fields: allowedFields,
    });
    if (!parsed.success) return undefined;
    if (
      new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength >
      CONTROL_LOG_MAX_RECORD_BYTES
    ) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

export type ControlDiagnosticProjector = {
  (event: string, fields: ControlDiagnosticFields): void;
  readonly enabled: boolean;
};

/**
 * The one native-gated stderr projector. It is a safe write only: it no-ops
 * when the gate is unset, applies the allowlist, validates the record, drops
 * `detail` and `reason`, and writes one JSON line. It does not read `accepting`,
 * buffer, upload, dedup, or touch `logToFile`.
 */
export function createControlDiagnosticProjector(options: {
  enabled: boolean;
  write?: (line: string) => void;
  now?: () => number;
}): ControlDiagnosticProjector {
  const write = options.write ?? ((line: string): void => console.error(line));
  const now = options.now ?? Date.now;
  const project = ((event: string, fields: ControlDiagnosticFields): void => {
    if (!options.enabled) return;
    try {
      if (!isProjectableControlDiagnostic(event, fields)) return;
      const record = createControlDiagnosticRecord(event, fields, now());
      if (!record) return;
      const safeFields = { ...record.fields };
      delete safeFields.detail;
      delete safeFields.reason;
      write(JSON.stringify({ ...record, fields: safeFields }));
    } catch {
      // The projector must never throw into its caller.
    }
  }) as ControlDiagnosticProjector;
  Object.defineProperty(project, 'enabled', { value: options.enabled, enumerable: true });
  return project;
}
