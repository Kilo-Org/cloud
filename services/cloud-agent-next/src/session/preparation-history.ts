import type {
  CloudStatusData,
  PreparationAttempt,
  PreparationStepSnapshot,
  PreparingEventDataV2,
} from '../shared/protocol.js';
import type { EventQueries } from './queries/index.js';
import type { StoredEvent } from '../websocket/types.js';
import type { EventId } from '../types/ids.js';

const OUTPUT_TAIL_MAX_BYTES = 65_536;

type PreparationSnapshot =
  | { action: 'attempt_snapshot'; attempt: Omit<PreparationAttempt, 'steps'> }
  | { action: 'step_snapshot'; stepSnapshot: PreparationStepSnapshot };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPreparationEvent(data: unknown): data is PreparingEventDataV2 {
  return (
    isRecord(data) &&
    data.version === 2 &&
    typeof data.attemptId === 'string' &&
    typeof data.triggerMessageId === 'string' &&
    typeof data.revision === 'number' &&
    typeof data.timestamp === 'number' &&
    typeof data.step === 'string' &&
    typeof data.message === 'string' &&
    typeof data.action === 'string'
  );
}

function parseSnapshot(payload: string): PreparationSnapshot | null {
  try {
    const data: unknown = JSON.parse(payload);
    if (!isRecord(data)) return null;
    if (data.action === 'attempt_snapshot' && isRecord(data.attempt)) {
      return { action: data.action, attempt: data.attempt as Omit<PreparationAttempt, 'steps'> };
    }
    if (data.action === 'step_snapshot' && isRecord(data.stepSnapshot)) {
      return { action: data.action, stepSnapshot: data.stepSnapshot as PreparationStepSnapshot };
    }
  } catch {
    return null;
  }
  return null;
}

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) start++;
  return { text: new TextDecoder().decode(bytes.subarray(start)), truncated: true };
}

function isTerminal(
  status: PreparationAttempt['status'] | PreparationStepSnapshot['status']
): boolean {
  return status === 'completed' || status === 'failed';
}

function attemptEntityId(attemptId: string): string {
  return `preparation/attempt/${attemptId}`;
}

function stepEntityId(attemptId: string, stepId: string): string {
  return `${attemptEntityId(attemptId)}/step/${stepId}`;
}

function writeSnapshot(
  eventQueries: EventQueries,
  event: Pick<StoredEvent, 'execution_id' | 'session_id' | 'timestamp'>,
  entityId: string,
  attempt: Omit<PreparationAttempt, 'steps'>,
  snapshot: PreparationSnapshot
): void {
  const step = snapshot.action === 'step_snapshot' ? snapshot.stepSnapshot.key : 'workspace_setup';
  eventQueries.upsert({
    executionId: event.execution_id,
    sessionId: event.session_id,
    streamEventType: 'preparing',
    payload: JSON.stringify({
      version: 2,
      attemptId: attempt.id,
      triggerMessageId: attempt.triggerMessageId,
      revision:
        snapshot.action === 'step_snapshot'
          ? snapshot.stepSnapshot.revision
          : snapshot.attempt.revision,
      timestamp: event.timestamp,
      step,
      message: 'Preparation snapshot',
      ...(snapshot.action === 'step_snapshot' ? { stepId: snapshot.stepSnapshot.id } : {}),
      ...snapshot,
    }),
    timestamp: event.timestamp,
    entityId,
  });
}

/**
 * Preparation steps come from two independent emitters (the DO before the
 * wrapper boots, the wrapper after), and each only completes its own previous
 * step. Whenever the attempt changes hands or reaches a terminal state, any
 * step still marked running has lost its emitter — settle it so it does not
 * spin forever.
 */
