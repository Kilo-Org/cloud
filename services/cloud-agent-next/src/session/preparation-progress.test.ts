import { describe, expect, it } from 'vitest';
import { createPreparationProgressRecorder } from './preparation-progress.js';
import { materializePreparationEvent } from './preparation-history.js';
import {
  createMemoryEventQueries,
  readAttempt,
  readStep,
  storedEvent,
} from './preparation-test-helpers.js';
import type { EventQueries } from './queries/index.js';
import type { StoredEvent } from '../websocket/types.js';

function createRecorder(eventQueries: EventQueries, broadcasts: StoredEvent[]) {
  let tick = 1000;
  return createPreparationProgressRecorder({
    attemptId: 'attempt-1',
    triggerMessageId: 'msg-1',
    sessionId: 'sess-1',
    eventQueries,
    broadcast: event => broadcasts.push(event),
    now: () => tick++,
  });
}

function broadcastActions(broadcasts: StoredEvent[]): string[] {
  return broadcasts.map(event => (JSON.parse(event.payload) as { action: string }).action);
}

describe('createPreparationProgressRecorder', () => {
  it('starts the attempt on first progress and tracks step transitions', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);

    recorder.onProgress('sandbox_provision', 'Provisioning sandbox…');
    recorder.onProgress('disk_check', 'Checking disk space…');

    const attempt = readAttempt(eventQueries, 'attempt-1');
    expect(attempt.status).toBe('running');
    expect(readStep(eventQueries, 'attempt-1', 'phase:sandbox_provision').status).toBe('completed');
    const diskCheck = readStep(eventQueries, 'attempt-1', 'phase:disk_check');
    expect(diskCheck.status).toBe('running');
    expect(diskCheck.latestDetail).toBe('Checking disk space…');
    expect(broadcastActions(broadcasts)).toEqual([
      'attempt_started',
      'step_started',
      'step_progress',
      'step_completed',
      'step_started',
      'step_progress',
    ]);
  });

  it('repeated progress on the same step only updates the detail', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);

    recorder.onProgress('sandbox_provision', 'Provisioning sandbox…');
    recorder.onProgress('sandbox_provision', 'Still provisioning…');

    const step = readStep(eventQueries, 'attempt-1', 'phase:sandbox_provision');
    expect(step.status).toBe('running');
    expect(step.latestDetail).toBe('Still provisioning…');
    expect(broadcastActions(broadcasts)).toEqual([
      'attempt_started',
      'step_started',
      'step_progress',
      'step_progress',
    ]);
  });

  it('keeps sandbox provisioning distinct from wrapper workspace setup', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);
    recorder.onProgress('sandbox_provision', 'Provisioning sandbox…');

    const wrapperRevision = 1_750_000_000_000;
    materializePreparationEvent(eventQueries, storedEvent(2000), {
      version: 2,
      attemptId: 'attempt-1',
      triggerMessageId: 'msg-1',
      revision: wrapperRevision,
      timestamp: 2000,
      step: 'workspace_setup',
      message: 'Preparing environment',
      action: 'attempt_started',
    });
    materializePreparationEvent(eventQueries, storedEvent(2001), {
      version: 2,
      attemptId: 'attempt-1',
      triggerMessageId: 'msg-1',
      revision: wrapperRevision + 1,
      timestamp: 2001,
      step: 'workspace_setup',
      message: 'Setting up workspace',
      action: 'step_started',
      stepId: 'phase:workspace_setup',
      kind: 'phase',
      label: 'workspace setup',
    });

    expect(readStep(eventQueries, 'attempt-1', 'phase:sandbox_provision').status).toBe('completed');
    expect(readStep(eventQueries, 'attempt-1', 'phase:workspace_setup').status).toBe('running');
  });

  it('finalize completes the running attempt and broadcasts the terminal events', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);
    recorder.onProgress('kilo_server', 'Starting Kilo…');
    broadcasts.length = 0;

    recorder.finalize({ status: 'completed' });

    expect(readAttempt(eventQueries, 'attempt-1').status).toBe('completed');
    expect(readStep(eventQueries, 'attempt-1', 'phase:kilo_server').status).toBe('completed');
    expect(broadcastActions(broadcasts)).toEqual(['step_completed', 'attempt_completed']);
  });

  it('finalize marks the attempt failed with the safe error', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);
    recorder.onProgress('kilo_server', 'Starting Kilo…');

    recorder.finalize({ status: 'failed', safeError: 'Environment preparation failed' });

    const attempt = readAttempt(eventQueries, 'attempt-1');
    expect(attempt.status).toBe('failed');
    expect(attempt.safeError).toBe('Environment preparation failed');
  });

  it('finalize is a no-op when no preparation progress was observed', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);

    recorder.finalize({ status: 'failed', safeError: 'Environment preparation failed' });

    expect(broadcasts).toEqual([]);
    expect(eventQueries.findByEntityPrefix('preparation/attempt/')).toEqual([]);
  });

  it('finalize settles an attempt the wrapper continued but never terminated', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);
    recorder.onProgress('sandbox_provision', 'Provisioning sandbox…');

    // The wrapper joins the same attempt with epoch-scale revisions and then
    // loses its terminal event.
    const wrapperRevision = 1_750_000_000_000;
    materializePreparationEvent(eventQueries, storedEvent(5000), {
      version: 2,
      attemptId: 'attempt-1',
      triggerMessageId: 'msg-1',
      revision: wrapperRevision,
      timestamp: 5000,
      step: 'cloning',
      message: 'Cloning repository',
      action: 'step_started',
      stepId: 'phase:cloning',
      kind: 'phase',
      label: 'cloning',
    });

    recorder.finalize({ status: 'completed' });

    const attempt = readAttempt(eventQueries, 'attempt-1');
    expect(attempt.status).toBe('completed');
    expect(attempt.revision).toBeGreaterThan(wrapperRevision);
    expect(attempt.startedAt).toBe(1000);
    expect(readStep(eventQueries, 'attempt-1', 'phase:cloning').status).toBe('completed');
  });
});
