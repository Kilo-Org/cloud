import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import {
  catalogEntryFor,
  catalogForVersion,
  preReplyStepKeys,
  teardownStepKeys,
  USER_DELETION_CATALOG_V1,
  USER_DELETION_CATALOG_V2,
  validateMaterializedStepKeys,
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
  it('includes the completion email between Pylon finalize and contact cleanup', () => {
    expect(USER_DELETION_CATALOG_V2).toHaveLength(13);
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
      UserDeletionStepKey.CompletionEmail,
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
      UserDeletionStepKey.CompletionEmail,
    ]);
    expect(catalogEntryFor(2, UserDeletionStepKey.CsaSupportDb).dependsOn).toEqual([
      UserDeletionStepKey.PylonContact,
    ]);
  });

  it('does not select completion email before teardown and anonymize', () => {
    expect(catalogEntryFor(2, UserDeletionStepKey.CompletionEmail).dependsOn).toEqual([
      ...teardownStepKeys(2),
      UserDeletionStepKey.Anonymize,
    ]);
    expect(catalogEntryFor(2, UserDeletionStepKey.CompletionEmail)).toMatchObject({
      phase: 'finalize',
      allowsManualVerification: true,
    });
  });

  it('rejects an unknown catalog version', () => {
    expect(() => catalogForVersion(3)).toThrow(/Unsupported/);
  });

  it('rejects duplicate and unknown materialized task keys', () => {
    expect(() =>
      validateMaterializedStepKeys(2, [
        UserDeletionStepKey.Anonymize,
        UserDeletionStepKey.Anonymize,
      ])
    ).toThrow(/duplicate step/);
    expect(() => validateMaterializedStepKeys(2, ['retired_step' as UserDeletionStepKey])).toThrow(
      /Unknown user deletion step/
    );
  });
});

describe('materialized deletion catalog validation', () => {
  it.each([1, 2])('accepts complete catalog version %i requests', version => {
    const stepKeys = catalogForVersion(version).map(entry => entry.stepKey);

    expect(() => validateMaterializedStepKeys(version, stepKeys)).not.toThrow();
  });

  it('accepts legacy v2 requests missing only the completion email task', () => {
    const stepKeys = catalogForVersion(2)
      .map(entry => entry.stepKey)
      .filter(stepKey => stepKey !== UserDeletionStepKey.CompletionEmail);

    expect(() => validateMaterializedStepKeys(2, stepKeys)).not.toThrow();
  });

  it.each([
    UserDeletionStepKey.PylonReply,
    UserDeletionStepKey.PylonFinalize,
    UserDeletionStepKey.CsaSupportDb,
  ])('rejects v2 requests missing the required %s task', missingStepKey => {
    const stepKeys = catalogForVersion(2)
      .map(entry => entry.stepKey)
      .filter(stepKey => stepKey !== missingStepKey);

    expect(() => validateMaterializedStepKeys(2, stepKeys)).toThrow(
      `missing required step ${missingStepKey}`
    );
  });

  it('rejects v1 requests missing a required task', () => {
    const stepKeys = catalogForVersion(1)
      .map(entry => entry.stepKey)
      .filter(stepKey => stepKey !== UserDeletionStepKey.Anonymize);

    expect(() => validateMaterializedStepKeys(1, stepKeys)).toThrow(
      `missing required step ${UserDeletionStepKey.Anonymize}`
    );
  });
});
