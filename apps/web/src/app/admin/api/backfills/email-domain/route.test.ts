/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { softDeleteUser } from '@/lib/user';
import { emailDomainBackfillCandidates } from './route';

describe('emailDomainBackfillCandidates', () => {
  afterEach(async () => {
    await db.delete(kilocode_users);
  });

  it('includes users that are missing email_domain', async () => {
    const user = await insertTestUser({ email_domain: null });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).toContain(user.id);
  });

  it('excludes users that already have email_domain set', async () => {
    const user = await insertTestUser({ email_domain: 'example.com' });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
  });

  it('does not select newly soft-deleted users because their tombstone domain is stored', async () => {
    const user = await insertTestUser({ email_domain: 'example.com' });

    await softDeleteUser(user.id);
    const softDeleted = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(softDeleted[0].email_domain).toBe('deleted.invalid');
    expect(softDeleted[0].blocked_reason).toMatch(/^soft-deleted at /);

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
  });

  it('includes legacy soft-deleted users missing a tombstone domain', async () => {
    const userId = 'legacy-deleted-user';
    const user = await insertTestUser({
      id: userId,
      google_user_email: `deleted+${userId}@deleted.invalid`,
      email_domain: null,
      blocked_reason: 'soft-deleted at 2026-01-15T12:00:00.000Z',
    });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).toContain(user.id);
  });

  it('still includes users blocked for other reasons', async () => {
    const user = await insertTestUser({
      email_domain: null,
      blocked_reason: 'domainblocked',
    });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).toContain(user.id);
  });
});
