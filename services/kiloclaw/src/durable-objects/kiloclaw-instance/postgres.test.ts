import { describe, expect, it } from 'vitest';
import { fallbackAppNameForRestore } from './postgres';
import { sandboxIdFromUserId } from '../../auth/sandbox-id';
import { appNameFromUserId, appNameFromInstanceId } from '../../fly/apps';

describe('fallbackAppNameForRestore', () => {
  it('keeps migrated legacy sandboxes on the acct-* naming path', async () => {
    const legacyUserId = 'oauth/google:117453785559478190551';
    const migratedUserId = '199e2b19-aa40-488d-9442-9a18a620ba68';

    await expect(
      fallbackAppNameForRestore(migratedUserId, sandboxIdFromUserId(legacyUserId))
    ).resolves.toBe(await appNameFromUserId(legacyUserId));
  });

  it('keeps ki_ sandboxes on the inst-* naming path', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';

    await expect(
      fallbackAppNameForRestore(
        '199e2b19-aa40-488d-9442-9a18a620ba68',
        'ki_11111111111141118111111111111111'
      )
    ).resolves.toBe(await appNameFromInstanceId(instanceId));
  });
});
