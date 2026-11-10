import type { PreparationAttempt, PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { environmentBuildRecoveryOffered } from './environment-build-recovery';

function phase(key: string, startedAt: number): PreparationStepSnapshot {
  return {
    id: `phase:${key}`,
    key,
    kind: 'phase',
    label: key,
    status: 'completed',
    startedAt,
    revision: startedAt,
  };
}

function attempt(
  id: string,
  status: PreparationAttempt['status'],
  startedAt: number,
  steps: PreparationStepSnapshot[]
): PreparationAttempt {
  return { id, triggerMessageId: 'm1', status, startedAt, revision: 1, steps };
}

describe('environmentBuildRecoveryOffered', () => {
  const failedAtEnvironment = attempt('a1', 'failed', 10, [
    phase('sandbox_provision', 11),
    phase('environment_snapshot', 12),
  ]);

  it('offers the environment when the latest attempt failed at the environment snapshot', () => {
    expect(
      environmentBuildRecoveryOffered({
        cloudStatus: { type: 'error' },
        attempts: [failedAtEnvironment],
        environmentId: 'env-1',
      })
    ).toBe('env-1');
  });

  it('does not offer it when the attempt failed at a later step', () => {
    expect(
      environmentBuildRecoveryOffered({
        cloudStatus: { type: 'error' },
        attempts: [
          attempt('a1', 'failed', 10, [phase('environment_snapshot', 11), phase('cloning', 12)]),
        ],
        environmentId: 'env-1',
      })
    ).toBeNull();
  });

  it('uses only the latest attempt', () => {
    expect(
      environmentBuildRecoveryOffered({
        cloudStatus: { type: 'error' },
        attempts: [failedAtEnvironment, attempt('a2', 'failed', 20, [phase('cloning', 21)])],
        environmentId: 'env-1',
      })
    ).toBeNull();
  });

  it('does not offer it without an environment or outside the error state', () => {
    expect(
      environmentBuildRecoveryOffered({
        cloudStatus: { type: 'error' },
        attempts: [failedAtEnvironment],
        environmentId: null,
      })
    ).toBeNull();
    expect(
      environmentBuildRecoveryOffered({
        cloudStatus: { type: 'ready' },
        attempts: [failedAtEnvironment],
        environmentId: 'env-1',
      })
    ).toBeNull();
  });
});