function settleRunningSteps(
  eventQueries: EventQueries,
  event: Pick<StoredEvent, 'execution_id' | 'session_id' | 'timestamp'>,
  attempt: Omit<PreparationAttempt, 'steps'>,
  data: { timestamp: number; revision: number },
  outcome: { status: 'completed' } | { status: 'failed'; safeError: string }
): void {
  for (const stepRow of eventQueries.findByEntityPrefix(`${attemptEntityId(attempt.id)}/step/`)) {
    const snapshot = parseSnapshot(stepRow.payload);
    if (snapshot?.action !== 'step_snapshot') continue;
    const step = snapshot.stepSnapshot;
    if (step.status !== 'running') continue;
    const settled: PreparationStepSnapshot = {
      ...step,
      status: outcome.status,
      completedAt: data.timestamp,
      ...(outcome.status === 'failed' ? { safeError: outcome.safeError } : {}),
      revision: data.revision,
    };
    writeSnapshot(eventQueries, event, stepEntityId(attempt.id, step.id), attempt, {
      action: 'step_snapshot',
      stepSnapshot: settled,
    });
  }
}

export function materializePreparationEvent(
  eventQueries: EventQueries,
  event: Pick<StoredEvent, 'execution_id' | 'session_id' | 'timestamp'>,
  data: unknown
): boolean {
  if (!isPreparationEvent(data) || data.action.endsWith('_snapshot')) return false;
  const attemptId = data.attemptId;
  const attemptIdKey = attemptEntityId(attemptId);
  const existingAttempt = eventQueries.findByEntityId(attemptIdKey);
  const existingAttemptSnapshot = existingAttempt ? parseSnapshot(existingAttempt.payload) : null;
  let attempt =
    existingAttemptSnapshot?.action === 'attempt_snapshot'
      ? existingAttemptSnapshot.attempt
      : undefined;

  if (data.action === 'attempt_started') {
    if (attempt && attempt.revision >= data.revision) return false;
    const handoff = attempt?.status === 'running';
    attempt = {
      id: attemptId,
      triggerMessageId: data.triggerMessageId,
      status: 'running',
      // The wrapper re-announces the attempt the server already started;
      // keep the original start so the duration spans the whole preparation.
      startedAt: handoff && attempt ? attempt.startedAt : data.timestamp,
      revision: data.revision,
    };
    writeSnapshot(eventQueries, event, attemptIdKey, attempt, {
      action: 'attempt_snapshot',
      attempt,
    });
    // A re-announce means a new emitter (the wrapper) took over; the previous
    // emitter's active step has no one left to complete it.
    if (handoff) {
      settleRunningSteps(eventQueries, event, attempt, data, { status: 'completed' });
    }
    return true;
  }

  if (!attempt || data.revision <= attempt.revision || isTerminal(attempt.status)) return false;

  if (data.action === 'attempt_completed' || data.action === 'attempt_failed') {
    attempt = {
      ...attempt,
      status: data.action === 'attempt_completed' ? 'completed' : 'failed',
      completedAt: data.timestamp,
      ...(data.action === 'attempt_failed' ? { safeError: data.safeError } : {}),
      revision: data.revision,
    };
    writeSnapshot(eventQueries, event, attemptIdKey, attempt, {
      action: 'attempt_snapshot',
      attempt,
    });
    settleRunningSteps(
      eventQueries,
      event,
      attempt,
      data,
      data.action === 'attempt_completed'
        ? { status: 'completed' }
        : { status: 'failed', safeError: data.safeError }
    );
    return true;
  }

  if (!('stepId' in data) || typeof data.stepId !== 'string') return false;
  const entityId = stepEntityId(attemptId, data.stepId);
  const existingStep = eventQueries.findByEntityId(entityId);
  const existingStepSnapshot = existingStep ? parseSnapshot(existingStep.payload) : null;
  let step =
    existingStepSnapshot?.action === 'step_snapshot'
      ? existingStepSnapshot.stepSnapshot
      : undefined;

  if (data.action === 'step_started') {
    if (step && step.revision >= data.revision) return false;
    step = {
      id: data.stepId,
      key: data.step,
      kind: data.kind,
      label: data.label,
      status: 'running',
      startedAt: data.timestamp,
      revision: data.revision,
      ...(data.command === undefined ? {} : { command: data.command }),
      ...(data.commandIndex === undefined ? {} : { commandIndex: data.commandIndex }),
      ...(data.commandCount === undefined ? {} : { commandCount: data.commandCount }),
    };
  } else {
    if (!step || data.revision <= step.revision || isTerminal(step.status)) return false;
    if (data.action === 'step_progress') {
      step = { ...step, latestDetail: data.detail, revision: data.revision };
    } else if (data.action === 'step_output') {
      const tail = utf8Tail(`${step.outputTail ?? ''}${data.output}`, OUTPUT_TAIL_MAX_BYTES);
      step = {
        ...step,
        outputTail: tail.text,
        outputTruncated: step.outputTruncated === true || tail.truncated,
        revision: data.revision,
      };
    } else if (data.action === 'step_completed') {
      step = {
        ...step,
        status: 'completed',
        completedAt: data.timestamp,
        ...(data.exitCode === undefined ? {} : { exitCode: data.exitCode }),
        revision: data.revision,
      };
    } else if (data.action === 'step_failed') {
      step = {
        ...step,
        status: 'failed',
        completedAt: data.timestamp,
        safeError: data.safeError,
        ...(data.exitCode === undefined ? {} : { exitCode: data.exitCode }),
        revision: data.revision,
      };
    } else {
      return false;
    }
  }

  const updatedAttempt = { ...attempt, revision: data.revision };
  writeSnapshot(eventQueries, event, entityId, updatedAttempt, {
    action: 'step_snapshot',
    stepSnapshot: step,
  });
  writeSnapshot(eventQueries, event, attemptIdKey, updatedAttempt, {
    action: 'attempt_snapshot',
    attempt: updatedAttempt,
  });
  return true;
}

