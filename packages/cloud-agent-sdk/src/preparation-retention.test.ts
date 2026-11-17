import { normalize } from './normalizer';
import {
  PREPARATION_MAX_ATTEMPTS,
  PREPARATION_MAX_DETAIL_LENGTH,
  PREPARATION_MAX_MESSAGE_LENGTH,
  PREPARATION_MAX_SETUP_LOG_ENTRIES,
  PREPARATION_MAX_STEPS,
} from './schemas';
import { createServiceState, type ServiceState } from './service-state';

const base = {
  version: 2,
  step: 'setup_commands',
  message: 'Preparing workspace',
  attemptId: 'attempt',
  triggerMessageId: 'message',
  revision: 1,
  timestamp: 1,
  action: 'step_progress',
};

function normalizePreparation(data: Record<string, unknown>) {
  return normalize({
    eventId: 1,
    executionId: 'execution',
    sessionId: 'session',
    streamEventType: 'preparing',
    timestamp: '2026-01-01T00:00:00.000Z',
    data,
  });
}

function processPreparation(state: ServiceState, data: Record<string, unknown>) {
  const event = normalizePreparation(data);
  if (!event || event.type !== 'preparing') throw new Error('Expected preparation event');
  state.process(event);
}

const stepSnapshot = (index: number) => ({
  id: `step-${index}`,
  key: 'setup_commands',
  kind: 'setup_command',
  label: `Command ${index}`,
  status: 'running',
  startedAt: 1_000 - index,
  startedRevision: index + 2,
  revision: index + 2,
});

