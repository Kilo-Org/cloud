import type { InstanceMutableState, InstanceStatus } from './types';
import {
  ALARM_INTERVAL_RUNNING_MS,
  ALARM_INTERVAL_STARTING_MS,
  ALARM_INTERVAL_RESTARTING_MS,
  ALARM_INTERVAL_RECOVERING_MS,
  ALARM_INTERVAL_DESTROYING_MS,
  ALARM_INTERVAL_IDLE_MS,
  ALARM_JITTER_MS,
} from '../../config';
import { writeEvent, eventContextFromState } from '../../utils/analytics';

type LoggableInstanceContext = Pick<
  InstanceMutableState,
  'userId' | 'sandboxId' | 'flyMachineId' | 'flyRegion' | 'flyAppName'
>;

/**
 * Structured reconciliation logging — emits a JSON line tagged for
 * log-based observability.
 */
export function reconcileLog(
  reason: string,
  action: string,
  details: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      tag: 'reconcile',
      reason,
      action,
      ...details,
    })
  );
}

// ── ReconcileContext ──────────────────────────────────────────────────
//
// Bundles state + env + reason so every reconcileLog call site
// automatically emits to Cloudflare Analytics Engine without needing
// to thread env/state through every function signature.

export type ReconcileContext = {
  readonly state: InstanceMutableState;
  readonly env: { KILOCLAW_AE?: AnalyticsEngineDataset };
  readonly reason: string;
  /** Log a reconcile action to both console and Analytics Engine. */
  log: (action: string, details?: Record<string, unknown>) => void;
};

export function createReconcileContext(
  state: InstanceMutableState,
  env: { KILOCLAW_AE?: AnalyticsEngineDataset },
  reason: string
): ReconcileContext {
  return {
    state,
    env,
    reason,
    log(action: string, details: Record<string, unknown> = {}) {
      reconcileLog(reason, action, details);

      const rawErr = details.error;
      let errorStr: string | undefined;
      if (rawErr !== undefined) {
        try {
          errorStr = (
            rawErr instanceof Error
              ? rawErr.message
              : typeof rawErr === 'string'
                ? rawErr
                : JSON.stringify(rawErr)
          ).slice(0, 200);
        } catch {
          errorStr = '[unserializable error]';
        }
      }

      writeEvent(env, {
        event: `reconcile.${action}`,
        delivery: 'reconcile',
        label: typeof details.label === 'string' ? details.label : '',
        error: errorStr,
        durationMs: typeof details.durationMs === 'number' ? details.durationMs : undefined,
        value: typeof details.value === 'number' ? details.value : undefined,
        ...eventContextFromState(state),
      });
    },
  };
}

// ── Structured error/warn logging ────────────────────────────────────

/**
 * Coerce an unknown caught value into an Error or string for structured logging.
 * Call sites can pass `toLoggable(err)` instead of repeating the instanceof check.
 */
export function toLoggable(err: unknown): Error | string {
  return err instanceof Error ? err : String(err);
}

function serializeError(err: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  // Preserve own enumerable properties (e.g. FlyApiError.status,
  // GatewayControllerError.code) that JSON.stringify would otherwise drop.
  for (const [k, v] of Object.entries(err)) {
    if (!(k in serialized)) {
      serialized[k] = v;
    }
  }
  return serialized;
}

/**
 * Walk a details record and convert Error instances into plain objects
 * so JSON.stringify doesn't lose the message and stack.
 */
function serializeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value instanceof Error) {
      out[key] = serializeError(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Extract the 5 standard context fields from InstanceMutableState.
 */
function instanceContext(state: LoggableInstanceContext): Record<string, unknown> {
  return {
    userId: state.userId,
    sandboxId: state.sandboxId,
    flyMachineId: state.flyMachineId,
    flyRegion: state.flyRegion,
    flyAppName: state.flyAppName,
  };
}

/**
 * Emit a structured JSON log line. Falls back to plain console output
 * if JSON.stringify throws (e.g. circular references, BigInt values)
 * so that logging never crashes the surrounding error-handling path.
 */
function emitStructuredLog(
  logFn: (...args: unknown[]) => void,
  level: 'info' | 'error' | 'warn',
  state: LoggableInstanceContext,
  message: string,
  details: Record<string, unknown>
): void {
  try {
    logFn(
      JSON.stringify({
        tag: 'kiloclaw_do',
        level,
        message,
        ...serializeDetails(details),
        ...instanceContext(state),
      })
    );
  } catch {
    // Serialization failed — fall back to plain multi-arg logging so the
    // message and context are still captured in the log stream.
    logFn(`[kiloclaw_do] [${level}]`, message, details, instanceContext(state));
  }
}

/**
 * Structured info log for DO modules. Instance context fields always
 * take precedence over caller details to prevent accidental shadowing.
 */
export function doLog(
  state: LoggableInstanceContext,
  message: string,
  details: Record<string, unknown> = {}
): void {
  emitStructuredLog(console.log, 'info', state, message, details);
}

/**
 * Structured error log for DO modules. Instance context fields always
 * take precedence over caller details to prevent accidental shadowing.
 */
export function doError(
  state: LoggableInstanceContext,
  message: string,
  details: Record<string, unknown> = {}
): void {
  emitStructuredLog(console.error, 'error', state, message, details);
}

/**
 * Structured warn log for DO modules. Instance context fields always
 * take precedence over caller details to prevent accidental shadowing.
 */
export function doWarn(
  state: LoggableInstanceContext,
  message: string,
  details: Record<string, unknown> = {}
): void {
  emitStructuredLog(console.warn, 'warn', state, message, details);
}

/**
 * Alarm interval for a given instance status.
 */
export function alarmIntervalForStatus(status: InstanceStatus): number {
  switch (status) {
    case 'running':
      return ALARM_INTERVAL_RUNNING_MS;
    case 'starting':
      return ALARM_INTERVAL_STARTING_MS;
    case 'restarting':
      return ALARM_INTERVAL_RESTARTING_MS;
    case 'recovering':
      return ALARM_INTERVAL_RECOVERING_MS;
    case 'destroying':
      return ALARM_INTERVAL_DESTROYING_MS;
    case 'restoring':
      return ALARM_INTERVAL_STARTING_MS; // 1 min — frequent enough to detect stuck restores
    case 'provisioned':
    case 'stopped':
      return ALARM_INTERVAL_IDLE_MS;
  }
}

/**
 * Next alarm time with jitter.
 */
export function nextAlarmTime(status: InstanceStatus): number {
  return Date.now() + alarmIntervalForStatus(status) + Math.random() * ALARM_JITTER_MS;
}
