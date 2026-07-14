import type { PreparingEventDataV2, PreparingStep } from '../shared/protocol.js';
import type { EventQueries } from './queries/index.js';
import type { StoredEvent } from '../websocket/types.js';
import type { EventId } from '../types/ids.js';
import {
  finalizePreparationAttempt,
  materializePreparationEvent,
  readPreparationAttempt,
  type PreparationOutcome,
} from './preparation-history.js';

/**
 * Records the worker-side portion of a preparation attempt: the progress the
 * DO observes before the wrapper is up (sandbox provisioning, disk checks,
 * backup restores) and the guaranteed terminal transition once delivery
 * settles. The wrapper later joins the same attempt (its ready request
 * carries the same attemptId) and continues it with bootstrap steps.
 */
export type PreparationProgressRecorder = {
  readonly attemptId: string;
  /** Translate a legacy (step, message) progress callback into v2 events. */
  onProgress(step: string, message: string): void;
  /**
   * Drive the attempt to a terminal state if it is still running. A no-op
   * when no preparation happened or the wrapper already finished the attempt.
   */
  finalize(outcome: PreparationOutcome): void;
};

export function createPreparationProgressRecorder(options: {
  attemptId: string;
  triggerMessageId: string;
  sessionId: string;
  eventQueries: EventQueries;
  broadcast: (event: StoredEvent) => void;
  now?: () => number;
}): PreparationProgressRecorder {
  const { attemptId, triggerMessageId, sessionId, eventQueries, broadcast } = options;
  const now = options.now ?? Date.now;
  let activeStep: { id: string; key: PreparingStep } | undefined;

  function emit(
    step: PreparingStep,
    message: string,
    action:
      | { action: 'attempt_started' }
      | { action: 'step_started'; stepId: string; kind: 'phase'; label: string }
      | { action: 'step_progress'; stepId: string; detail: string }
      | { action: 'step_completed'; stepId: string }
  ): void {
    // Revisions ride on the materialized snapshot so they stay monotonic no
    // matter who (DO or wrapper) produced the previous event for this attempt.
    const revision = (readPreparationAttempt(eventQueries, attemptId)?.revision ?? 0) + 1;
    const data: PreparingEventDataV2 = {
      version: 2,
      attemptId,
      triggerMessageId,
      revision,
      timestamp: now(),
      step,
      message,
      ...action,
    };
    const stored: StoredEvent = {
      id: 0 as EventId,
      execution_id: '',
      session_id: sessionId,
      stream_event_type: 'preparing',
      payload: JSON.stringify(data),
      timestamp: data.timestamp,
    };
    if (materializePreparationEvent(eventQueries, stored, data)) broadcast(stored);
  }

  function onProgress(step: string, message: string): void {
    const key = step as PreparingStep;
    if (!readPreparationAttempt(eventQueries, attemptId)) {
      emit('workspace_setup', 'Preparing environment', { action: 'attempt_started' });
    }
    const stepId = `phase:${key}`;
    if (activeStep?.id !== stepId) {
      if (activeStep) {
        emit(activeStep.key, message, { action: 'step_completed', stepId: activeStep.id });
      }
      emit(key, message, {
        action: 'step_started',
        stepId,
        kind: 'phase',
        label: key.replaceAll('_', ' '),
      });
      activeStep = { id: stepId, key };
    }
    emit(key, message, { action: 'step_progress', stepId, detail: message });
  }

  function finalize(outcome: PreparationOutcome): void {
    activeStep = undefined;
    for (const event of finalizePreparationAttempt(eventQueries, attemptId, {
      ...outcome,
      timestamp: now(),
    })) {
      broadcast(event);
    }
  }

  return { attemptId, onProgress, finalize };
}
