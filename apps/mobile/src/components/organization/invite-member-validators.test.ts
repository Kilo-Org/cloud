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

  it('accepts the longest address a mail system delivers and rejects one character more', () => {
    // 64-character local part, then three 63-character labels: 254 characters,
    // the RFC 5321 path maximum the procedure's `.max(254)` mirrors.
    const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(longest).toHaveLength(254);
    expect(inviteEmailError(longest)).toBeNull();

    const oneMore = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    expect(oneMore).toHaveLength(255);
    expect(inviteEmailError(oneMore)).toBe(invalidCopy);
  });

  it('rejects an address whose local part is far past the length maximum', () => {
    // The shape the sheet used to enable Send for: well-formed enough for the
    // syntax rule, longer than any address a mail system can deliver.
    expect(inviteEmailError(`${'a'.repeat(2004)}@example.com`)).toBe(invalidCopy);
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
    // Both sentences the invite procedure raises as CONFLICT, each with the
    // reason it actually gives.
    const cases: [string, string][] = [
      ['This email already has a pending invitation', 'pendingInvitation'],
      ['This user is already a member of this organization', 'alreadyMember'],
    ];
    for (const [message, key] of cases) {
      expect(
        inviteErrorCopy(Object.assign(new Error(message), { data: { code: 'CONFLICT' } }))
      ).toEqual({
        field: 'form',
        message: i18n.t(`organization.inviteMember.${key}`),
      });
    }
  });

  it('keeps the shared already-invited line for a conflict the app does not name', () => {
    expect(
      inviteErrorCopy(Object.assign(new Error('Invite conflict'), { data: { code: 'CONFLICT' } }))
    ).toEqual({ field: 'form', message: i18n.t('organization.inviteMember.alreadyInvited') });
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
