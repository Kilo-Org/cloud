import { describe, expect, it } from 'vitest';
import {
  cloudStatusForPreparingEvent,
  finalizePreparationAttempt,
  getPreparationSnapshots,
  materializePreparationEvent,
  readPreparationAttempt,
  reconcileStalePreparationAttempts,
} from './preparation-history.js';
import {
  createMemoryEventQueries,
  readAttempt,
  readStep,
  seedRunningAttempt,
  storedEvent,
} from './preparation-test-helpers.js';

const MINUTE_MS = 60 * 1000;

describe('materializePreparationEvent', () => {
  it('preserves startedAt when attempt_started re-announces a running attempt', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId } = seedRunningAttempt(eventQueries, { startedAt: 1000 });

    const applied = materializePreparationEvent(eventQueries, storedEvent(60_000), {
      version: 2,
      attemptId,
      triggerMessageId: 'msg-1',
      revision: 50_000,
      timestamp: 60_000,
      step: 'workspace_setup',
      message: 'Preparing environment',
      action: 'attempt_started',
    });

    expect(applied).toBe(true);
    const attempt = readAttempt(eventQueries, attemptId);
    expect(attempt.startedAt).toBe(1000);
    expect(attempt.revision).toBe(50_000);
  });

  it("settles the previous emitter's running steps when the wrapper takes over", () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId, lastEventAt } = seedRunningAttempt(eventQueries, { startedAt: 1000 });

    materializePreparationEvent(eventQueries, storedEvent(lastEventAt + 1000), {
      version: 2,
      attemptId,
      triggerMessageId: 'msg-1',
      revision: 50_000,
      timestamp: lastEventAt + 1000,
      step: 'workspace_setup',
      message: 'Preparing environment',
      action: 'attempt_started',
    });

    const step = readStep(eventQueries, attemptId, 'phase:kilo_server');
    expect(step.status).toBe('completed');
    expect(step.completedAt).toBe(lastEventAt + 1000);
  });

  it('settles dangling running steps when the attempt fails', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId, lastEventAt } = seedRunningAttempt(eventQueries, { startedAt: 1000 });

    materializePreparationEvent(eventQueries, storedEvent(lastEventAt + 1000), {
      version: 2,
      attemptId,
      triggerMessageId: 'msg-1',
      revision: 50_000,
      timestamp: lastEventAt + 1000,
      step: 'failed',
      message: 'Setup command failed',
      action: 'attempt_failed',
      safeError: 'Setup command failed',
    });

    const step = readStep(eventQueries, attemptId, 'phase:kilo_server');
    expect(step.status).toBe('failed');
    expect(step.safeError).toBe('Setup command failed');
  });

  it('restarts a terminal attempt with a fresh startedAt', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId, lastEventAt } = seedRunningAttempt(eventQueries, { startedAt: 1000 });
    finalizePreparationAttempt(eventQueries, attemptId, {
      status: 'failed',
      safeError: 'boom',
      timestamp: lastEventAt,
    });
    const failedRevision = readAttempt(eventQueries, attemptId).revision;

    materializePreparationEvent(eventQueries, storedEvent(90_000), {
      version: 2,
      attemptId,
      triggerMessageId: 'msg-1',
      revision: failedRevision + 1,
      timestamp: 90_000,
      step: 'workspace_setup',
      message: 'Preparing environment',
      action: 'attempt_started',
    });

    const attempt = readAttempt(eventQueries, attemptId);
    expect(attempt.status).toBe('running');
    expect(attempt.startedAt).toBe(90_000);
  });
});

describe('finalizePreparationAttempt', () => {
  it('completes a running attempt and its running steps and returns the events', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId } = seedRunningAttempt(eventQueries);

    const events = finalizePreparationAttempt(eventQueries, attemptId, {
      status: 'completed',
      timestamp: 9000,
    });

    const attempt = readAttempt(eventQueries, attemptId);
    expect(attempt.status).toBe('completed');
    expect(attempt.completedAt).toBe(9000);
    const step = readStep(eventQueries, attemptId, 'phase:kilo_server');
    expect(step.status).toBe('completed');
    expect(step.completedAt).toBe(9000);
    expect(events.map(event => (JSON.parse(event.payload) as { action: string }).action)).toEqual([
      'step_completed',
      'attempt_completed',
    ]);
  });

  it('fails a running attempt with the given safe error', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId } = seedRunningAttempt(eventQueries);

    const events = finalizePreparationAttempt(eventQueries, attemptId, {
      status: 'failed',
      safeError: 'Environment preparation failed',
      timestamp: 9000,
    });

    const attempt = readAttempt(eventQueries, attemptId);
    expect(attempt.status).toBe('failed');
    expect(attempt.safeError).toBe('Environment preparation failed');
    expect(readStep(eventQueries, attemptId, 'phase:kilo_server').status).toBe('failed');
    expect(events).toHaveLength(2);
  });

  it('is a no-op for terminal and unknown attempts', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId } = seedRunningAttempt(eventQueries);
    finalizePreparationAttempt(eventQueries, attemptId, { status: 'completed', timestamp: 9000 });
    const before = readAttempt(eventQueries, attemptId);

    expect(
      finalizePreparationAttempt(eventQueries, attemptId, { status: 'completed', timestamp: 9999 })
    ).toEqual([]);
    expect(
      finalizePreparationAttempt(eventQueries, 'missing', { status: 'completed', timestamp: 9999 })
    ).toEqual([]);
    expect(readAttempt(eventQueries, attemptId)).toEqual(before);
  });
});

