import { describe, expect, it } from 'vitest';

import { REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY } from '@kilocode/app-shared/code-review';
import { i18n } from '@/i18n';
import {
  isTrialExpiredRefusal,
  knownServerErrorMessage,
  ORGANIZATION_MEMBER_EXISTS_MESSAGE,
  ORGANIZATION_PENDING_INVITATION_MESSAGE,
  ORGANIZATION_TRIAL_EXPIRED_MESSAGE,
  organizationErrorMessage,
} from '@/lib/server-error-copy';
import { TRIAL_ENDED_BILLING_COPY_KEY, TRIAL_ENDED_COPY_KEY } from '@/lib/trial-refusal-copy';

function makeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { data: { code, message } });
}

describe('knownServerErrorMessage', () => {
  it('explains the lapsed organization plan', () => {
    expect(
      knownServerErrorMessage(makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE))
    ).toBe(i18n.t('common.organizationTrialEnded'));
  });

  it('explains both invite conflicts', () => {
    expect(knownServerErrorMessage(makeError('CONFLICT', ORGANIZATION_MEMBER_EXISTS_MESSAGE))).toBe(
      i18n.t('organization.inviteMember.alreadyMember')
    );
    expect(
      knownServerErrorMessage(makeError('CONFLICT', ORGANIZATION_PENDING_INVITATION_MESSAGE))
    ).toBe(i18n.t('organization.inviteMember.pendingInvitation'));
  });

  it('explains a refused self role change', () => {
    expect(knownServerErrorMessage(makeError('FORBIDDEN', 'You cannot change your own role'))).toBe(
      i18n.t('organization.members.ownRoleChange')
    );
  });

  it('explains the owner-authority refusal and the invitation refusals', () => {
    expect(
      knownServerErrorMessage(
        makeError('FORBIDDEN', 'Only an organization owner can manage owners')
      )
    ).toBe(i18n.t('organization.members.ownerAuthority'));
    expect(knownServerErrorMessage(makeError('CONFLICT', 'This invitation has expired'))).toBe(
      i18n.t('organization.members.inviteExpired')
    );
    expect(
      knownServerErrorMessage(makeError('CONFLICT', 'This invitation has already been accepted'))
    ).toBe(i18n.t('organization.members.inviteAccepted'));
    expect(
      knownServerErrorMessage(makeError('CONFLICT', 'This invitation can no longer be resent'))
    ).toBe(i18n.t('organization.members.inviteNotResendable'));
  });

  it('reads a shaped client error too', () => {
    const shaped = {
      shape: { data: { code: 'FORBIDDEN', message: ORGANIZATION_TRIAL_EXPIRED_MESSAGE } },
    };
    expect(knownServerErrorMessage(shaped)).toBe(i18n.t('common.organizationTrialEnded'));
  });

  it('has no explanation for a server sentence it does not know', () => {
    expect(
      knownServerErrorMessage(makeError('FORBIDDEN', 'This user must join through your SSO'))
    ).toBeNull();
    expect(knownServerErrorMessage(new Error('Network request failed'))).toBeNull();
    expect(knownServerErrorMessage(null)).toBeNull();
  });

  it('matches the whole sentence, not a fragment of it', () => {
    expect(
      knownServerErrorMessage(
        makeError('FORBIDDEN', `Prefix ${ORGANIZATION_TRIAL_EXPIRED_MESSAGE}`)
      )
    ).toBeNull();
  });

  // The expected mapping is read from the shared table instead of a fixture, so
  // a review-memory reason added there fails this test until the app maps it.
  it.each(Object.entries(REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY))(
    'explains the review memory rejection %s',
    (_reason, sentence) => {
      const copy = knownServerErrorMessage(makeError('BAD_REQUEST', sentence));
      expect(copy).not.toBeNull();
      expect(copy).not.toBe(i18n.t('common.somethingWentWrong'));
      expect(copy).not.toBe(sentence);
    }
  );

  // `assertEnabled` refuses save, reject and approve with this one sentence, so
  // its copy must describe the gate and never one action's outcome.
  it('describes only the gate for the shared disabled rejection', () => {
    const copy = knownServerErrorMessage(
      makeError('FORBIDDEN', REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.review_memory_disabled)
    );
    expect(copy).toBe(i18n.t('codeReviewer.reviewMemory.offAction'));
    expect(copy).not.toContain(i18n.t('common.pullRequest'));
    expect(copy).not.toContain('REVIEW.md');
  });
});

describe('isTrialExpiredRefusal', () => {
  it('recognizes the trial sentence the gate refuses with', () => {
    expect(isTrialExpiredRefusal(makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE))).toBe(
      true
    );
  });

  it('answers false for every other rejection on the same surface', () => {
    expect(isTrialExpiredRefusal(makeError('FORBIDDEN', 'You cannot change your own role'))).toBe(
      false
    );
    expect(isTrialExpiredRefusal(new TypeError('Network request failed'))).toBe(false);
    expect(isTrialExpiredRefusal(null)).toBe(false);
  });
});

describe('the trial refusal, read by role', () => {
  const trialRefusal = () => makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE);

  it('gives a billing role the copy that offers the step', () => {
    expect(knownServerErrorMessage(trialRefusal(), true)).toBe(
      i18n.t(TRIAL_ENDED_BILLING_COPY_KEY)
    );
    expect(organizationErrorMessage(trialRefusal(), true)).toBe(
      i18n.t(TRIAL_ENDED_BILLING_COPY_KEY)
    );
  });

  it('keeps the owner-naming copy for a reader who cannot change the plan', () => {
    expect(knownServerErrorMessage(trialRefusal(), false)).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
    expect(knownServerErrorMessage(trialRefusal())).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
    expect(organizationErrorMessage(trialRefusal())).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
  });

  it('carries the role into no other sentence', () => {
    const inviteConflict = makeError('CONFLICT', ORGANIZATION_MEMBER_EXISTS_MESSAGE);
    expect(knownServerErrorMessage(inviteConflict, true)).toBe(
      i18n.t('organization.inviteMember.alreadyMember')
    );
    expect(organizationErrorMessage(inviteConflict, true)).toBe(
      i18n.t('organization.inviteMember.alreadyMember')
    );
  });

  it('does not let the role invent an explanation for an unknown sentence', () => {
    expect(
      knownServerErrorMessage(makeError('FORBIDDEN', 'This user must join through your SSO'), true)
    ).toBeNull();
  });
});

describe('organizationErrorMessage', () => {
  it('keeps the specific reason for a server sentence the app explains', () => {
    expect(
      organizationErrorMessage(makeError('CONFLICT', ORGANIZATION_PENDING_INVITATION_MESSAGE))
    ).toBe(i18n.t('organization.inviteMember.pendingInvitation'));
  });

  it('never shows an unexplained server sentence', () => {
    const unknown = makeError('NOT_FOUND', 'User is not a member of this organization');
    expect(organizationErrorMessage(unknown)).toBe(i18n.t('common.somethingWentWrong'));
    expect(organizationErrorMessage(unknown)).not.toContain('not a member');
  });

  it('falls back to the generic line for a transport failure', () => {
    expect(organizationErrorMessage(new TypeError('Network request failed'))).toBe(
      i18n.t('common.somethingWentWrong')
    );
  });
});
