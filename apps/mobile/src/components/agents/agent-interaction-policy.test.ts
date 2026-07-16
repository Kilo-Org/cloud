import { describe, expect, it } from 'vitest';

import { getBlockingInteraction } from './agent-interaction-policy';

describe('getBlockingInteraction', () => {
  it('returns none without a question or permission', () => {
    expect(getBlockingInteraction({ activeQuestion: null, activePermission: null })).toBe('none');
  });

  it('returns permission when only permission is active', () => {
    expect(
      getBlockingInteraction({ activeQuestion: null, activePermission: { requestId: 'perm-1' } })
    ).toBe('permission');
  });

  it('gives question priority when both are active', () => {
    expect(
      getBlockingInteraction({
        activeQuestion: { requestId: 'question-1' },
        activePermission: { requestId: 'perm-1' },
      })
    ).toBe('question');
  });
});
