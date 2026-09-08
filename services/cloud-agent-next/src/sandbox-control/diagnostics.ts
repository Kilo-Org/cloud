import { withDORetry, type DORetryConfig } from '@kilocode/worker-utils';
import { logger } from '../logger.js';

export type ControlDiagnosticFields = Record<string, string | number | boolean | null | undefined>;
type ControlDiagnosticOptions = { coalesceIdentity?: string };

export const CONTROL_DIAGNOSTIC_COALESCE_LIMIT = 128;
const coalescedDiagnostics = new Map<
  string,
  { fields: ControlDiagnosticFields; stableFields: string; occurrences: number }
>();

const EVENT_TYPES = new Set([
  'sandbox.ready',
  'sandbox.heartbeat',
  'session.event',
  'session.preparing',
  'session.message.outcome',
  'session.status',
  'session.updated',
  'session.created',
  'session.deleted',
  'session.error',
  'session.idle',
  'session.turn.close',
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'question.asked',
  'question.replied',
  'question.rejected',
  'permission.asked',
  'permission.replied',
]);

const CAUSES = new Set([
  'idle',
  'heartbeat_expired',
  'kilo_unhealthy',
  'control_replaced',
  'control_disconnected',
  'session_delivery_failed',
  'environment_failed',
  'environment_stopped',
  'provider_unknown',
  'runtime_unhealthy',
  'preparation_interrupted',
  'preparation_timeout',
  'attach_exhausted',
  'prompt_exhausted',
  'credential_containment_unavailable',
  'demand',
  'terminal',
  'failed',
  'recovered',
  'hello',
  'instance confirmed',
  'stop attempt',
  'stop retries exhausted',
  'observe:active',
  'observe:terminal',
  'observe:unknown',
]);

export function diagnosticEventType(value: string): string {
  return EVENT_TYPES.has(value) ? value : 'other';
}

export function diagnosticCause(value: string): string {
  return CAUSES.has(value)
    ? value.replaceAll(' ', '_')
    : value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128);
}

const DELTA_PROGRESS_EVENTS = new Set([
  'socket_frame_received',
  'forward_enqueued',
  'forward_started',
  'forward_settled',
]);

export function logControlDiagnostic(
  event: string,
  fields: ControlDiagnosticFields,
  level: 'info' | 'warn' = 'info',
  options?: ControlDiagnosticOptions
): void {
  try {
    if (
      level === 'info' &&
      fields.eventType === 'message.part.delta' &&
      (DELTA_PROGRESS_EVENTS.has(event) ||
        (event === 'forward_result' && fields.result === 'delivered' && fields.applied === true) ||
        (event === 'session_event_result' && fields.applied === true))
    ) {
      return;
    }
    const bounded: ControlDiagnosticFields = {};
    for (const [key, value] of Object.entries(fields).slice(0, 48)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key)) continue;
      if (typeof value === 'string') {
        bounded[key] = /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : 'redacted';
      } else if (typeof value === 'number') {
        bounded[key] = Number.isFinite(value)
          ? Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value))
          : null;
      } else if (typeof value === 'boolean' || value === null) {
        bounded[key] = value;
      }
    }
    const emit = (diagnosticFields: ControlDiagnosticFields) => {
      const scoped = logger.withFields({
        ...diagnosticFields,
        logTag: 'sandbox_control',
        diagnosticEvent: /^[a-z_]{1,64}$/.test(event) ? event : 'unknown',
      });
      scoped[level]('Sandbox control diagnostic');
    };
    if (!options?.coalesceIdentity) {
      emit(bounded);
      return;
    }
    const stableFields = JSON.stringify(
      Object.entries(bounded)
        .filter(([key]) => key !== 'durationMs' && key !== 'occurrences')
        .sort(([left], [right]) => left.localeCompare(right))
    );
    const previous = coalescedDiagnostics.get(options.coalesceIdentity);
    if (previous?.stableFields === stableFields) {
      previous.occurrences = Math.min(Number.MAX_SAFE_INTEGER, previous.occurrences + 1);
      return;
    }
    if (previous) emit({ ...previous.fields, occurrences: previous.occurrences });
    else if (coalescedDiagnostics.size >= CONTROL_DIAGNOSTIC_COALESCE_LIMIT) {
      const oldest = coalescedDiagnostics.keys().next().value;
      if (oldest !== undefined) coalescedDiagnostics.delete(oldest);
    }
    coalescedDiagnostics.set(options.coalesceIdentity, {
      fields: bounded,
      stableFields,
      occurrences: 1,
    });
    emit(bounded);
  } catch {
    return;
  }
}

export function diagnosticConnection(
  identity?: {
    connectionId: string;
    wrapperInstanceId?: string;
  } | null
): ControlDiagnosticFields {
  return {
    connectionId: identity?.connectionId,
    wrapperInstanceId: identity?.wrapperInstanceId,
  };
}

export function withControlDORetry<TStub, TResult>(
  getStub: () => TStub,
  operation: (stub: TStub) => Promise<TResult>,
  operationName: string,
  config?: DORetryConfig
): Promise<TResult> {
  const logRetry = (_message: unknown, fields: unknown) => {
    try {
      logControlDiagnostic(
        'rpc_retry',
        {
          operation: operationName,
          attempt:
            typeof fields === 'object' &&
            fields !== null &&
            'attempt' in fields &&
            typeof fields.attempt === 'number'
              ? fields.attempt
              : undefined,
          attempts:
            typeof fields === 'object' &&
            fields !== null &&
            'attempts' in fields &&
            typeof fields.attempts === 'number'
              ? fields.attempts
              : undefined,
          backoffMs:
            typeof fields === 'object' &&
            fields !== null &&
            'backoffMs' in fields &&
            typeof fields.backoffMs === 'number'
              ? fields.backoffMs
              : undefined,
          retryable:
            typeof fields === 'object' &&
            fields !== null &&
            'retryable' in fields &&
            typeof fields.retryable === 'boolean'
              ? fields.retryable
              : undefined,
        },
        'warn'
      );
    } catch {
      return;
    }
  };
  return withDORetry(getStub, operation, operationName, config, {
    warn: logRetry,
    error: logRetry,
  });
}
