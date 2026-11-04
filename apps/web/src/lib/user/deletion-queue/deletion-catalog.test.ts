import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import {
  catalogEntryFor,
  catalogForVersion,
  preReplyStepKeys,
  teardownStepKeys,
  USER_DELETION_CATALOG_V1,
  USER_DELETION_CATALOG_V2,
  USER_DELETION_CATALOG_V3,
  validateMaterializedStepKeys,
} from '@/lib/user/deletion-queue/deletion-catalog';
import {
  USER_DELETION_CATALOG_VERSION,
  USER_DELETION_ID_ONLY_CATALOG_VERSION,
} from '@kilocode/web-shared/lib/user/deletion-queue/deletion-constants';

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
  it('remains the default catalog for ordinary requests', () => {
    expect(USER_DELETION_CATALOG_VERSION).toBe(2);
    expect(teardownStepKeys()).toEqual(teardownStepKeys(2));
    expect(preReplyStepKeys()).toEqual(preReplyStepKeys(2));
  });

  it('includes the completion email between Pylon finalize and contact cleanup', () => {
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
      UserDeletionStepKey.CompletionEmail,
      UserDeletionStepKey.PylonContact,
    ]);
  });

  it('requires PostHog and Substack before anonymize', () => {
    expect(catalogEntryFor(2, UserDeletionStepKey.Anonymize).dependsOn).toEqual(
      expect.arrayContaining([UserDeletionStepKey.Posthog, UserDeletionStepKey.Substack])
    );
    expect(preReplyStepKeys(2)).toHaveLength(8);
    expect(teardownStepKeys(2)).toHaveLength(7);
  });

  it('chains finalize after reply, then contact', () => {
    expect(catalogEntryFor(2, UserDeletionStepKey.PylonFinalize).dependsOn).toEqual([
      UserDeletionStepKey.PylonReply,
    ]);
    expect(catalogEntryFor(2, UserDeletionStepKey.PylonContact).dependsOn).toEqual([
      UserDeletionStepKey.PylonFinalize,
      UserDeletionStepKey.CompletionEmail,
    ]);
  });

  it('still resolves historical CSA support DB rows without including them in new requests', () => {
    expect(catalogEntryFor(2, UserDeletionStepKey.CsaSupportDb)).toMatchObject({
      stepKey: UserDeletionStepKey.CsaSupportDb,
      phase: 'finalize',
      dependsOn: [UserDeletionStepKey.PylonContact],
    });
    expect(catalogForVersion(2).map(entry => entry.stepKey)).not.toContain(
      UserDeletionStepKey.CsaSupportDb
    );
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
    expect(() => catalogForVersion(4)).toThrow(/Unsupported/);
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

describe('deletion catalog v3', () => {
  it('contains only the six user-ID-only backfill tasks', () => {
    expect(USER_DELETION_ID_ONLY_CATALOG_VERSION).toBe(3);
    expect(catalogForVersion(USER_DELETION_ID_ONLY_CATALOG_VERSION)).toBe(USER_DELETION_CATALOG_V3);
    expect(USER_DELETION_CATALOG_V3.map(entry => entry.stepKey)).toEqual([
      UserDeletionStepKey.KiloclawDestroy,
      UserDeletionStepKey.CliV1Blobs,
      UserDeletionStepKey.CliV2Sessions,
      UserDeletionStepKey.UsagePromptPrefixes,
      UserDeletionStepKey.Posthog,
      UserDeletionStepKey.Anonymize,
    ]);
  });

  it('requires all five teardown tasks, including PostHog, before anonymize', () => {
    const teardown = [
      UserDeletionStepKey.KiloclawDestroy,
      UserDeletionStepKey.CliV1Blobs,
      UserDeletionStepKey.CliV2Sessions,
      UserDeletionStepKey.UsagePromptPrefixes,
      UserDeletionStepKey.Posthog,
    ];
    expect(teardownStepKeys(3)).toEqual(teardown);
    expect(catalogEntryFor(3, UserDeletionStepKey.Posthog)).toMatchObject({
      phase: 'teardown',
      dependsOn: [],
    });
    expect(catalogEntryFor(3, UserDeletionStepKey.Anonymize)).toMatchObject({
      phase: 'anonymize',
      dependsOn: teardown,
    });
    expect(preReplyStepKeys(3)).toEqual([...teardown, UserDeletionStepKey.Anonymize]);
  });

  it('preserves the existing retry and manual verification policies', () => {
    for (const entry of USER_DELETION_CATALOG_V3) {
      const original = catalogEntryFor(2, entry.stepKey);
      expect(entry).toMatchObject({
        maxOrdinaryAttempts: original.maxOrdinaryAttempts,
        allowsManualVerification: original.allowsManualVerification,
      });
    }
  });
});

describe('materialized deletion catalog validation', () => {
  it.each([1, 2, 3])('accepts complete catalog version %i requests', version => {
    const stepKeys = catalogForVersion(version).map(entry => entry.stepKey);

    expect(() => validateMaterializedStepKeys(version, stepKeys)).not.toThrow();
  });

  it('accepts legacy v2 requests missing only the completion email task', () => {
    const stepKeys = catalogForVersion(2)
      .map(entry => entry.stepKey)
      .filter(stepKey => stepKey !== UserDeletionStepKey.CompletionEmail);

    expect(() => validateMaterializedStepKeys(2, stepKeys)).not.toThrow();
  });

  it.each([true, false])(
    'accepts historical v2 CSA rows with completion email present: %s',
    includesCompletionEmail => {
      const stepKeys = [
        ...catalogForVersion(2)
          .map(entry => entry.stepKey)
          .filter(
            stepKey => includesCompletionEmail || stepKey !== UserDeletionStepKey.CompletionEmail
          ),
        UserDeletionStepKey.CsaSupportDb,
      ];

      expect(() => validateMaterializedStepKeys(2, stepKeys)).not.toThrow();
    }
  );

  it.each([1, 3])('rejects historical CSA rows in catalog version %i', version => {
    const stepKeys = [
      ...catalogForVersion(version).map(entry => entry.stepKey),
      UserDeletionStepKey.CsaSupportDb,
    ];

    expect(() => catalogEntryFor(version, UserDeletionStepKey.CsaSupportDb)).toThrow(
      `Unknown user deletion step ${UserDeletionStepKey.CsaSupportDb}`
    );
    expect(() => validateMaterializedStepKeys(version, stepKeys)).toThrow(
      `Unknown user deletion step ${UserDeletionStepKey.CsaSupportDb}`
    );
  });

  it('rejects duplicate historical CSA rows', () => {
    const stepKeys = [
      ...catalogForVersion(2).map(entry => entry.stepKey),
      UserDeletionStepKey.CsaSupportDb,
      UserDeletionStepKey.CsaSupportDb,
    ];

    expect(() => validateMaterializedStepKeys(2, stepKeys)).toThrow(/duplicate step/);
  });

  it.each([
    UserDeletionStepKey.PylonReply,
    UserDeletionStepKey.PylonFinalize,
    UserDeletionStepKey.PylonContact,
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

  it.each(USER_DELETION_CATALOG_V3.map(entry => entry.stepKey))(
    'rejects v3 requests missing the required %s task',
    missingStepKey => {
      const stepKeys = catalogForVersion(3)
        .map(entry => entry.stepKey)
        .filter(stepKey => stepKey !== missingStepKey);

      expect(() => validateMaterializedStepKeys(3, stepKeys)).toThrow(
        `missing required step ${missingStepKey}`
      );
    }
  );

  it.each([
    UserDeletionStepKey.Customerio,
    UserDeletionStepKey.Substack,
    UserDeletionStepKey.PylonReply,
    UserDeletionStepKey.PylonFinalize,
    UserDeletionStepKey.CompletionEmail,
    UserDeletionStepKey.PylonContact,
    UserDeletionStepKey.CsaSupportDb,
  ])('rejects the excluded %s task in v3 requests', stepKey => {
    const stepKeys = [...catalogForVersion(3).map(entry => entry.stepKey), stepKey];

    expect(() => validateMaterializedStepKeys(3, stepKeys)).toThrow(
      `Unknown user deletion step ${stepKey}`
    );
  });
});
