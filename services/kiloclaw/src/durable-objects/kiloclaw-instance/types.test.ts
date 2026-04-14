import { describe, expect, it } from 'vitest';
import { getAppKey } from './types';
import { sandboxIdFromUserId } from '../../auth/sandbox-id';

describe('getAppKey', () => {
  it('derives the legacy app owner key from sandboxId instead of migrated userId', () => {
    const legacyUserId = 'oauth/google:117453785559478190551';

    expect(
      getAppKey({
        userId: '199e2b19-aa40-488d-9442-9a18a620ba68',
        sandboxId: sandboxIdFromUserId(legacyUserId),
      })
    ).toBe(legacyUserId);
  });

  it('keeps instance-keyed sandboxes on the instanceId owner key', () => {
    expect(
      getAppKey({
        userId: '199e2b19-aa40-488d-9442-9a18a620ba68',
        sandboxId: 'ki_11111111111141118111111111111111',
      })
    ).toBe('11111111-1111-4111-8111-111111111111');
  });
});
