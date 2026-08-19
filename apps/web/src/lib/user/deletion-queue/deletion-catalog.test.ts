import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import {
  catalogEntryFor,
  catalogForVersion,
  preReplyStepKeys,
  USER_DELETION_CATALOG_V1,
} from '@/lib/user/deletion-queue/deletion-catalog';

describe('deletion catalog v1', () => {
  it('has active aggregate tasks (CSA-handled tasks commented out)', () => {
    expect(USER_DELETION_CATALOG_V1).toHaveLength(6);
    expect(catalogForVersion(1).map(entry => entry.stepKey)).toEqual([
      UserDeletionStepKey.KiloclawDestroy,
      UserDeletionStepKey.Customerio,
      UserDeletionStepKey.CliV1Blobs,
      UserDeletionStepKey.CliV2Sessions,
      UserDeletionStepKey.UsagePromptPrefixes,
      UserDeletionStepKey.Anonymize,
    ]);
  });

  it('does not allow manual verification for usage prompt cleanup or anonymize', () => {
    expect(catalogEntryFor(1, UserDeletionStepKey.UsagePromptPrefixes)).toMatchObject({
      allowsManualVerification: false,
    });
    expect(catalogEntryFor(1, UserDeletionStepKey.Anonymize).allowsManualVerification).toBe(false);
  });

  it('requires teardown before anonymize', () => {
    expect(catalogEntryFor(1, UserDeletionStepKey.Anonymize).dependsOn).toHaveLength(5);
    expect(preReplyStepKeys()).toHaveLength(6);
  });

  it('rejects an unknown catalog version', () => {
    expect(() => catalogForVersion(2)).toThrow(/Unsupported/);
  });
});