describe('preparation diagnostics', () => {
  it.each(['attempt_started', 'attempt_snapshot'])(
    'retains the newest orphan step snapshot until %s without requiring redelivery',
    action => {
      const state = createServiceState({ rootSessionId: 'session' });
      const snapshot = { ...stepSnapshot(0), revision: 5, outputTail: 'latest output' };
      for (const step of [snapshot, { ...snapshot, revision: 4, outputTail: 'stale output' }]) {
        processPreparation(state, {
          ...base,
          action: 'step_snapshot',
          revision: step.revision,
          stepId: step.id,
          stepSnapshot: step,
        });
      }
      expect(state.getPreparationAttempts()).toEqual([]);
      expect(state.getCloudStatus()).toBeNull();
      processPreparation(state, {
        ...base,
        action,
        revision: 3,
        attempt: {
          id: base.attemptId,
          triggerMessageId: base.triggerMessageId,
          status: 'completed',
          startedAt: 1,
          completedAt: 2,
          revision: 3,
        },
      });
      expect(state.getPreparationAttempts()).toMatchObject([
        { id: base.attemptId, revision: 5, steps: [snapshot] },
      ]);
      expect(state.getCloudStatus()?.type).toBe(
        action === 'attempt_snapshot' ? 'ready' : 'preparing'
      );
    }
  );

  it.each(['clearPreparationAttempts', 'reset'] as const)(
    '%s discards orphan step snapshots',
    clear => {
      const state = createServiceState({ rootSessionId: 'session' });
      processPreparation(state, {
        ...base,
        action: 'step_snapshot',
        stepId: 'step-0',
        stepSnapshot: stepSnapshot(0),
      });
      state[clear]();
      processPreparation(state, { ...base, action: 'attempt_started' });
      expect(state.getPreparationAttempts()[0]?.steps).toEqual([]);
    }
  );

  it('bounds orphan step snapshots by the preparation history budget', () => {
    const state = createServiceState({ rootSessionId: 'session' });
    const count = PREPARATION_MAX_ATTEMPTS * PREPARATION_MAX_STEPS;
    for (let index = 0; index <= count; index++) {
      processPreparation(state, {
        ...base,
        attemptId: `attempt-${index}`,
        action: 'step_snapshot',
        stepId: 'step-0',
        stepSnapshot: stepSnapshot(0),
      });
    }
    processPreparation(state, { ...base, attemptId: 'attempt-0', action: 'attempt_started' });
    expect(state.getPreparationAttempts()[0]?.steps).toEqual([]);
    processPreparation(state, {
      ...base,
      attemptId: `attempt-${count}`,
      action: 'attempt_started',
    });
    expect(state.getPreparationAttempts()[1]?.steps).toEqual([stepSnapshot(0)]);
  });

  it('retains recent setup messages and clears them on completion', () => {
    const state = createServiceState({ rootSessionId: 'session' });
    const messages = Array.from(
      { length: PREPARATION_MAX_SETUP_LOG_ENTRIES * 3 },
      (_, index) => `Setup ${index}`
    );
    for (const message of messages) {
      processPreparation(state, { step: 'setup_commands', message });
    }
    expect(state.getSetupLog()).toEqual(messages.slice(-PREPARATION_MAX_SETUP_LOG_ENTRIES));
    processPreparation(state, { step: 'ready', message: 'Ready' });
    expect(state.getSetupLog()).toEqual([]);
    expect(state.getCloudStatus()).toEqual({ type: 'ready' });
  });

  it.each(['attempt_started', 'attempt_snapshot'])('retains recent attempts: %s', action => {
    const state = createServiceState({ rootSessionId: 'session' });
    const count = PREPARATION_MAX_ATTEMPTS * 3;
    for (let index = count - 1; index >= 0; index--) {
      processPreparation(state, {
        ...base,
        action,
        attemptId: `attempt-${index}`,
        timestamp: index,
        attempt: {
          id: `attempt-${index}`,
          triggerMessageId: 'message',
          status: 'running',
          startedAt: index,
          revision: 1,
        },
      });
    }
    const ids = Array.from(
      { length: PREPARATION_MAX_ATTEMPTS },
      (_, index) => `attempt-${count - PREPARATION_MAX_ATTEMPTS + index}`
    );
    expect(state.getPreparationAttempts().map(attempt => attempt.id)).toEqual(ids);
    processPreparation(state, {
      ...base,
      attemptId: ids[0],
      action: 'attempt_completed',
      revision: 2,
      timestamp: count + 1,
      step: 'ready',
    });
    expect(state.getPreparationAttempts().map(attempt => attempt.id)).toEqual(ids);
    expect(state.getPreparationAttempts()[0]?.status).toBe('completed');
    expect(state.getCloudStatus()).toEqual({ type: 'ready' });
  });

  it.each(['attempt_started', 'attempt_snapshot'])(
    'preserves ready status during replay: %s',
    action => {
      const state = createServiceState({ rootSessionId: 'session' });
      for (let index = 0; index <= PREPARATION_MAX_ATTEMPTS; index++) {
        processPreparation(state, {
          ...base,
          attemptId: `attempt-${index}`,
          timestamp: index,
          action: 'attempt_started',
        });
        processPreparation(state, {
          ...base,
          attemptId: `attempt-${index}`,
          timestamp: index,
          revision: 2,
          action: 'attempt_completed',
          step: 'ready',
        });
      }
      const retained = state.getPreparationAttempts();
      processPreparation(state, {
        ...base,
        attemptId: 'attempt-0',
        timestamp: 0,
        action,
        attempt: {
          id: 'attempt-0',
          triggerMessageId: 'message',
          status: 'running',
          startedAt: 0,
          revision: 1,
        },
      });
      expect(state.getPreparationAttempts()).toEqual(retained);
      expect(state.getCloudStatus()).toEqual({ type: 'ready' });
    }
  );

  it.each(['step_started', 'step_snapshot'])('retains causal step order: %s', action => {
    const state = createServiceState({ rootSessionId: 'session' });
    processPreparation(state, { ...base, action: 'attempt_started' });
    const count = PREPARATION_MAX_STEPS * 3;
    for (let index = count - 1; index >= 0; index--) {
      const snapshot = stepSnapshot(index);
      processPreparation(state, {
        ...base,
        action,
        stepId: snapshot.id,
        kind: snapshot.kind,
        label: snapshot.label,
        revision: snapshot.revision,
        timestamp: snapshot.startedAt,
        stepSnapshot: snapshot,
      });
    }
    const ids = Array.from(
      { length: PREPARATION_MAX_STEPS },
      (_, index) => `step-${count - PREPARATION_MAX_STEPS + index}`
    );
    const retained = () => state.getPreparationAttempts()[0]?.steps;
    expect(retained()?.map(step => step.id)).toEqual(ids);
    const previous = retained();
    processPreparation(state, {
      ...base,
      action: 'step_progress',
      stepId: ids[0],
      revision: count + 2,
      detail: 'Finishing command',
    });
    expect(retained()?.map(step => step.id)).toEqual(ids);
    expect(retained()?.[0]?.latestDetail).toBe('Finishing command');
    expect(previous?.[0]?.latestDetail).toBeUndefined();
    processPreparation(state, {
      ...base,
      action: 'attempt_completed',
      revision: count + 3,
      step: 'ready',
    });
    expect(retained()?.every(step => step.status === 'completed')).toBe(true);
    state.reset();
    expect(state.getPreparationAttempts()).toEqual([]);
  });

  it.each([
    ['message', PREPARATION_MAX_MESSAGE_LENGTH],
    ['detail', PREPARATION_MAX_DETAIL_LENGTH],
  ] as const)('applies the %s text policy', (field, limit) => {
    expect(normalizePreparation({ ...base, [field]: 'x'.repeat(limit) })).toMatchObject({
      type: 'preparing',
      [field]: 'x'.repeat(limit),
    });
    expect(normalizePreparation({ ...base, [field]: 'x'.repeat(limit + 1) })).toBeNull();
  });

  it('applies the detail policy to replayed steps', () => {
    const data = {
      ...base,
      action: 'step_snapshot',
      stepId: 'step-0',
      stepSnapshot: {
        ...stepSnapshot(0),
        latestDetail: 'x'.repeat(PREPARATION_MAX_DETAIL_LENGTH),
      },
    };
    expect(normalizePreparation(data)).toMatchObject({
      type: 'preparing',
      stepSnapshot: data.stepSnapshot,
    });
    expect(
      normalizePreparation({
        ...data,
        stepSnapshot: { ...data.stepSnapshot, latestDetail: `${data.stepSnapshot.latestDetail}x` },
      })
    ).toBeNull();
  });
});
