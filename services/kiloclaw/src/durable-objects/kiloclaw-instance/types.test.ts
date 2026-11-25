import { describe, expect, it } from 'vitest';
import { getAppKey } from './types';
import { sandboxIdFromUserId } from '../../auth/sandbox-id';

describe('getAppKey', () => {
  it('derives the legacy app owner key from sandboxId instead of migrated userId', () => {
    const legacyUserId = 'oauth/google:100000000000000000005';

    expect(
      getAppKey({
        userId: '22222222-2222-4222-8222-222222222222',
        sandboxId: sandboxIdFromUserId(legacyUserId),
      })
    ).toBe(legacyUserId);
  });

  it('keeps instance-keyed sandboxes on the instanceId owner key', () => {
    expect(
      getAppKey({
        userId: '22222222-2222-4222-8222-222222222222',
        sandboxId: 'ki_11111111111141118111111111111111',
      })
    ).toBe('11111111-1111-4111-8111-111111111111');
  });
});
