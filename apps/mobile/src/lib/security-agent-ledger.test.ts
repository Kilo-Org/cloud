// The ledger's reader-dependent copy. Every other marker has one sentence for
// everyone; the organization trial refusal is the one whose explanation depends
// on the reader's role, so these suites pin both readers on all three mapping
// paths: the sync mapper, the dismissal mapper, and the config write.

import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import {
  isSecurityTrialRefusal,
  isSecurityTrialRefusalCopyKey,
  localizedSecurityMarkerMessage,
  mapSecurityDismissOperationError,
  mapSecuritySyncOperationError,
  securityConfigMutationMessage,
  securityMutationCopyKey,
} from '@/lib/security-agent-ledger';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { TRIAL_ENDED_BILLING_COPY_KEY, TRIAL_ENDED_COPY_KEY } from '@/lib/trial-refusal-copy';

const MEMBER_COPY = i18n.t(TRIAL_ENDED_COPY_KEY);
const BILLING_COPY = i18n.t(TRIAL_ENDED_BILLING_COPY_KEY);

/** A lapsed-trial rejection as the organization gate sends it. */
function trialRejection(): Error {
  return Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
    data: { code: 'FORBIDDEN' },
  });
}

const MAPPER_BY_SURFACE = {
  sync: mapSecuritySyncOperationError,
  dismiss: mapSecurityDismissOperationError,
} as const;

describe('the two trial-refusal sentences differ by reader', () => {
  it('holds one sentence per role', () => {
    expect(MEMBER_COPY).not.toBe(BILLING_COPY);
    expect(MEMBER_COPY).toContain('An organization owner can update billing');
    expect(BILLING_COPY).toContain('You can update billing');
  });
});

describe('mapSecurityOperationError with the reader role', () => {
  for (const [surface, mapError] of Object.entries(MAPPER_BY_SURFACE)) {
    it(`gives a billing role the sentence that offers the step on a ${surface}`, () => {
      const mapped = mapError(trialRejection(), true);

      expect(mapped).toMatchObject({ message: BILLING_COPY });
      expect(securityMutationCopyKey(mapped)).toBe(TRIAL_ENDED_BILLING_COPY_KEY);
    });

    it(`gives every other role the sentence that names the owner on a ${surface}`, () => {
      expect(mapError(trialRejection())).toMatchObject({ message: MEMBER_COPY });
      expect(mapError(trialRejection(), false)).toMatchObject({ message: MEMBER_COPY });
      expect(securityMutationCopyKey(mapError(trialRejection(), false))).toBe(TRIAL_ENDED_COPY_KEY);
    });

    it(`keeps the role out of a refusal that has one explanation on a ${surface}`, () => {
      const precondition = Object.assign(new Error('device cannot translate this sentence'), {
        data: { code: 'PRECONDITION_FAILED', upstreamCode: 'security_sync_no_repositories' },
      });

      expect(mapError(precondition, true)).toMatchObject({
        message: i18n.t('securityAgent.mutations.syncNoRepositories'),
      });
    });
  }

  it('stores the trial refusal by key, never by sentence', () => {
    const mapped = mapSecuritySyncOperationError(trialRejection(), true);
    const key = securityMutationCopyKey(mapped, true);

    expect(key).toBe(TRIAL_ENDED_BILLING_COPY_KEY);
    // The stored key re-translates; a stored sentence would freeze one language.
    expect(key).not.toBe(BILLING_COPY);
    expect(i18n.t(key ?? '')).toBe(BILLING_COPY);
  });

  it('reads the role for a raw rejection exactly as the mapper would', () => {
    expect(securityMutationCopyKey(trialRejection(), true)).toBe(TRIAL_ENDED_BILLING_COPY_KEY);
    expect(securityMutationCopyKey(trialRejection(), false)).toBe(TRIAL_ENDED_COPY_KEY);
  });
});

describe('securityConfigMutationMessage with the reader role', () => {
  it('gives a billing role the config refusal that offers the step', () => {
    expect(securityConfigMutationMessage(trialRejection(), true)).toBe(BILLING_COPY);
  });

  it('gives every other role the config refusal that names the owner', () => {
    expect(securityConfigMutationMessage(trialRejection())).toBe(MEMBER_COPY);
    expect(securityConfigMutationMessage(trialRejection(), false)).toBe(MEMBER_COPY);
  });

  it('keeps a marked refusal on its own copy for both roles', () => {
    const conflict = Object.assign(new Error('server sentence'), {
      data: { code: 'CONFLICT', upstreamCode: 'security_config_conflict' },
    });

    expect(securityConfigMutationMessage(conflict, true)).toBe(
      i18n.t('securityAgent.mutations.configConflict')
    );
    expect(securityConfigMutationMessage(conflict, false)).toBe(
      i18n.t('securityAgent.mutations.configConflict')
    );
  });

  it('keeps the generic sentence for an unmarked refusal, whatever the role', () => {
    const transport = new Error('GitHub integration not found or inactive');

    expect(securityConfigMutationMessage(transport, false)).toBe(
      i18n.t('securityAgent.mutations.actionFailed')
    );
  });
});

describe('localizedSecurityMarkerMessage with the reader role', () => {
  it('translates the trial refusal for the reader it is given', () => {
    expect(localizedSecurityMarkerMessage(trialRejection(), true)).toBe(BILLING_COPY);
    expect(localizedSecurityMarkerMessage(trialRejection(), false)).toBe(MEMBER_COPY);
  });

  it('stays null for a failure no catalog explains', () => {
    expect(localizedSecurityMarkerMessage(new Error('Network request failed'), true)).toBeNull();
  });
});

describe('isSecurityTrialRefusal', () => {
  it('reads through the mapped error the surfaces hold', () => {
    expect(isSecurityTrialRefusal(trialRejection())).toBe(true);
    expect(isSecurityTrialRefusal(mapSecuritySyncOperationError(trialRejection(), true))).toBe(
      true
    );
    expect(isSecurityTrialRefusal(mapSecurityDismissOperationError(trialRejection()))).toBe(true);
  });

  it('is false for every other refusal, mapped or raw', () => {
    expect(isSecurityTrialRefusal(new Error('Network request failed'))).toBe(false);
    expect(
      isSecurityTrialRefusal(mapSecuritySyncOperationError(new Error('Network request failed')))
    ).toBe(false);
    expect(
      isSecurityTrialRefusal(
        mapSecuritySyncOperationError(
          Object.assign(new Error('server sentence'), {
            data: { code: 'PRECONDITION_FAILED', upstreamCode: 'security_sync_no_repositories' },
          })
        )
      )
    ).toBe(false);
  });
});

describe('isSecurityTrialRefusalCopyKey', () => {
  it('recognises the key either reader stores', () => {
    expect(isSecurityTrialRefusalCopyKey(TRIAL_ENDED_COPY_KEY)).toBe(true);
    expect(isSecurityTrialRefusalCopyKey(TRIAL_ENDED_BILLING_COPY_KEY)).toBe(true);
  });

  it('is false for another stored key, a missing one, and an unrecognised failure', () => {
    expect(isSecurityTrialRefusalCopyKey('common.actionNotRecorded')).toBe(false);
    expect(isSecurityTrialRefusalCopyKey(null)).toBe(false);
    expect(isSecurityTrialRefusalCopyKey(undefined)).toBe(false);
  });
});
