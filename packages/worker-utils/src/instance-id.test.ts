import { describe, expect, it } from 'vitest';
import { imageRolloutSubjectFromSandboxId, sandboxIdFromInstanceId } from './instance-id';

describe('imageRolloutSubjectFromSandboxId', () => {
  it('uses userId for legacy sandboxIds', () => {
    expect(imageRolloutSubjectFromSandboxId('dXNlci1sZWdhY3k', 'user-legacy')).toBe('user-legacy');
  });

  it('decodes the rollout subject from ki_ sandboxIds', () => {
    const instanceId = '11111111-2222-4333-8444-555555555555';

    expect(
      imageRolloutSubjectFromSandboxId(sandboxIdFromInstanceId(instanceId), 'user-instance-keyed')
    ).toBe(instanceId);
  });

  it('uses userId when sandboxId is absent', () => {
    expect(imageRolloutSubjectFromSandboxId(null, 'user-missing-sandbox')).toBe(
      'user-missing-sandbox'
    );
  });
});