describe('readPreparationAttempt', () => {
  it('returns the materialized attempt snapshot or null', () => {
    const eventQueries = createMemoryEventQueries();
    expect(readPreparationAttempt(eventQueries, 'attempt-1')).toBeNull();
    const { attemptId } = seedRunningAttempt(eventQueries);
    expect(readPreparationAttempt(eventQueries, attemptId)?.status).toBe('running');
  });
});

describe('reconcileStalePreparationAttempts', () => {
  it('completes a stale running attempt and its running steps on a prepared session', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId, lastEventAt } = seedRunningAttempt(eventQueries);

    reconcileStalePreparationAttempts(eventQueries, {
      now: lastEventAt + 16 * MINUTE_MS,
      sessionPrepared: true,
    });

    const attempt = readAttempt(eventQueries, attemptId);
    expect(attempt.status).toBe('completed');
    expect(attempt.completedAt).toBe(lastEventAt);
    expect(attempt.safeError).toBeUndefined();
    const step = readStep(eventQueries, attemptId, 'phase:kilo_server');
    expect(step.status).toBe('completed');
    expect(step.completedAt).toBe(lastEventAt);
  });

  it('fails a stale running attempt when the session never became prepared', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId, lastEventAt } = seedRunningAttempt(eventQueries);

    reconcileStalePreparationAttempts(eventQueries, {
      now: lastEventAt + 16 * MINUTE_MS,
      sessionPrepared: false,
    });

    const attempt = readAttempt(eventQueries, attemptId);
    expect(attempt.status).toBe('failed');
    expect(attempt.safeError).toBe('Preparation did not complete');
    expect(readStep(eventQueries, attemptId, 'phase:kilo_server').status).toBe('failed');
  });

  it('leaves a recently updated running attempt untouched', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId, lastEventAt } = seedRunningAttempt(eventQueries);

    reconcileStalePreparationAttempts(eventQueries, {
      now: lastEventAt + 5 * MINUTE_MS,
      sessionPrepared: true,
    });

    expect(readAttempt(eventQueries, attemptId).status).toBe('running');
    expect(readStep(eventQueries, attemptId, 'phase:kilo_server').status).toBe('running');
  });

  it('leaves terminal attempts untouched', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId, lastEventAt } = seedRunningAttempt(eventQueries);
    materializePreparationEvent(eventQueries, storedEvent(lastEventAt + 1000), {
      version: 2,
      attemptId,
      triggerMessageId: 'msg-1',
      revision: 3,
      timestamp: lastEventAt + 1000,
      step: 'ready',
      message: 'Preparation complete',
      action: 'attempt_completed',
    });
    const before = readAttempt(eventQueries, attemptId);

    reconcileStalePreparationAttempts(eventQueries, {
      now: lastEventAt + 60 * MINUTE_MS,
      sessionPrepared: true,
    });

    expect(readAttempt(eventQueries, attemptId)).toEqual(before);
  });

  it('bumps revisions above the stale snapshots so clients apply the repair', () => {
    const eventQueries = createMemoryEventQueries();
    const { attemptId, lastEventAt } = seedRunningAttempt(eventQueries);
    const staleRevision = readAttempt(eventQueries, attemptId).revision;

    reconcileStalePreparationAttempts(eventQueries, {
      now: lastEventAt + 16 * MINUTE_MS,
      sessionPrepared: true,
    });

    const attempt = readAttempt(eventQueries, attemptId);
    expect(attempt.revision).toBeGreaterThan(staleRevision);
    const step = readStep(eventQueries, attemptId, 'phase:kilo_server');
    expect(step.revision).toBeGreaterThan(staleRevision);
    expect(step.revision).toBeLessThanOrEqual(attempt.revision);
    const snapshots = getPreparationSnapshots(eventQueries);
    expect(snapshots).toHaveLength(2);
  });
});

describe('cloudStatusForPreparingEvent', () => {
  const v2 = {
    version: 2,
    attemptId: 'attempt-1',
    triggerMessageId: 'msg-1',
    revision: 5,
    timestamp: 1000,
  };

  it('maps applied v2 events by action', () => {
    expect(
      cloudStatusForPreparingEvent(
        { ...v2, step: 'cloning', message: 'Cloning…', action: 'step_progress' },
        true
      )
    ).toEqual({ type: 'preparing', step: 'cloning', message: 'Cloning…' });
    expect(
      cloudStatusForPreparingEvent(
        { ...v2, step: 'ready', message: 'Preparation complete', action: 'attempt_completed' },
        true
      )
    ).toEqual({ type: 'ready' });
    expect(
      cloudStatusForPreparingEvent(
        { ...v2, step: 'failed', message: 'nope', action: 'attempt_failed', safeError: 'boom' },
        true
      )
    ).toEqual({ type: 'error', message: 'boom' });
  });

  it('suppresses the broadcast for stale v2 events', () => {
    expect(
      cloudStatusForPreparingEvent(
        { ...v2, step: 'cloning', message: 'Cloning…', action: 'step_progress' },
        false
      )
    ).toBeNull();
    expect(
      cloudStatusForPreparingEvent(
        { ...v2, step: 'ready', message: 'Preparation complete', action: 'attempt_completed' },
        false
      )
    ).toBeNull();
  });

  it('maps legacy v1 events by step', () => {
    expect(cloudStatusForPreparingEvent({ step: 'cloning', message: 'Cloning…' }, false)).toEqual({
      type: 'preparing',
      step: 'cloning',
      message: 'Cloning…',
    });
    expect(cloudStatusForPreparingEvent({ step: 'ready', message: 'Done' }, false)).toEqual({
      type: 'ready',
    });
    expect(cloudStatusForPreparingEvent({ step: 'failed', message: 'nope' }, false)).toEqual({
      type: 'error',
      message: 'nope',
    });
    expect(cloudStatusForPreparingEvent('not-an-object', false)).toBeNull();
  });
});
