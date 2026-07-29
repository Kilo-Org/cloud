import type { PreparationAttempt, PreparationStepSnapshot } from './types';
import { isNoOpCompletedPreparationAttempt } from './preparation-attempts';

function step(overrides: Partial<PreparationStepSnapshot>): PreparationStepSnapshot {
  return {
    id: 'step-1',
    key: 'workspace_setup',
    kind: 'phase',
    label: 'workspace setup',
    status: 'running',
    startedAt: 1000,
    revision: 1,
    ...overrides,
  };
}

function attempt(overrides: Partial<PreparationAttempt>): PreparationAttempt {
  return {
    id: 'attempt-1',
    triggerMessageId: 'message-1',
    status: 'running',
    startedAt: 1000,
    revision: 1,
    steps: [],
    ...overrides,
  };
}

describe('isNoOpCompletedPreparationAttempt', () => {
  it('treats a completed attempt with no steps as a no-op', () => {
    expect(isNoOpCompletedPreparationAttempt(attempt({ status: 'completed' }))).toBe(true);
  });

  it('treats a completed attempt with only synthetic sandbox markers as a no-op', () => {
    const warmReuse = attempt({
      status: 'completed',
      steps: [
        step({
          id: 'a',
          key: 'sandbox_provision',
          label: 'sandbox_provision',
          status: 'completed',
        }),
        step({ id: 'b', key: 'sandbox_boot', label: 'sandbox_boot', status: 'completed' }),
      ],
    });
    expect(isNoOpCompletedPreparationAttempt(warmReuse)).toBe(true);
  });

  it('does not treat a completed attempt with a substantive step as a no-op', () => {
    const coldStart = attempt({
      status: 'completed',
      steps: [
        step({
          id: 'a',
          key: 'sandbox_provision',
          label: 'sandbox_provision',
          status: 'completed',
        }),
        step({ id: 'b', key: 'cloning', label: 'cloning', status: 'completed' }),
      ],
    });
    expect(isNoOpCompletedPreparationAttempt(coldStart)).toBe(false);
  });

  it('never treats a running attempt as a no-op', () => {
    const running = attempt({
      status: 'running',
      steps: [step({ key: 'sandbox_provision', label: 'sandbox_provision' })],
    });
    expect(isNoOpCompletedPreparationAttempt(running)).toBe(false);
  });

  it('never treats a failed attempt as a no-op', () => {
    const failed = attempt({ status: 'failed' });
    expect(isNoOpCompletedPreparationAttempt(failed)).toBe(false);
  });
});
