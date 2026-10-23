import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import {
  knownServerErrorMessage,
  ORGANIZATION_MEMBER_EXISTS_MESSAGE,
  ORGANIZATION_PENDING_INVITATION_MESSAGE,
  ORGANIZATION_TRIAL_EXPIRED_MESSAGE,
  organizationErrorMessage,
} from '@/lib/server-error-copy';

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
