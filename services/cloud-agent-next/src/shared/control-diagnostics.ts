import { z } from 'zod';
import {
  CONTROL_OPERATIONS,
  controlErrorCodes,
  worktreeDeletePayloadSchema,
} from './sandbox-control-protocol.js';

export const CONTROL_LOG_MAX_BATCH_BYTES = 256 * 1024;
export const CONTROL_LOG_MAX_BATCH_RECORDS = 128;
export const CONTROL_LOG_MAX_BUFFER_RECORDS = 512;
export const CONTROL_LOG_MAX_RECORD_BYTES = 4096;
export const CONTROL_LOG_GRANT_SECONDS = 4 * 60 * 60;
export const controlLogUploadResults = [
  'accepted',
  'http_rejection',
  'network_failure',
  'timeout',
  'cancelled',
] as const;
export type ControlLogUploadResult = (typeof controlLogUploadResults)[number];

export type ControlDiagnosticFields = Record<string, string | number | boolean | undefined>;
export type ControlDiagnosticReporter = (event: string, fields: ControlDiagnosticFields) => void;

export const controlLogSandboxIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/);
export const controlLogAllocationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const controlLogWrapperIdSchema = z.string().uuid();
const identifier = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const milliseconds = z.number().min(0).max(Number.MAX_SAFE_INTEGER);

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
    scopeId: identifier.optional(),
    worktreeId: worktreeDeletePayloadSchema.shape.worktreeId.optional(),
    sessionId: identifier.optional(),
    kiloSessionId: identifier.optional(),
    messageId: identifier.optional(),
    requestId: identifier.optional(),
    connectionId: identifier.optional(),
    incarnation: identifier.optional(),
    elapsedMs: milliseconds.optional(),
    lastSentAt: milliseconds.optional(),
    sinceLastSentMs: milliseconds.optional(),
    lastEventAt: milliseconds.optional(),
    ageMs: milliseconds.optional(),
    delayMs: milliseconds.optional(),
    sequence: count.optional(),
    eventsReceived: count.optional(),
    sessionCount: count.optional(),
    bufferedBytes: count.optional(),
    bytes: count.optional(),
    attempt: count.optional(),
    failureCount: count.optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    readyState: z.number().int().min(0).max(3).optional(),
    closeCode: z.number().int().min(0).max(65535).optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    wasClean: z.boolean().optional(),
    ok: z.boolean().optional(),
    aborted: z.boolean().optional(),
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
    ]),
    fields: controlDiagnosticFieldsSchema,
  })
  .strict();

export type ControlDiagnosticRecord = z.infer<typeof controlDiagnosticRecordSchema>;

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