const STALE_RUNNING_ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000;

/** Read the materialized snapshot of one attempt, without its steps. */
export function readPreparationAttempt(
  eventQueries: EventQueries,
  attemptId: string
): Omit<PreparationAttempt, 'steps'> | null {
  const row = eventQueries.findByEntityId(attemptEntityId(attemptId));
  const snapshot = row ? parseSnapshot(row.payload) : null;
  return snapshot?.action === 'attempt_snapshot' ? snapshot.attempt : null;
}

export type PreparationOutcome = { status: 'completed' } | { status: 'failed'; safeError: string };

/**
 * Drive a still-running attempt (and its running steps) to a terminal state
 * by synthesizing the missing v2 events through the materializer. Returns the
 * synthesized events as stored rows so callers can broadcast them to live
 * stream clients; terminal or unknown attempts yield no events.
 */
export function finalizePreparationAttempt(
  eventQueries: EventQueries,
  attemptId: string,
  options: PreparationOutcome & { timestamp: number }
): StoredEvent[] {
  const row = eventQueries.findByEntityId(attemptEntityId(attemptId));
  if (!row) return [];
  const snapshot = parseSnapshot(row.payload);
  if (snapshot?.action !== 'attempt_snapshot' || snapshot.attempt.status !== 'running') return [];

  const attempt = snapshot.attempt;
  let revision = attempt.revision;
  const events: StoredEvent[] = [];
  const emit = (data: PreparingEventDataV2): void => {
    const stored: StoredEvent = {
      id: 0 as EventId,
      execution_id: row.execution_id,
      session_id: row.session_id,
      stream_event_type: 'preparing',
      payload: JSON.stringify(data),
      timestamp: options.timestamp,
    };
    if (materializePreparationEvent(eventQueries, stored, data)) events.push(stored);
  };
  const base = {
    version: 2 as const,
    attemptId: attempt.id,
    triggerMessageId: attempt.triggerMessageId,
    timestamp: options.timestamp,
  };

  for (const stepRow of eventQueries.findByEntityPrefix(`${attemptEntityId(attemptId)}/step/`)) {
    const stepSnapshot = parseSnapshot(stepRow.payload);
    if (stepSnapshot?.action !== 'step_snapshot') continue;
    const step = stepSnapshot.stepSnapshot;
    if (step.status !== 'running') continue;
    emit(
      options.status === 'completed'
        ? {
            ...base,
            revision: ++revision,
            step: step.key,
            message: 'Preparation complete',
            action: 'step_completed',
            stepId: step.id,
          }
        : {
            ...base,
            revision: ++revision,
            step: step.key,
            message: options.safeError,
            action: 'step_failed',
            stepId: step.id,
            safeError: options.safeError,
          }
    );
  }

  emit(
    options.status === 'completed'
      ? {
          ...base,
          revision: ++revision,
          step: 'ready',
          message: 'Preparation complete',
          action: 'attempt_completed',
        }
      : {
          ...base,
          revision: ++revision,
          step: 'failed',
          message: options.safeError,
          action: 'attempt_failed',
          safeError: options.safeError,
        }
  );
  return events;
}

