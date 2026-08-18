import {
  classifyProtectedIdentity,
  deletionEmailsEqual,
  DeletionRefusalCode,
  normalizeDeletionEmail,
  parsePylonTicket,
  previewDeletionTargets,
} from '@/lib/user/deletion-queue/deletion-intake';

describe('deletion intake', () => {
  it('normalizes email without plus or gmail-dot aliasing', () => {
    expect(normalizeDeletionEmail('  User.Name+tag@Gmail.com ')).toBe('user.name+tag@gmail.com');
  });

  it('compares provider emails case-insensitively', () => {
    expect(deletionEmailsEqual('User@Example.com', 'user@example.com')).toBe(true);
    expect(deletionEmailsEqual('  User@Example.com  ', 'user@example.com')).toBe(true);
    expect(deletionEmailsEqual('User@Example.com', 'other@example.com')).toBe(false);
  });

  it('rejects malformed and duplicate emails and accepts a ticket', () => {
    const result = previewDeletionTargets([
      { email: 'not-an-email', pylonTicket: '#12' },
      { email: 'ok@example.com', pylonTicket: '#99' },
      { email: 'ok@example.com' },
      { email: 'staff@kilocode.ai' },
    ]);
    expect(result.rejected.map(entry => entry.code)).toEqual([
      DeletionRefusalCode.MalformedEmail,
      DeletionRefusalCode.DuplicateEntry,
    ]);
    expect(result.accepted).toEqual([
      { ok: true, email: 'ok@example.com', pylonTicket: '#99' },
      { ok: true, email: 'staff@kilocode.ai', pylonTicket: null },
    ]);
  });

  it('does not apply plus aliasing when previewing', () => {
    const result = previewDeletionTargets([
      { email: 'user+one@example.com' },
      { email: 'user+two@example.com' },
    ]);
    expect(result.accepted).toHaveLength(2);
  });

  it('classifies bot and self targets, and allows other staff or admins', () => {
    expect(
      classifyProtectedIdentity({
        email: 'person@example.com',
        user: {
          id: 'admin-1',
          is_admin: true,
          is_super_admin: false,
          is_bot: false,
          hosted_domain: '@@personal@@',
          google_user_email: 'person@example.com',
        },
      })
    ).toBeNull();
    expect(
      classifyProtectedIdentity({
        email: 'bot@example.com',
        user: {
          id: 'bot-1',
          is_admin: false,
          is_super_admin: false,
          is_bot: true,
          hosted_domain: '@@personal@@',
          google_user_email: 'bot@example.com',
        },
      })
    ).toBe(DeletionRefusalCode.ProtectedBot);
    expect(
      classifyProtectedIdentity({
        email: 'worker@kilocode.ai',
        user: {
          id: 'staff-1',
          is_admin: false,
          is_super_admin: false,
          is_bot: false,
          hosted_domain: 'kilocode.ai',
          google_user_email: 'worker@kilocode.ai',
        },
        actor: { id: 'admin-1', email: 'admin@kilocode.ai' },
      })
    ).toBeNull();
    expect(
      classifyProtectedIdentity({
        email: 'admin@kilocode.ai',
        user: {
          id: 'admin-1',
          is_admin: true,
          is_super_admin: false,
          is_bot: false,
          hosted_domain: 'kilocode.ai',
          google_user_email: 'admin@kilocode.ai',
        },
        actor: { id: 'admin-1', email: 'admin@kilocode.ai' },
      })
    ).toBe(DeletionRefusalCode.ProtectedSelf);
  });

  it('accepts a ticket-only entry for later Pylon resolution', () => {
    const result = previewDeletionTargets([{ pylonTicket: '#9999' }]);
    expect(result.accepted).toEqual([{ ok: true, email: '', pylonTicket: '#9999' }]);
    expect(result.rejected).toEqual([]);
  });

  it('rejects the same Pylon ticket twice in one batch', () => {
    const result = previewDeletionTargets([
      { email: 'one@example.com', pylonTicket: '#99' },
      { email: 'two@example.com', pylonTicket: '99' },
    ]);
    expect(result.accepted).toEqual([{ ok: true, email: 'one@example.com', pylonTicket: '#99' }]);
    expect(result.rejected).toEqual([
      {
        ok: false,
        email: 'two@example.com',
        pylonTicket: '99',
        code: DeletionRefusalCode.DuplicateEntry,
      },
    ]);
  });

  it('rejects malformed pylon tickets', () => {
    expect(parsePylonTicket('bad ticket with spaces')).toBe(DeletionRefusalCode.MalformedTicket);
    expect(parsePylonTicket('#12345')).toBe('#12345');
    expect(parsePylonTicket('')).toBeNull();
  });
});
