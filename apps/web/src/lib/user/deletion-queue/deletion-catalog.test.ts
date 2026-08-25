import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import {
  catalogEntryFor,
  catalogForVersion,
  preReplyStepKeys,
  teardownStepKeys,
  USER_DELETION_CATALOG_V1,
  USER_DELETION_CATALOG_V2,
} from '@/lib/user/deletion-queue/deletion-catalog';

describe('deletion catalog v1', () => {
  it('stays frozen at the original six Cloud steps', () => {
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
    expect(preReplyStepKeys(1)).toHaveLength(6);
    expect(teardownStepKeys(1)).toHaveLength(5);
  });
});

describe('deletion catalog v2', () => {
  it('includes PostHog, Substack, Pylon finalize, and CSA support DB', () => {
    expect(USER_DELETION_CATALOG_V2).toHaveLength(12);
    expect(catalogForVersion(2).map(entry => entry.stepKey)).toEqual([
      UserDeletionStepKey.KiloclawDestroy,
      UserDeletionStepKey.Customerio,
      UserDeletionStepKey.CliV1Blobs,
      UserDeletionStepKey.CliV2Sessions,
      UserDeletionStepKey.UsagePromptPrefixes,
      UserDeletionStepKey.Posthog,
      UserDeletionStepKey.Substack,
      UserDeletionStepKey.Anonymize,
      UserDeletionStepKey.PylonReply,
      UserDeletionStepKey.PylonFinalize,
      UserDeletionStepKey.PylonContact,
      UserDeletionStepKey.CsaSupportDb,
    ]);
  });

  it('requires PostHog and Substack before anonymize', () => {
    expect(catalogEntryFor(2, UserDeletionStepKey.Anonymize).dependsOn).toEqual(
      expect.arrayContaining([UserDeletionStepKey.Posthog, UserDeletionStepKey.Substack])
    );
    expect(preReplyStepKeys(2)).toHaveLength(8);
    expect(teardownStepKeys(2)).toHaveLength(7);
  });

  it('chains finalize after reply, then contact, then CSA support DB', () => {
    expect(catalogEntryFor(2, UserDeletionStepKey.PylonFinalize).dependsOn).toEqual([
      UserDeletionStepKey.PylonReply,
    ]);
    expect(catalogEntryFor(2, UserDeletionStepKey.PylonContact).dependsOn).toEqual([
      UserDeletionStepKey.PylonFinalize,
    ]);
    expect(catalogEntryFor(2, UserDeletionStepKey.CsaSupportDb).dependsOn).toEqual([
      UserDeletionStepKey.PylonContact,
    ]);
  });

  it('rejects an unknown catalog version', () => {
    expect(() => catalogForVersion(3)).toThrow(/Unsupported/);
  });
});
