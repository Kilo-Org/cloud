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

  it('excludes soft-deleted users so the GDPR email_domain=null invariant is preserved', async () => {
    const user = await insertTestUser({ email_domain: 'example.com' });

    await softDeleteUser(user.id);
    const softDeleted = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(softDeleted[0].email_domain).toBeNull();
    expect(softDeleted[0].blocked_reason).toMatch(/^soft-deleted at /);

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
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