/**
 * Repair attempts stranded in 'running'. Preparation is hard-capped well
 * below this timeout, so a running attempt whose snapshots stopped updating
 * this long ago lost its terminal event (e.g. the wrapper's progress channel
 * dropped before `attempt_completed` was delivered). Rewrites the
 * materialized snapshots so replaying clients see a terminal attempt instead
 * of a forever-running one.
 */
export function reconcileStalePreparationAttempts(
  eventQueries: EventQueries,
  options: { now: number; sessionPrepared: boolean }
): void {
  for (const row of eventQueries.findByEntityPrefix('preparation/attempt/')) {
    const snapshot = parseSnapshot(row.payload);
    if (snapshot?.action !== 'attempt_snapshot') continue;
    if (snapshot.attempt.status !== 'running') continue;
    if (options.now - row.timestamp < STALE_RUNNING_ATTEMPT_TIMEOUT_MS) continue;

    finalizePreparationAttempt(eventQueries, snapshot.attempt.id, {
      ...(options.sessionPrepared
        ? { status: 'completed' as const }
        : { status: 'failed' as const, safeError: 'Preparation did not complete' }),
      timestamp: row.timestamp,
    });
  }
}

/**
 * Map a 'preparing' stream event to the `cloud.status` broadcast that should
 * accompany it, or null when none should be sent. Stale v2 events (ones the
 * materializer rejected) must not regress a ready session back to
 * 'preparing' — that strands the chat input in its disabled state.
 */
export function cloudStatusForPreparingEvent(
  data: unknown,
  applied: boolean
): CloudStatusData['cloudStatus'] | null {
  if (!isRecord(data)) return null;
  const step = typeof data.step === 'string' ? { step: data.step } : {};
  const message = typeof data.message === 'string' ? { message: data.message } : {};
  if (data.version === 2) {
    if (!applied) return null;
    if (data.action === 'attempt_completed') return { type: 'ready' };
    if (data.action === 'attempt_failed') {
      return {
        type: 'error',
        ...(typeof data.safeError === 'string' ? { message: data.safeError } : message),
      };
    }
    return { type: 'preparing', ...step, ...message };
  }
  if (data.step === 'ready') return { type: 'ready' };
  if (data.step === 'failed') return { type: 'error', ...message };
  return { type: 'preparing', ...step, ...message };
}

export function getPreparationSnapshots(eventQueries: EventQueries): StoredEvent[] {
  const rows = eventQueries.findByEntityPrefix('preparation/attempt/');
  const attempts: StoredEvent[] = [];
  const steps: StoredEvent[] = [];
  for (const row of rows) {
    const snapshot = parseSnapshot(row.payload);
    if (snapshot?.action === 'attempt_snapshot') attempts.push(row);
    if (snapshot?.action === 'step_snapshot') steps.push(row);
  }
  return [
    ...attempts.sort((a, b) => a.timestamp - b.timestamp),
    ...steps.sort((a, b) => a.timestamp - b.timestamp),
  ];
}
