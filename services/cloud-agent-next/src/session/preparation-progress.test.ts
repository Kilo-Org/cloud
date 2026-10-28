import { describe, expect, it } from 'vitest';
import { createPreparationProgressRecorder } from './preparation-progress.js';
import { materializePreparationEvent, readPreparationSteps } from './preparation-history.js';
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

  it('drops an identical repeated report', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);

    recorder.onProgress('sandbox_provision', 'Creating sandbox');
    recorder.onProgress('sandbox_provision', 'Creating sandbox');

    expect(broadcastActions(broadcasts)).toEqual([
      'attempt_started',
      'step_started',
      'step_progress',
    ]);
  });

  it('preserves phase occurrences in causal order through a snapshot fallback', () => {
    const eventQueries = createMemoryEventQueries();
    const recorder = createRecorder(eventQueries, []);
    const progress = [
      ['sandbox_provision', 'Creating sandbox'],
      ['sandbox_boot', 'Starting sandbox'],
      ['workspace_restore', 'Updating repository'],
      ['sandbox_provision', 'Creating sandbox'],
      ['snapshot_fallback', 'Previous snapshot startup failed. Retrying without a snapshot.'],
      ['sandbox_boot', 'Starting sandbox without a snapshot'],
      ['cloning', 'Cloning repository'],
    ];
    for (const [key, detail] of progress) recorder.onProgress(key, detail);
    recorder.finalize({ status: 'completed' });

    const steps = readPreparationSteps(eventQueries, 'attempt-1');
    expect(steps.map(step => [step.key, step.latestDetail])).toEqual(progress);
    expect(new Set(steps.map(step => step.id)).size).toBe(progress.length);
    expect(steps.every(step => step.status === 'completed')).toBe(true);
    expect(steps.map(step => step.startedRevision)).toEqual([2, 5, 8, 11, 14, 17, 20]);
  });

  it('resumes a retried phase after eviction without restarting it', () => {
    const eventQueries = createMemoryEventQueries();
    const first = createRecorder(eventQueries, []);
    first.onProgress('sandbox_provision', 'Creating sandbox');
    first.onProgress('snapshot_fallback', 'Retrying without a snapshot');
    first.onProgress('sandbox_provision', 'Creating replacement sandbox');
    const retry = readPreparationSteps(eventQueries, 'attempt-1').at(-1);

    const broadcasts: StoredEvent[] = [];
    const resumed = createRecorder(eventQueries, broadcasts);
    resumed.onProgress('sandbox_provision', 'Creating replacement sandbox');
    expect(broadcasts).toEqual([]);
    resumed.onProgress('sandbox_provision', 'Replacement sandbox created');

    expect(readPreparationSteps(eventQueries, 'attempt-1')).toHaveLength(3);
    expect(readPreparationSteps(eventQueries, 'attempt-1').at(-1)).toMatchObject({
      id: retry?.id,
      startedAt: retry?.startedAt,
      startedRevision: retry?.startedRevision,
      latestDetail: 'Replacement sandbox created',
    });
  });

  it('a fresh recorder for an open attempt closes the step its evicted predecessor left running', () => {
    const eventQueries = createMemoryEventQueries();
    createRecorder(eventQueries, []).onProgress('cloning', 'Cloning repository');
    const startedAt = readStep(eventQueries, 'attempt-1', 'phase:cloning').startedAt;

    // The DO was evicted: the next progress arrives at a new recorder.
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);
    recorder.onProgress('cloning', 'Cloning repository... Receiving objects: 45%');
    expect(readStep(eventQueries, 'attempt-1', 'phase:cloning')).toMatchObject({
      status: 'running',
      startedAt,
      latestDetail: 'Cloning repository... Receiving objects: 45%',
    });

    createRecorder(eventQueries, broadcasts).onProgress('branch', 'Checking out branch');
    expect(readStep(eventQueries, 'attempt-1', 'phase:cloning').status).toBe('completed');
    expect(readStep(eventQueries, 'attempt-1', 'phase:branch').status).toBe('running');
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
    broadcasts.length = 0;
    recorder.onProgress('sandbox_provision', 'Provisioning sandbox\u2026');
    expect(broadcasts).toEqual([]);
    expect(readPreparationSteps(eventQueries, 'attempt-1')).toHaveLength(2);
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

  it('ignores progress received after the attempt was finalized', () => {
    const eventQueries = createMemoryEventQueries();
    const broadcasts: StoredEvent[] = [];
    const recorder = createRecorder(eventQueries, broadcasts);

    recorder.onProgress('sandbox_provision', 'Provisioning sandbox…');
    recorder.finalize({ status: 'failed', safeError: 'Environment preparation failed' });
    broadcasts.length = 0;

    expect(recorder.onProgress('cloning', 'Cloning repository…')).toBe(false);
    expect(broadcasts).toEqual([]);
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
