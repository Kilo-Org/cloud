import { describe, expect, it } from 'vitest';

import {
  inviteEmailError,
  inviteErrorCopy,
} from '@/components/organization/invite-member-validators';
import { i18n } from '@/i18n';

const invalidCopy = i18n.t('organization.inviteMember.emailError');

describe('inviteEmailError', () => {
  it('asks for an address when the field is empty', () => {
    expect(inviteEmailError('')).toBe(invalidCopy);
    expect(inviteEmailError('   ')).toBe(invalidCopy);
  });

  it('rejects the addresses the server schema rejects even though they hold an at-sign and a dot', () => {
    // The shapes the sheet used to enable Send for: the old pattern only
    // required text around an @ and a dot, so the server answered after the
    // round trip instead of the field reporting them here.
    for (const value of ['يوسف🔥@مثال.ش', 'e̷x̸a̶m̵p̷l̶e̷@t.co', 'name space@example.com', 'a@b..c']) {
      expect(inviteEmailError(value)).toBe(invalidCopy);
    }
  });

  it('accepts an ordinary address, including the trimmed form', () => {
    expect(inviteEmailError('first.last+tag@sub.example.co.uk')).toBeNull();
    expect(inviteEmailError('  dev@example.com \n')).toBeNull();
  });
});

describe('inviteErrorCopy', () => {
  it('places a schema rejection on the email field', () => {
    const error = Object.assign(new Error('[]'), { data: { code: 'BAD_REQUEST' } });
    expect(inviteErrorCopy(error)).toEqual({ field: 'email', message: invalidCopy });
  });

  it('never echoes the server message, which is a JSON issue array', () => {
    const raw = String.raw`[{"origin":"string","code":"invalid_format","format":"email","pattern":"/^(?!\\).+$/","path":["email"],"message":"Invalid email address"}]`;
    const copy = inviteErrorCopy(Object.assign(new Error(raw), { data: { code: 'BAD_REQUEST' } }));
    expect(copy.message).not.toContain('invalid_format');
    expect(copy.message).not.toContain('pattern');
    expect(copy.message).not.toContain('Invalid email address');
  });

  it('names a taken address on the form rather than blaming the field', () => {
    // CONFLICT covers both an invitation that is already pending and an
    // address that already belongs to a member.
    for (const message of [
      'This email already has a pending invitation',
      'This user is already a member of this organization',
    ]) {
      expect(
        inviteErrorCopy(Object.assign(new Error(message), { data: { code: 'CONFLICT' } }))
      ).toEqual({
        field: 'form',
        message: i18n.t('organization.inviteMember.alreadyInvited'),
      });
    }
  });

  it('falls back to the generic line for every other failure', () => {
    const generic = { field: 'form', message: i18n.t('organization.inviteMember.sendError') };
    expect(inviteErrorCopy(new Error('Failed to fetch'))).toEqual(generic);
    expect(
      inviteErrorCopy(Object.assign(new Error('boom'), { code: 'INTERNAL_SERVER_ERROR' }))
    ).toEqual(generic);
    // FORBIDDEN covers both a missing authority and an SSO-only join rule, so it
    // must not claim either one.
    expect(
      inviteErrorCopy(
        Object.assign(new Error('This user must join through SSO'), { code: 'FORBIDDEN' })
      )
    ).toEqual(generic);
  });
});
